//! Agent setup uses the same native commands as Settings. Secrets are write-only.
use super::*;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

type OperationMap = BTreeMap<String, Operation>;
pub(super) type Operations = Arc<Mutex<OperationMap>>;
pub(super) struct Operation {
    provider: String,
    result: Value,
    task: Option<tokio::task::JoinHandle<()>>,
}

pub(super) fn install(manager: &ConnectionManager) -> Result<(), String> {
    let provider = json!({"type":"string","enum":["google","slack","granola","github"]});
    let definitions = [
        (
            "list",
            "List accounts, setup methods, and pending operations.",
            object_schema(json!({}), &[]),
        ),
        (
            "connect",
            "Connect an account; return an operation ID.",
            object_schema(
                json!({"provider":provider,"credential":{"type":"string","minLength":1,"maxLength":16384,"description":"Slack token or Granola key via --stdin. Omit for browser login."}}),
                &["provider"],
            ),
        ),
        (
            "check",
            "Check access without sending; return an operation ID.",
            object_schema(
                json!({"provider":provider,"account":{"type":"string"}}),
                &["provider"],
            ),
        ),
        (
            "set_default",
            "Set the default Google account.",
            object_schema(
                json!({"account":{"type":"string","minLength":1}}),
                &["account"],
            ),
        ),
        (
            "disconnect",
            "Disconnect locally. Google requires account; GitHub affects shared CLI login.",
            object_schema(
                json!({"provider":provider,"account":{"type":"string"},"shared_login":{"type":"boolean","description":"Required for shared GitHub sign-out."}}),
                &["provider"],
            ),
        ),
        (
            "operation",
            "Read progress or cancel pending setup.",
            object_schema(
                json!({"id":{"type":"string","minLength":1},"cancel":{"type":"boolean","default":false}}),
                &["id"],
            ),
        ),
    ];
    for (action, description, schema) in definitions {
        let manager = manager.clone();
        let descriptor = ToolDescriptor::new(
            format!("connections.{action}"),
            format!("connections_{action}"),
            description,
            schema,
            ToolOwner::Provider("connection-setup".into()),
            ToolSource::Native,
        )
        .with_annotations(ToolAnnotations {
            read_only_hint: Some(action == "list"),
            ..Default::default()
        });
        let registry = manager.registry.clone();
        registry
            .register(ToolRegistration::new(
                descriptor,
                move |_: ToolCallContext, input: Value| {
                    let manager = manager.clone();
                    async move {
                        dispatch(&manager, action, input)
                            .await
                            .map(ToolResult::new)
                            .map_err(|error| ToolError::new(ToolErrorCode::Handler, error))
                    }
                },
            ))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn dispatch(
    manager: &ConnectionManager,
    action: &str,
    input: Value,
) -> Result<Value, String> {
    match action {
        "list" => {
            let tools = manager.registry.list();
            let mut providers = manager
                .statuses()
                .into_iter()
                .map(|status| {
                    let methods = match status.provider {
                        "google" if status.oauth_available => vec!["browser"],
                        "google" => vec![],
                        "slack" if status.oauth_available => vec!["browser", "personal_token"],
                        "slack" => vec!["personal_token"],
                        _ => vec!["api_key"],
                    };
                    let available_tools = tools.iter().filter(|tool| tool.owner == ToolOwner::Provider(status.provider.into())).map(|tool| tool.mcp_alias.as_str()).collect::<Vec<_>>();
                    let setup_issue = if status.provider == "google" && !status.oauth_available { Some("This build has no Google OAuth client ID. Configure MIMIR_GOOGLE_OAUTH_CLIENT_ID when building Mimir.") } else { None };
                    json!({"provider":status.provider,"status":status,"methods":methods,"availableTools":available_tools,"setupIssue":setup_issue})
                })
                .collect::<Vec<_>>();
            providers.push(json!({"provider":"github","status":crate::managed_git::github_connection_status().await?,"methods":["browser"],"credentialOwner":"GitHub CLI","setup":"Install git and gh if missing. Login is shared with other tools."}));
            let pending = manager
                .operations
                .lock()
                .map_err(|_| "Connection operation lock failed.")?
                .values()
                .filter(|op| op.result["state"] == "pending")
                .map(|op| op.result.clone())
                .collect::<Vec<_>>();
            Ok(json!({"providers":providers,"remoteChecked":false,"pendingOperations":pending}))
        }
        "operation" => {
            operation(
                manager,
                &required_string(&input, "id")?,
                input["cancel"] == true,
            )
            .await
        }
        "connect" | "check" => {
            let provider = required_string(&input, "provider")?;
            validate_provider(&provider)?;
            if action == "connect" {
                match (provider.as_str(), string(&input, "credential")) {
                    ("granola", None) => return Err("Supply a Granola API key through standard input.".into()),
                    ("google" | "github", Some(_)) => return Err("This provider uses browser login; do not supply a credential.".into()),
                    ("google", _) if configured_google_client_id().is_none() => return Err("This build has no Google OAuth client ID.".into()),
                    ("slack", None) if configured_slack_client_id().is_none() => return Err("This build has no Slack OAuth client ID. Supply a personal token through standard input.".into()),
                    _ => {}
                }
            }
            start(manager, action.to_string(), provider, input)
        }
        "set_default" => Ok(json!(commands::set_google_default(
            required_string(&input, "account")?,
            manager
        )?)),
        "disconnect" => {
            let provider = required_string(&input, "provider")?;
            validate_provider(&provider)?;
            let account = string(&input, "account");
            if provider == "google" && account.as_ref().is_none_or(|v| v.trim().is_empty()) {
                return Err("Specify the Google account to remove.".into());
            }
            if provider == "github" {
                if input["shared_login"] != true {
                    return Err("GitHub uses a shared CLI login. Set shared_login to true only when the user requested that sign-out.".into());
                }
                let _mutation = manager
                    .mutation
                    .try_lock()
                    .map_err(|_| "Another connection change is in progress.")?;
                Ok(json!(crate::managed_git::github_disconnect().await?))
            } else {
                Ok(json!(commands::disconnect(provider, account, manager)?))
            }
        }
        _ => Err("Unknown connection action.".into()),
    }
}

fn validate_provider(provider: &str) -> Result<(), String> {
    if ["google", "slack", "granola", "github"].contains(&provider) {
        Ok(())
    } else {
        Err("Unknown connection provider.".into())
    }
}

fn start(
    manager: &ConnectionManager,
    action: String,
    provider: String,
    input: Value,
) -> Result<Value, String> {
    let mut operations = manager
        .operations
        .lock()
        .map_err(|_| "Connection operation lock failed.")?;
    if operations
        .values()
        .any(|op| op.provider == provider && op.result["state"] == "pending")
    {
        return Err(
            "A setup operation is already pending for this provider. Check or cancel it first."
                .into(),
        );
    }
    // Retain a bounded set of receipts. Pending work is never evicted.
    if operations.len() >= 64 {
        let completed = operations
            .iter()
            .find(|(_, op)| op.result["state"] != "pending")
            .map(|(id, _)| id.clone());
        if let Some(id) = completed {
            operations.remove(&id);
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let receipt = json!({"id":id,"provider":provider,"action":action,"state":"pending"});
    operations.insert(
        id.clone(),
        Operation {
            provider: provider.clone(),
            result: receipt.clone(),
            task: None,
        },
    );
    let manager = manager.clone();
    let operation_id = id.clone();
    let task = tokio::spawn(async move {
        let secret = string(&input, "credential");
        let result = tokio::time::timeout(
            Duration::from_secs(240),
            perform(&manager, &action, &provider, &input),
        )
        .await;
        let result = match result {
            Ok(Ok(value)) => json!({"state":"complete","result":value}),
            Ok(Err(error)) => {
                json!({"state":"failed","error":redact_error(error, secret.as_deref())})
            }
            Err(_) => {
                json!({"state":"failed","error":"Connection operation timed out. Read connection status before retrying."})
            }
        };
        if let Some(app) = manager.app.get() {
            use tauri::Emitter;
            let _ = app.emit("connections-changed", ());
        }
        if let Ok(mut operations) = manager.operations.lock() {
            if let Some(op) = operations.get_mut(&operation_id) {
                op.result
                    .as_object_mut()
                    .unwrap()
                    .extend(result.as_object().unwrap().clone());
            }
        }
    });
    operations.get_mut(&id).unwrap().task = Some(task);
    Ok(receipt)
}

fn redact_error(error: String, secret: Option<&str>) -> String {
    match secret.filter(|s| !s.trim().is_empty()) {
        Some(secret) => error
            .replace(secret, "[redacted]")
            .replace(secret.trim(), "[redacted]"),
        None => error,
    }
}

async fn operation(manager: &ConnectionManager, id: &str, cancel: bool) -> Result<Value, String> {
    let task = {
        let mut operations = manager
            .operations
            .lock()
            .map_err(|_| "Connection operation lock failed.")?;
        let op = operations.get_mut(id).ok_or("Unknown operation. Receipts expire when Mimir restarts or the receipt limit is reached.")?;
        if cancel && op.result["state"] == "pending" {
            op.task.take()
        } else {
            None
        }
    };
    if let Some(task) = task {
        task.abort();
        let _ = task.await;
        let mut operations = manager
            .operations
            .lock()
            .map_err(|_| "Connection operation lock failed.")?;
        let op = operations.get_mut(id).ok_or("Unknown operation.")?;
        // A finished operation wins the race. Never claim cancellation after a save.
        if op.result["state"] == "pending" {
            op.result["state"] = json!("cancelled");
            if op.provider == "github" {
                op.result["detail"] = json!("Login process stopped. GitHub CLI may already have saved login; check connections_list.");
            }
        }
    }
    let operations = manager
        .operations
        .lock()
        .map_err(|_| "Connection operation lock failed.")?;
    Ok(operations
        .get(id)
        .ok_or("Unknown operation.")?
        .result
        .clone())
}

async fn perform(
    manager: &ConnectionManager,
    action: &str,
    provider: &str,
    input: &Value,
) -> Result<Value, String> {
    if action == "check" {
        return check(manager, provider, input).await;
    }
    match provider {
        "google" => Ok(json!(commands::connect_google(manager).await?)),
        "slack" => match string(input, "credential") {
            Some(token) => Ok(json!(commands::connect_slack_token(token, manager).await?)),
            None => Ok(json!(commands::connect_slack(manager).await?)),
        },
        "granola" => Ok(json!(
            commands::connect_granola(required_string(input, "credential")?, manager).await?
        )),
        "github" => {
            let _mutation = manager
                .mutation
                .try_lock()
                .map_err(|_| "Another connection change is in progress.")?;
            Ok(json!(crate::managed_git::github_connect().await?))
        }
        _ => Err("Unknown connection provider.".into()),
    }
}

async fn check(
    manager: &ConnectionManager,
    provider: &str,
    input: &Value,
) -> Result<Value, String> {
    let _mutation = manager
        .mutation
        .try_lock()
        .map_err(|_| "Another connection change is in progress.")?;
    match provider {
        "slack" => {
            let token = manager.runtime.slack_access_token().await?;
            let response = manager
                .runtime
                .http
                .post("https://slack.com/api/auth.test")
                .bearer_auth(token)
                .send()
                .await
                .map_err(|_| "Slack could not be reached.")?;
            let scopes = response
                .headers()
                .get("x-oauth-scopes")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let value: Value = response
                .json()
                .await
                .map_err(|_| "Slack returned invalid check data.")?;
            if value["ok"] != true {
                return Err("Slack rejected the stored credential. Reconnect Slack.".into());
            }
            let missing = scopes.as_ref().map(|scopes| {
                SLACK_USER_SCOPES
                    .split(',')
                    .filter(|required| {
                        !scopes.split(',').any(|granted| granted.trim() == *required)
                    })
                    .collect::<Vec<_>>()
            });
            Ok(
                json!({"remoteChecked":true,"identityVerified":true,"team":value["team"],"user":value["user"],"grantedScopes":scopes,"missingScopes":missing,"capabilitiesVerified":false,"detail":"Identity checked. Reported scopes are compared with Mimir requirements; individual channel access and writes are not tested."}),
            )
        }
        "google" => {
            let token = manager.runtime.google_access_token(input).await?;
            let response = manager
                .runtime
                .http
                .get("https://openidconnect.googleapis.com/v1/userinfo")
                .bearer_auth(token)
                .send()
                .await
                .map_err(|_| "Google could not be reached.")?;
            if !response.status().is_success() {
                return Err(
                    "Google rejected the stored credential. Reconnect this account.".into(),
                );
            }
            let identity: Value = response
                .json()
                .await
                .map_err(|_| "Google returned invalid check data.")?;
            let store = google_store()?;
            let account = resolve_google_account(&store, string(input, "account").as_deref())?;
            Ok(
                json!({"remoteChecked":true,"identityVerified":true,"account":identity["email"],"grantedScopes":account.bundle.scope,"capabilitiesVerified":false,"detail":"Identity checked. Gmail, Calendar, Drive access and writes are not tested."}),
            )
        }
        "granola" => {
            manager
                .runtime
                .granola_json("/notes", &[("page_size", "1".into())])
                .await
                .map_err(|_| "Granola notes check failed. Check service access or reconnect.")?;
            Ok(
                json!({"remoteChecked":true,"notesReadable":true,"capabilitiesVerified":false,"detail":"Notes API checked. Transcript access is not tested."}),
            )
        }
        "github" => Ok(
            json!({"remoteChecked":false,"status":crate::managed_git::github_connection_status().await?,"detail":"Shared CLI status checked. Repository access is not tested."}),
        ),
        _ => Err("Unknown connection provider.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_are_removed_from_errors() {
        assert_eq!(
            redact_error("Rejected xoxp-secret".into(), Some(" xoxp-secret ")),
            "Rejected [redacted]"
        );
    }
    #[tokio::test]
    async fn setup_tools_exist_without_credentials_and_validate_before_work() {
        let manager = ConnectionManager::new(ToolRegistry::default()).unwrap();
        install(&manager).unwrap();
        let error = manager
            .registry
            .call(
                "connections.connect",
                ToolCallContext::default(),
                json!({"provider":"invalid","credential":"private-value"}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, ToolErrorCode::InvalidInput);
        assert!(!error.message.contains("private-value"));
        let error = dispatch(
            &manager,
            "connect",
            json!({"provider":"google","credential":"private-value"}),
        )
        .await
        .unwrap_err();
        assert!(!error.contains("private-value"));
        assert!(
            dispatch(&manager, "disconnect", json!({"provider":"google"}))
                .await
                .unwrap_err()
                .contains("Specify")
        );
        assert!(
            dispatch(&manager, "disconnect", json!({"provider":"github"}))
                .await
                .unwrap_err()
                .contains("shared")
        );
    }

    #[tokio::test]
    async fn cancellation_waits_for_task_drop_and_preserves_completed_results() {
        let manager = ConnectionManager::new(ToolRegistry::default()).unwrap();
        let (started, ready) = tokio::sync::oneshot::channel();
        let mutation = manager.mutation.clone();
        let task = tokio::spawn(async move {
            let _guard = mutation.lock().await;
            let _ = started.send(());
            std::future::pending::<()>().await;
        });
        manager.operations.lock().unwrap().insert(
            "pending".into(),
            Operation {
                provider: "slack".into(),
                result: json!({"state":"pending"}),
                task: Some(task),
            },
        );
        ready.await.unwrap();
        assert!(manager.mutation.try_lock().is_err());
        assert_eq!(
            operation(&manager, "pending", true).await.unwrap()["state"],
            "cancelled"
        );
        assert!(manager.mutation.try_lock().is_ok());
        manager.operations.lock().unwrap().insert(
            "saved".into(),
            Operation {
                provider: "slack".into(),
                result: json!({"state":"complete","result":{"account":"Team"}}),
                task: None,
            },
        );
        assert_eq!(
            operation(&manager, "saved", true).await.unwrap()["state"],
            "complete"
        );
    }

    #[tokio::test]
    async fn concurrent_changes_fail_before_reading_or_replacing_credentials() {
        let manager = ConnectionManager::new(ToolRegistry::default()).unwrap();
        let _guard = manager.mutation.lock().await;
        assert!(commands::connect_slack_token("xoxp-test".into(), &manager)
            .await
            .unwrap_err()
            .contains("in progress"));
        assert!(commands::disconnect("slack".into(), None, &manager)
            .unwrap_err()
            .contains("in progress"));
        assert!(commands::set_google_default("account".into(), &manager)
            .unwrap_err()
            .contains("in progress"));
    }
}
