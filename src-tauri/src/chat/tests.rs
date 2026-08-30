use super::*;

fn test_runtime() -> (tempfile::TempDir, ChatRuntime) {
    let directory = tempfile::tempdir().unwrap();
    let config_path = directory.path().join("chat.json");
    let database = ChatDatabase::open(directory.path().join("chat.sqlite3")).unwrap();
    let config = ChatConfig::default();
    let runtime = ChatRuntime {
        inner: Arc::new(ChatInner {
            config_path,
            credential_path: directory.path().join("chat.credential"),
            database,
            status: RwLock::new(ChatStatus::new(&config, ChatConnectionState::Connected)),
            app: Mutex::new(None),
            outbound: Mutex::new(None),
            generation: AtomicU64::new(0),
            active_target: RwLock::new(None),
        }),
    };
    (directory, runtime)
}

#[test]
fn chunking_survives_multibyte_whitespace_at_the_wrap_point() {
    // U+00A0 after the midpoint of a >350-byte line used to make the
    // word-wrap adjustment split inside the character and panic.
    let text = format!("{}\u{a0}{}", "a".repeat(300), "b".repeat(100));
    let chunks = split_utf8(&text, IRC_CHUNK_BYTES);
    assert_eq!(chunks.concat(), text);
    let ideographic = format!("{}\u{3000}{}", "語".repeat(100), "b".repeat(100));
    let chunks = split_utf8(&ideographic, IRC_CHUNK_BYTES);
    assert_eq!(chunks.concat(), ideographic);
}

#[test]
fn incoming_multiline_batches_assemble_into_one_message() {
    let (_directory, runtime) = test_runtime();
    let config = ChatConfig::default();
    let mut session = SessionState::default();
    for line in [
        "@msgid=ml1;time=2026-01-01T00:00:00.000Z;account=anna \
             :anna!~u@example BATCH +b1 draft/multiline #general",
        "@batch=b1 :anna!~u@example PRIVMSG #general :first line",
        "@batch=b1;draft/multiline-concat :anna!~u@example PRIVMSG #general : continued",
        "@batch=b1 :anna!~u@example PRIVMSG #general :second line",
        ":anna!~u@example BATCH -b1",
    ] {
        handle_irc_line(&runtime, &config, "", &mut session, line).unwrap();
    }
    let messages = runtime.messages("#general", None, 10).unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].id, "ml1");
    assert_eq!(messages[0].body, "first line continued\nsecond line");
    assert_eq!(messages[0].server_time, "2026-01-01T00:00:00.000Z");
    assert!(session.multiline_batches.is_empty());

    // Replaying the same batch inside a chathistory batch dedupes on the
    // stable msgid instead of accumulating synthetic duplicates.
    for line in [
        ":server BATCH +hist chathistory #general",
        "@batch=hist;msgid=ml1;time=2026-01-01T00:00:00.000Z;account=anna \
             :anna!~u@example BATCH +b2 draft/multiline #general",
        "@batch=b2 :anna!~u@example PRIVMSG #general :first line",
        "@batch=b2;draft/multiline-concat :anna!~u@example PRIVMSG #general : continued",
        "@batch=b2 :anna!~u@example PRIVMSG #general :second line",
        ":server BATCH -b2",
        ":server BATCH -hist",
    ] {
        handle_irc_line(&runtime, &config, "", &mut session, line).unwrap();
    }
    assert_eq!(runtime.messages("#general", None, 10).unwrap().len(), 1);
}

#[test]
fn failed_oper_and_relaymsg_disable_relay_identity() {
    let (_directory, runtime) = test_runtime();
    let config = ChatConfig::default();
    let mut session = SessionState::default();
    {
        let mut status = runtime.status();
        status.relay_ready = true;
        *write_lock(&runtime.inner.status) = status;
    }
    handle_irc_line(
        &runtime,
        &config,
        "",
        &mut session,
        ":server 491 waqr :No O-lines for your host",
    )
    .unwrap();
    assert!(!runtime.status().relay_ready);

    {
        let mut status = runtime.status();
        status.relay_ready = true;
        *write_lock(&runtime.inner.status) = status;
    }
    handle_irc_line(
        &runtime,
        &config,
        "",
        &mut session,
        ":server FAIL RELAYMSG NOT_OPER :You are not an operator",
    )
    .unwrap();
    assert!(!runtime.status().relay_ready);
}

#[test]
fn message_chunking_preserves_utf8_and_reply_tags() {
    let text = format!("hello\n{} world", "å".repeat(400));
    let lines = human_lines("#general", &text, Some("msg-1"));
    assert!(lines[0].starts_with("@+reply=msg-1 BATCH +mimir"));
    assert!(lines
        .iter()
        .any(|line| line.contains("draft/multiline-concat")));
    assert!(lines.last().unwrap().starts_with("BATCH -mimir"));
    assert!(lines.iter().all(|line| line.len() < 512));
}

