use super::*;

impl MeetingStore {
    pub fn transcript_snapshot(
        &self,
        meeting_id: &str,
        revision: Option<u64>,
    ) -> Result<TranscriptSnapshot, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        let meeting = load_meeting(&connection, meeting_id)?;
        let target = revision.unwrap_or(meeting.transcript_revision);
        if target > meeting.transcript_revision {
            return Err(MeetingStoreError::RevisionConflict {
                meeting_id: meeting_id.into(),
                expected: target,
                actual: meeting.transcript_revision,
            });
        }
        Ok(TranscriptSnapshot {
            meeting_id: meeting_id.into(),
            revision: target,
            segments: load_segments_at(&connection, meeting_id, target)?,
            gaps: load_gaps_at(&connection, meeting_id, target)?,
        })
    }

    /// Read a bounded, keyset-paginated window from the current transcript.
    ///
    /// Pages are returned in presentation order, while the query walks the
    /// durable index newest-first. A cursor is stable when new live segments
    /// arrive and therefore cannot duplicate or skip older rows due to offset
    /// shifts.
    pub fn transcript_page(
        &self,
        meeting_id: &str,
        before: Option<&TranscriptPageCursor>,
        limit: u32,
    ) -> Result<TranscriptPage, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        if let Some(cursor) = before {
            validate_id(&cursor.segment_id, "transcript cursor segment id")
                .map_err(MeetingStoreError::Validation)?;
            if cursor.start_ms < 0 || cursor.end_ms <= cursor.start_ms {
                return Err(MeetingStoreError::Validation(
                    "transcript cursor has an invalid time range".into(),
                ));
            }
        }
        let limit = limit.clamp(1, MAX_TRANSCRIPT_PAGE_SEGMENTS);
        let connection = self.lock()?;
        let meeting = load_meeting(&connection, meeting_id)?;
        let total_segments = connection.query_row(
            "SELECT COUNT(*) FROM transcript_segments WHERE meeting_id=?1",
            [meeting_id],
            |row| row.get::<_, i64>(0),
        )? as u64;
        let before_start = before.map(|cursor| cursor.start_ms);
        let before_end = before.map(|cursor| cursor.end_ms);
        let before_id = before.map(|cursor| cursor.segment_id.as_str());
        let mut statement = connection.prepare(
            "SELECT segment_id,start_ms,end_ms,text,channel_id,speaker,confidence,
                    is_final,metadata_json,created_revision,updated_revision
             FROM transcript_segments
             WHERE meeting_id=?1
               AND (
                 ?2 IS NULL
                 OR start_ms < ?2
                 OR (start_ms=?2 AND end_ms < ?3)
                 OR (start_ms=?2 AND end_ms=?3 AND segment_id < ?4)
               )
             ORDER BY start_ms DESC,end_ms DESC,segment_id DESC
             LIMIT ?5",
        )?;
        let mut segments = statement
            .query_map(
                params![
                    meeting_id,
                    before_start,
                    before_end,
                    before_id,
                    i64::from(limit) + 1
                ],
                current_segment_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = segments.len() > limit as usize;
        segments.truncate(limit as usize);
        let next_before =
            has_more
                .then(|| segments.last())
                .flatten()
                .map(|segment| TranscriptPageCursor {
                    start_ms: segment.segment.start_ms,
                    end_ms: segment.segment.end_ms,
                    segment_id: segment.segment.id.clone(),
                });
        segments.reverse();
        Ok(TranscriptPage {
            meeting_id: meeting_id.into(),
            revision: meeting.transcript_revision,
            total_segments,
            has_more,
            next_before,
            segments,
        })
    }

    /// Backward-compatible chronological slice for bounded agent reads.
    ///
    /// Renderer navigation uses keyset pagination above. This offset form is
    /// deliberately capped by callers and exists for the established
    /// `meetings_get` tool contract.
    pub fn transcript_slice(
        &self,
        meeting_id: &str,
        offset: u64,
        limit: u32,
    ) -> Result<TranscriptPage, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let offset = i64::try_from(offset).map_err(|_| {
            MeetingStoreError::Validation("transcript offset exceeds the durable range".into())
        })?;
        let limit = limit.clamp(1, MAX_TRANSCRIPT_PAGE_SEGMENTS);
        let connection = self.lock()?;
        let meeting = load_meeting(&connection, meeting_id)?;
        let total_segments = connection.query_row(
            "SELECT COUNT(*) FROM transcript_segments WHERE meeting_id=?1",
            [meeting_id],
            |row| row.get::<_, i64>(0),
        )? as u64;
        let mut statement = connection.prepare(
            "SELECT segment_id,start_ms,end_ms,text,channel_id,speaker,confidence,
                    is_final,metadata_json,created_revision,updated_revision
             FROM transcript_segments
             WHERE meeting_id=?1
             ORDER BY start_ms,end_ms,segment_id
             LIMIT ?2 OFFSET ?3",
        )?;
        let segments = statement
            .query_map(
                params![meeting_id, i64::from(limit), offset],
                current_segment_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let returned = segments.len() as u64;
        Ok(TranscriptPage {
            meeting_id: meeting_id.into(),
            revision: meeting.transcript_revision,
            total_segments,
            has_more: (offset as u64).saturating_add(returned) < total_segments,
            next_before: None,
            segments,
        })
    }

    pub fn transcript_slice_since(
        &self,
        meeting_id: &str,
        since_ms: i64,
        limit: u32,
    ) -> Result<TranscriptPage, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let limit = limit.clamp(1, MAX_TRANSCRIPT_PAGE_SEGMENTS);
        let connection = self.lock()?;
        let meeting = load_meeting(&connection, meeting_id)?;
        let total_segments = connection.query_row(
            "SELECT COUNT(*) FROM transcript_segments WHERE meeting_id=?1",
            [meeting_id],
            |row| row.get::<_, i64>(0),
        )? as u64;
        let matching_segments = connection.query_row(
            "SELECT COUNT(*) FROM transcript_segments WHERE meeting_id=?1 AND start_ms>=?2",
            params![meeting_id, since_ms],
            |row| row.get::<_, i64>(0),
        )? as u64;
        let mut statement = connection.prepare(
            "SELECT segment_id,start_ms,end_ms,text,channel_id,speaker,confidence,
                    is_final,metadata_json,created_revision,updated_revision
             FROM transcript_segments
             WHERE meeting_id=?1 AND start_ms>=?2
             ORDER BY start_ms,end_ms,segment_id
             LIMIT ?3",
        )?;
        let segments = statement
            .query_map(
                params![meeting_id, since_ms, i64::from(limit)],
                current_segment_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let returned = segments.len() as u64;
        Ok(TranscriptPage {
            meeting_id: meeting_id.into(),
            revision: meeting.transcript_revision,
            total_segments,
            has_more: returned < matching_segments,
            next_before: None,
            segments,
        })
    }

    /// Return only the bounded transcript metadata required by a library row.
    pub fn transcript_overview(
        &self,
        meeting_id: &str,
        gap_limit: u32,
    ) -> Result<TranscriptOverview, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        let meeting = load_meeting(&connection, meeting_id)?;
        let is_final = connection
            .query_row(
                "SELECT marks_final FROM transcript_revisions
                 WHERE meeting_id=?1 AND revision=?2",
                params![meeting_id, to_i64(meeting.transcript_revision)?],
                |row| row.get::<_, bool>(0),
            )
            .optional()?
            .unwrap_or(false);
        let (segment_count, non_final_segment_count) = connection.query_row(
            "SELECT COUNT(*),COALESCE(SUM(CASE WHEN is_final=0 THEN 1 ELSE 0 END),0)
             FROM transcript_segments WHERE meeting_id=?1",
            [meeting_id],
            |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64)),
        )?;
        let unresolved_gap_count = connection.query_row(
            "SELECT COUNT(*) FROM transcript_gaps
             WHERE meeting_id=?1 AND resolved_revision IS NULL",
            [meeting_id],
            |row| row.get::<_, i64>(0),
        )? as u64;
        let mut statement = connection.prepare(
            "SELECT gap_id,start_ms,end_ms,reason,channel_id,detail,
                    created_revision,resolved_revision
             FROM transcript_gaps
             WHERE meeting_id=?1 AND resolved_revision IS NULL
             ORDER BY start_ms DESC,end_ms DESC,gap_id DESC
             LIMIT ?2",
        )?;
        let mut gaps = statement
            .query_map(params![meeting_id, gap_limit.clamp(1, 100)], gap_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        gaps.reverse();
        Ok(TranscriptOverview {
            revision: meeting.transcript_revision,
            is_final,
            segment_count,
            non_final_segment_count,
            unresolved_gap_count,
            gaps,
        })
    }

    pub fn search_transcript(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<TranscriptSearchHit>, MeetingStoreError> {
        let query = query.trim();
        if query.is_empty() {
            return Err(MeetingStoreError::Validation(
                "transcript search query cannot be empty".into(),
            ));
        }
        let phrase = format!("\"{}\"", query.replace('"', "\"\""));
        let connection = self.lock()?;
        let mut statement = connection.prepare(
            "WITH ranked AS (
               SELECT s.meeting_id,s.segment_id,s.start_ms,s.text,
                      ROW_NUMBER() OVER (
                        PARTITION BY s.meeting_id
                        ORDER BY s.start_ms,s.end_ms,s.segment_id
                      ) AS meeting_rank
               FROM transcript_segments_fts f
               JOIN transcript_segments s
                 ON s.meeting_id=f.meeting_id AND s.segment_id=f.segment_id
               JOIN meetings m ON m.id=s.meeting_id
               WHERE transcript_segments_fts MATCH ?1
                 AND m.status IN ('completed','interrupted','failed')
                 AND NOT EXISTS (
                   SELECT 1 FROM meeting_deletions d
                   WHERE d.meeting_id=s.meeting_id AND d.mode='all'
                 )
             )
             SELECT meeting_id,segment_id,start_ms,text
             FROM ranked
             WHERE meeting_rank<=3
             ORDER BY (
               SELECT created_at FROM meetings WHERE id=ranked.meeting_id
             ) DESC,meeting_id DESC,start_ms,segment_id
             LIMIT ?2",
        )?;
        let hits = statement
            .query_map(params![phrase, limit.clamp(1, 300)], |row| {
                Ok(TranscriptSearchHit {
                    meeting_id: row.get(0)?,
                    segment_id: row.get(1)?,
                    start_ms: row.get(2)?,
                    text: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(hits)
    }

    /// Atomically synchronize the private reviewed-content search authority.
    ///
    /// The JSON review document remains the human-editable projection. This
    /// transaction owns the queryable copy, including its trigram index, so a
    /// search never walks an unbounded content directory.
    pub fn sync_content_search(
        &self,
        meeting_id: &str,
        title: &str,
        summary: Option<&str>,
        tags: &[String],
        deleted: bool,
        content_fingerprint: &str,
    ) -> Result<(), MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let title = title.trim();
        if title.is_empty() {
            return Err(MeetingStoreError::Validation(
                "meeting search title cannot be empty".into(),
            ));
        }
        if title.chars().count() > MAX_TITLE_CHARS {
            return Err(MeetingStoreError::Validation(
                "meeting search title exceeds the durable limit".into(),
            ));
        }
        if summary.is_some_and(|value| value.len() > MAX_INDEXED_SUMMARY_BYTES) {
            return Err(MeetingStoreError::Validation(
                "meeting search summary exceeds the durable limit".into(),
            ));
        }
        if tags.len() > MAX_INDEXED_TAGS
            || tags.iter().any(|tag| {
                tag.trim().is_empty()
                    || tag.len() > MAX_INDEXED_TAG_BYTES
                    || tag.chars().any(char::is_control)
            })
        {
            return Err(MeetingStoreError::Validation(
                "meeting search tags exceed the durable limits".into(),
            ));
        }
        if content_fingerprint.is_empty()
            || content_fingerprint.len() > 512
            || content_fingerprint.chars().any(char::is_control)
        {
            return Err(MeetingStoreError::Validation(
                "meeting content fingerprint is invalid".into(),
            ));
        }
        let tags_json = json(tags)?;
        let tags_text = tags.join("\n");
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_meeting(&transaction, meeting_id)?;
        transaction.execute(
            "INSERT INTO meeting_content_search (
               meeting_id,title,summary,tags_json,tags_text,deleted,content_fingerprint
             ) VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(meeting_id) DO UPDATE SET
               title=excluded.title,
               summary=excluded.summary,
               tags_json=excluded.tags_json,
               tags_text=excluded.tags_text,
               deleted=excluded.deleted,
               content_fingerprint=excluded.content_fingerprint",
            params![
                meeting_id,
                title,
                summary.unwrap_or_default(),
                tags_json,
                tags_text,
                deleted,
                content_fingerprint
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn content_search_fingerprint(
        &self,
        meeting_id: &str,
    ) -> Result<Option<String>, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        require_meeting(&connection, meeting_id)?;
        connection
            .query_row(
                "SELECT content_fingerprint FROM meeting_content_search
                 WHERE meeting_id=?1",
                [meeting_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    /// Search every durable reviewed title, full summary, and tag.
    ///
    /// Queries use the FTS5 trigram index for true substring matching. The
    /// three-character minimum is deliberate: shorter terms cannot use the
    /// index and would require reading arbitrarily many multi-megabyte
    /// summaries while holding the meeting operation boundary.
    pub fn search_content(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<MeetingContentSearchHit>, MeetingStoreError> {
        let query = query.trim();
        if query.is_empty() {
            return Err(MeetingStoreError::Validation(
                "meeting content search query cannot be empty".into(),
            ));
        }
        if query.len() > MAX_CONTENT_SEARCH_QUERY_BYTES {
            return Err(MeetingStoreError::Validation(
                "meeting content search query exceeds the durable limit".into(),
            ));
        }
        if query.chars().count() < 3 {
            return Err(MeetingStoreError::Validation(
                "meeting content search query must contain at least 3 characters".into(),
            ));
        }
        let limit = limit.clamp(1, 100);
        let normalized = query.to_lowercase();
        let connection = self.lock()?;
        let phrase = format!("\"{}\"", query.replace('"', "\"\""));
        let mut statement = connection.prepare(
            "WITH field_matches AS (
               SELECT meeting_id,1 AS title_match,0 AS summary_match,0 AS tags_match
               FROM meeting_content_search_fts WHERE title MATCH ?1
               UNION ALL
               SELECT meeting_id,0,1,0
               FROM meeting_content_search_fts WHERE summary MATCH ?1
               UNION ALL
               SELECT meeting_id,0,0,1
               FROM meeting_content_search_fts WHERE tags MATCH ?1
             ),
             grouped AS (
               SELECT meeting_id,
                      MAX(title_match) AS title_match,
                      MAX(summary_match) AS summary_match,
                      MAX(tags_match) AS tags_match
               FROM field_matches GROUP BY meeting_id
             )
             SELECT g.meeting_id,g.title_match,g.summary_match,g.tags_match,
                    c.title,c.tags_json
             FROM grouped g
             JOIN meeting_content_search c ON c.meeting_id=g.meeting_id
             JOIN meetings m ON m.id=g.meeting_id
             WHERE c.deleted=0
               AND m.status IN ('completed','interrupted','failed')
               AND NOT EXISTS (
                 SELECT 1 FROM meeting_deletions d
                 WHERE d.meeting_id=g.meeting_id AND d.mode='all'
               )
             ORDER BY m.created_at DESC,m.id DESC",
        )?;
        let rows = statement.query_map([phrase], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, bool>(1)?,
                row.get::<_, bool>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;
        let mut hits = Vec::with_capacity(limit as usize);
        for row in rows {
            let (
                meeting_id,
                indexed_title_match,
                summary_match,
                indexed_tags_match,
                title,
                tags_json,
            ) = row?;
            let tags: Vec<String> = serde_json::from_str(&tags_json)?;
            // Recheck bounded title/tag values with Rust's Unicode lowercase
            // semantics and reject a theoretical cross-tag trigram match.
            let title_match = indexed_title_match && title.to_lowercase().contains(&normalized);
            let tags_match = indexed_tags_match
                && tags
                    .iter()
                    .any(|tag| tag.to_lowercase().contains(&normalized));
            if title_match || summary_match || tags_match {
                hits.push(MeetingContentSearchHit {
                    meeting_id,
                    title_match,
                    summary_match,
                    tags_match,
                });
                if hits.len() == limit as usize {
                    break;
                }
            }
        }
        Ok(hits)
    }

    pub fn transcript_revisions(
        &self,
        meeting_id: &str,
    ) -> Result<Vec<TranscriptRevision>, MeetingStoreError> {
        validate_id(meeting_id, "meeting id").map_err(MeetingStoreError::Validation)?;
        let connection = self.lock()?;
        require_meeting(&connection, meeting_id)?;
        let mut statement = connection.prepare(
            "SELECT meeting_id,revision,base_revision,batch_id,source,observed_at,marks_final
             FROM transcript_revisions WHERE meeting_id=?1 ORDER BY revision",
        )?;
        let rows = statement
            .query_map([meeting_id], |row| {
                Ok(TranscriptRevision {
                    meeting_id: row.get(0)?,
                    revision: row.get::<_, i64>(1)? as u64,
                    base_revision: row.get::<_, i64>(2)? as u64,
                    batch_id: row.get(3)?,
                    source: row.get(4)?,
                    observed_at: row.get(5)?,
                    marks_final: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}
