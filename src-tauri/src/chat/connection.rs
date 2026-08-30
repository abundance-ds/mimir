use super::*;

pub(super) async fn supervise_connection(
    inner: Arc<ChatInner>,
    generation: u64,
    config: ChatConfig,
    password: String,
    mut receiver: mpsc::UnboundedReceiver<ChatOutbound>,
) {
    let runtime = ChatRuntime {
        inner: inner.clone(),
    };
    let mut attempt = 0_u32;
    loop {
        if inner.generation.load(Ordering::Acquire) != generation {
            return;
        }
        let state = if attempt == 0 {
            ChatConnectionState::Connecting
        } else {
            ChatConnectionState::Reconnecting
        };
        runtime.update_status(ChatStatus::new(&config, state));
        match run_session(&runtime, generation, &config, &password, &mut receiver).await {
            Ok(SessionEnd::Shutdown) => return,
            Ok(SessionEnd::Disconnected) => {}
            Err(error) => {
                let mut status = ChatStatus::new(&config, ChatConnectionState::Reconnecting);
                status.diagnostic = Some(error);
                runtime.update_status(status);
            }
        }
        if inner.generation.load(Ordering::Acquire) != generation {
            return;
        }
        attempt = attempt.saturating_add(1);
        let delay = match attempt {
            1 => 1,
            2 => 2,
            3 => 5,
            4 => 10,
            _ => 30,
        };
        tokio::time::sleep(Duration::from_secs(delay)).await;
    }
}

enum SessionEnd {
    Shutdown,
    Disconnected,
}

async fn run_session(
    runtime: &ChatRuntime,
    generation: u64,
    config: &ChatConfig,
    password: &str,
    receiver: &mut mpsc::UnboundedReceiver<ChatOutbound>,
) -> Result<SessionEnd, String> {
    let mut request = config
        .endpoint
        .as_str()
        .into_client_request()
        .map_err(|error| format!("Invalid chat endpoint: {error}"))?;
    let origin = websocket_origin(&config.endpoint)?;
    request.headers_mut().insert(
        "Origin",
        HeaderValue::from_str(&origin).map_err(|error| error.to_string())?,
    );
    let (mut socket, _) = connect_async(request)
        .await
        .map_err(|error| format!("Could not connect to chat: {error}"))?;
    send_line(&mut socket, "CAP LS 302").await?;
    send_line(&mut socket, &format!("NICK {}", config.account)).await?;
    send_line(
        &mut socket,
        &format!("USER {} 0 * :{}", config.account, config.display_name),
    )
    .await?;
    let mut session = SessionState::default();

    loop {
        if runtime.inner.generation.load(Ordering::Acquire) != generation {
            let _ = socket.close(None).await;
            return Ok(SessionEnd::Shutdown);
        }
        tokio::select! {
            outbound = receiver.recv() => {
                match outbound {
                    Some(ChatOutbound::Lines(lines)) => {
                        for line in lines {
                            send_line(&mut socket, &line).await?;
                        }
                    }
                    Some(ChatOutbound::Shutdown) | None => {
                        let _ = send_line(&mut socket, "QUIT :Mimir disconnected").await;
                        let _ = socket.close(None).await;
                        return Ok(SessionEnd::Shutdown);
                    }
                }
            }
            incoming = socket.next() => {
                match incoming {
                    Some(Ok(WebSocketMessage::Text(text))) => {
                        for line in text.lines() {
                            let outgoing = handle_irc_line(
                                runtime,
                                config,
                                password,
                                &mut session,
                                line.trim_end_matches('\r'),
                            )?;
                            for line in outgoing {
                                send_line(&mut socket, &line).await?;
                            }
                        }
                    }
                    Some(Ok(WebSocketMessage::Ping(payload))) => {
                        socket.send(WebSocketMessage::Pong(payload))
                            .await
                            .map_err(|error| error.to_string())?;
                    }
                    Some(Ok(WebSocketMessage::Close(_))) | None => {
                        return Ok(SessionEnd::Disconnected);
                    }
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(format!("Chat connection closed: {error}")),
                }
            }
        }
    }
}

pub(super) async fn send_line<S>(socket: &mut S, line: &str) -> Result<(), String>
where
    S: futures_util::Sink<WebSocketMessage> + Unpin,
    S::Error: std::fmt::Display,
{
    socket
        .send(WebSocketMessage::Text(format!("{line}\r\n").into()))
        .await
        .map_err(|error| error.to_string())
}
