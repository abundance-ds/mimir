use super::*;

pub(super) fn handle_irc_line(
    runtime: &ChatRuntime,
    config: &ChatConfig,
    password: &str,
    session: &mut SessionState,
    line: &str,
) -> Result<Vec<String>, String> {
    let message = match IrcMessage::from_str(line) {
        Ok(message) => message,
        // Extensions occasionally add numeric replies unknown to irc-proto
        // (for example WHOIS account metadata). They are informational and
        // must not tear down an otherwise healthy chat session.
        Err(_) if has_unknown_numeric_command(line) => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut outgoing = Vec::new();
    match &message.command {
        Command::PING(server, second) => {
            outgoing.push(match second {
                Some(second) => format!("PONG {server} :{second}"),
                None => format!("PONG :{server}"),
            });
        }
        Command::CAP(_, CapSubCommand::LS, continuation, capabilities) => {
            if let Some(capabilities) = cap_payload(continuation, capabilities) {
                if !session.caps.is_empty() {
                    session.caps.push(' ');
                }
                session.caps.push_str(capabilities);
            }
            if continuation.as_deref() != Some("*") && !session.requested_caps {
                for required in [
                    "sasl",
                    "message-tags",
                    "server-time",
                    "batch",
                    "draft/chathistory",
                    "draft/event-playback",
                    "draft/message-redaction",
                    "account-notify",
                    "away-notify",
                    "extended-join",
                ] {
                    if !session
                        .caps
                        .split_whitespace()
                        .any(|capability| capability.split('=').next() == Some(required))
                    {
                        return Err(format!(
                            "Chat server does not advertise required capability {required}."
                        ));
                    }
                }
                session.requested_caps = true;
                outgoing.push(format!("CAP REQ :{REQUESTED_CAPABILITIES}"));
            }
        }
        Command::CAP(_, CapSubCommand::ACK, continuation, capabilities)
            if cap_payload(continuation, capabilities)
                .unwrap_or_default()
                .split_whitespace()
                .any(|capability| capability == "sasl") =>
        {
            outgoing.push("AUTHENTICATE PLAIN".into());
        }
        Command::CAP(_, CapSubCommand::NAK, continuation, capabilities) => {
            return Err(format!(
                "Chat server rejected required capabilities: {}",
                cap_payload(continuation, capabilities).unwrap_or("unknown")
            ));
        }
        Command::AUTHENTICATE(challenge) if challenge == "+" => {
            let payload = format!("\0{}\0{password}", config.account);
            outgoing.push(format!("AUTHENTICATE {}", STANDARD.encode(payload)));
        }
        Command::Response(Response::RPL_SASLSUCCESS, _) => {
            outgoing.push("CAP END".into());
        }
        Command::Response(
            Response::ERR_SASLFAIL | Response::ERR_SASLTOOLONG | Response::ERR_SASLABORT,
            _,
        ) => {
            let mut status = ChatStatus::new(config, ChatConnectionState::Error);
            status.diagnostic = Some("Chat authentication failed.".into());
            runtime.update_status(status);
        }
        Command::Response(Response::RPL_WELCOME, _) => {
            let mut status = ChatStatus::new(config, ChatConnectionState::Connected);
            // This owned Ergo deployment grants only the RELAYMSG capability
            // and uses the already verified SASL passphrase for OPER. Resumed
            // always-on sessions may not repeat numeric 381.
            status.relay_ready = true;
            runtime.update_status(status);
            outgoing.push(format!("OPER {} {password}", config.account));
            if !config.display_name.trim().is_empty() {
                outgoing.push(format!(
                    "SETNAME :{}",
                    clean_irc_parameter(&config.display_name)
                ));
            }
            let mut channels = runtime.inner.database.known_channels()?;
            if !channels.iter().any(|channel| channel == "#general") {
                channels.insert(0, "#general".into());
            }
            for channel in channels {
                outgoing.push(format!("JOIN {channel}"));
            }
            outgoing.push(format!(
                "CHATHISTORY TARGETS timestamp=1970-01-01T00:00:00.000Z timestamp={} 100",
                timestamp()
            ));
        }
        Command::Response(Response::RPL_YOUREOPER, _) => {
            let mut status = runtime.status();
            status.relay_ready = true;
            runtime.update_status(status);
        }
        Command::Response(
            Response::ERR_PASSWDMISMATCH | Response::ERR_NOPRIVILEGES | Response::ERR_NOOPERHOST,
            _,
        ) => {
            let mut status = runtime.status();
            status.relay_ready = false;
            status.diagnostic =
                Some("Agent messages will use visible labels instead of relay identity.".into());
            runtime.update_status(status);
        }
        Command::Raw(command, arguments)
            if command.eq_ignore_ascii_case("FAIL")
                && arguments
                    .first()
                    .is_some_and(|value| value.eq_ignore_ascii_case("RELAYMSG")) =>
        {
            let mut status = runtime.status();
            status.relay_ready = false;
            status.diagnostic =
                Some("Agent messages will use visible labels instead of relay identity.".into());
            runtime.update_status(status);
        }
        Command::JOIN(target, extended_account, _) => {
            if let Some(nick) = message.source_nickname() {
                let account = tag(&message, "account")
                    .or_else(|| extended_account.clone())
                    .filter(|account| account != "*");
                runtime
                    .inner
                    .database
                    .upsert_member(target, nick, account.as_deref(), None)?;
            }
            if message
                .source_nickname()
                .is_some_and(|nick| nick.eq_ignore_ascii_case(&config.account))
            {
                let now = timestamp();
                runtime.inner.database.ensure_target(
                    target,
                    ChatTargetKind::Channel,
                    true,
                    Some(&now),
                )?;
                if session.history_requested.insert(target.to_lowercase()) {
                    outgoing.push(format!("CHATHISTORY LATEST {target} * 100"));
                }
                runtime.emit(ChatEvent::TargetsChanged);
            }
        }
        Command::PART(target, _) => {
            if let Some(nick) = message.source_nickname() {
                runtime.inner.database.remove_member(target, nick)?;
            }
            if message
                .source_nickname()
                .is_some_and(|nick| nick.eq_ignore_ascii_case(&config.account))
            {
                runtime.inner.database.set_joined(target, false)?;
                runtime.emit(ChatEvent::TargetsChanged);
            }
        }
        Command::QUIT(_) => {
            if let Some(nick) = message.source_nickname() {
                runtime.inner.database.remove_member_everywhere(nick)?;
                runtime.emit(ChatEvent::TargetsChanged);
            }
        }
        Command::TOPIC(target, Some(topic)) => {
            runtime.inner.database.set_topic(target, topic)?;
            runtime.emit(ChatEvent::TargetsChanged);
        }
        Command::Response(Response::RPL_TOPIC, arguments) if arguments.len() >= 3 => {
            let target = &arguments[arguments.len() - 2];
            let topic = &arguments[arguments.len() - 1];
            runtime.inner.database.set_topic(target, topic)?;
            runtime.emit(ChatEvent::TargetsChanged);
        }
        Command::Response(Response::RPL_NAMREPLY, arguments) if arguments.len() >= 4 => {
            let target = arguments[arguments.len() - 2].to_lowercase();
            let members = session.names.entry(target).or_default();
            for member in arguments
                .last()
                .into_iter()
                .flat_map(|names| names.split_whitespace())
            {
                members.insert(
                    member
                        .trim_start_matches(['~', '&', '@', '%', '+'])
                        .to_lowercase(),
                );
            }
        }
        Command::Response(Response::RPL_ENDOFNAMES, arguments) if arguments.len() >= 2 => {
            let target = arguments[arguments.len() - 2].to_lowercase();
            if let Some(members) = session.names.remove(&target) {
                let members = members.into_iter().collect::<Vec<_>>();
                runtime.inner.database.replace_members(&target, &members)?;
                for member in &members {
                    outgoing.push(format!("WHOIS {member}"));
                }
                runtime.emit(ChatEvent::TargetsChanged);
            }
        }
        Command::Response(Response::RPL_WHOISUSER, arguments) if arguments.len() >= 6 => {
            let nick = &arguments[1];
            let display_name = arguments.last().map(String::as_str).unwrap_or(nick);
            runtime
                .inner
                .database
                .update_member_profile(nick, display_name)?;
            runtime.emit(ChatEvent::TargetsChanged);
        }
        Command::AWAY(reason) => {
            if let Some(nick) = message.source_nickname() {
                runtime.inner.database.update_member_presence(
                    nick,
                    reason.is_some(),
                    reason.as_deref(),
                )?;
                runtime.emit(ChatEvent::TargetsChanged);
            }
        }
        Command::Response(Response::RPL_AWAY, arguments) if arguments.len() >= 3 => {
            let nick = &arguments[arguments.len() - 2];
            let reason = arguments.last().map(String::as_str);
            runtime
                .inner
                .database
                .update_member_presence(nick, true, reason)?;
            runtime.emit(ChatEvent::TargetsChanged);
        }
        Command::BATCH(reference, Some(BatchSubCommand::CUSTOM(kind)), _)
            if reference.starts_with('+') && kind.eq_ignore_ascii_case("chathistory") =>
        {
            session
                .history_batches
                .insert(reference.trim_start_matches('+').to_string());
        }
        Command::BATCH(reference, Some(BatchSubCommand::CUSTOM(kind)), arguments)
            if reference.starts_with('+') && kind.eq_ignore_ascii_case("draft/multiline") =>
        {
            let Some(target) = arguments.as_ref().and_then(|arguments| arguments.first()) else {
                return Ok(outgoing);
            };
            let historical = tag(&message, "batch")
                .as_deref()
                .is_some_and(|batch| session.history_batches.contains(batch));
            if session.multiline_batches.len() < MAX_MULTILINE_BATCHES {
                session.multiline_batches.insert(
                    reference.trim_start_matches('+').to_string(),
                    PendingMultiline {
                        target: target.clone(),
                        historical,
                        opening: message.clone(),
                        chunks: Vec::new(),
                        bytes: 0,
                    },
                );
            }
        }
        Command::BATCH(reference, None, _) if reference.starts_with('-') => {
            let reference = reference.trim_start_matches('-');
            session.history_batches.remove(reference);
            if let Some(pending) = session.multiline_batches.remove(reference) {
                let mut body = String::new();
                for (chunk, concatenate) in &pending.chunks {
                    if !body.is_empty() && !concatenate {
                        body.push('\n');
                    }
                    body.push_str(chunk);
                }
                if !body.trim().is_empty() {
                    ingest_message(
                        runtime,
                        config,
                        &pending.opening,
                        &pending.target,
                        &body,
                        pending.historical,
                    )?;
                }
            }
        }
        Command::PRIVMSG(target, body) => {
            let batch = tag(&message, "batch");
            if let Some(pending) = batch
                .as_deref()
                .and_then(|batch| session.multiline_batches.get_mut(batch))
            {
                if pending.bytes + body.len() <= MAX_MULTILINE_BYTES {
                    let concatenate = has_tag(&message, "draft/multiline-concat")
                        || has_tag(&message, "+draft/multiline-concat");
                    pending.bytes += body.len();
                    pending.chunks.push((body.clone(), concatenate));
                }
                return Ok(outgoing);
            }
            let historical = batch
                .as_deref()
                .is_some_and(|batch| session.history_batches.contains(batch));
            ingest_message(runtime, config, &message, target, body, historical)?;
        }
        Command::Raw(command, arguments)
            if command.eq_ignore_ascii_case("TAGMSG") && !arguments.is_empty() =>
        {
            ingest_tag_message(runtime, config, &message, &arguments[0])?;
        }
        Command::Raw(command, arguments)
            if command.eq_ignore_ascii_case("REDACT") && arguments.len() >= 2 =>
        {
            ingest_redaction(runtime, config, &message, &arguments[0], &arguments[1])?;
        }
        Command::Raw(command, arguments)
            if command.eq_ignore_ascii_case("CHATHISTORY")
                && arguments
                    .first()
                    .is_some_and(|value| value.eq_ignore_ascii_case("TARGETS"))
                && arguments.len() >= 2 =>
        {
            let target = normalize_target(&arguments[1])?;
            let kind = if target.starts_with(['#', '&']) {
                ChatTargetKind::Channel
            } else {
                ChatTargetKind::Direct
            };
            let now = timestamp();
            runtime.inner.database.ensure_target(
                &target,
                kind,
                target.starts_with(['#', '&']),
                Some(&now),
            )?;
            runtime.emit(ChatEvent::TargetsChanged);
        }
        _ => {}
    }
    Ok(outgoing)
}

pub(super) fn cap_payload<'a>(
    continuation_or_payload: &'a Option<String>,
    payload: &'a Option<String>,
) -> Option<&'a str> {
    payload.as_deref().or_else(|| {
        continuation_or_payload
            .as_deref()
            .filter(|value| *value != "*")
    })
}
