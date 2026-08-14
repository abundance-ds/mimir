use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// One raw PTY-output fragment. The bytes are intentionally not decoded:
/// terminal control sequences and UTF-8 code points may cross read boundaries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputChunk {
    pub sequence: u64,
    pub bytes: Vec<u8>,
}

/// A bounded replay returned to a newly attached renderer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollbackReplay {
    pub chunks: Vec<OutputChunk>,
    pub retained_bytes: usize,
    pub byte_cap: usize,
    pub first_sequence: Option<u64>,
    pub last_sequence: u64,
    /// True when bytes older than this replay have been evicted.
    pub truncated: bool,
}

/// Deterministically byte-bounded raw scrollback.
///
/// Eviction may begin in the middle of a UTF-8 code point or terminal escape
/// sequence. That is deliberate: PTYs are byte streams, and preserving the
/// exact newest `byte_cap` bytes is both deterministic and lossless for the
/// retained tail. Terminal renderers already accept arbitrarily split input.
#[derive(Debug, Clone)]
pub struct RawScrollback {
    chunks: VecDeque<OutputChunk>,
    retained_bytes: usize,
    byte_cap: usize,
    next_sequence: u64,
    truncated: bool,
}

impl RawScrollback {
    pub fn new(byte_cap: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            retained_bytes: 0,
            byte_cap,
            next_sequence: 1,
            truncated: false,
        }
    }

    pub fn from_persisted(
        byte_cap: usize,
        chunks: Vec<OutputChunk>,
        next_sequence: u64,
        was_truncated: bool,
    ) -> Self {
        let mut scrollback = Self::new(byte_cap);
        scrollback.next_sequence = next_sequence.max(1);
        scrollback.truncated = was_truncated;

        for chunk in chunks {
            scrollback.next_sequence = scrollback
                .next_sequence
                .max(chunk.sequence.saturating_add(1));
            scrollback.push_existing(chunk);
        }
        scrollback
    }

    /// Append bytes and return the stable sequence assigned to this read.
    pub fn append(&mut self, bytes: &[u8]) -> u64 {
        let sequence = self.next_sequence;
        self.append_with_sequence(sequence, bytes);
        sequence
    }

    /// Append bytes with a sequence from the ordered terminal event stream.
    /// Resize events can create gaps between output chunks.
    pub fn append_with_sequence(&mut self, sequence: u64, bytes: &[u8]) {
        self.observe_sequence(sequence);

        if bytes.is_empty() {
            return;
        }

        self.push_existing(OutputChunk {
            sequence,
            bytes: bytes.to_vec(),
        });
    }

    pub fn observe_sequence(&mut self, sequence: u64) {
        self.next_sequence = self.next_sequence.max(sequence.saturating_add(1));
    }

    fn push_existing(&mut self, mut chunk: OutputChunk) {
        if self.byte_cap == 0 {
            self.truncated = true;
            return;
        }

        if chunk.bytes.len() >= self.byte_cap {
            let keep_from = chunk.bytes.len() - self.byte_cap;
            if keep_from > 0 || self.retained_bytes > 0 {
                self.truncated = true;
            }
            chunk.bytes.drain(..keep_from);
            self.chunks.clear();
            self.retained_bytes = chunk.bytes.len();
            self.chunks.push_back(chunk);
            return;
        }

        let overflow = self
            .retained_bytes
            .saturating_add(chunk.bytes.len())
            .saturating_sub(self.byte_cap);
        if overflow > 0 {
            self.evict_front(overflow);
        }

        self.retained_bytes += chunk.bytes.len();
        self.chunks.push_back(chunk);
    }

    fn evict_front(&mut self, mut bytes: usize) {
        if bytes == 0 {
            return;
        }
        self.truncated = true;

        while bytes > 0 {
            let Some(front) = self.chunks.front_mut() else {
                break;
            };

            if bytes >= front.bytes.len() {
                bytes -= front.bytes.len();
                self.retained_bytes -= front.bytes.len();
                self.chunks.pop_front();
            } else {
                front.bytes.drain(..bytes);
                self.retained_bytes -= bytes;
                bytes = 0;
            }
        }
    }

    pub fn replay_after(&self, after_sequence: Option<u64>) -> ScrollbackReplay {
        let chunks: Vec<_> = self
            .chunks
            .iter()
            .filter(|chunk| after_sequence.is_none_or(|after| chunk.sequence > after))
            .cloned()
            .collect();
        let retained_bytes = chunks.iter().map(|chunk| chunk.bytes.len()).sum();

        ScrollbackReplay {
            first_sequence: chunks.first().map(|chunk| chunk.sequence),
            chunks,
            retained_bytes,
            byte_cap: self.byte_cap,
            last_sequence: self.next_sequence.saturating_sub(1),
            truncated: self.truncated,
        }
    }

    pub fn retained_bytes(&self) -> usize {
        self.retained_bytes
    }

    pub fn byte_cap(&self) -> usize {
        self.byte_cap
    }

    pub fn next_sequence(&self) -> u64 {
        self.next_sequence
    }

    pub fn was_truncated(&self) -> bool {
        self.truncated
    }

    pub fn persisted_chunks(&self) -> Vec<OutputChunk> {
        self.chunks.iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flattened(replay: &ScrollbackReplay) -> Vec<u8> {
        replay
            .chunks
            .iter()
            .flat_map(|chunk| chunk.bytes.iter().copied())
            .collect()
    }

    #[test]
    fn retains_the_exact_newest_bytes_at_the_cap() {
        let mut scrollback = RawScrollback::new(5);
        assert_eq!(scrollback.append(b"abc"), 1);
        assert_eq!(scrollback.append(b"defg"), 2);

        let replay = scrollback.replay_after(None);
        assert_eq!(flattened(&replay), b"cdefg");
        assert_eq!(replay.retained_bytes, 5);
        assert_eq!(replay.first_sequence, Some(1));
        assert_eq!(replay.last_sequence, 2);
        assert!(replay.truncated);
    }

    #[test]
    fn raw_unicode_may_split_without_corrupting_or_exceeding_the_cap() {
        let smile = "🙂".as_bytes();
        let mut scrollback = RawScrollback::new(3);
        scrollback.append(&smile[..2]);
        scrollback.append(&smile[2..]);

        let replay = scrollback.replay_after(None);
        assert_eq!(flattened(&replay), smile[1..]);
        assert_eq!(replay.retained_bytes, 3);
        assert_eq!(replay.byte_cap, 3);
    }

    #[test]
    fn oversized_chunk_replaces_the_tail_deterministically() {
        let mut scrollback = RawScrollback::new(4);
        scrollback.append(b"old");
        let sequence = scrollback.append(b"012345");

        let replay = scrollback.replay_after(None);
        assert_eq!(flattened(&replay), b"2345");
        assert_eq!(replay.chunks[0].sequence, sequence);
        assert_eq!(replay.first_sequence, Some(sequence));
    }

    #[test]
    fn replay_after_sequence_filters_complete_read_fragments() {
        let mut scrollback = RawScrollback::new(100);
        scrollback.append(b"one");
        let second = scrollback.append(b"two");
        scrollback.append(b"three");

        let replay = scrollback.replay_after(Some(second));
        assert_eq!(flattened(&replay), b"three");
        assert_eq!(replay.first_sequence, Some(3));
        assert_eq!(replay.last_sequence, 3);
    }

    #[test]
    fn persisted_reconstruction_preserves_sequences_and_reapplies_new_cap() {
        let chunks = vec![
            OutputChunk {
                sequence: 8,
                bytes: b"abcd".to_vec(),
            },
            OutputChunk {
                sequence: 9,
                bytes: b"efgh".to_vec(),
            },
        ];

        let scrollback = RawScrollback::from_persisted(5, chunks, 10, false);
        let replay = scrollback.replay_after(None);
        assert_eq!(flattened(&replay), b"defgh");
        assert_eq!(replay.last_sequence, 9);
        assert!(replay.truncated);
    }
}
