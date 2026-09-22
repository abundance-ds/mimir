//! Local HTTP and credential substitutes; no browser, Keychain, or real account.
use super::*;
use std::{cell::RefCell, collections::BTreeMap};

tokio::task_local! {
    pub(super) static ENV: Environment;
}

pub(super) struct Environment {
    pub(super) api_root: String,
    pub(super) secrets: RefCell<BTreeMap<String, String>>,
}

async fn response_server(status: u16, body: &str) -> (String, tokio::task::JoinHandle<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let root = format!("http://{}", listener.local_addr().unwrap());
    let body = body.to_owned();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        loop {
            let mut buffer = [0; 1024];
            let count = socket.read(&mut buffer).await.unwrap();
            assert!(count > 0);
            request.extend_from_slice(&buffer[..count]);
            if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                break;
            }
        }
        let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        socket.write_all(response.as_bytes()).await.unwrap();
        String::from_utf8(request).unwrap()
    });
    (root, task)
}

async fn credential_case(provider: &str, status: u16, body: &str, accepted: bool) {
    let (api_root, server) = response_server(status, body).await;
    let key = format!("{provider}:default");
    let old = if provider == "slack" {
        json!({"access_token":"xoxp-old","account":"Existing team"})
    } else {
        json!({"api_key":"grn_old","account":"Existing account"})
    }
    .to_string();
    let environment = Environment {
        api_root,
        secrets: RefCell::new(BTreeMap::from([(key.clone(), old.clone())])),
    };
    ENV.scope(environment, async {
        let manager = ConnectionManager::new(ToolRegistry::default()).unwrap();
        manager.refresh_provider(provider).unwrap();
        let before = manager.registry.list();
        let result = if provider == "slack" {
            commands::connect_slack_token("xoxp-new".into(), &manager).await
        } else {
            commands::connect_granola("grn_new".into(), &manager).await
        };
        let stored = read_secret(&key).unwrap().unwrap().value;
        if accepted {
            assert_eq!(result.unwrap().state, "connected");
            assert_ne!(stored, old);
            assert!(stored.contains(if provider == "slack" {
                "xoxp-new"
            } else {
                "grn_new"
            }));
        } else {
            let error = result.unwrap_err();
            assert!(!error.contains("xoxp-new"));
            assert!(!error.contains("grn_new"));
            assert_eq!(
                stored, old,
                "Failed validation must preserve the credential"
            );
        }
        assert_eq!(
            manager.registry.list(),
            before,
            "Existing data tools remain available"
        );
    })
    .await;
    let request = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("Validation did not reach the local provider")
        .unwrap();
    assert!(request.starts_with(if provider == "slack" {
        "POST /api/auth.test "
    } else {
        "GET /v1/notes?page_size=1 "
    }));
    assert!(request.to_lowercase().contains(if provider == "slack" {
        "authorization: bearer xoxp-new"
    } else {
        "authorization: bearer grn_new"
    }));
}

#[tokio::test]
async fn rejected_and_malformed_credentials_preserve_existing_connections() {
    for (status, body) in [
        (200, r#"{"ok":false,"error":"invalid_auth"}"#),
        (401, r#"{"error":"xoxp-new"}"#),
        (200, "not json"),
    ] {
        credential_case("slack", status, body, false).await;
    }
    for (status, body) in [(401, r#"{"error":"grn_new"}"#), (200, "not json")] {
        credential_case("granola", status, body, false).await;
    }
}

#[tokio::test]
async fn verified_credentials_replace_existing_connections() {
    credential_case(
        "slack",
        200,
        r#"{"ok":true,"team":"New team","user":"Tester","team_id":"T1","user_id":"U1"}"#,
        true,
    )
    .await;
    credential_case(
        "granola",
        200,
        r#"{"notes":[{"owner":{"email":"test@example.invalid"}}]}"#,
        true,
    )
    .await;
}