#[test]
fn client_only_tag_values_are_escaped_before_transport() {
    let prefix = tags_prefix(
        Some("reply\\id"),
        Some("codex"),
        Some("agent:one; workspace\nnext"),
    );
    assert_eq!(
        prefix,
        r"@+reply=reply\\id;+shoulde.rs/agent=codex;+shoulde.rs/activity=agent:one\:\sworkspace\nnext "
    );
}

#[test]
fn agent_messages_use_relay_when_ready_and_visible_fallback_otherwise() {
    let relay = agent_lines(
        "waqr",
        "#general",
        "done",
        None,
        "Codex",
        Some("agent:one"),
        true,
    );
    assert_eq!(
        relay,
        vec![
            "@+shoulde.rs/agent=codex;+shoulde.rs/activity=agent:one \
                 RELAYMSG #general waqr/codex :done"
        ]
    );
    let fallback = agent_lines("waqr", "#general", "done", None, "Codex", None, false);
    assert!(fallback[0].contains("PRIVMSG #general :[codex] done"));
}

#[test]
fn target_and_endpoint_validation_is_deliberately_small() {
    assert_eq!(normalize_channel("Product").unwrap(), "#product");
    assert!(normalize_channel("#bad room").is_err());
    assert!(validate_config(&ChatConfig::default()).is_ok());
    assert!(validate_config(&ChatConfig {
        endpoint: "ws://example.com/webirc".into(),
        ..ChatConfig::default()
    })
    .is_err());
}

#[cfg(any(not(target_os = "macos"), debug_assertions))]
#[test]
fn file_credential_round_trip_is_owner_only_and_target_bound() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("chat.credential");
    let config = ChatConfig::default();

    store_credential(&path, &config, "correct horse battery staple").unwrap();
    assert_eq!(
        load_credential(&path, &config).unwrap().as_deref(),
        Some("correct horse battery staple")
    );

    let other_account = ChatConfig {
        account: "someone-else".into(),
        ..config
    };
    assert_eq!(load_credential(&path, &other_account).unwrap(), None);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn irc_message_ingestion_reads_reply_and_relay_identity() {
    let parsed = IrcMessage::from_str(
        "@msgid=m1;time=2026-01-01T00:00:00.000Z;+reply=m0;draft/relaymsg=waqr \
             :waqr/codex!~u@example PRIVMSG #general :done",
    )
    .unwrap();
    assert_eq!(tag(&parsed, "msgid").as_deref(), Some("m1"));
    assert_eq!(tag(&parsed, "+reply").as_deref(), Some("m0"));
    assert_eq!(parsed.source_nickname(), Some("waqr/codex"));
}

#[test]
fn synced_message_events_materialize_for_people_and_agents() {
    let (_directory, runtime) = test_runtime();
    let config = ChatConfig::default();
    let original = IrcMessage::from_str(
        "@msgid=m1;time=2026-01-01T00:00:00.000Z;account=anna \
             :anna!~u@example PRIVMSG #general :hello @waqr",
    )
    .unwrap();
    ingest_message(
        &runtime,
        &config,
        &original,
        "#general",
        "hello @waqr",
        false,
    )
    .unwrap();
    assert!(runtime.messages("#general", None, 10).unwrap()[0].mentioned);

    let edit = IrcMessage::from_str(
        "@msgid=e1;time=2026-01-01T00:00:01.000Z;account=anna;\
             +shoulde.rs/edit=m1 :anna!~u@example PRIVMSG #general :edited",
    )
    .unwrap();
    ingest_message(&runtime, &config, &edit, "#general", "edited", false).unwrap();

    let reaction = IrcMessage::from_str(
        "@msgid=r1;time=2026-01-01T00:00:02.000Z;account=waqr;\
             +reply=m1;+draft/react=👍 :waqr!~u@example TAGMSG #general",
    )
    .unwrap();
    ingest_tag_message(&runtime, &config, &reaction, "#general").unwrap();
    let materialized = runtime.messages("#general", None, 10).unwrap()[0].clone();
    assert_eq!(materialized.body, "edited");
    assert!(materialized.edited_at.is_some());
    assert!(!materialized.mentioned);
    assert_eq!(materialized.reactions[0].value, "👍");
    assert!(materialized.reactions[0].own);

    let redaction =
        IrcMessage::from_str("@time=2026-01-01T00:00:03.000Z :anna!~u@example REDACT #general m1")
            .unwrap();
    ingest_redaction(&runtime, &config, &redaction, "#general", "m1").unwrap();
    let deleted = runtime.messages("#general", None, 10).unwrap()[0].clone();
    assert!(deleted.deleted);
    assert!(deleted.body.is_empty());
    assert!(deleted.reactions.is_empty());
}

#[test]
fn mentions_require_an_account_word_and_reactions_stay_small() {
    assert!(mentions_account("please ask @Waqr about it", "waqr"));
    assert!(!mentions_account("mail waqr@example.com", "waqr"));
    assert!(normalize_reaction("👍").is_ok());
    assert!(normalize_reaction("two words").is_err());
}

