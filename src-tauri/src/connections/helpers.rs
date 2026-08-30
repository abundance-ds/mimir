use super::*;

pub(super) fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false
    })
}

pub(super) fn google_object_schema(
    mut properties: Value,
    required: &[&str],
    accounts: &[&GoogleAccount],
    default_account: Option<&str>,
) -> Value {
    let emails = accounts
        .iter()
        .map(|account| account.email.clone())
        .collect::<Vec<_>>();
    let mut account = json!({
        "type": "string",
        "description": "Connected Google account email. Uses the marked default when omitted.",
        "enum": emails,
    });
    if let Some(default) = default_account.and_then(|default| {
        accounts
            .iter()
            .find(|account| account.id.eq_ignore_ascii_case(default))
            .map(|account| account.email.clone())
    }) {
        account["default"] = Value::String(default);
    }
    if let Some(properties) = properties.as_object_mut() {
        properties.insert("account".into(), account);
    }
    object_schema(properties, required)
}

pub(super) fn connection_annotations(canonical: &str) -> ToolAnnotations {
    let write = matches!(canonical, "gmail.send" | "calendar.create" | "slack.send");
    ToolAnnotations {
        read_only_hint: Some(!write),
        destructive_hint: Some(false),
        idempotent_hint: (!write).then_some(true),
    }
}

pub(super) fn gmail_summary(message: &Value) -> Value {
    let headers = gmail_headers(message.get("payload"));
    json!({
        "id": message.get("id"),
        "threadId": message.get("threadId"),
        "from": headers.get("from"),
        "subject": headers.get("subject"),
        "date": headers.get("date"),
        "snippet": message.get("snippet"),
        "internalDate": message.get("internalDate")
    })
}

pub(super) fn read_gmail_message(message: &Value) -> Value {
    let headers = gmail_headers(message.get("payload"));
    let body = gmail_body(message.get("payload")).unwrap_or_default();
    json!({
        "id": message.get("id"),
        "threadId": message.get("threadId"),
        "labelIds": message.get("labelIds"),
        "snippet": message.get("snippet"),
        "internalDate": message.get("internalDate"),
        "from": headers.get("from"),
        "to": headers.get("to"),
        "cc": headers.get("cc"),
        "subject": headers.get("subject"),
        "date": headers.get("date"),
        "messageId": headers.get("message-id"),
        "body": body
    })
}

pub(super) fn gmail_headers(payload: Option<&Value>) -> std::collections::HashMap<String, String> {
    payload
        .and_then(|value| value.get("headers"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|header| {
            Some((
                header.get("name")?.as_str()?.to_lowercase(),
                header.get("value")?.as_str()?.to_string(),
            ))
        })
        .collect()
}

pub(super) fn gmail_body(payload: Option<&Value>) -> Option<String> {
    let payload = payload?;
    if let Some(parts) = payload.get("parts").and_then(Value::as_array) {
        for preferred in ["text/plain", "text/html"] {
            for part in parts {
                if part.get("mimeType").and_then(Value::as_str) == Some(preferred) {
                    if let Some(value) = gmail_body(Some(part)) {
                        return Some(value);
                    }
                }
            }
        }
        for part in parts {
            if let Some(value) = gmail_body(Some(part)) {
                return Some(value);
            }
        }
    }
    let data = payload.pointer("/body/data")?.as_str()?;
    let decoded = URL_SAFE_NO_PAD.decode(data.trim_end_matches('=')).ok()?;
    let text = String::from_utf8_lossy(&decoded).to_string();
    if payload.get("mimeType").and_then(Value::as_str) == Some("text/html") {
        Some(strip_html(&text))
    } else {
        Some(text)
    }
}

pub(super) fn strip_html(input: &str) -> String {
    let mut output = String::new();
    let mut tag = false;
    for character in input.chars() {
        match character {
            '<' => tag = true,
            '>' => {
                tag = false;
                if !output.ends_with([' ', '\n']) {
                    output.push(' ');
                }
            }
            _ if !tag => output.push(character),
            _ => {}
        }
    }
    output.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub(super) fn remote_error_suffix(raw: &str) -> String {
    let message = serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.get("error_description"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();
    if message.is_empty() {
        String::new()
    } else {
        format!(": {}", truncate(&message, 240))
    }
}

pub(super) fn drive_mime(kind: Option<&str>) -> Option<&'static str> {
    match kind {
        Some("document") => Some("mimeType = 'application/vnd.google-apps.document'"),
        Some("spreadsheet") => Some("mimeType = 'application/vnd.google-apps.spreadsheet'"),
        Some("presentation") => Some("mimeType = 'application/vnd.google-apps.presentation'"),
        Some("pdf") => Some("mimeType = 'application/pdf'"),
        Some("folder") => Some("mimeType = 'application/vnd.google-apps.folder'"),
        Some("image") => Some("mimeType contains 'image/'"),
        _ => None,
    }
}

pub(super) fn spreadsheet_text(spreadsheet: &Value) -> String {
    let mut output = String::new();
    if let Some(title) = spreadsheet
        .pointer("/properties/title")
        .and_then(Value::as_str)
    {
        output.push_str("# Spreadsheet: ");
        output.push_str(title.trim());
        output.push_str("\n\n");
    }
    for (sheet_index, sheet) in spreadsheet
        .get("sheets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let title = sheet
            .pointer("/properties/title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Sheet {}", sheet_index + 1));
        output.push_str("## Sheet: ");
        output.push_str(&title);
        output.push('\n');

        let mut rows =
            std::collections::BTreeMap::<usize, std::collections::BTreeMap<usize, String>>::new();
        for grid in sheet
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let start_row = grid.get("startRow").and_then(Value::as_u64).unwrap_or(0) as usize;
            let start_column =
                grid.get("startColumn").and_then(Value::as_u64).unwrap_or(0) as usize;
            for (row_offset, row) in grid
                .get("rowData")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .enumerate()
            {
                for (column_offset, cell) in row
                    .get("values")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    let value = sheet_cell_text(cell);
                    if !value.is_empty() {
                        rows.entry(start_row + row_offset)
                            .or_default()
                            .insert(start_column + column_offset, value);
                    }
                }
            }
        }
        if rows.is_empty() {
            output.push_str("(no populated cells)\n\n");
            continue;
        }
        for (row_index, cells) in rows {
            let last_column = cells.keys().next_back().copied().unwrap_or(0);
            let values = (0..=last_column)
                .map(|column| cells.get(&column).cloned().unwrap_or_default())
                .collect::<Vec<_>>();
            output.push_str(&(row_index + 1).to_string());
            output.push('\t');
            output.push_str(&values.join("\t"));
            output.push('\n');
        }
        output.push('\n');
    }
    output.trim_end().to_string()
}

