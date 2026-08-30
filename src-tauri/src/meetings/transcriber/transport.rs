use super::*;

pub(super) type PinnedWebSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

pub(super) async fn connect_openai_pinned(
    endpoint: &CustomSttEndpoint,
    credential: &str,
) -> Result<(PinnedWebSocket, SocketAddr), String> {
    let parsed = openai_transport_url(endpoint)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "approved OpenAI endpoint has no host".to_string())?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "approved OpenAI endpoint has no port".to_string())?;
    let addresses = timeout(CONNECT_TIMEOUT, lookup_host((host, port)))
        .await
        .map_err(|_| "OpenAI DNS lookup timed out".to_string())?
        .map_err(|_| "OpenAI DNS lookup failed".to_string())?
        .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.len() > MAX_DNS_ADDRESSES {
        return Err("OpenAI DNS returned an invalid address count".into());
    }
    endpoint
        .validate_resolved_addresses(addresses.iter().map(SocketAddr::ip))
        .map_err(|error| error.to_string())?;

    let mut last_error = None;
    for address in addresses {
        let tcp = match timeout(CONNECT_TIMEOUT, TcpStream::connect(address)).await {
            Ok(Ok(tcp)) => tcp,
            Ok(Err(_)) => {
                last_error = Some("TCP connection failed");
                continue;
            }
            Err(_) => {
                last_error = Some("TCP connection timed out");
                continue;
            }
        };
        tcp.set_nodelay(true)
            .map_err(|_| "could not configure OpenAI connection".to_string())?;
        let mut request = parsed
            .as_str()
            .into_client_request()
            .map_err(|_| "could not build OpenAI handshake".to_string())?;
        let value = HeaderValue::from_str(&format!("Bearer {credential}"))
            .map_err(|_| "native OpenAI credential contains invalid header bytes".to_string())?;
        request.headers_mut().insert(AUTHORIZATION, value);
        let configuration = WebSocketConfig::default()
            .write_buffer_size(64 * 1024)
            .max_write_buffer_size(512 * 1024)
            .max_message_size(Some(MAX_PROVIDER_RESPONSE_BYTES))
            .max_frame_size(Some(MAX_PROVIDER_FRAME_BYTES));
        match timeout(
            CONNECT_TIMEOUT,
            client_async_tls_with_config(request, tcp, Some(configuration), None),
        )
        .await
        {
            Ok(Ok((websocket, _))) => return Ok((websocket, address)),
            Ok(Err(_)) => last_error = Some("TLS/WebSocket handshake failed"),
            Err(_) => last_error = Some("TLS/WebSocket handshake timed out"),
        }
    }
    Err(format!(
        "OpenAI connection failed ({})",
        last_error.unwrap_or("no validated address succeeded")
    ))
}

pub(super) fn openai_transport_url(endpoint: &CustomSttEndpoint) -> Result<Url, String> {
    let mut parsed =
        Url::parse(endpoint.as_str()).map_err(|_| "approved OpenAI endpoint is invalid")?;
    // OpenAI uses this wire-only selector to create a dedicated transcription
    // session. Keep it out of persisted/user-facing configuration so the
    // approved endpoint remains stable and credential binding stays scoped to
    // the canonical host/path.
    parsed
        .query_pairs_mut()
        .clear()
        .append_pair("intent", "transcription");
    Ok(parsed)
}

pub(super) async fn connect_pinned(
    endpoint: &CustomSttEndpoint,
    credential: Option<&str>,
) -> Result<(PinnedWebSocket, SocketAddr), String> {
    let parsed =
        Url::parse(endpoint.as_str()).map_err(|_| "approved custom endpoint is invalid")?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "approved custom endpoint has no host".to_string())?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "approved custom endpoint has no port".to_string())?;
    let addresses = timeout(CONNECT_TIMEOUT, lookup_host((host, port)))
        .await
        .map_err(|_| "custom provider DNS lookup timed out".to_string())?
        .map_err(|_| "custom provider DNS lookup failed".to_string())?
        .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.len() > MAX_DNS_ADDRESSES {
        return Err("custom provider DNS returned an invalid address count".into());
    }
    endpoint
        .validate_resolved_addresses(addresses.iter().map(SocketAddr::ip))
        .map_err(|error| error.to_string())?;
    connect_prevalidated_addresses(endpoint, credential, addresses, None).await
}

/// Opens addresses already pinned to the approved endpoint. Production calls
/// this only after public-address validation above. The test connector injects
/// loopback plus a generated CA to exercise the real TLS/WebSocket path
/// deterministically without weakening production routing.
pub(super) async fn connect_prevalidated_addresses(
    endpoint: &CustomSttEndpoint,
    credential: Option<&str>,
    addresses: Vec<SocketAddr>,
    connector: Option<WebSocketConnector>,
) -> Result<(PinnedWebSocket, SocketAddr), String> {
    let mut last_error = None;
    for address in addresses {
        let tcp = match timeout(CONNECT_TIMEOUT, TcpStream::connect(address)).await {
            Ok(Ok(tcp)) => tcp,
            Ok(Err(_)) => {
                last_error = Some("TCP connection failed");
                continue;
            }
            Err(_) => {
                last_error = Some("TCP connection timed out");
                continue;
            }
        };
        tcp.set_nodelay(true)
            .map_err(|_| "could not configure provider connection".to_string())?;
        let mut request = endpoint
            .as_str()
            .into_client_request()
            .map_err(|_| "could not build custom provider handshake".to_string())?;
        request.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_static(STT_WIRE_CONTRACT),
        );
        if let Some(token) = credential {
            let value = HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| "native credential contains invalid header bytes".to_string())?;
            request.headers_mut().insert(AUTHORIZATION, value);
        }
        let configuration = WebSocketConfig::default()
            .write_buffer_size(64 * 1024)
            .max_write_buffer_size(512 * 1024)
            .max_message_size(Some(MAX_PROVIDER_RESPONSE_BYTES))
            .max_frame_size(Some(MAX_PROVIDER_FRAME_BYTES));
        match timeout(
            CONNECT_TIMEOUT,
            client_async_tls_with_config(request, tcp, Some(configuration), connector.clone()),
        )
        .await
        {
            Ok(Ok((websocket, response))) => {
                let selected = response
                    .headers()
                    .get("sec-websocket-protocol")
                    .and_then(|value| value.to_str().ok());
                if selected != Some(STT_WIRE_CONTRACT) {
                    return Err(
                        "custom provider did not select the mimir.stt.v1 subprotocol".into(),
                    );
                }
                return Ok((websocket, address));
            }
            Ok(Err(_)) => last_error = Some("TLS/WebSocket handshake failed"),
            Err(_) => last_error = Some("TLS/WebSocket handshake timed out"),
        }
    }
    Err(format!(
        "could not connect to any approved DNS address: {}",
        last_error.unwrap_or("connection unavailable")
    ))
}
