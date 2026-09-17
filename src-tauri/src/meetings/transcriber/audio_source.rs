use super::*;

#[derive(Clone, PartialEq, Eq)]
pub struct PersistedAudioChunk {
    pub sequence: u64,
    pub start_ms: u64,
    pub end_ms: u64,
    pub bytes: Vec<u8>,
}

impl std::fmt::Debug for PersistedAudioChunk {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PersistedAudioChunk")
            .field("sequence", &self.sequence)
            .field("start_ms", &self.start_ms)
            .field("end_ms", &self.end_ms)
            .field("audio", &format_args!("[{} bytes]", self.bytes.len()))
            .finish()
    }
}

#[derive(Clone)]
enum AudioAuthority {
    CommittedStore(Arc<MeetingStore>),
    #[cfg(test)]
    FixtureDirectory,
}

enum AuthorizedAudioChunk {
    Committed(Box<AudioChunk>),
    #[cfg(test)]
    Fixture {
        path: PathBuf,
    },
}

/// Safe reader for capture-owned channel files.
///
/// Production construction requires a [`MeetingStore`]. SQLite's committed
/// rows are the only authority for which files may cross the STT boundary;
/// directory contents are never discovered or trusted.
#[derive(Clone)]
pub struct PersistedAudioSource {
    root: PathBuf,
    meeting_id: String,
    authority: AudioAuthority,
    pub(super) end_sequence: Arc<AtomicU64>,
}

impl PersistedAudioSource {
    pub(crate) fn authoritative(
        store: Arc<MeetingStore>,
        data_dir: impl Into<PathBuf>,
        meeting_id: &str,
    ) -> Result<Self, String> {
        validate_path_component(meeting_id, "meeting id")?;
        Ok(Self {
            root: data_dir.into(),
            end_sequence: Arc::new(AtomicU64::new(u64::MAX)),
            meeting_id: meeting_id.into(),
            authority: AudioAuthority::CommittedStore(store),
        })
    }

    /// Raw fixture construction exists only for isolated local-whisper unit
    /// tests. It is absent from production builds and cannot be reached by a
    /// runtime provider.
    #[cfg(test)]
    pub fn new(data_dir: impl Into<PathBuf>, meeting_id: &str) -> Result<Self, String> {
        validate_path_component(meeting_id, "meeting id")?;
        Ok(Self {
            root: data_dir.into(),
            end_sequence: Arc::new(AtomicU64::new(u64::MAX)),
            meeting_id: meeting_id.into(),
            authority: AudioAuthority::FixtureDirectory,
        })
    }

    pub fn paired_chunks_from(
        &self,
        first_sequence: u64,
    ) -> Result<Vec<PersistedAudioChunk>, String> {
        self.paired_chunks_from_bounded(first_sequence, DEFAULT_AUDIO_READ_CHUNKS)
    }

    pub fn paired_chunks_from_bounded(
        &self,
        first_sequence: u64,
        maximum_chunks: usize,
    ) -> Result<Vec<PersistedAudioChunk>, String> {
        self.chunks_from(first_sequence, false, maximum_chunks)
    }

    /// Returns every durable final chunk. A channel that ended one partial
    /// chunk earlier is padded with silence only in the provider projection;
    /// its source file is never changed.
    pub fn final_chunks_from(
        &self,
        first_sequence: u64,
    ) -> Result<Vec<PersistedAudioChunk>, String> {
        self.final_chunks_from_bounded(first_sequence, DEFAULT_AUDIO_READ_CHUNKS)
    }

    pub fn final_chunks_from_bounded(
        &self,
        first_sequence: u64,
        maximum_chunks: usize,
    ) -> Result<Vec<PersistedAudioChunk>, String> {
        self.chunks_from(first_sequence, true, maximum_chunks)
    }

