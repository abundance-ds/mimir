use super::*;

#[tauri::command]
pub async fn connections_connect_google(
    manager: tauri::State<'_, ConnectionManager>,
) -> Result<ConnectionStatus, String> {
    let client_id = configured_google_client_id().ok_or_else(|| {
        "This Mimir build has no Google sign-in client. Add MIMIR_GOOGLE_OAUTH_CLIENT_ID when you build the app."
            .to_string()
    })?;
    let oauth = OauthLoopback::new().await?;
    let mut authorize = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|error| error.to_string())?;
    authorize
        .query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &oauth.redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", GOOGLE_SCOPES)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent select_account")
        .append_pair("code_challenge", &oauth.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &oauth.state);
    open_system_browser(authorize.as_str())?;
    let code = oauth.receive_code().await?;

    let form = {
        let mut form = url::form_urlencoded::Serializer::new(String::new());
        form.append_pair("client_id", &client_id)
            .append_pair("code", &code)
            .append_pair("code_verifier", &oauth.verifier)
            .append_pair("redirect_uri", &oauth.redirect_uri)
            .append_pair("grant_type", "authorization_code");
        if let Some(secret) = configured_google_client_secret() {
            form.append_pair("client_secret", &secret);
        }
        form.finish()
    };
    let response = manager
        .runtime
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
        .map_err(|error| format!("Google returned invalid sign-in data: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "Google sign-in failed with HTTP {status}{}",
            remote_error_suffix(&value.to_string())
        ));
    }
    let access_token = required_json_string(&value, "access_token")?;
    let identity = manager
        .runtime
        .http
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !identity.status().is_success() {
        return Err(
            "Google sign-in succeeded, but Mimir could not read the account identity.".into(),
        );
    }
    let identity: Value = identity
        .json()
        .await
        .map_err(|error| format!("Google returned invalid account data: {error}"))?;
    let email = required_json_string(&identity, "email")?;
    let mut bundle = GoogleBundle {
        access_token,
        refresh_token: value
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string),
        expires_at: Some(
            unix_seconds()
                + value
                    .get("expires_in")
                    .and_then(Value::as_i64)
                    .unwrap_or(3600),
        ),
        scope: value
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or(GOOGLE_SCOPES)
            .to_string(),
        auth: Some(json!({
            "client_id": client_id,
            "email": identity.get("email").and_then(Value::as_str),
            "name": identity.get("name").and_then(Value::as_str),
        })),
    };
    let mut store = google_store()?;
    let id = email.to_lowercase();
    if bundle.refresh_token.is_none() {
        bundle.refresh_token = store
            .accounts
            .iter()
            .find(|account| account.id.eq_ignore_ascii_case(&id))
            .and_then(|account| account.bundle.refresh_token.clone());
    }
    upsert_google_account(
        &mut store,
        GoogleAccount {
            id,
            email,
            name: identity
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string),
            bundle,
        },
    );
    write_google_store(&store)?;
    manager.refresh_provider("google")?;
    Ok(google_status())
}

#[tauri::command]
pub async fn connections_connect_slack(
    manager: tauri::State<'_, ConnectionManager>,
) -> Result<ConnectionStatus, String> {
    let client_id = configured_slack_client_id().ok_or_else(|| {
        "This Mimir build has no Slack sign-in client. Add MIMIR_SLACK_CLIENT_ID when you build the app."
            .to_string()
    })?;
    let oauth = OauthLoopback::new().await?;
    let mut authorize = url::Url::parse("https://slack.com/oauth/v2/authorize")
        .map_err(|error| error.to_string())?;
    authorize
        .query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &oauth.redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("user_scope", SLACK_USER_SCOPES)
        .append_pair("code_challenge", &oauth.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &oauth.state);
    open_system_browser(authorize.as_str())?;
    let code = oauth.receive_code().await?;
    let form = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", &client_id)
        .append_pair("code", &code)
        .append_pair("code_verifier", &oauth.verifier)
        .append_pair("redirect_uri", &oauth.redirect_uri)
        .finish();
    let response = manager
        .runtime
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
        .map_err(|error| format!("Slack returned invalid sign-in data: {error}"))?;
    if !status.is_success() || value.get("ok") == Some(&Value::Bool(false)) {
        let reason = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown_error");
        return Err(format!("Slack sign-in failed: {reason}"));
    }
    let access_token = value
        .pointer("/authed_user/access_token")
        .and_then(Value::as_str)
        .or_else(|| value.get("access_token").and_then(Value::as_str))
        .ok_or_else(|| "Slack sign-in returned no user access token.".to_string())?;
    let account = value
        .pointer("/team/name")
        .and_then(Value::as_str)
        .unwrap_or("Slack workspace");
    let stored = json!({
        "access_token": access_token,
        "refresh_token": slack_oauth_optional(&value, "refresh_token"),
        "account": account,
        "team_id": value.pointer("/team/id").and_then(Value::as_str),
        "user_id": value.pointer("/authed_user/id").and_then(Value::as_str),
        "expires_at": slack_oauth_i64(&value, "expires_in").map(|seconds| unix_seconds() + seconds),
    });
    write_secret(
        MIMIR_KEYCHAIN_SERVICE,
        "slack:default",
        &serde_json::to_string(&stored).map_err(|error| error.to_string())?,
    )?;
    manager.refresh_provider("slack")?;
    Ok(slack_status())
}

