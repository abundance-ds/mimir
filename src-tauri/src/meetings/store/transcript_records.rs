use super::*;

pub(super) trait Queryable {
    fn prepare_query<'a>(&'a self, sql: &str) -> rusqlite::Result<rusqlite::Statement<'a>>;
}

impl Queryable for Connection {
    fn prepare_query<'a>(&'a self, sql: &str) -> rusqlite::Result<rusqlite::Statement<'a>> {
        self.prepare(sql)
    }
}

impl Queryable for Transaction<'_> {
    fn prepare_query<'a>(&'a self, sql: &str) -> rusqlite::Result<rusqlite::Statement<'a>> {
        self.prepare(sql)
    }
}

pub(super) fn load_channels<Q: Queryable>(
    queryable: &Q,
    meeting_id: &str,
) -> Result<Vec<AudioChannel>, MeetingStoreError> {
    let mut statement = queryable.prepare_query(
        "SELECT id,kind,sample_rate_hz,channels,sample_format,device_id,created_at
         FROM audio_channels WHERE meeting_id=?1 ORDER BY id",
    )?;
    let channels = statement
        .query_map([meeting_id], |row| {
            let kind: String = row.get(1)?;
            Ok(AudioChannel {
                definition: AudioChannelDraft {
                    id: row.get(0)?,
                    kind: channel_kind(&kind).map_err(text_from_sql_error)?,
                    sample_rate_hz: row.get(2)?,
                    channels: row.get(3)?,
                    sample_format: row.get(4)?,
                    device_id: row.get(5)?,
                },
                created_at: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(channels)
}

pub(super) fn load_segments_at(
    connection: &Connection,
    meeting_id: &str,
    revision: u64,
) -> Result<Vec<TranscriptSegmentRecord>, MeetingStoreError> {
    let mut statement = connection.prepare(
        "SELECT v.segment_id,v.start_ms,v.end_ms,v.text,v.channel_id,v.speaker,
                v.confidence,v.is_final,v.metadata_json,v.created_revision,v.revision
         FROM transcript_segment_versions v
         JOIN (
           SELECT segment_id,MAX(revision) AS revision
           FROM transcript_segment_versions
           WHERE meeting_id=?1 AND revision<=?2
           GROUP BY segment_id
         ) latest ON latest.segment_id=v.segment_id AND latest.revision=v.revision
         WHERE v.meeting_id=?1 AND v.operation='upsert'
         ORDER BY v.start_ms,v.end_ms,v.segment_id",
    )?;
    let segments = statement
        .query_map(params![meeting_id, to_i64(revision)?], |row| {
            let metadata: String = row.get(8)?;
            Ok(TranscriptSegmentRecord {
                segment: TranscriptSegmentInput {
                    id: row.get(0)?,
                    start_ms: row.get(1)?,
                    end_ms: row.get(2)?,
                    text: row.get(3)?,
                    channel_id: row.get(4)?,
                    speaker: row.get(5)?,
                    confidence: row.get(6)?,
                    is_final: row.get(7)?,
                    metadata: serde_json::from_str(&metadata).map_err(json_from_sql_error)?,
                },
                created_revision: row.get::<_, i64>(9)? as u64,
                updated_revision: row.get::<_, i64>(10)? as u64,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(segments)
}

pub(super) fn current_segment_from_row(row: &Row<'_>) -> rusqlite::Result<TranscriptSegmentRecord> {
    let metadata: String = row.get(8)?;
    Ok(TranscriptSegmentRecord {
        segment: TranscriptSegmentInput {
            id: row.get(0)?,
            start_ms: row.get(1)?,
            end_ms: row.get(2)?,
            text: row.get(3)?,
            channel_id: row.get(4)?,
            speaker: row.get(5)?,
            confidence: row.get(6)?,
            is_final: row.get(7)?,
            metadata: serde_json::from_str(&metadata).map_err(json_from_sql_error)?,
        },
        created_revision: row.get::<_, i64>(9)? as u64,
        updated_revision: row.get::<_, i64>(10)? as u64,
    })
}

pub(super) fn gap_from_row(row: &Row<'_>) -> rusqlite::Result<TranscriptGapRecord> {
    let reason: String = row.get(3)?;
    Ok(TranscriptGapRecord {
        gap: TranscriptGapInput {
            id: row.get(0)?,
            start_ms: row.get(1)?,
            end_ms: row.get(2)?,
            reason: gap_reason(&reason).map_err(text_from_sql_error)?,
            channel_id: row.get(4)?,
            detail: row.get(5)?,
        },
        created_revision: row.get::<_, i64>(6)? as u64,
        resolved_revision: row.get::<_, Option<i64>>(7)?.map(|value| value as u64),
    })
}

pub(super) fn load_gaps_at(
    connection: &Connection,
    meeting_id: &str,
    revision: u64,
) -> Result<Vec<TranscriptGapRecord>, MeetingStoreError> {
    let mut statement = connection.prepare(
        "SELECT gap_id,start_ms,end_ms,reason,channel_id,detail,
                created_revision,resolved_revision
         FROM transcript_gaps
         WHERE meeting_id=?1 AND created_revision<=?2
           AND (resolved_revision IS NULL OR resolved_revision>?2)
         ORDER BY start_ms,end_ms,gap_id",
    )?;
    let gaps = statement
        .query_map(params![meeting_id, to_i64(revision)?], |row| {
            let reason: String = row.get(3)?;
            Ok(TranscriptGapRecord {
                gap: TranscriptGapInput {
                    id: row.get(0)?,
                    start_ms: row.get(1)?,
                    end_ms: row.get(2)?,
                    reason: gap_reason(&reason).map_err(text_from_sql_error)?,
                    channel_id: row.get(4)?,
                    detail: row.get(5)?,
                },
                created_revision: row.get::<_, i64>(6)? as u64,
                // This snapshot contains only gaps unresolved at `revision`.
                // Do not leak a resolution that happened in a future revision.
                resolved_revision: None,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(gaps)
}