    pub(super) fn chunks_from(
        &self,
        first_sequence: u64,
        include_unpaired_final_chunks: bool,
        maximum_chunks: usize,
    ) -> Result<Vec<PersistedAudioChunk>, String> {
        if maximum_chunks == 0 || maximum_chunks > MAX_AUDIO_READ_CHUNKS {
            return Err(format!(
                "audio reads must request between 1 and {MAX_AUDIO_READ_CHUNKS} chunks"
            ));
        }
        let microphone =
            self.authorized_channel_chunks("microphone", first_sequence, maximum_chunks)?;
        let system = self.authorized_channel_chunks("system", first_sequence, maximum_chunks)?;
        let mut result = Vec::new();
        let mut sequence = first_sequence;
        while result.len() < maximum_chunks && sequence < self.end_sequence.load(Ordering::Acquire)
        {
            let microphone_chunk = microphone.get(&sequence);
            let system_chunk = system.get(&sequence);
            match (microphone_chunk, system_chunk) {
                (None, None) => break,
                (Some(_), Some(_)) => {}
                _ if include_unpaired_final_chunks => {}
                _ => break,
            }
            // A missing final channel is projected as silence only after the
            // other channel has been authorized and read. No synthetic file
            // or database row is created.
            let microphone_bytes = microphone_chunk
                .map(|chunk| self.read_authorized_chunk(chunk))
                .transpose()?
                .unwrap_or_default();
            let system_bytes = system_chunk
                .map(|chunk| self.read_authorized_chunk(chunk))
                .transpose()?
                .unwrap_or_default();
            let bytes = interleave_f32le(&microphone_bytes, &system_bytes)?;
            let sample_count = bytes.len() / BYTES_PER_SAMPLE / CHANNELS as usize;
            let start_ms = sequence.saturating_mul(1_000);
            let duration_ms = (sample_count as u64).saturating_mul(1_000) / SAMPLE_RATE_HZ as u64;
            result.push(PersistedAudioChunk {
                sequence,
                start_ms,
                end_ms: start_ms.saturating_add(duration_ms.max(1)),
                bytes,
            });
            sequence = sequence
                .checked_add(1)
                .ok_or_else(|| "audio chunk sequence overflow".to_string())?;
        }
        Ok(result)
    }

    fn authorized_channel_chunks(
        &self,
        channel: &str,
        first_sequence: u64,
        maximum_chunks: usize,
    ) -> Result<BTreeMap<u64, AuthorizedAudioChunk>, String> {
        validate_path_component(channel, "audio channel")?;
        match &self.authority {
            AudioAuthority::CommittedStore(store) => {
                let chunks = store
                    .committed_audio_chunks(
                        &self.meeting_id,
                        channel,
                        first_sequence,
                        maximum_chunks as u32,
                    )
                    .map_err(|error| error.to_string())?
                    .into_iter()
                    .map(|chunk| {
                        let sequence = chunk.definition.sequence;
                        (sequence, AuthorizedAudioChunk::Committed(Box::new(chunk)))
                    })
                    .collect::<BTreeMap<_, _>>();
                Ok(chunks)
            }
            #[cfg(test)]
            AudioAuthority::FixtureDirectory => {
                self.fixture_channel_chunks(channel, first_sequence, maximum_chunks)
            }
        }
    }

    fn read_authorized_chunk(&self, chunk: &AuthorizedAudioChunk) -> Result<Vec<u8>, String> {
        match chunk {
            AuthorizedAudioChunk::Committed(chunk) => {
                read_committed_mono_chunk(&self.root, &self.meeting_id, chunk)
            }
            #[cfg(test)]
            AuthorizedAudioChunk::Fixture { path, .. } => read_fixture_mono_chunk(path),
        }
    }

