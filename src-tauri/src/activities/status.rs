use serde::{Deserialize, Serialize};

use super::model::{ActivityStatus, SessionExitRecord};

const BEL: u8 = 0x07;
const ESC: u8 = 0x1b;
const DEL: u8 = 0x7f;

/// Runtime-status tuning kept explicit so tests and future agent presets can
/// choose their own grace period without adding a timer/runtime dependency.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusTrackerConfig {
    pub idle_threshold_ms: u64,
    pub fallback_activity_delay_ms: u64,
    /// Bounds malformed or hostile OSC payloads without losing parser sync.
    pub max_osc_bytes: usize,
}

impl Default for AgentStatusTrackerConfig {
    fn default() -> Self {
        Self {
            idle_threshold_ms: 5_000,
            fallback_activity_delay_ms: 5_000,
            max_osc_bytes: 64 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusSnapshot {
    pub status: ActivityStatus,
    pub needs_input_is_blocking: bool,
}

/// A coalesced renderer update. A complete PTY chunk may contain many control
/// sequences, but consumers only need the final status and attention state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusChange {
    pub status: ActivityStatus,
    pub needs_input_is_blocking: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParserState {
    Text,
    Escape,
    Csi,
    Osc,
    OscEscape,
    OscDiscard,
    OscDiscardEscape,
    ControlString,
    ControlStringEscape,
}

/// Dependency-free, incremental status tracker for interactive CLI agents.
///
/// Input is raw PTY bytes rather than UTF-8 strings: escape sequences and
/// multibyte title characters may be split at any chunk boundary. Callers
/// provide monotonic milliseconds to `feed`, `poll`, and `finish`, which keeps
/// this type deterministic and independent of an async runtime.
#[derive(Debug, Clone)]
pub struct AgentStatusTracker {
    config: AgentStatusTrackerConfig,
    started_at_ms: u64,
    last_signal_at_ms: u64,
    status: ActivityStatus,
    parser_state: ParserState,
    osc_buffer: Vec<u8>,
    has_tui_signals: bool,
    has_status_signal: bool,
    needs_input_is_blocking: bool,
    last_title_spinner: bool,
    last_title_requires_action: bool,
    has_seen_title: bool,
    finished: bool,
    last_emitted_status: ActivityStatus,
    last_emitted_needs_input_is_blocking: bool,
}

impl AgentStatusTracker {
    pub fn new(started_at_ms: u64, config: AgentStatusTrackerConfig) -> Self {
        Self {
            config,
            started_at_ms,
            last_signal_at_ms: started_at_ms,
            status: ActivityStatus::Idle,
            parser_state: ParserState::Text,
            osc_buffer: Vec::new(),
            has_tui_signals: false,
            has_status_signal: false,
            needs_input_is_blocking: false,
            last_title_spinner: false,
            last_title_requires_action: false,
            has_seen_title: false,
            finished: false,
            last_emitted_status: ActivityStatus::Idle,
            last_emitted_needs_input_is_blocking: false,
        }
    }

    /// Consume one arbitrarily-sized PTY chunk and return at most one update.
    /// Escape/control parsing state is retained for the next call.
    pub fn feed(&mut self, chunk: impl AsRef<[u8]>, now_ms: u64) -> Option<AgentStatusChange> {
        if self.finished {
            return None;
        }

        for &byte in chunk.as_ref() {
            self.consume_byte(byte, now_ms);
        }
        self.emit_if_changed(now_ms)
    }

    /// Evaluate silence-based settling when no PTY bytes arrive.
    pub fn poll(&mut self, now_ms: u64) -> Option<AgentStatusChange> {
        self.emit_if_changed(now_ms)
    }

    /// Reconcile runtime hints with the authoritative process outcome.
    /// Terminal outcomes never settle back to idle and later PTY bytes are
    /// ignored, including bytes already queued after process exit.
    pub fn finish(&mut self, exit: &SessionExitRecord, now_ms: u64) -> Option<AgentStatusChange> {
        if self.finished {
            return None;
        }

        self.finished = true;
        self.needs_input_is_blocking = false;
        self.set_status(exit.activity_status(), now_ms);
        self.emit_if_changed(now_ms)
    }

    pub fn snapshot(&self, now_ms: u64) -> AgentStatusSnapshot {
        AgentStatusSnapshot {
            status: self.effective_status(now_ms),
            needs_input_is_blocking: self.needs_input_is_blocking,
        }
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }

    fn consume_byte(&mut self, byte: u8, now_ms: u64) {
        let state = std::mem::replace(&mut self.parser_state, ParserState::Text);
        match state {
            ParserState::Text => {
                if byte == ESC {
                    self.parser_state = ParserState::Escape;
                } else if byte == BEL {
                    self.has_status_signal = true;
                    self.set_status(ActivityStatus::NeedsInput, now_ms);
                } else {
                    self.parser_state = ParserState::Text;
                    if is_printable(byte)
                        && !self.has_tui_signals
                        && (self.has_status_signal
                            || now_ms.saturating_sub(self.started_at_ms)
                                >= self.config.fallback_activity_delay_ms)
                    {
                        self.set_status(ActivityStatus::Working, now_ms);
                    }
                }
            }
            ParserState::Escape => self.dispatch_escape(byte),
            ParserState::Csi => {
                self.parser_state = if is_csi_final_byte(byte) {
                    ParserState::Text
                } else {
                    ParserState::Csi
                };
            }
            ParserState::Osc => {
                if byte == BEL {
                    self.commit_osc(now_ms);
                } else if byte == ESC {
                    self.parser_state = ParserState::OscEscape;
                } else {
                    self.push_osc_byte(byte);
                }
            }
            ParserState::OscEscape => {
                if byte == b'\\' {
                    self.commit_osc(now_ms);
                } else {
                    self.commit_osc(now_ms);
                    self.dispatch_escape(byte);
                }
            }
            ParserState::OscDiscard => {
                if byte == BEL {
                    self.osc_buffer.clear();
                    self.parser_state = ParserState::Text;
                } else if byte == ESC {
                    self.parser_state = ParserState::OscDiscardEscape;
                } else {
                    self.parser_state = ParserState::OscDiscard;
                }
            }
            ParserState::OscDiscardEscape => {
                self.osc_buffer.clear();
                if byte == b'\\' {
                    self.parser_state = ParserState::Text;
                } else {
                    self.dispatch_escape(byte);
                }
            }
            ParserState::ControlString => {
                self.parser_state = if byte == BEL {
                    ParserState::Text
                } else if byte == ESC {
                    ParserState::ControlStringEscape
                } else {
                    ParserState::ControlString
                };
            }
            ParserState::ControlStringEscape => {
                self.parser_state = if byte == b'\\' {
                    ParserState::Text
                } else {
                    ParserState::ControlString
                };
            }
        }
    }

    fn dispatch_escape(&mut self, byte: u8) {
        self.parser_state = match byte {
            b'[' => ParserState::Csi,
            b']' => {
                self.osc_buffer.clear();
                ParserState::Osc
            }
            // DCS, SOS, PM, and APC strings terminate with ST (or BEL in
            // common terminal implementations) and must not leak printable
            // payload into the fallback heuristic.
            b'P' | b'X' | b'^' | b'_' => ParserState::ControlString,
            _ => ParserState::Text,
        };
    }

    fn push_osc_byte(&mut self, byte: u8) {
        if self.osc_buffer.len() < self.config.max_osc_bytes {
            self.osc_buffer.push(byte);
            self.parser_state = ParserState::Osc;
        } else {
            self.osc_buffer.clear();
            self.parser_state = ParserState::OscDiscard;
        }
    }

    fn commit_osc(&mut self, now_ms: u64) {
        let sequence = String::from_utf8_lossy(&self.osc_buffer).into_owned();
        self.osc_buffer.clear();
        self.parser_state = ParserState::Text;

        let Some((code, payload)) = sequence.split_once(';') else {
            return;
        };

        if matches!(code, "0" | "1" | "2") {
            self.handle_title(payload, now_ms);
        }

        if code == "9" && payload.starts_with("4;") {
            self.has_tui_signals = true;
            self.has_status_signal = true;
            match payload.as_bytes().get(2) {
                Some(b'0') => self.set_status(ActivityStatus::Done, now_ms),
                Some(b'3') => self.set_status(ActivityStatus::Working, now_ms),
                _ => {}
            }
        }

        if code == "777" {
            self.has_tui_signals = true;
            self.has_status_signal = true;
            self.needs_input_is_blocking = true;
            self.set_status(ActivityStatus::NeedsInput, now_ms);
        }
    }

    fn handle_title(&mut self, title: &str, now_ms: u64) {
        let now_spinner = is_spinner_prefix(title);
        let now_requires_action = is_codex_action_required_title(title);
        self.has_tui_signals = true;

        // A supported CLI's first plain title is its ready signal. It may
        // cancel noisy printable startup output, but never a real lifecycle
        // signal that arrived first.
        if !self.has_seen_title && !now_spinner && !now_requires_action && !self.has_status_signal {
            self.has_status_signal = true;
            self.set_status(ActivityStatus::Idle, now_ms);
        }

        if let Some(status) = codex_word_status(title) {
            self.has_status_signal = true;
            self.set_status(status, now_ms);
        } else if now_requires_action {
            self.has_status_signal = true;
            self.needs_input_is_blocking = true;
            self.set_status(ActivityStatus::NeedsInput, now_ms);
        } else {
            if now_spinner && !self.last_title_spinner {
                self.has_status_signal = true;
                self.set_status(ActivityStatus::Working, now_ms);
            }
            if self.last_title_spinner && !now_spinner {
                self.has_status_signal = true;
                self.set_status(ActivityStatus::NeedsInput, now_ms);
            }
            if self.last_title_requires_action && !now_spinner {
                self.has_status_signal = true;
                self.needs_input_is_blocking = false;
                self.set_status(ActivityStatus::NeedsInput, now_ms);
            }
        }

        self.last_title_spinner = now_spinner;
        self.last_title_requires_action = now_requires_action;
        self.has_seen_title = true;
    }

    fn set_status(&mut self, next: ActivityStatus, now_ms: u64) {
        self.status = next;
        self.last_signal_at_ms = now_ms;
        if matches!(
            next,
            ActivityStatus::Starting
                | ActivityStatus::Working
                | ActivityStatus::Done
                | ActivityStatus::Idle
                | ActivityStatus::Error
                | ActivityStatus::Stopped
                | ActivityStatus::Interrupted
        ) {
            self.needs_input_is_blocking = false;
        }
    }

    fn effective_status(&self, now_ms: u64) -> ActivityStatus {
        if self.finished {
            return self.status;
        }

        let elapsed = now_ms.saturating_sub(self.last_signal_at_ms);
        if elapsed >= self.config.idle_threshold_ms
            && (self.status == ActivityStatus::Done
                || (self.status == ActivityStatus::NeedsInput && !self.needs_input_is_blocking))
        {
            ActivityStatus::Idle
        } else {
            self.status
        }
    }

    fn emit_if_changed(&mut self, now_ms: u64) -> Option<AgentStatusChange> {
        let status = self.effective_status(now_ms);
        let status_changed = status != self.last_emitted_status;
        let blocking_changed =
            self.needs_input_is_blocking != self.last_emitted_needs_input_is_blocking;
        if !status_changed && !blocking_changed {
            return None;
        }

        self.last_emitted_status = status;
        self.last_emitted_needs_input_is_blocking = self.needs_input_is_blocking;
        Some(AgentStatusChange {
            status,
            needs_input_is_blocking: self.needs_input_is_blocking,
        })
    }
}

fn is_printable(byte: u8) -> bool {
    byte >= b' ' && byte != DEL
}

fn is_csi_final_byte(byte: u8) -> bool {
    (b'@'..=b'~').contains(&byte)
}

/// Braille animation cells are used by Claude Code and Codex; Gemini uses a
/// static `✦` working marker.
pub fn is_spinner_prefix(value: &str) -> bool {
    value
        .chars()
        .next()
        .is_some_and(|ch| matches!(ch as u32, 0x2800..=0x28ff | 0x2726))
}

// Mimir launches Codex with [app-name, status, activity] title items.
// Match the complete status field; arbitrary title/prose text is not a signal.
// Codex omits its title spinner entirely when tui.animations=false.
fn codex_word_status(title: &str) -> Option<ActivityStatus> {
    let rest = title.strip_prefix("codex | ")?;
    let state = rest.split(" | ").next()?;
    match state {
        "Starting" => Some(ActivityStatus::Starting),
        "Working" | "Thinking" | "Waiting" => Some(ActivityStatus::Working),
        "Ready" => Some(ActivityStatus::Idle),
        _ => None,
    }
}

fn is_codex_action_required_title(title: &str) -> bool {
    let Some(rest) = title.strip_prefix('[') else {
        return false;
    };
    let rest = rest.trim_start_matches(char::is_whitespace);
    let Some(marker) = rest.chars().next() else {
        return false;
    };
    if !matches!(marker, '!' | '.') {
        return false;
    }

    let rest = &rest[marker.len_utf8()..];
    let rest = rest.trim_start_matches(char::is_whitespace);
    let Some(rest) = rest.strip_prefix(']') else {
        return false;
    };

    // Codex always separates the bracketed pulse from "Action Required".
    let trimmed = rest.trim_start_matches(char::is_whitespace);
    if trimmed.len() == rest.len() {
        return false;
    }
    let Some(rest) = trimmed.strip_prefix("Action Required") else {
        return false;
    };
    let rest = rest.trim_start_matches(char::is_whitespace);
    rest.is_empty() || rest.starts_with('|')
}

#[cfg(test)]
mod tests {
    use super::super::model::SessionExitReason;
    use super::*;

    fn tracker(started_at_ms: u64) -> AgentStatusTracker {
        AgentStatusTracker::new(started_at_ms, AgentStatusTrackerConfig::default())
    }

    fn exit(reason: SessionExitReason) -> SessionExitRecord {
        SessionExitRecord {
            reason,
            code: None,
            signal: None,
            message: None,
        }
    }

    #[test]
    fn starts_idle_and_emits_only_status_or_attention_changes() {
        let mut status = tracker(100);
        assert_eq!(status.snapshot(100).status, ActivityStatus::Idle);
        assert_eq!(status.poll(100), None);
        assert_eq!(status.feed(b"\r\n", 100), None);

        let change = status.feed(b"\x07", 101).unwrap();
        assert_eq!(change.status, ActivityStatus::NeedsInput);
        assert_eq!(status.feed(b"\x07", 102), None);
    }

    #[test]
    fn printable_fallback_obeys_startup_grace_and_bel_resumes_it() {
        let mut status = tracker(1_000);
        assert_eq!(status.feed(b"boot banner", 5_999), None);
        assert_eq!(
            status.feed(b"x", 6_000).unwrap().status,
            ActivityStatus::Working
        );

        let mut after_bel = tracker(10_000);
        assert_eq!(
            after_bel.feed(b"\x07", 10_001).unwrap().status,
            ActivityStatus::NeedsInput
        );
        assert_eq!(
            after_bel.feed(b"response", 10_002).unwrap().status,
            ActivityStatus::Working
        );
    }

    #[test]
    fn a_first_plain_title_resets_noisy_startup_to_idle() {
        let mut status = tracker(0);
        assert_eq!(
            status.feed(b"late startup redraw", 5_000).unwrap().status,
            ActivityStatus::Working
        );
        let change = status.feed(b"\x1b]0;Codex\x07", 5_001).unwrap();
        assert_eq!(change.status, ActivityStatus::Idle);
    }

    #[test]
    fn title_terminating_bel_is_swallowed_not_reinterpreted() {
        let mut status = tracker(0);
        assert_eq!(status.feed(b"\x1b]2;Claude Code\x07", 0), None);
        assert_eq!(status.snapshot(0).status, ActivityStatus::Idle);
        assert!(!status.snapshot(0).needs_input_is_blocking);
    }

    #[test]
    fn parses_osc_split_at_introducer_payload_and_st_terminator() {
        let mut status = tracker(0);
        assert_eq!(status.feed(b"\x1b", 0), None);
        assert_eq!(status.feed(b"]2;\xe2\xa0", 0), None);
        assert_eq!(status.feed(b"\xb4 split title\x1b", 0), None);
        let change = status.feed(b"\\", 0).unwrap();
        assert_eq!(change.status, ActivityStatus::Working);
    }

    #[test]
    fn preserves_a_multibyte_spinner_split_across_chunks() {
        let bytes = "\x1b]0;⠴ Refactoring\x07".as_bytes();
        let spinner_start = b"\x1b]0;".len();
        let mut status = tracker(0);
        assert_eq!(status.feed(&bytes[..spinner_start + 1], 0), None);
        assert_eq!(
            status.feed(&bytes[spinner_start + 1..spinner_start + 2], 0),
            None
        );
        let change = status.feed(&bytes[spinner_start + 2..], 0).unwrap();
        assert_eq!(change.status, ActivityStatus::Working);
    }

    #[test]
    fn progress_protocol_drives_work_done_and_live_idle_settling() {
        let mut status = tracker(0);
        assert_eq!(
            status.feed(b"\x1b]9;4;3;\x07", 10).unwrap().status,
            ActivityStatus::Working
        );
        assert_eq!(
            status.feed(b"\x1b]9;4;0;\x07", 20).unwrap().status,
            ActivityStatus::Done
        );
        assert_eq!(status.poll(5_019), None);
        assert_eq!(status.poll(5_020).unwrap().status, ActivityStatus::Idle);
        assert_eq!(status.poll(20_000), None);
    }

    #[test]
    fn progress_sequence_can_be_split_at_every_boundary() {
        let mut status = tracker(0);
        for part in [b"\x1b".as_slice(), b"]9".as_slice(), b";4;".as_slice()] {
            assert_eq!(status.feed(part, 1), None);
        }
        assert_eq!(
            status.feed(b"3;\x07", 1).unwrap().status,
            ActivityStatus::Working
        );
    }

    #[test]
    fn osc_777_is_blocking_until_an_explicit_work_signal() {
        let mut status = tracker(0);
        let change = status
            .feed(b"\x1b]777;notify;Permission required\x07", 1)
            .unwrap();
        assert_eq!(change.status, ActivityStatus::NeedsInput);
        assert!(change.needs_input_is_blocking);
        assert_eq!(status.poll(100_000), None);
        assert_eq!(
            status.feed(b"\x1b]9;4;3;\x07", 100_001).unwrap().status,
            ActivityStatus::Working
        );
        assert!(!status.snapshot(100_001).needs_input_is_blocking);
    }

    #[test]
    fn spinner_gain_and_loss_map_to_work_and_transient_input() {
        let mut status = tracker(0);
        assert_eq!(status.feed(b"\x1b]0;Codex\x07", 0), None);
        assert_eq!(
            status.feed("\x1b]0;⠂ Editing\x07", 1).unwrap().status,
            ActivityStatus::Working
        );
        assert_eq!(
            status.feed(b"\x1b]0;Codex\x07", 2).unwrap().status,
            ActivityStatus::NeedsInput
        );
        assert_eq!(status.poll(5_002).unwrap().status, ActivityStatus::Idle);
    }

    #[test]
    fn codex_word_status_works_without_cli_animation_and_after_approval() {
        let mut status = tracker(0);
        assert_eq!(status.feed(b"\x1b]0;codex | Ready\x07", 0), None);
        for (index, word) in ["Starting", "Working", "Thinking", "Waiting"]
            .iter()
            .enumerate()
        {
            let title = format!("\x1b]0;codex | {word}\x07");
            status.feed(title, index as u64 + 1);
            assert_eq!(
                status.snapshot(10).status,
                if *word == "Starting" {
                    ActivityStatus::Starting
                } else {
                    ActivityStatus::Working
                }
            );
        }
        assert_eq!(status.poll(50_000), None, "work must survive silence");
        assert_eq!(
            status
                .feed(b"\x1b]0;[ ! ] Action Required | codex\x07", 50_001)
                .unwrap()
                .status,
            ActivityStatus::NeedsInput
        );
        assert!(status.snapshot(50_001).needs_input_is_blocking);
        assert_eq!(
            status
                .feed(b"\x1b]0;codex | Working\x07", 50_002)
                .unwrap()
                .status,
            ActivityStatus::Working
        );
        assert!(!status.snapshot(50_002).needs_input_is_blocking);
        assert_eq!(
            status
                .feed(b"\x1b]0;codex | Ready\x07", 50_003)
                .unwrap()
                .status,
            ActivityStatus::Idle
        );
        assert_eq!(status.feed(b"ordinary redraw", 50_004), None);
    }

    #[test]
    fn codex_word_status_handles_split_sequences_and_animated_titles() {
        let mut status = tracker(0);
        for chunk in ["\x1b]", "0;codex | Wor", "king | ⠋", "\x1b", "\\"] {
            status.feed(chunk, 1);
        }
        assert_eq!(status.snapshot(1).status, ActivityStatus::Working);
        for title in [
            "Working",
            "codex | Working on docs",
            "project | Working",
            "codex | Not Ready",
        ] {
            assert_eq!(codex_word_status(title), None);
        }
    }

    #[test]
    fn codex_action_required_is_exact_and_blocking() {
        for title in [
            "[ ! ] Action Required | project",
            "[ . ] Action Required | project",
            "[!] Action Required",
        ] {
            assert!(is_codex_action_required_title(title), "{title}");
        }
        for title in [
            "Action Required | project",
            "[ ! ] Action Requiredness | project",
            "Refactor Action Required handling",
            " [ ! ] Action Required",
        ] {
            assert!(!is_codex_action_required_title(title), "{title}");
        }

        let mut status = tracker(0);
        let change = status
            .feed(b"\x1b]0;[ ! ] Action Required | project\x07", 1)
            .unwrap();
        assert_eq!(change.status, ActivityStatus::NeedsInput);
        assert!(status.snapshot(1).needs_input_is_blocking);
        assert_eq!(status.poll(50_000), None);

        let release = status.feed(b"\x1b]0;project\x07", 50_001).unwrap();
        assert_eq!(release.status, ActivityStatus::NeedsInput);
        assert!(!release.needs_input_is_blocking);
        assert_eq!(status.poll(55_001).unwrap().status, ActivityStatus::Idle);
    }

    #[test]
    fn tui_signals_permanently_suppress_printable_redraws() {
        let mut status = tracker(0);
        status.feed(b"\x1b]9;4;0;\x07", 1).unwrap();
        assert_eq!(status.feed(b"constant redraw", 2), None);
        assert_eq!(status.snapshot(2).status, ActivityStatus::Done);

        status.feed(b"\x07", 3).unwrap();
        assert_eq!(status.feed(b"still redrawing", 4), None);
        assert_eq!(status.snapshot(4).status, ActivityStatus::NeedsInput);
    }

    #[test]
    fn title_only_changes_do_not_emit_redundant_status_updates() {
        let mut status = tracker(0);
        assert_eq!(status.feed(b"\x1b]0;first\x07", 0), None);
        assert_eq!(status.feed(b"\x1b]0;first\x07", 1), None);
        assert_eq!(status.feed(b"\x1b]1;second\x07", 2), None);
    }

    #[test]
    fn csi_and_control_strings_do_not_leak_payload_or_bel() {
        let mut status = tracker(0);
        assert_eq!(status.feed(b"\x1b[31m", 5_000), None);
        assert_eq!(status.feed(b"\x1bPprintable\x07", 5_000), None);
        assert_eq!(status.feed(b"\x1b_hidden\x1b\\", 5_000), None);
        assert_eq!(
            status.feed(b"real output", 5_000).unwrap().status,
            ActivityStatus::Working
        );
    }

    #[test]
    fn oversized_osc_is_discarded_and_parser_recovers() {
        let mut status = AgentStatusTracker::new(
            0,
            AgentStatusTrackerConfig {
                max_osc_bytes: 4,
                ..AgentStatusTrackerConfig::default()
            },
        );
        assert_eq!(status.feed(b"\x1b]0;too-long-title\x07", 10_000), None);
        assert_eq!(
            status.feed(b"\x07", 10_001).unwrap().status,
            ActivityStatus::NeedsInput
        );
    }

    #[test]
    fn authoritative_exit_outcomes_end_the_lifecycle() {
        for (reason, expected) in [
            (SessionExitReason::Completed, ActivityStatus::Done),
            (SessionExitReason::Stopped, ActivityStatus::Stopped),
            (SessionExitReason::Failed, ActivityStatus::Error),
            (SessionExitReason::Interrupted, ActivityStatus::Interrupted),
        ] {
            let mut status = tracker(0);
            status.feed(b"\x1b]9;4;3;\x07", 1).unwrap();
            let change = status.finish(&exit(reason), 2).unwrap();
            assert_eq!(change.status, expected);
            assert!(status.is_finished());
            assert_eq!(status.poll(100_000), None);
            assert_eq!(status.snapshot(100_000).status, expected);
            assert_eq!(status.feed(b"\x07late bytes", 100_001), None);
            assert_eq!(status.finish(&exit(reason), 100_002), None);
        }
    }

    #[test]
    fn spinner_prefix_vocabulary_is_intentional() {
        assert!(is_spinner_prefix("⣿ compiling"));
        assert!(is_spinner_prefix("⠀ blank braille"));
        assert!(is_spinner_prefix("✦ Gemini"));
        assert!(!is_spinner_prefix("✳ settled"));
        assert!(!is_spinner_prefix(""));
    }
}
