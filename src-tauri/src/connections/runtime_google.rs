use super::*;

impl ConnectionRuntime {
    pub(super) async fn execute(&self, tool: &str, input: Value) -> Result<Value, String> {
        let result = match tool {
            "gmail.search" => self.gmail_search(&input).await,
            "gmail.read" => self.gmail_read(&input).await,
            "gmail.send" => self.gmail_send(&input).await,
            "calendar.list" => self.calendar_list(&input).await,
            "calendar.create" => self.calendar_create(&input).await,
            "calendar.calendars" => self.calendar_calendars(&input).await,
            "calendar.freebusy" => self.calendar_freebusy(&input).await,
            "drive.search" => self.drive_search(&input).await,
            "drive.read" => self.drive_read(&input).await,
            "slack.search" => self.slack_search(&input).await,
            "slack.read" => self.slack_read(&input).await,
            "slack.send" => self.slack_send(&input).await,
            "granola.search" => self.granola_search(&input).await,
            "granola.get" => self.granola_get(&input).await,
            _ => Err(format!("Unknown connection tool: {tool}")),
        }?;
        if matches!(
            tool.split_once('.').map(|(provider, _)| provider),
            Some("gmail" | "calendar" | "drive")
        ) {
            return add_google_account_to_result(&input, result);
        }
        Ok(result)
    }