    #[cfg(test)]
    fn fixture_channel_chunks(
        &self,
        channel: &str,
        first_sequence: u64,
        _maximum_chunks: usize,
    ) -> Result<BTreeMap<u64, AuthorizedAudioChunk>, String> {
        let directory = self.root.join(&self.meeting_id).join("audio").join(channel);
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
            Err(error) => {
                return Err(format!(
                    "could not inspect durable {channel} audio chunks: {error}"
                ))
            }
        };
        let mut chunks = BTreeMap::new();
        for entry in entries {
            let entry = entry.map_err(|error| format!("could not inspect audio chunk: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("could not inspect audio chunk type: {error}"))?;
            if !file_type.is_file() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                return Err("audio chunk filename is not valid UTF-8".into());
            };
            let Some(stem) = name.strip_suffix(".f32le") else {
                continue;
            };
            if stem.len() != 8 || !stem.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(
                    "audio chunk filename does not use the canonical sequence format".into(),
                );
            }
            let sequence = stem
                .parse::<u64>()
                .map_err(|_| "audio chunk sequence is invalid".to_string())?;
            if sequence < first_sequence {
                continue;
            }
            if chunks
                .insert(
                    sequence,
                    AuthorizedAudioChunk::Fixture { path: entry.path() },
                )
                .is_some()
            {
                return Err(format!(
                    "durable {channel} audio contains duplicate sequence {sequence}"
                ));
            }
        }
        Ok(chunks)
    }
}

pub(super) fn read_committed_mono_chunk(
    root: &Path,
    meeting_id: &str,
    chunk: &AudioChunk,
) -> Result<Vec<u8>, String> {
    let definition = &chunk.definition;
    if chunk.status != AudioChunkStatus::Committed
        || chunk.committed_at.is_none()
        || chunk.integrity_error.is_some()
    {
        return Err("audio chunk is not a healthy committed database record".into());
    }
    if definition.meeting_id != meeting_id {
        return Err("audio chunk database authority belongs to another meeting".into());
    }
    validate_path_component(&definition.channel_id, "audio channel")?;
    let canonical_relative_path = format!(
        "{meeting_id}/audio/{}/{:08}.f32le",
        definition.channel_id, definition.sequence
    );
    if definition.relative_path != canonical_relative_path {
        return Err("audio chunk database path is not canonical".into());
    }
    let expected_byte_len = definition
        .sample_count
        .checked_mul(BYTES_PER_SAMPLE as u64)
        .ok_or_else(|| "audio chunk byte length overflow".to_string())?;
    if definition.byte_len != expected_byte_len
        || definition.byte_len == 0
        || definition.byte_len > MAX_MONO_CHUNK_BYTES as u64
    {
        return Err("audio chunk database length is invalid".into());
    }
    let expected_start_ms = definition
        .sequence
        .checked_mul(1_000)
        .ok_or_else(|| "audio chunk timestamp overflow".to_string())?;
    let expected_duration_ms = definition
        .sample_count
        .checked_mul(1_000)
        .ok_or_else(|| "audio chunk duration overflow".to_string())?
        / SAMPLE_RATE_HZ as u64;
    let expected_end_ms = expected_start_ms
        .checked_add(expected_duration_ms.max(1))
        .ok_or_else(|| "audio chunk timestamp overflow".to_string())?;
    if u64::try_from(definition.start_ms).ok() != Some(expected_start_ms)
        || u64::try_from(definition.end_ms).ok() != Some(expected_end_ms)
    {
        return Err("audio chunk database timestamps are invalid".into());
    }
    if definition.sha256.len() != 64
        || !definition
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("audio chunk database digest is invalid".into());
    }

    let mut file = open_committed_chunk_no_follow(
        root,
        meeting_id,
        &definition.channel_id,
        definition.sequence,
    )?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("could not inspect committed audio chunk: {error}"))?;
    if !metadata.is_file() || metadata.len() != definition.byte_len {
        return Err("committed audio chunk is not a regular file of the recorded length".into());
    }
    let read_limit = definition
        .byte_len
        .checked_add(1)
        .ok_or_else(|| "audio chunk read limit overflow".to_string())?;
    let mut bytes = Vec::with_capacity(definition.byte_len as usize);
    file.by_ref()
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read committed audio chunk: {error}"))?;
    if bytes.len() as u64 != definition.byte_len {
        return Err("committed audio chunk changed while it was being read".into());
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if !digest.eq_ignore_ascii_case(&definition.sha256) {
        return Err("committed audio chunk failed its database SHA-256 check".into());
    }
    Ok(bytes)
}

