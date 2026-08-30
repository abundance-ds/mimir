use super::*;

impl ConnectionRuntime {
    pub(super) async fn slack_api(
        &self,
        method: &str,
        verb: Method,
        query: &[(&str, String)],
        body: Option<Value>,
    ) -> Result<Value, String> {
        let token = self.slack_access_token().await?;
        let send = || {
            let mut request = self
                .http
                .request(verb.clone(), format!("https://slack.com/api/{method}"))
                .bearer_auth(&token);
            if !query.is_empty() {
                request = request.query(query);
            }
            if let Some(body) = body.clone() {
                request = request.json(&body);
            }
            request.send()
        };
        let mut response = send().await.map_err(|error| error.to_string())?;
        if response.status() == StatusCode::TOO_MANY_REQUESTS {
            let retry = response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(1);
            if retry > 5 {
                return Err(format!("Slack rate limited. Retry after {retry} seconds."));
            }
            tokio::time::sleep(Duration::from_secs(retry)).await;
            response = send().await.map_err(|error| error.to_string())?;
        }
        let status = response.status();
        let value: Value = response
            .json()
            .await
            .map_err(|error| format!("Slack returned invalid JSON: {error}"))?;
        if !status.is_success() || value.get("ok") == Some(&Value::Bool(false)) {
            let reason = value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown_error");
            return Err(format!("Slack {method}: {reason}"));
        }
        Ok(value)
    }

    pub(super) async fn slack_access_token(&self) -> Result<String, String> {
        let mut bundle = slack_bundle(&self.slack_account)?.ok_or_else(|| {
            "Slack is not connected. Connect Slack in Settings → Connections.".to_string()
        })?;
        if bundle.expires_at.unwrap_or(i64::MAX) > unix_seconds() + 60 {
            return Ok(bundle.access_token);
        }
        let refresh_token = bundle.refresh_token.clone().ok_or_else(|| {
            "Slack needs sign-in. Connect Slack in Settings → Connections.".to_string()
        })?;
        let client_id = configured_slack_client_id().ok_or_else(|| {
            "Slack needs sign-in. Connect Slack in Settings → Connections.".to_string()
        })?;
        let form = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "refresh_token")
            .append_pair("refresh_token", &refresh_token)
            .append_pair("client_id", &client_id)
            .finish();
        let response = self
            .http
            .post("https://slack.com/api/oauth.v2.access")
            .header("content-type", "application/x-www-form-urlencoded")
            .body(form)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let value: Value = response
            .json()
            .await
            .map_err(|error| format!("Slack returned invalid refresh data: {error}"))?;
        if !status.is_success() || value.get("ok") == Some(&Value::Bool(false)) {
            return Err("Slack needs sign-in. Connect Slack in Settings → Connections.".into());
        }
        bundle.access_token = slack_oauth_value(&value, "access_token")?;
        bundle.refresh_token =
            slack_oauth_optional(&value, "refresh_token").or(bundle.refresh_token);
        bundle.expires_at =
            slack_oauth_i64(&value, "expires_in").map(|seconds| unix_seconds() + seconds);
        write_secret(
            MIMIR_KEYCHAIN_SERVICE,
            &format!("slack:{}", self.slack_account),
            &serde_json::to_string(&bundle.as_stored()).map_err(|error| error.to_string())?,
        )?;
        Ok(bundle.access_token)
    }

    pub(super) async fn slack_search(&self, input: &Value) -> Result<Value, String> {
        self.slack_api(
            "search.messages",
            Method::GET,
            &[
                ("query", required_string(input, "query")?),
                ("count", int(input, "limit", 20, 1, 100).to_string()),
            ],
            None,
        )
        .await
    }

    pub(super) async fn slack_read(&self, input: &Value) -> Result<Value, String> {
        let channel = required_string(input, "channel")?;
        let limit = int(input, "limit", 50, 1, 100).to_string();
        let mut query = vec![("channel", channel), ("limit", limit)];
        let method = if let Some(thread) = string(input, "thread_ts") {
            query.push(("ts", thread));
            "conversations.replies"
        } else {
            "conversations.history"
        };
        if let Some(cursor) = string(input, "cursor") {
            query.push(("cursor", cursor));
        }
        self.slack_api(method, Method::GET, &query, None).await
    }

    pub(super) async fn slack_send(&self, input: &Value) -> Result<Value, String> {
        self.slack_api(
            "chat.postMessage",
            Method::POST,
            &[],
            Some(json!({
                "channel": required_string(input, "channel")?,
                "text": required_string(input, "text")?,
                "thread_ts": string(input, "thread_ts")
            })),
        )
        .await
    }

    pub(super) async fn granola_json(
        &self,
        endpoint: &str,
        query: &[(&str, String)],
    ) -> Result<Value, String> {
        let bundle = granola_bundle()?.ok_or_else(|| {
            "Granola is not connected. Connect Granola in Settings → Connections.".to_string()
        })?;
        let response = self
            .http
            .get(format!("{GRANOLA_API_ROOT}{endpoint}"))
            .bearer_auth(bundle.api_key)
            .query(query)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let value = response
            .json::<Value>()
            .await
            .map_err(|error| format!("Granola returned invalid JSON: {error}"))?;
        if !status.is_success() {
            return Err(format!(
                "Granola request failed with HTTP {status}{}",
                remote_error_suffix(&value.to_string())
            ));
        }
        Ok(value)
    }

    pub(super) async fn granola_search(&self, input: &Value) -> Result<Value, String> {
        let limit = int(input, "limit", 10, 1, 30);
        let mut query = vec![("page_size", limit.to_string())];
        if let Some(value) = string(input, "from") {
            query.push(("created_after", value));
        }
        if let Some(value) = string(input, "to") {
            query.push(("created_before", value));
        }
        if let Some(value) = string(input, "cursor") {
            query.push(("cursor", value));
        }
        let mut value = self.granola_json("/notes", &query).await?;
        if let Some(needle) = string(input, "query").map(|value| value.to_lowercase()) {
            if let Some(notes) = value.get_mut("notes").and_then(Value::as_array_mut) {
                notes.retain(|note| {
                    [
                        note.get("title").and_then(Value::as_str),
                        note.pointer("/owner/name").and_then(Value::as_str),
                        note.pointer("/owner/email").and_then(Value::as_str),
                    ]
                    .into_iter()
                    .flatten()
                    .any(|field| field.to_lowercase().contains(&needle))
                });
            }
        }
        Ok(value)
    }

    pub(super) async fn granola_get(&self, input: &Value) -> Result<Value, String> {
        let id = required_string(input, "id")?;
        let query = input
            .get("transcript")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            .then(|| ("include", "transcript".to_string()))
            .into_iter()
            .collect::<Vec<_>>();
        let mut value = self
            .granola_json(&format!("/notes/{}", url_encode(&id)), &query)
            .await?;
        let max_chars = int(input, "max_chars", 20_000, 1_000, 50_000) as usize;
        if let Some(markdown) = value.get_mut("summary_markdown") {
            if let Some(text) = markdown.as_str() {
                *markdown = Value::String(truncate(text, max_chars));
            }
        }
        Ok(value)
    }
}