    async fn google_request(
        &self,
        input: &Value,
        method: Method,
        url: &str,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<reqwest::Response, String> {
        let token = self.google_access_token(input).await?;
        let mut request = self.http.request(method, url).bearer_auth(token);
        if !query.is_empty() {
            request = request.query(query);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|error| error.to_string())?;
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status();
        let message = response.text().await.unwrap_or_default();
        Err(format!(
            "Google request failed with HTTP {status}{}",
            remote_error_suffix(&message)
        ))
    }

    async fn google_json(
        &self,
        input: &Value,
        method: Method,
        url: &str,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<Value, String> {
        self.google_request(input, method, url, query, body)
            .await?
            .json()
            .await
            .map_err(|error| format!("Google returned invalid JSON: {error}"))
    }

    async fn google_access_token(&self, input: &Value) -> Result<String, String> {
        let store = google_store()?;
        let account = resolve_google_account(&store, string(input, "account").as_deref())?;
        let account_id = account.id.clone();
        let email = account.email.clone();
        let mut bundle = account.bundle.clone();
        if google_needs_sign_in(&bundle) {
            return Err(format!(
                "Google account {email} needs sign-in. Reconnect it in Settings → Connections."
            ));
        }
        if bundle.expires_at.unwrap_or(i64::MAX) > unix_seconds() + 60
            || bundle.refresh_token.is_none()
        {
            return Ok(bundle.access_token);
        }
        let client_id = bundle
            .auth
            .as_ref()
            .and_then(|auth| auth.get("client_id"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(configured_google_client_id)
            .ok_or_else(|| {
                "Google needs sign-in. Connect Google in Settings → Connections.".to_string()
            })?;
        let refresh_token = bundle.refresh_token.clone().unwrap_or_default();
        let form = {
            let mut form = url::form_urlencoded::Serializer::new(String::new());
            form.append_pair("client_id", &client_id)
                .append_pair("refresh_token", &refresh_token)
                .append_pair("grant_type", "refresh_token");
            if let Some(secret) = configured_google_client_secret() {
                form.append_pair("client_secret", &secret);
            }
            form.finish()
        };
        let response = self
            .http
            .post("https://oauth2.googleapis.com/token")
            .header("content-type", "application/x-www-form-urlencoded")
            .body(form)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let value: Value = response
            .json()
            .await
            .map_err(|error| format!("Google token refresh returned invalid JSON: {error}"))?;
        if !status.is_success() {
            return Err(format!("Google token refresh failed with HTTP {status}"));
        }
        bundle.access_token = required_json_string(&value, "access_token")?;
        bundle.expires_at = Some(
            unix_seconds()
                + value
                    .get("expires_in")
                    .and_then(Value::as_i64)
                    .unwrap_or(3600),
        );
        if let Some(scope) = value.get("scope").and_then(Value::as_str) {
            bundle.scope = scope.to_string();
        }
        let access_token = bundle.access_token.clone();
        save_google_bundle(&account_id, bundle)?;
        Ok(access_token)
    }

    async fn gmail_search(&self, input: &Value) -> Result<Value, String> {
        let limit = int(input, "limit", 10, 1, 50);
        let mut query = vec![("maxResults", limit.to_string())];
        if let Some(value) = string(input, "query") {
            query.push(("q", value));
        }
        if let Some(value) = string(input, "page_token") {
            query.push(("pageToken", value));
        }
        let list = self
            .google_json(
                input,
                Method::GET,
                "https://gmail.googleapis.com/gmail/v1/users/me/messages",
                &query,
                None,
            )
            .await?;
        let mut messages = Vec::new();
        for item in list
            .get("messages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            let detail = self
                .google_json(
                    input,
                    Method::GET,
                    &format!(
                        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}",
                        url_encode(id)
                    ),
                    &[
                        ("format", "metadata".into()),
                        ("metadataHeaders", "From".into()),
                        ("metadataHeaders", "Subject".into()),
                        ("metadataHeaders", "Date".into()),
                    ],
                    None,
                )
                .await?;
            messages.push(gmail_summary(&detail));
        }
        Ok(json!({
            "messages": messages,
            "nextPageToken": list.get("nextPageToken"),
            "resultSizeEstimate": list.get("resultSizeEstimate")
        }))
    }

    async fn gmail_read(&self, input: &Value) -> Result<Value, String> {
        if let Some(id) = string(input, "message_id") {
            let message = self
                .google_json(
                    input,
                    Method::GET,
                    &format!(
                        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}",
                        url_encode(&id)
                    ),
                    &[("format", "full".into())],
                    None,
                )
                .await?;
            return Ok(json!({ "message": read_gmail_message(&message) }));
        }
        let id = string(input, "thread_id")
            .ok_or_else(|| "message_id or thread_id is required.".to_string())?;
        let thread = self
            .google_json(
                input,
                Method::GET,
                &format!(
                    "https://gmail.googleapis.com/gmail/v1/users/me/threads/{}",
                    url_encode(&id)
                ),
                &[("format", "full".into())],
                None,
            )
            .await?;
        let messages = thread
            .get("messages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(read_gmail_message)
            .collect::<Vec<_>>();
        Ok(
            json!({ "threadId": thread.get("id").unwrap_or(&Value::String(id)), "messages": messages }),
        )
    }

    async fn gmail_send(&self, input: &Value) -> Result<Value, String> {
        let to = required_string(input, "to")?;
        let body = required_string(input, "body")?;
        let mut subject = string(input, "subject");
        let mut thread_id = string(input, "thread_id");
        let mut in_reply_to = None;
        let mut references = None;
        if let Some(reply_id) = string(input, "reply_to_message_id") {
            let original = self
                .google_json(
                    input,
                    Method::GET,
                    &format!(
                        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}",
                        url_encode(&reply_id)
                    ),
                    &[("format", "metadata".into())],
                    None,
                )
                .await?;
            let headers = gmail_headers(original.get("payload"));
            in_reply_to = headers.get("message-id").cloned();
            references = [headers.get("references").cloned(), in_reply_to.clone()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ")
                .into();
            thread_id = thread_id.or_else(|| {
                original
                    .get("threadId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            });
            subject = subject.or_else(|| headers.get("subject").map(|value| reply_subject(value)));
        }
        let subject = subject.ok_or_else(|| "subject is required.".to_string())?;
        let mut lines = vec![format!("To: {}", safe_header(&to))];
        if let Some(value) = string(input, "cc") {
            lines.push(format!("Cc: {}", safe_header(&value)));
        }
        if let Some(value) = string(input, "bcc") {
            lines.push(format!("Bcc: {}", safe_header(&value)));
        }
        lines.push(format!("Subject: {}", safe_header(&subject)));
        if let Some(value) = in_reply_to {
            lines.push(format!("In-Reply-To: {}", safe_header(&value)));
        }
        if let Some(value) = references.filter(|value: &String| !value.is_empty()) {
            lines.push(format!("References: {}", safe_header(&value)));
        }
        lines.push("Content-Type: text/plain; charset=\"UTF-8\"".into());
        lines.push(String::new());
        lines.push(body);
        let raw = URL_SAFE_NO_PAD.encode(lines.join("\r\n"));
        self.google_json(
            input,
            Method::POST,
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            &[],
            Some(json!({ "raw": raw, "threadId": thread_id })),
        )
        .await
    }

    async fn calendar_list(&self, input: &Value) -> Result<Value, String> {
        let calendar = string(input, "calendar_id").unwrap_or_else(|| "primary".into());
        let mut query = vec![
            ("timeMin", required_string(input, "from")?),
            ("timeMax", required_string(input, "to")?),
            ("singleEvents", "true".into()),
            ("orderBy", "startTime".into()),
            ("maxResults", int(input, "limit", 20, 1, 100).to_string()),
        ];
        if let Some(value) = string(input, "page_token") {
            query.push(("pageToken", value));
        }
        self.google_json(
            input,
            Method::GET,
            &format!(
                "https://www.googleapis.com/calendar/v3/calendars/{}/events",
                url_encode(&calendar)
            ),
            &query,
            None,
        )
        .await
    }

    async fn calendar_create(&self, input: &Value) -> Result<Value, String> {
        let calendar = string(input, "calendar_id").unwrap_or_else(|| "primary".into());
        let attendees = input
            .get("attendees")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|email| json!({ "email": email }))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        self.google_json(
            input,
            Method::POST,
            &format!(
                "https://www.googleapis.com/calendar/v3/calendars/{}/events",
                url_encode(&calendar)
            ),
            &[],
            Some(json!({
                "summary": required_string(input, "summary")?,
                "description": string(input, "description"),
                "start": { "dateTime": required_string(input, "start")? },
                "end": { "dateTime": required_string(input, "end")? },
                "attendees": attendees
            })),
        )
        .await
    }

    async fn calendar_calendars(&self, input: &Value) -> Result<Value, String> {
        let mut query = vec![
            (
                "maxResults",
                int(input, "limit", 100, 1, 250).to_string(),
            ),
            (
                "showHidden",
                input
                    .get("include_hidden")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    .to_string(),
            ),
            (
                "fields",
                "nextPageToken,nextSyncToken,items(id,summary,description,location,timeZone,colorId,backgroundColor,foregroundColor,selected,primary,accessRole,hidden,deleted)"
                    .into(),
            ),
        ];
        if let Some(value) = string(input, "page_token") {
            query.push(("pageToken", value));
        }
        self.google_json(
            input,
            Method::GET,
            "https://www.googleapis.com/calendar/v3/users/me/calendarList",
            &query,
            None,
        )
        .await
    }

    async fn calendar_freebusy(&self, input: &Value) -> Result<Value, String> {
        let calendar_ids = input
            .get("calendar_ids")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .take(50)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .filter(|values| !values.is_empty())
            .unwrap_or_else(|| vec!["primary".into()]);
        let mut body = json!({
            "timeMin": required_string(input, "from")?,
            "timeMax": required_string(input, "to")?,
            "calendarExpansionMax": 50,
            "items": calendar_ids
                .into_iter()
                .map(|id| json!({ "id": id }))
                .collect::<Vec<_>>()
        });
        if let Some(time_zone) = string(input, "time_zone") {
            body["timeZone"] = Value::String(time_zone);
        }
        self.google_json(
            input,
            Method::POST,
            "https://www.googleapis.com/calendar/v3/freeBusy",
            &[],
            Some(body),
        )
        .await
    }

    async fn drive_search(&self, input: &Value) -> Result<Value, String> {
        let mut clauses = vec!["trashed = false".to_string()];
        if let Some(value) = string(input, "query") {
            clauses.push(format!("name contains '{}'", escape_drive_query(&value)));
        }
        if let Some(value) = string(input, "folder_id") {
            clauses.push(format!("'{}' in parents", escape_drive_query(&value)));
        }
        if let Some(mime) = drive_mime(string(input, "type").as_deref()) {
            clauses.push(mime.into());
        }
        let mut query = vec![
            ("q", clauses.join(" and ")),
            ("pageSize", int(input, "limit", 20, 1, 100).to_string()),
            (
                "fields",
                "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress,displayName),size)".into(),
            ),
        ];
        if let Some(value) = string(input, "page_token") {
            query.push(("pageToken", value));
        }
        self.google_json(
            input,
            Method::GET,
            "https://www.googleapis.com/drive/v3/files",
            &query,
            None,
        )
        .await
    }

    async fn drive_read(&self, input: &Value) -> Result<Value, String> {
        let id = required_string(input, "file_id")?;
        let metadata = self
            .google_json(
                input,
                Method::GET,
                &format!(
                    "https://www.googleapis.com/drive/v3/files/{}",
                    url_encode(&id)
                ),
                &[(
                    "fields",
                    "id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress,displayName),size"
                        .into(),
                )],
                None,
            )
            .await?;
        let mime = metadata
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("");
        let content = if mime == "application/vnd.google-apps.document" {
            Some(
                self.google_request(
                    input,
                    Method::GET,
                    &format!(
                        "https://www.googleapis.com/drive/v3/files/{}/export",
                        url_encode(&id)
                    ),
                    &[("mimeType", "text/plain".into())],
                    None,
                )
                .await?
                .text()
                .await
                .map_err(|error| error.to_string())?,
            )
        } else if mime == "application/vnd.google-apps.spreadsheet" {
            let spreadsheet = self
                .google_json(
                    input,
                    Method::GET,
                    &format!(
                        "https://sheets.googleapis.com/v4/spreadsheets/{}",
                        url_encode(&id)
                    ),
                    &[
                        ("includeGridData", "true".into()),
                        (
                            "fields",
                            "spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)),data(startRow,startColumn,rowData(values(effectiveValue,formattedValue))))"
                                .into(),
                        ),
                    ],
                    None,
                )
                .await?;
            Some(spreadsheet_text(&spreadsheet))
        } else if mime == "application/vnd.google-apps.presentation" {
            let presentation = self
                .google_json(
                    input,
                    Method::GET,
                    &format!(
                        "https://slides.googleapis.com/v1/presentations/{}",
                        url_encode(&id)
                    ),
                    &[("fields", "presentationId,title,slides".into())],
                    None,
                )
                .await?;
            Some(presentation_text(&presentation))
        } else if mime.starts_with("text/")
            || matches!(mime, "application/json" | "application/xml")
        {
            Some(
                self.google_request(
                    input,
                    Method::GET,
                    &format!(
                        "https://www.googleapis.com/drive/v3/files/{}",
                        url_encode(&id)
                    ),
                    &[("alt", "media".into())],
                    None,
                )
                .await?
                .text()
                .await
                .map_err(|error| error.to_string())?,
            )
        } else {
            None
        };
        let max_chars = int(input, "max_chars", 30_000, 1_000, 100_000) as usize;
        let content_available = content.is_some();
        Ok(json!({
            "file": metadata,
            "content": content.map(|value| truncate(&value, max_chars)),
            "contentAvailable": content_available
        }))
    }
}
