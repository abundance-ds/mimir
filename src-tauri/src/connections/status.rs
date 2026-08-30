use super::*;

pub(super) fn google_status() -> ConnectionStatus {
    match google_store() {
        Ok(store) if store.accounts.is_empty() => {
            disconnected_status("google", "Google", "Gmail, Calendar, and Drive")
        }
        Ok(store) => {
            let default = resolve_google_account(&store, None).ok();
            let connected = store
                .accounts
                .iter()
                .any(|account| !google_needs_sign_in(&account.bundle));
            let count = store.accounts.len();
            ConnectionStatus {
                provider: "google",
                name: "Google",
                state: if connected {
                    "connected"
                } else {
                    "needs_sign_in"
                },
                account: default.map(|account| account.email.clone()),
                accounts: store
                    .accounts
                    .iter()
                    .map(|account| ConnectionAccountStatus {
                        id: account.id.clone(),
                        label: account.email.clone(),
                        detail: account.name.clone(),
                        state: if google_needs_sign_in(&account.bundle) {
                            "needs_sign_in"
                        } else {
                            "connected"
                        },
                        is_default: store.default_account.as_deref() == Some(&account.id),
                    })
                    .collect(),
                oauth_available: configured_google_client_id().is_some(),
                detail: if !connected {
                    "Sign in again to restore Gmail, Calendar, and Drive.".into()
                } else if count == 1 {
                    "Gmail, Calendar, and Drive are available to agents.".into()
                } else {
                    format!("{count} Google accounts are available to agents.")
                },
            }
        }
        Err(error) => needs_sign_in_status("google", "Google", error),
    }
}

pub(super) fn slack_status() -> ConnectionStatus {
    match slack_bundle(DEFAULT_ACCOUNT) {
        Ok(Some(bundle)) if slack_needs_sign_in(&bundle) => ConnectionStatus {
            provider: "slack",
            name: "Slack",
            state: "needs_sign_in",
            account: bundle.account,
            accounts: Vec::new(),
            oauth_available: configured_slack_client_id().is_some(),
            detail: "Sign in again to restore Slack access.".into(),
        },
        Ok(Some(bundle)) => ConnectionStatus {
            provider: "slack",
            name: "Slack",
            state: "connected",
            account: bundle.account,
            accounts: Vec::new(),
            oauth_available: configured_slack_client_id().is_some(),
            detail: "Search, read, and send tools are available to agents.".into(),
        },
        Ok(None) => disconnected_status("slack", "Slack", "Search, read, and send messages"),
        Err(error) => needs_sign_in_status("slack", "Slack", error),
    }
}

pub(super) fn granola_status() -> ConnectionStatus {
    match granola_bundle() {
        Ok(Some(bundle)) => ConnectionStatus {
            provider: "granola",
            name: "Granola",
            state: "connected",
            account: bundle.account,
            accounts: Vec::new(),
            oauth_available: false,
            detail: "Meeting notes and transcripts are available to agents.".into(),
        },
        Ok(None) => disconnected_status("granola", "Granola", "Meeting notes and transcripts"),
        Err(error) => needs_sign_in_status("granola", "Granola", error),
    }
}

pub(super) fn disconnected_status(
    provider: &'static str,
    name: &'static str,
    capability: &str,
) -> ConnectionStatus {
    ConnectionStatus {
        provider,
        name,
        state: "not_connected",
        account: None,
        accounts: Vec::new(),
        oauth_available: match provider {
            "google" => configured_google_client_id().is_some(),
            "slack" => configured_slack_client_id().is_some(),
            _ => false,
        },
        detail: format!("Connect to use {capability}."),
    }
}

pub(super) fn needs_sign_in_status(
    provider: &'static str,
    name: &'static str,
    error: String,
) -> ConnectionStatus {
    ConnectionStatus {
        provider,
        name,
        state: "needs_sign_in",
        account: None,
        accounts: Vec::new(),
        oauth_available: match provider {
            "google" => configured_google_client_id().is_some(),
            "slack" => configured_slack_client_id().is_some(),
            _ => false,
        },
        detail: truncate(&error, 160),
    }
}

pub(super) fn google_needs_sign_in(bundle: &GoogleBundle) -> bool {
    bundle
        .expires_at
        .is_some_and(|expires| expires <= unix_seconds() + 60)
        && bundle.refresh_token.is_none()
}

pub(super) fn slack_needs_sign_in(bundle: &SlackBundle) -> bool {
    bundle
        .expires_at
        .is_some_and(|expires| expires <= unix_seconds() + 60)
        && bundle.refresh_token.is_none()
}

pub(super) fn slack_personal_token(value: &str) -> Result<&str, String> {
    let token = value.trim();
    if token.starts_with("xoxp-") {
        Ok(token)
    } else {
        Err("Enter a Slack personal token that starts with xoxp-.".into())
    }
}

pub(crate) fn local_diagnostics() -> Value {
    let manager = ConnectionManager::new(ToolRegistry::default());
    let statuses = manager
        .map(|manager| manager.statuses())
        .unwrap_or_else(|_| vec![google_status(), slack_status(), granola_status()]);
    let diagnostic = |provider: &str| {
        let status = statuses.iter().find(|status| status.provider == provider);
        json!({
            "status": status.map(|status| status.state).unwrap_or("error"),
            "detail": status.map(|status| status.detail.as_str()).unwrap_or("status unavailable"),
            "account": status.and_then(|status| status.account.as_deref()),
        })
    };
    json!({
        "remoteChecked": false,
        "google": diagnostic("google"),
        "slack": diagnostic("slack"),
        "granola": diagnostic("granola"),
    })
}