#[cfg(test)]
pub(super) fn read_fixture_mono_chunk(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("could not inspect durable audio chunk: {error}"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err("durable audio chunk is not a regular file".into());
    }
    let length = usize::try_from(metadata.len())
        .map_err(|_| "durable audio chunk is too large for this platform".to_string())?;
    if length == 0 || length > MAX_MONO_CHUNK_BYTES || length % BYTES_PER_SAMPLE != 0 {
        return Err("durable audio chunk has an invalid f32le length".into());
    }
    let bytes = fs::read(path).map_err(|error| format!("could not read durable audio: {error}"))?;
    if bytes.len() != length {
        return Err("durable audio chunk changed while it was being read".into());
    }
    Ok(bytes)
}

#[cfg(unix)]
pub(super) fn open_committed_chunk_no_follow(
    root: &Path,
    meeting_id: &str,
    channel_id: &str,
    sequence: u64,
) -> Result<File, String> {
    use std::{
        ffi::CString,
        os::fd::{AsRawFd, FromRawFd},
        os::unix::fs::OpenOptionsExt,
    };

    fn child(parent: &File, name: &str, flags: libc::c_int, kind: &str) -> Result<File, String> {
        let name = CString::new(name)
            .map_err(|_| format!("committed audio {kind} contains a NUL byte"))?;
        // SAFETY: `parent` remains open for this call, `name` is a valid
        // NUL-terminated C string, and no creation flag requiring a mode is
        // passed. Ownership of a successful descriptor moves into `File`.
        let descriptor = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if descriptor < 0 {
            return Err(format!(
                "could not open committed audio {kind} without following links: {}",
                io::Error::last_os_error()
            ));
        }
        // SAFETY: `openat` returned a fresh owned descriptor above.
        Ok(unsafe { File::from_raw_fd(descriptor) })
    }

    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let root = options.open(root).map_err(|error| {
        format!("could not open committed audio root without following links: {error}")
    })?;
    let directory_flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let meeting = child(&root, meeting_id, directory_flags, "meeting directory")?;
    let audio = child(&meeting, "audio", directory_flags, "audio directory")?;
    let channel = child(&audio, channel_id, directory_flags, "channel directory")?;
    child(
        &channel,
        &format!("{sequence:08}.f32le"),
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        "chunk",
    )
}

#[cfg(not(unix))]
pub(super) fn open_committed_chunk_no_follow(
    _root: &Path,
    _meeting_id: &str,
    _channel_id: &str,
    _sequence: u64,
) -> Result<File, String> {
    Err("secure committed audio reads are unavailable on this platform".into())
}

pub(super) fn interleave_f32le(microphone: &[u8], system: &[u8]) -> Result<Vec<u8>, String> {
    if !microphone.len().is_multiple_of(BYTES_PER_SAMPLE)
        || !system.len().is_multiple_of(BYTES_PER_SAMPLE)
    {
        return Err("audio channel is not aligned to f32le samples".into());
    }
    let samples = (microphone.len().max(system.len())) / BYTES_PER_SAMPLE;
    let output_len = samples
        .checked_mul(CHANNELS as usize)
        .and_then(|count| count.checked_mul(BYTES_PER_SAMPLE))
        .ok_or_else(|| "interleaved audio frame size overflow".to_string())?;
    if output_len > MAX_INTERLEAVED_CHUNK_BYTES {
        return Err("interleaved audio frame exceeds the protocol limit".into());
    }
    let silence = 0_f32.to_le_bytes();
    let mut output = Vec::with_capacity(output_len);
    for index in 0..samples {
        for channel in [microphone, system] {
            let offset = index * BYTES_PER_SAMPLE;
            if let Some(sample) = channel.get(offset..offset + BYTES_PER_SAMPLE) {
                output.extend_from_slice(sample);
            } else {
                output.extend_from_slice(&silence);
            }
        }
    }
    Ok(output)
}
