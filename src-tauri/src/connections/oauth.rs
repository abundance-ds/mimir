use super::*;

pub(crate) struct OauthLoopback {
    pub(crate) listener: tokio::net::TcpListener,
    pub(crate) redirect_uri: String,
    pub(crate) state: String,
    pub(crate) verifier: String,
    pub(crate) challenge: String,
}

impl OauthLoopback {
    pub(crate) async fn new() -> Result<Self, String> {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|error| format!("Mimir could not start the sign-in callback: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();
        let verifier = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Ok(Self {
            listener,
            redirect_uri: format!("http://127.0.0.1:{port}/callback"),
            state: uuid::Uuid::new_v4().simple().to_string(),
            verifier,
            challenge,
        })
    }

    pub(crate) async fn receive_code(&self) -> Result<String, String> {
        self.receive_code_with_timeout(Duration::from_secs(180))
            .await
    }

    async fn receive_code_with_timeout(&self, timeout: Duration) -> Result<String, String> {
        let (mut stream, _) = tokio::time::timeout(timeout, self.listener.accept())
            .await
            .map_err(|_| "Sign-in timed out. Try Connect again.".to_string())?
            .map_err(|error| format!("Mimir could not receive the sign-in callback: {error}"))?;
        let mut request = vec![0u8; 8192];
        let length = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut request))
            .await
            .map_err(|_| "The sign-in callback did not finish.".to_string())?
            .map_err(|error| error.to_string())?;
        let request = String::from_utf8_lossy(&request[..length]);
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .ok_or_else(|| "The sign-in callback was invalid.".to_string())?;
        let callback = url::Url::parse(&format!("http://127.0.0.1{target}"))
            .map_err(|_| "The sign-in callback URL was invalid.".to_string())?;
        let values = callback
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect::<std::collections::HashMap<_, _>>();
        let success = values.get("state") == Some(&self.state) && values.contains_key("code");
        let body = if success {
            "<!doctype html><meta charset=\"utf-8\"><title>Mimir connected</title><p>Sign-in response received. Return to Mimir to check completion.</p>"
        } else {
            "<!doctype html><meta charset=\"utf-8\"><title>Mimir sign-in stopped</title><p>Mimir could not complete sign-in. Return to Mimir and try again.</p>"
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes()).await;
        if values.get("state") != Some(&self.state) {
            return Err("Sign-in returned an invalid security state. Try again.".into());
        }
        if let Some(error) = values.get("error") {
            return Err(format!("Sign-in was not completed: {error}"));
        }
        values
            .get("code")
            .cloned()
            .ok_or_else(|| "Sign-in returned no authorization code.".to_string())
    }
}

pub(crate) fn open_system_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", ""]);
        command
    };
    command
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Mimir could not open the sign-in page: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn callback(query: &str, valid_state: bool) -> (Result<String, String>, String) {
        let oauth = OauthLoopback::new().await.unwrap();
        let address = oauth.listener.local_addr().unwrap();
        let state = if valid_state {
            oauth.state.clone()
        } else {
            "wrong-state".into()
        };
        let request =
            format!("GET /callback?state={state}&{query} HTTP/1.1\r\nHost: localhost\r\n\r\n");
        let client = async {
            let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
            socket.write_all(request.as_bytes()).await.unwrap();
            let mut response = vec![0; 4096];
            let count = socket.read(&mut response).await.unwrap();
            String::from_utf8(response[..count].to_vec()).unwrap()
        };
        tokio::join!(oauth.receive_code(), client)
    }

    #[tokio::test]
    async fn callback_accepts_matching_state_and_does_not_echo_code() {
        let (result, page) = callback("code=test-code", true).await;
        assert_eq!(result.unwrap(), "test-code");
        assert!(!page.contains("test-code"));
        assert!(page.contains("check completion"));
    }

    #[tokio::test]
    async fn callback_rejects_wrong_state_denial_and_missing_code() {
        assert!(callback("code=test-code", false)
            .await
            .0
            .unwrap_err()
            .contains("security state"));
        assert!(callback("error=access_denied", true)
            .await
            .0
            .unwrap_err()
            .contains("access_denied"));
        assert!(callback("other=value", true)
            .await
            .0
            .unwrap_err()
            .contains("no authorization code"));
    }

    #[tokio::test]
    async fn callback_times_out_without_browser_input() {
        let oauth = OauthLoopback::new().await.unwrap();
        assert!(oauth
            .receive_code_with_timeout(Duration::from_millis(20))
            .await
            .unwrap_err()
            .contains("timed out"));
    }

    #[tokio::test]
    async fn cancellation_closes_callback_listener() {
        let oauth = OauthLoopback::new().await.unwrap();
        let address = oauth.listener.local_addr().unwrap();
        let (started, ready) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            started.send(()).unwrap();
            oauth.receive_code().await
        });
        ready.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(tokio::net::TcpStream::connect(address).await.is_err());
    }
}