#[tauri::command]
pub async fn connections_connect_slack_token(
    token: String,
    manager: tauri::State<'_, ConnectionManager>,
) -> Result<ConnectionStatus, String> {
    let token = slack_personal_token(&token)?;
    let response = manager
        .runtime
        .http
        .post("https://slack.com/api/auth.test")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("Slack returned invalid token data: {error}"))?;
    if !status.is_success() || value.get("ok") != Some(&Value::Bool(true)) {
        let reason = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("invalid_auth");
        return Err(format!("Slack rejected this personal token: {reason}"));
    }
    let team = value
        .get("team")
        .and_then(Value::as_str)
        .unwrap_or("Slack workspace");
    let user = value.get("user").and_then(Value::as_str);
    let account = user
        .map(|user| format!("{team} · {user}"))
        .unwrap_or_else(|| team.to_string());
    let stored = json!({
        "access_token": token,
        "refresh_token": null,
        "account": account,
        "team_id": value.get("team_id").and_then(Value::as_str),
        "user_id": value.get("user_id").and_then(Value::as_str),
        "expires_at": null,
    });
    write_secret(
        MIMIR_KEYCHAIN_SERVICE,
        "slack:default",
        &serde_json::to_string(&stored).map_err(|error| error.to_string())?,
    )?;
    manager.refresh_provider("slack")?;
    Ok(slack_status())
}

#[tauri::command]
pub async fn connections_connect_granola(
    api_key: String,
    manager: tauri::State<'_, ConnectionManager>,
) -> Result<ConnectionStatus, String> {
    let api_key = api_key.trim();
    if !api_key.starts_with("grn_") {
        return Err("Enter a Granola API key that starts with grn_.".into());
    }
    let response = manager
        .runtime
        .http
        .get(format!("{GRANOLA_API_ROOT}/notes"))
        .bearer_auth(api_key)
        .query(&[("page_size", "1")])
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("Granola returned invalid connection data: {error}"))?;
    if !status.is_success() {
        return Err(format!(
            "Granola rejected this API key with HTTP {status}{}",
            remote_error_suffix(&value.to_string())
        ));
    }
    let account = value
        .pointer("/notes/0/owner/email")
        .and_then(Value::as_str)
        .unwrap_or("Personal API key");
    let stored = json!({ "api_key": api_key, "account": account });
    write_secret(
        MIMIR_KEYCHAIN_SERVICE,
        "granola:default",
        &serde_json::to_string(&stored).map_err(|error| error.to_string())?,
    )?;
    manager.refresh_provider("granola")?;
    Ok(granola_status())
}

#[tauri::command]
pub fn connections_disconnect(
    provider: String,
    account: Option<String>,
    manager: tauri::State<'_, ConnectionManager>,
) -> Result<Vec<ConnectionStatus>, String> {
    match provider.as_str() {
        "google" => {
            if let Some(account) = account.filter(|value| !value.trim().is_empty()) {
                let mut store = google_store()?;
                let id = resolve_google_account(&store, Some(&account))?.id.clone();
                store.accounts.retain(|entry| entry.id != id);
                normalize_google_store(&mut store);
                write_google_store(&store)?;
            } else {
                delete_secret(GOOGLE_ACCOUNTS_KEY)?;
                delete_secret("google:default")?;
            }
        }
        "slack" => delete_secret("slack:default")?,
        "granola" => delete_secret("granola:default")?,
        _ => return Err(format!("Unknown connection provider: {provider}")),
    }
    manager.refresh_provider(&provider)?;
    Ok(manager.statuses())
}

#[tauri::command]
pub fn connections_set_google_default(
    account: String,
    manager: tauri::State<'_, ConnectionManager>,
) -> Result<ConnectionStatus, String> {
    let mut store = google_store()?;
    let id = resolve_google_account(&store, Some(&account))?.id.clone();
    store.default_account = Some(id);
    write_google_store(&store)?;
    manager.refresh_provider("google")?;
    Ok(google_status())
}