#[test]
fn attachment_tags_become_canonical_authenticated_file_metadata() {
    let parsed = IrcMessage::from_str(
            "@msgid=m1;+shoulde.rs/file=file-one;\
             +shoulde.rs/file-name=launch.pdf;+shoulde.rs/file-size=42;\
             +shoulde.rs/file-type=application/pdf;\
             +shoulde.rs/file-sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
             :anna!~u@example PRIVMSG #general :📎 launch.pdf",
        )
        .unwrap();
    let attachments = attachment_from_tags(&ChatConfig::default(), &parsed);
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0].name, "launch.pdf");
    assert_eq!(attachments[0].url, "https://chat.shoulde.rs/files/file-one",);
    assert_eq!(
            attachment_message_line("#general", &attachments[0]),
            "@+shoulde.rs/file=file-one;+shoulde.rs/file-name=launch.pdf;\
             +shoulde.rs/file-size=42;+shoulde.rs/file-type=application/pdf;\
             +shoulde.rs/file-sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
             PRIVMSG #general :📎 launch.pdf",
        );
}

#[test]
fn cap_payload_handles_single_and_multiline_server_forms() {
    let single = IrcMessage::from_str(":server CAP * LS :sasl batch server-time").unwrap();
    match single.command {
        Command::CAP(_, CapSubCommand::LS, continuation, payload) => {
            assert_eq!(
                cap_payload(&continuation, &payload),
                Some("sasl batch server-time")
            );
        }
        other => panic!("unexpected command: {other:?}"),
    }
    let multiline = IrcMessage::from_str(":server CAP * LS * :sasl batch server-time").unwrap();
    match multiline.command {
        Command::CAP(_, CapSubCommand::LS, continuation, payload) => {
            assert_eq!(continuation.as_deref(), Some("*"));
            assert_eq!(
                cap_payload(&continuation, &payload),
                Some("sasl batch server-time")
            );
        }
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn away_notifications_materialize_as_coarse_member_presence() {
    let (_directory, runtime) = test_runtime();
    let config = ChatConfig::default();
    runtime
        .inner
        .database
        .upsert_member("#general", "anna", Some("anna"), Some("Anna"))
        .unwrap();
    let mut session = SessionState::default();

    handle_irc_line(
        &runtime,
        &config,
        "",
        &mut session,
        ":anna!~u@example AWAY :User is currently disconnected",
    )
    .unwrap();
    let away = runtime.members(Some("#general")).unwrap().remove(0);
    assert!(away.away);
    assert_eq!(
        away.away_message.as_deref(),
        Some("User is currently disconnected")
    );

    handle_irc_line(&runtime, &config, "", &mut session, ":anna!~u@example AWAY").unwrap();
    assert!(!runtime.members(Some("#general")).unwrap()[0].away);
}

#[test]
fn typing_events_are_ephemeral_and_have_a_small_frontend_contract() {
    let event = ChatEvent::Typing {
        target: "#general".into(),
        sender_nick: "anna".into(),
        active: true,
    };
    assert_eq!(
        serde_json::to_value(event).unwrap(),
        json!({
            "type": "typing",
            "target": "#general",
            "senderNick": "anna",
            "active": true,
        })
    );
}

#[test]
fn activity_link_is_a_default_target_not_a_fence() {
    let (_directory, runtime) = test_runtime();
    runtime
        .inner
        .database
        .link_activity("agent:one", "#general", Some("codex"))
        .unwrap();
    let mut context = ToolCallContext::new(crate::tool_registry::ToolCaller::MimirCli);
    context
        .metadata
        .insert("activityId".into(), Value::String("agent:one".into()));

    assert_eq!(
        runtime.resolve_tool_target(&context, None).unwrap(),
        "#general"
    );
    assert_eq!(
        runtime
            .resolve_tool_target(&context, Some("#product"))
            .unwrap(),
        "#product"
    );
    assert_eq!(
        runtime.resolve_tool_target(&context, Some("anna")).unwrap(),
        "anna"
    );
}

#[test]
fn disabling_chat_disconnects_and_removes_its_public_tools() {
    let (_directory, runtime) = test_runtime();
    let registry = ToolRegistry::default();
    register_native_tools(&registry, &runtime).unwrap();
    assert_eq!(
        registry
            .snapshot()
            .tools
            .iter()
            .filter(|tool| tool.canonical_name.starts_with("chat."))
            .count(),
        5
    );

    let status = runtime.set_enabled(false, &registry).unwrap();
    assert_eq!(status.state, ChatConnectionState::Disconnected);
    assert!(!runtime.config().unwrap().enabled);
    assert!(!registry
        .snapshot()
        .tools
        .iter()
        .any(|tool| tool.canonical_name.starts_with("chat.")));

    runtime.set_enabled(true, &registry).unwrap();
    assert!(runtime.config().unwrap().enabled);
    assert_eq!(
        registry
            .snapshot()
            .tools
            .iter()
            .filter(|tool| tool.canonical_name.starts_with("chat."))
            .count(),
        5
    );
}
