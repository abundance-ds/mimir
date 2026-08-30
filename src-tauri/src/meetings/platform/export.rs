use super::*;

impl NativeMeetingPlatform {
    pub(super) fn render_markdown(&self, meeting_id: &str) -> Result<String, String> {
        let meeting = self
            .inner
            .store
            .get_meeting(meeting_id)
            .map_err(|error| error.to_string())?;
        let transcript = self
            .inner
            .store
            .transcript_snapshot(meeting_id, None)
            .map_err(|error| error.to_string())?;
        let content = self.load_content(meeting_id)?;
        let title = content.title.as_deref().unwrap_or(&meeting.title);
        let mut markdown = format!("# {}\n\n", escape_markdown_heading(title));
        if let Some(summary) = content.summary.as_deref() {
            markdown.push_str("## Summary\n\n");
            markdown.push_str(summary.trim());
            markdown.push_str("\n\n");
        }
        if !content.tags.is_empty() {
            markdown.push_str("Tags: ");
            markdown.push_str(
                &content
                    .tags
                    .iter()
                    .map(|tag| format!("`{}`", tag.replace('`', "\\`")))
                    .collect::<Vec<_>>()
                    .join(", "),
            );
            markdown.push_str("\n\n");
        }
        markdown.push_str("## Transcript\n\n");
        for segment in readable_transcript_segments(&transcript.segments, &transcript.gaps) {
            markdown.push_str(&format!(
                "**{} · {}**  \n{}\n\n",
                format_timestamp(segment.start_ms),
                segment.speaker,
                segment.text
            ));
        }
        if !transcript.gaps.is_empty() {
            markdown.push_str("## Recording gaps\n\n");
            for gap in transcript.gaps {
                markdown.push_str(&format!(
                    "- {}–{}: {}\n",
                    format_timestamp(gap.gap.start_ms),
                    format_timestamp(gap.gap.end_ms),
                    gap.gap.reason
                ));
            }
        }
        Ok(markdown)
    }

    pub(super) fn export_markdown(&self, meeting_id: &str) -> Result<MeetingExport, String> {
        let markdown = self.render_markdown(meeting_id)?;
        let path = self.unique_export_path(meeting_id, "md")?;
        write_private_bytes_atomic(&path, markdown.as_bytes())
            .map_err(|error| error.to_string())?;
        Ok(MeetingExport {
            format: "markdown".into(),
            path: path.to_string_lossy().into_owned(),
        })
    }

    pub(super) fn export_files(&self, meeting_id: &str) -> Result<MeetingExport, String> {
        validate_component(meeting_id, "meeting id")?;
        let markdown = self.render_markdown(meeting_id)?;
        let meeting_root = ensure_private_subdirectory(&self.inner.paths.meetings_root, meeting_id)
            .map_err(|error| format!("Could not resolve private meeting directory: {error}"))?;
        let markdown_path = prepare_private_file_path(&meeting_root, "meeting.md")
            .map_err(|error| format!("Could not resolve meeting Markdown path: {error}"))?;
        write_private_bytes_atomic(&markdown_path, markdown.as_bytes())
            .map_err(|error| error.to_string())?;
        Ok(MeetingExport {
            format: "files".into(),
            path: meeting_root.to_string_lossy().into_owned(),
        })
    }

    pub(super) fn export_json(&self, meeting_id: &str) -> Result<MeetingExport, String> {
        let meeting = self
            .inner
            .store
            .get_meeting(meeting_id)
            .map_err(|error| error.to_string())?;
        let transcript = self
            .inner
            .store
            .transcript_snapshot(meeting_id, None)
            .map_err(|error| error.to_string())?;
        let content = self.load_content(meeting_id)?;
        let document = serde_json::json!({
            "schemaVersion": 1,
            "meeting": meeting,
            "content": content,
            "transcript": transcript,
        });
        let path = self.unique_export_path(meeting_id, "json")?;
        write_private_json_atomic(&path, &document).map_err(|error| error.to_string())?;
        Ok(MeetingExport {
            format: "json".into(),
            path: path.to_string_lossy().into_owned(),
        })
    }

    pub(super) fn export_audio(&self, meeting_id: &str) -> Result<MeetingExport, String> {
        validate_component(meeting_id, "meeting id")?;
        let meeting = self
            .inner
            .store
            .get_meeting(meeting_id)
            .map_err(|error| error.to_string())?;
        if matches!(
            meeting.status,
            crate::meetings::MeetingStatus::Detected
                | crate::meetings::MeetingStatus::Recording
                | crate::meetings::MeetingStatus::Stopping
                | crate::meetings::MeetingStatus::Finalizing
        ) {
            return Err(
                "Audio export requires the meeting recording to be stopped and finalized".into(),
            );
        }
        let source_root = safe_direct_child(&self.inner.paths.meetings_root, meeting_id)?;
        if !source_root.exists() {
            return Err(format!(
                "Meeting '{meeting_id}' has no recorded audio artifacts to export"
            ));
        }
        reject_symlink(&source_root)?;
        let export_name = format!("{meeting_id}-audio-{}", Uuid::new_v4());
        let final_path = safe_direct_child(&self.inner.paths.exports_root, &export_name)?;
        let pending_path = safe_direct_child(
            &self.inner.paths.exports_root,
            &format!(".{export_name}.part"),
        )?;
        create_private_new_directory(&pending_path)?;
        let mut pending_guard = PendingPath::directory(pending_path.clone());
        let mut copied = 0_u64;
        for name in ["audio", "microphone", "system"] {
            copied +=
                copy_path_without_symlinks(&source_root.join(name), &pending_path.join(name))?;
        }
        for name in [
            "recording.wav",
            "recording.flac",
            "recording.m4a",
            "recording.aac",
        ] {
            copied +=
                copy_path_without_symlinks(&source_root.join(name), &pending_path.join(name))?;
        }
        if copied == 0 {
            let _ = fs::remove_dir_all(&pending_path);
            return Err(format!(
                "Meeting '{meeting_id}' has no recorded audio artifacts to export"
            ));
        }
        sync_tree(&pending_path)?;
        fs::rename(&pending_path, &final_path)
            .map_err(|error| format!("Could not atomically publish audio export: {error}"))?;
        pending_guard.disarm();
        sync_directory(&self.inner.paths.exports_root)?;
        Ok(MeetingExport {
            format: "audio".into(),
            path: final_path.to_string_lossy().into_owned(),
        })
    }

    pub(super) fn unique_export_path(
        &self,
        meeting_id: &str,
        extension: &str,
    ) -> Result<PathBuf, String> {
        validate_component(meeting_id, "meeting id")?;
        validate_component(extension, "export extension")?;
        let name = format!("{meeting_id}-{}.{}", Uuid::new_v4(), extension);
        prepare_private_file_path(&self.inner.paths.exports_root, name)
            .map_err(|error| format!("Could not resolve private meeting export path: {error}"))
    }
}
