use super::*;

pub trait ModelArtifactDownloader: Send + Sync {
    fn download(
        &self,
        manifest: &ModelManifest,
        destination: &mut File,
        progress: &mut dyn FnMut(u64) -> Result<(), String>,
    ) -> Result<(), String>;
}

/// HTTPS-only downloader with bounded redirects and DNS pinning per hop.
///
/// Every connection resolves the hostname before the request, rejects private
/// and special-purpose addresses through `ModelDownloadUrl`, and pins reqwest
/// to those exact addresses. This closes the usual validate-then-resolve DNS
/// rebinding gap while retaining TLS hostname validation.
pub struct HttpsModelArtifactDownloader;

impl ModelArtifactDownloader for HttpsModelArtifactDownloader {
    fn download(
        &self,
        manifest: &ModelManifest,
        destination: &mut File,
        progress: &mut dyn FnMut(u64) -> Result<(), String>,
    ) -> Result<(), String> {
        let manifest_url = manifest.download_url.as_str().to_string();
        let expected_bytes = manifest.artifact_bytes;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| format!("Could not start the managed model downloader: {error}"))?;
        runtime.block_on(async {
            let mut current = Url::parse(&manifest_url)
                .map_err(|_| "Managed model manifest contains an invalid URL".to_string())?;
            for redirect_count in 0..=MAX_DOWNLOAD_REDIRECTS {
                let (host, addresses) = validated_download_destination(&current)?;
                let client = reqwest::Client::builder()
                    .redirect(Policy::none())
                    .https_only(true)
                    .user_agent("Mimir-Scribe/0.1")
                    .resolve_to_addrs(&host, &addresses)
                    .build()
                    .map_err(|error| {
                        redacted_reqwest_error("Could not configure model download TLS", &error)
                    })?;
                let response = client
                    .get(current.clone())
                    .send()
                    .await
                    .map_err(|error| {
                        redacted_reqwest_error("Managed model download failed", &error)
                    })?;

                if is_redirect(response.status()) {
                    if redirect_count == MAX_DOWNLOAD_REDIRECTS {
                        return Err("Managed model download exceeded the redirect limit".into());
                    }
                    let location = response
                        .headers()
                        .get(LOCATION)
                        .ok_or_else(|| {
                            "Managed model server returned a redirect without a destination"
                                .to_string()
                        })?
                        .to_str()
                        .map_err(|_| {
                            "Managed model server returned an invalid redirect destination"
                                .to_string()
                        })?;
                    current = current.join(location).map_err(|_| {
                        "Managed model server returned an invalid redirect destination".to_string()
                    })?;
                    continue;
                }

                if !response.status().is_success() {
                    return Err(format!(
                        "Managed model server returned HTTP {}",
                        response.status()
                    ));
                }
                if let Some(length) = response.content_length() {
                    if length != expected_bytes {
                        return Err(format!(
                            "Managed model server declared {length} bytes; expected {expected_bytes}"
                        ));
                    }
                }

                let mut received = 0_u64;
                let mut stream = response.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|error| {
                        redacted_reqwest_error("Managed model download was interrupted", &error)
                    })?;
                    received = received
                        .checked_add(chunk.len() as u64)
                        .ok_or_else(|| "Managed model download size overflow".to_string())?;
                    if received > expected_bytes {
                        return Err("Managed model download exceeded its declared size".into());
                    }
                    destination
                        .write_all(&chunk)
                        .map_err(|error| format!("Could not write the managed model: {error}"))?;
                    progress(chunk.len() as u64)?;
                }
                if received != expected_bytes {
                    return Err(format!(
                        "Managed model download ended at {received} bytes; expected {expected_bytes}"
                    ));
                }
                return Ok(());
            }
            Err("Managed model download exceeded the redirect limit".into())
        })
    }
}

fn redacted_reqwest_error(context: &str, error: &reqwest::Error) -> String {
    let category = if error.is_timeout() {
        "network timeout"
    } else if error.is_connect() {
        "connection failure"
    } else if error.is_body() {
        "response body failure"
    } else if error.is_decode() {
        "response decode failure"
    } else if error.is_request() {
        "request failure"
    } else {
        "network failure"
    };
    // reqwest's Display representation can include the complete request URL,
    // including a signed redirect query. Only a stable category may cross into
    // diagnostics or durable job state.
    format!("{context}: {category}")
}

fn is_redirect(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    )
}

fn validated_download_destination(url: &Url) -> Result<(String, Vec<SocketAddr>), String> {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Managed model redirects must remain HTTPS and cannot contain credentials or fragments"
                .into(),
        );
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Managed model URL has no hostname".to_string())?
        .to_ascii_lowercase();
    // Reuse config.rs's public-DNS validation without accepting the redirect's
    // (possibly signed) query string as a persisted manifest URL.
    ModelDownloadUrl::new(&format!("https://{host}/"))
        .map_err(|error| format!("Unsafe managed model destination: {error}"))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Managed model URL has no HTTPS port".to_string())?;
    let mut addresses = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|error| format!("Could not resolve managed model host: {error}"))?
        .collect::<Vec<_>>();
    addresses.sort_unstable();
    addresses.dedup();
    ModelDownloadUrl::new(&format!("https://{host}/"))
        .and_then(|validated| {
            validated.validate_resolved_addresses(addresses.iter().map(SocketAddr::ip))
        })
        .map_err(|error| format!("Unsafe managed model destination: {error}"))?;
    if addresses.is_empty() {
        return Err("Managed model hostname resolved to no addresses".into());
    }
    Ok((host, addresses))
}
