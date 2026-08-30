use super::*;

impl ChatRuntime {
    pub async fn upload_path(&self, target: &str, path: &str) -> Result<ChatAttachment, String> {
        let path = PathBuf::from(path);
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Attachment filename is not valid UTF-8.".to_string())?;
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|error| format!("Could not read attachment: {error}"))?;
        self.upload_bytes(target, name, mime_for_filename(name), bytes)
            .await
    }

    pub async fn upload_base64(
        &self,
        target: &str,
        name: &str,
        mime: &str,
        data_base64: &str,
    ) -> Result<ChatAttachment, String> {
        let bytes = STANDARD
            .decode(data_base64)
            .map_err(|_| "Pasted attachment data is invalid.".to_string())?;
        self.upload_bytes(target, name, mime, bytes).await
    }

    async fn upload_bytes(
        &self,
        target: &str,
        name: &str,
        mime: &str,
        bytes: Vec<u8>,
    ) -> Result<ChatAttachment, String> {
        let target = normalize_target(target)?;
        let name = normalize_attachment_name(name)?;
        if bytes.is_empty() || bytes.len() > 25 * 1024 * 1024 {
            return Err("Attachments must be between 1 byte and 25 MB.".into());
        }
        let mime = normalize_mime(mime).unwrap_or_else(|| mime_for_filename(&name).into());
        let config = self.config()?;
        let password = load_credential(&self.inner.credential_path, &config)?
            .ok_or_else(|| "No saved chat passphrase was found.".to_string())?;
        let endpoint = attachment_collection_url(&config.endpoint)?;
        let expected_hash = format!("{:x}", Sha256::digest(&bytes));
        let response = reqwest::Client::new()
            .post(endpoint)
            .basic_auth(&config.account, Some(&password))
            .header("Content-Type", &mime)
            .header("X-Mimir-Filename", URL_SAFE_NO_PAD.encode(name.as_bytes()))
            .body(bytes)
            .send()
            .await
            .map_err(|error| format!("Attachment upload failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "Attachment upload failed with HTTP {}.",
                response.status().as_u16(),
            ));
        }
        let attachment = response
            .json::<ChatAttachment>()
            .await
            .map_err(|error| format!("Attachment service returned invalid metadata: {error}"))?;
        if attachment.name != name
            || attachment.mime != mime
            || attachment.sha256 != expected_hash
            || attachment.size == 0
        {
            return Err("Attachment service returned mismatched metadata.".into());
        }
        let line = attachment_message_line(&target, &attachment);
        if let Err(error) = self.queue_lines(vec![line]) {
            let _ = delete_remote_attachment(&config, &password, &attachment.url).await;
            return Err(error);
        }
        Ok(attachment)
    }

    pub async fn download_attachment(&self, file_id: &str) -> Result<ChatAttachment, String> {
        let file_id = validate_message_id(file_id)?;
        let attachment = self
            .inner
            .database
            .attachment(&file_id)?
            .ok_or_else(|| "That attachment is not in the local chat cache.".to_string())?;
        if attachment
            .local_path
            .as_deref()
            .is_some_and(|path| std::path::Path::new(path).is_file())
        {
            return Ok(attachment);
        }
        let config = self.config()?;
        let password = load_credential(&self.inner.credential_path, &config)?
            .ok_or_else(|| "No saved chat passphrase was found.".to_string())?;
        let response = reqwest::Client::new()
            .get(&attachment.url)
            .basic_auth(&config.account, Some(&password))
            .send()
            .await
            .map_err(|error| format!("Attachment download failed: {error}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "Attachment download failed with HTTP {}.",
                response.status().as_u16(),
            ));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("Could not read attachment download: {error}"))?;
        if bytes.len() as u64 != attachment.size
            || format!("{:x}", Sha256::digest(&bytes)) != attachment.sha256
        {
            return Err("Downloaded attachment failed its size or checksum check.".into());
        }
        let cache = self
            .inner
            .config_path
            .parent()
            .ok_or_else(|| "Chat cache directory is unavailable.".to_string())?
            .join("chat-files")
            .join(&attachment.id);
        fs::create_dir_all(&cache).map_err(|error| error.to_string())?;
        let path = cache.join(normalize_attachment_name(&attachment.name)?);
        crate::persistence::write_secret_bytes_atomic(&path, &bytes)
            .map_err(|error| error.to_string())?;
        self.inner
            .database
            .set_attachment_local_path(&attachment.id, &path.to_string_lossy())
    }

    pub fn open_attachment(&self, file_id: &str) -> Result<(), String> {
        let file_id = validate_message_id(file_id)?;
        let attachment = self
            .inner
            .database
            .attachment(&file_id)?
            .ok_or_else(|| "That attachment is not in the local chat cache.".to_string())?;
        let path = attachment
            .local_path
            .filter(|path| std::path::Path::new(path).is_file())
            .ok_or_else(|| "Download the attachment before opening it.".to_string())?;
        #[cfg(target_os = "macos")]
        let mut command = std::process::Command::new("open");
        #[cfg(target_os = "linux")]
        let mut command = std::process::Command::new("xdg-open");
        #[cfg(target_os = "windows")]
        let mut command = std::process::Command::new("explorer");
        command
            .arg(path)
            .spawn()
            .map_err(|error| format!("Could not open attachment: {error}"))?;
        Ok(())
    }

    pub fn attachment_preview(&self, file_id: &str) -> Result<String, String> {
        let file_id = validate_message_id(file_id)?;
        let attachment = self
            .inner
            .database
            .attachment(&file_id)?
            .ok_or_else(|| "That attachment is not in the local chat cache.".to_string())?;
        if !matches!(
            attachment.mime.as_str(),
            "image/png" | "image/jpeg" | "image/gif" | "image/webp"
        ) {
            return Err("That attachment does not have an inline image preview.".into());
        }
        if attachment.size > 10 * 1024 * 1024 {
            return Err("Image is too large for an inline preview.".into());
        }
        let path = attachment
            .local_path
            .filter(|path| std::path::Path::new(path).is_file())
            .ok_or_else(|| "Download the attachment before previewing it.".to_string())?;
        let bytes = fs::read(path).map_err(|error| error.to_string())?;
        if format!("{:x}", Sha256::digest(&bytes)) != attachment.sha256 {
            return Err("Cached attachment failed its checksum check.".into());
        }
        Ok(format!(
            "data:{};base64,{}",
            attachment.mime,
            STANDARD.encode(bytes),
        ))
    }
}
