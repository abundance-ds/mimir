use super::*;

pub(super) fn human_lines(target: &str, text: &str, reply_to: Option<&str>) -> Vec<String> {
    if !text.contains('\n') && text.len() <= IRC_CHUNK_BYTES {
        return vec![format!(
            "{}PRIVMSG {target} :{text}",
            tags_prefix(reply_to, None, None)
        )];
    }
    let batch = format!("mimir{}", uuid::Uuid::new_v4().simple());
    let opening_tags = tags_prefix(reply_to, None, None);
    let mut lines = vec![format!(
        "{opening_tags}BATCH +{batch} draft/multiline {target}"
    )];
    for (body, concatenate) in multiline_chunks(text) {
        let concat = if concatenate {
            "draft/multiline-concat;"
        } else {
            ""
        };
        lines.push(format!("@{concat}batch={batch} PRIVMSG {target} :{body}"));
    }
    lines.push(format!("BATCH -{batch}"));
    lines
}

pub(super) fn attachment_message_line(target: &str, attachment: &ChatAttachment) -> String {
    let tags = [
        format!("+abundanceds.com/file={}", irc_tag_value(&attachment.id)),
        format!(
            "+abundanceds.com/file-name={}",
            irc_tag_value(&attachment.name),
        ),
        format!("+abundanceds.com/file-size={}", attachment.size),
        format!(
            "+abundanceds.com/file-type={}",
            irc_tag_value(&attachment.mime),
        ),
        format!(
            "+abundanceds.com/file-sha256={}",
            irc_tag_value(&attachment.sha256),
        ),
    ]
    .join(";");
    format!("@{tags} PRIVMSG {target} :📎 {}", attachment.name)
}

pub(super) async fn delete_remote_attachment(
    config: &ChatConfig,
    password: &str,
    url: &str,
) -> Result<(), String> {
    let response = reqwest::Client::new()
        .delete(url)
        .basic_auth(&config.account, Some(password))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() || response.status() == reqwest::StatusCode::NOT_FOUND {
        Ok(())
    } else {
        Err(format!("HTTP {}", response.status().as_u16()))
    }
}

pub(super) fn attachment_collection_url(endpoint: &str) -> Result<String, String> {
    let mut url = Url::parse(endpoint).map_err(|error| error.to_string())?;
    url.set_scheme(if url.scheme() == "wss" {
        "https"
    } else {
        "http"
    })
    .map_err(|_| "Invalid chat endpoint scheme.".to_string())?;
    url.set_path("/files");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

pub(super) fn normalize_attachment_name(value: &str) -> Result<String, String> {
    let name = std::path::Path::new(value)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .trim();
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.len() > 240
        || name.chars().any(|character| character == '\0')
    {
        return Err("Invalid attachment filename.".into());
    }
    Ok(name.to_string())
}

pub(super) fn normalize_mime(value: &str) -> Option<String> {
    let value = value.trim().to_lowercase();
    if value.is_empty()
        || value.len() > 120
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "/+.-".contains(character))
    {
        None
    } else {
        Some(value)
    }
}

pub(super) fn mime_for_filename(name: &str) -> &'static str {
    match std::path::Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "md" | "csv" | "log" => "text/plain",
        "json" => "application/json",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

pub(super) fn agent_lines(
    account: &str,
    target: &str,
    text: &str,
    reply_to: Option<&str>,
    agent_label: &str,
    activity_id: Option<&str>,
    relay_ready: bool,
) -> Vec<String> {
    let agent = normalize_agent_label(agent_label);
    let chunks = plain_chunks(text);
    chunks
        .into_iter()
        .enumerate()
        .map(|(index, chunk)| {
            let reply = (index == 0).then_some(reply_to).flatten();
            let prefix = tags_prefix(reply, Some(&agent), activity_id);
            if relay_ready && target.starts_with(['#', '&']) {
                format!("{prefix}RELAYMSG {target} {account}/{agent} :{chunk}")
            } else {
                format!("{prefix}PRIVMSG {target} :[{agent}] {chunk}")
            }
        })
        .collect()
}

pub(super) fn tags_prefix(
    reply_to: Option<&str>,
    agent_label: Option<&str>,
    activity_id: Option<&str>,
) -> String {
    let mut tags = Vec::new();
    if let Some(reply_to) = reply_to {
        tags.push(format!("+reply={}", irc_tag_value(reply_to)));
    }
    if let Some(agent_label) = agent_label {
        tags.push(format!(
            "+abundanceds.com/agent={}",
            irc_tag_value(agent_label)
        ));
    }
    if let Some(activity_id) = activity_id {
        tags.push(format!(
            "+abundanceds.com/activity={}",
            irc_tag_value(activity_id)
        ));
    }
    if tags.is_empty() {
        String::new()
    } else {
        format!("@{} ", tags.join(";"))
    }
}

pub(super) fn irc_tag_value(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            ';' => escaped.push_str(r"\:"),
            ' ' => escaped.push_str(r"\s"),
            '\\' => escaped.push_str(r"\\"),
            '\r' => escaped.push_str(r"\r"),
            '\n' => escaped.push_str(r"\n"),
            _ => escaped.push(character),
        }
    }
    escaped
}

pub(super) fn multiline_chunks(text: &str) -> Vec<(String, bool)> {
    let mut chunks = Vec::new();
    for line in text.split('\n') {
        let line_chunks = split_utf8(line, IRC_CHUNK_BYTES);
        if line_chunks.is_empty() {
            chunks.push((String::new(), false));
        } else {
            for (index, chunk) in line_chunks.into_iter().enumerate() {
                chunks.push((chunk, index > 0));
            }
        }
    }
    chunks
}

pub(super) fn plain_chunks(text: &str) -> Vec<String> {
    text.split('\n')
        .flat_map(|line| {
            let chunks = split_utf8(line, IRC_CHUNK_BYTES);
            if chunks.is_empty() {
                vec![" ".into()]
            } else {
                chunks
            }
        })
        .collect()
}

pub(super) fn split_utf8(value: &str, max_bytes: usize) -> Vec<String> {
    if value.is_empty() {
        return Vec::new();
    }
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < value.len() {
        let mut end = (start + max_bytes).min(value.len());
        while end > start && !value.is_char_boundary(end) {
            end -= 1;
        }
        if end == start {
            break;
        }
        if end < value.len() {
            let whitespace = value[start..end]
                .char_indices()
                .rfind(|(_, character)| character.is_whitespace());
            if let Some((index, character)) = whitespace {
                let candidate = start + index + character.len_utf8();
                if candidate > start + max_bytes / 2 {
                    end = candidate;
                }
            }
        }
        chunks.push(value[start..end].to_string());
        start = end;
    }
    chunks
}