pub(super) fn sheet_cell_text(cell: &Value) -> String {
    let value = cell
        .get("formattedValue")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            let effective = cell.get("effectiveValue")?;
            effective
                .get("stringValue")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| effective.get("numberValue").map(|value| value.to_string()))
                .or_else(|| {
                    effective
                        .get("boolValue")
                        .and_then(Value::as_bool)
                        .map(|value| value.to_string())
                })
                .or_else(|| {
                    effective
                        .pointer("/errorValue/message")
                        .and_then(Value::as_str)
                        .map(|value| format!("#ERROR: {value}"))
                })
        })
        .unwrap_or_default();
    value.replace(['\r', '\n', '\t'], " ").trim().to_string()
}

pub(super) fn presentation_text(presentation: &Value) -> String {
    let mut output = String::new();
    if let Some(title) = presentation.get("title").and_then(Value::as_str) {
        output.push_str("# Presentation: ");
        output.push_str(title.trim());
        output.push_str("\n\n");
    }
    for (index, slide) in presentation
        .get("slides")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        output.push_str(&format!("## Slide {}\n", index + 1));
        let mut blocks = Vec::new();
        for element in slide
            .get("pageElements")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            slide_element_text(element, &mut blocks);
        }
        let notes = slide
            .pointer("/slideProperties/notesPage/pageElements")
            .and_then(Value::as_array)
            .map(|elements| {
                let mut notes = Vec::new();
                for element in elements {
                    slide_element_text(element, &mut notes);
                }
                notes
            })
            .unwrap_or_default();
        if blocks.is_empty() {
            output.push_str("(no text)\n");
        } else {
            output.push_str(&blocks.join("\n"));
            output.push('\n');
        }
        if !notes.is_empty() {
            output.push_str("\nSpeaker notes:\n");
            output.push_str(&notes.join("\n"));
            output.push('\n');
        }
        output.push('\n');
    }
    output.trim_end().to_string()
}

pub(super) fn slide_element_text(element: &Value, output: &mut Vec<String>) {
    if let Some(shape) = element.get("shape") {
        if let Some(text) = shape.get("text") {
            push_text_content(text, output);
        }
    }
    if let Some(word_art) = element
        .pointer("/wordArt/renderedText")
        .and_then(Value::as_str)
        .map(clean_text_block)
        .filter(|value| !value.is_empty())
    {
        output.push(word_art);
    }
    if let Some(rows) = element
        .pointer("/table/tableRows")
        .and_then(Value::as_array)
    {
        for row in rows {
            let cells = row
                .get("tableCells")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|cell| text_content(cell.get("text").unwrap_or(&Value::Null)))
                .collect::<Vec<_>>();
            if cells.iter().any(|cell| !cell.is_empty()) {
                output.push(cells.join("\t"));
            }
        }
    }
    for child in element
        .pointer("/elementGroup/children")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        slide_element_text(child, output);
    }
}

pub(super) fn push_text_content(text: &Value, output: &mut Vec<String>) {
    let content = text_content(text);
    if !content.is_empty() {
        output.push(content);
    }
}

pub(super) fn text_content(text: &Value) -> String {
    let content = text
        .get("textElements")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|element| element.pointer("/textRun/content").and_then(Value::as_str))
        .collect::<String>();
    clean_text_block(&content)
}

pub(super) fn clean_text_block(value: &str) -> String {
    value
        .replace('\r', "")
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

pub(super) fn escape_drive_query(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

pub(super) fn safe_header(value: &str) -> String {
    value.replace(['\r', '\n'], " ").trim().to_string()
}

pub(super) fn reply_subject(value: &str) -> String {
    if value.to_lowercase().starts_with("re:") {
        value.to_string()
    } else {
        format!("Re: {value}")
    }
}

pub(super) fn string(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(super) fn required_string(input: &Value, key: &str) -> Result<String, String> {
    string(input, key).ok_or_else(|| format!("{key} is required."))
}

pub(super) fn required_json_string(input: &Value, key: &str) -> Result<String, String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{key} is missing."))
}

pub(super) fn int(input: &Value, key: &str, fallback: i64, minimum: i64, maximum: i64) -> i64 {
    input
        .get(key)
        .and_then(Value::as_i64)
        .unwrap_or(fallback)
        .clamp(minimum, maximum)
}

pub(super) fn url_encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

pub(super) fn truncate(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    value
        .chars()
        .take(limit.saturating_sub(1))
        .collect::<String>()
        + "…"
}

pub(super) fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
