use super::*;

pub(super) fn require_collecting_repair_tx(
    transaction: &Transaction<'_>,
    meeting_id: &str,
    capture_generation: &str,
    provider_run_id: &str,
) -> Result<(), MeetingStoreError> {
    let (state, _) =
        require_repair_tx(transaction, meeting_id, capture_generation, provider_run_id)?;
    if state != "collecting" {
        return Err(MeetingStoreError::Validation(format!(
            "transcript repair '{meeting_id}:{capture_generation}' is already committed"
        )));
    }
    Ok(())
}

pub(super) fn require_repair_tx(
    transaction: &Transaction<'_>,
    meeting_id: &str,
    capture_generation: &str,
    provider_run_id: &str,
) -> Result<(String, Option<i64>), MeetingStoreError> {
    let repair = transaction
        .query_row(
            "SELECT provider_run_id,state,terminal_revision
             FROM transcript_repair_runs
             WHERE meeting_id=?1 AND capture_generation=?2",
            params![meeting_id, capture_generation],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found("transcript repair", capture_generation))?;
    if repair.0 != provider_run_id {
        return Err(MeetingStoreError::IdempotencyConflict {
            key: format!("{meeting_id}:{capture_generation}"),
        });
    }
    Ok((repair.1, repair.2))
}

pub(super) fn insert_channel(
    transaction: &Transaction<'_>,
    meeting_id: &str,
    channel: &AudioChannelDraft,
    observed_at: &str,
) -> Result<(), MeetingStoreError> {
    transaction.execute(
        "INSERT INTO audio_channels (
           meeting_id,id,kind,sample_rate_hz,channels,sample_format,device_id,created_at
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            meeting_id,
            channel.id,
            channel.kind.to_string(),
            channel.sample_rate_hz,
            channel.channels,
            channel.sample_format,
            channel.device_id,
            observed_at
        ],
    )?;
    Ok(())
}

pub(super) fn apply_transcript_change(
    transaction: &Transaction<'_>,
    meeting_id: &str,
    revision: u64,
    change: &TranscriptChange,
) -> Result<(), MeetingStoreError> {
    match change {
        TranscriptChange::UpsertSegment { segment } => {
            if let Some(channel_id) = &segment.channel_id {
                require_channel_tx(transaction, meeting_id, channel_id)?;
            }
            let created_revision: Option<i64> = transaction
                .query_row(
                    "SELECT created_revision FROM transcript_segment_versions
                     WHERE meeting_id=?1 AND segment_id=?2
                     ORDER BY revision DESC LIMIT 1",
                    params![meeting_id, segment.id],
                    |row| row.get(0),
                )
                .optional()?;
            let created_revision = created_revision
                .map(|value| from_i64(value, "created transcript revision"))
                .transpose()?
                .unwrap_or(revision);
            let metadata = json(segment.metadata.clone())?;
            transaction.execute(
                "INSERT INTO transcript_segment_versions (
                   meeting_id,segment_id,revision,operation,start_ms,end_ms,text,
                   channel_id,speaker,confidence,is_final,metadata_json,created_revision
                 ) VALUES (?1,?2,?3,'upsert',?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![
                    meeting_id,
                    segment.id,
                    to_i64(revision)?,
                    segment.start_ms,
                    segment.end_ms,
                    segment.text,
                    segment.channel_id,
                    segment.speaker,
                    segment.confidence,
                    segment.is_final,
                    metadata,
                    to_i64(created_revision)?
                ],
            )?;
            transaction.execute(
                "INSERT INTO transcript_segments (
                   meeting_id,segment_id,start_ms,end_ms,text,channel_id,speaker,
                   confidence,is_final,metadata_json,created_revision,updated_revision
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
                 ON CONFLICT(meeting_id,segment_id) DO UPDATE SET
                   start_ms=excluded.start_ms,end_ms=excluded.end_ms,text=excluded.text,
                   channel_id=excluded.channel_id,speaker=excluded.speaker,
                   confidence=excluded.confidence,is_final=excluded.is_final,
                   metadata_json=excluded.metadata_json,updated_revision=excluded.updated_revision",
                params![
                    meeting_id,
                    segment.id,
                    segment.start_ms,
                    segment.end_ms,
                    segment.text,
                    segment.channel_id,
                    segment.speaker,
                    segment.confidence,
                    segment.is_final,
                    json(segment.metadata.clone())?,
                    to_i64(created_revision)?,
                    to_i64(revision)?
                ],
            )?;
        }
        TranscriptChange::DeleteSegment { segment_id } => {
            let created_revision: i64 = transaction
                .query_row(
                    "SELECT created_revision FROM transcript_segments
                     WHERE meeting_id=?1 AND segment_id=?2",
                    params![meeting_id, segment_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| not_found("transcript segment", segment_id))?;
            transaction.execute(
                "INSERT INTO transcript_segment_versions (
                   meeting_id,segment_id,revision,operation,created_revision
                 ) VALUES (?1,?2,?3,'delete',?4)",
                params![meeting_id, segment_id, to_i64(revision)?, created_revision],
            )?;
            transaction.execute(
                "DELETE FROM transcript_segments WHERE meeting_id=?1 AND segment_id=?2",
                params![meeting_id, segment_id],
            )?;
        }
        TranscriptChange::OpenGap { gap } => {
            if let Some(channel_id) = &gap.channel_id {
                require_channel_tx(transaction, meeting_id, channel_id)?;
            }
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM transcript_gaps WHERE meeting_id=?1 AND gap_id=?2
                 )",
                params![meeting_id, gap.id],
                |row| row.get(0),
            )?;
            if exists {
                return Err(MeetingStoreError::IdempotencyConflict {
                    key: gap.id.clone(),
                });
            }
            transaction.execute(
                "INSERT INTO transcript_gaps (
                   meeting_id,gap_id,start_ms,end_ms,reason,channel_id,detail,created_revision
                 ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    meeting_id,
                    gap.id,
                    gap.start_ms,
                    gap.end_ms,
                    gap.reason.to_string(),
                    gap.channel_id,
                    gap.detail,
                    to_i64(revision)?
                ],
            )?;
        }
        TranscriptChange::ResolveGap { gap_id } => {
            let open: bool = transaction
                .query_row(
                    "SELECT resolved_revision IS NULL FROM transcript_gaps
                     WHERE meeting_id=?1 AND gap_id=?2",
                    params![meeting_id, gap_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| not_found("transcript gap", gap_id))?;
            if !open {
                return Err(MeetingStoreError::Validation(format!(
                    "transcript gap '{gap_id}' is already resolved"
                )));
            }
            transaction.execute(
                "UPDATE transcript_gaps SET resolved_revision=?3
                 WHERE meeting_id=?1 AND gap_id=?2",
                params![meeting_id, gap_id, to_i64(revision)?],
            )?;
        }
    }
    Ok(())
}
