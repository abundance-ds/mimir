use super::*;
use tempfile::tempdir;

fn message(id: &str, target: &str, time: &str, body: &str) -> ChatMessage {
    ChatMessage {
        id: id.into(),
        target: target.into(),
        server_time: time.into(),
        sender_nick: "anna".into(),
        sender_account: Some("anna".into()),
        body: body.into(),
        reply_to: None,
        own: false,
        agent_label: None,
        activity_id: None,
        edited_at: None,
        deleted: false,
        mentioned: false,
        reactions: Vec::new(),
        attachments: Vec::new(),
    }
}

#[test]
fn targets_messages_unread_search_and_links_round_trip() {
    let directory = tempdir().unwrap();
    let db = ChatDatabase::open(directory.path().join("chat.sqlite3")).unwrap();
    assert!(db.path().exists());
    db.ensure_target(
        "#general",
        ChatTargetKind::Channel,
        true,
        Some("2026-01-01T00:00:00.000Z"),
    )
    .unwrap();
    assert!(db
        .insert_message(&message(
            "m1",
            "#general",
            "2026-01-01T00:00:01.000Z",
            "hello product"
        ))
        .unwrap());
    assert!(!db
        .insert_message(&message(
            "m1",
            "#general",
            "2026-01-01T00:00:01.000Z",
            "hello product"
        ))
        .unwrap());
    assert_eq!(db.targets().unwrap()[0].unread_count, 1);
    assert_eq!(
        db.targets().unwrap()[0].first_unread_id.as_deref(),
        Some("m1")
    );
    assert_eq!(db.messages("#general", None, 50).unwrap().len(), 1);
    assert_eq!(
        db.messages_around("#general", "m1", 10).unwrap()[0].id,
        "m1"
    );
    assert_eq!(db.search("product", None, 10).unwrap()[0].id, "m1");
    let edited = db
        .record_message_event(
            "e1",
            "#general",
            "m1",
            "edit",
            "anna",
            Some("anna"),
            "hello edited product",
            "2026-01-01T00:00:02.000Z",
            false,
            false,
        )
        .unwrap()
        .unwrap();
    assert_eq!(edited.body, "hello edited product");
    assert_eq!(
        edited.edited_at.as_deref(),
        Some("2026-01-01T00:00:02.000Z"),
    );
    let reacted = db
        .record_message_event(
            "r1",
            "#general",
            "m1",
            "react",
            "waqr",
            Some("waqr"),
            "👍",
            "2026-01-01T00:00:03.000Z",
            true,
            false,
        )
        .unwrap()
        .unwrap();
    assert_eq!(reacted.reactions[0].count, 1);
    assert!(reacted.reactions[0].own);
    let unreacted = db
        .record_message_event(
            "r2",
            "#general",
            "m1",
            "unreact",
            "waqr",
            Some("waqr"),
            "👍",
            "2026-01-01T00:00:04.000Z",
            true,
            false,
        )
        .unwrap()
        .unwrap();
    assert!(unreacted.reactions.is_empty());
    let restored = db
        .redact("#general", "e1", "2026-01-01T00:00:05.000Z")
        .unwrap()
        .unwrap();
    assert_eq!(restored.body, "hello product");
    let mut attachment_message = message(
        "m2",
        "#general",
        "2026-01-01T00:00:06.000Z",
        "📎 launch.pdf",
    );
    attachment_message.own = true;
    attachment_message.attachments.push(ChatAttachment {
        id: "file-one".into(),
        name: "launch.pdf".into(),
        mime: "application/pdf".into(),
        size: 42,
        sha256: "a".repeat(64),
        url: "https://chat.example/files/file-one".into(),
        local_path: None,
    });
    db.insert_message(&attachment_message).unwrap();
    assert_eq!(
        db.attachment_target("file-one").unwrap().as_deref(),
        Some("#general"),
    );
    assert_eq!(
        db.messages("#general", None, 50).unwrap()[1].attachments[0].name,
        "launch.pdf",
    );
    let cached = db
        .set_attachment_local_path("file-one", "/tmp/launch.pdf")
        .unwrap();
    assert_eq!(cached.local_path.as_deref(), Some("/tmp/launch.pdf"));
    db.replace_members("#general", &["anna".into(), "waqr".into()])
        .unwrap();
    assert_eq!(db.targets().unwrap()[0].member_count, 2);
    db.remove_member("#general", "anna").unwrap();
    assert_eq!(db.targets().unwrap()[0].member_count, 1);
    db.upsert_member("#general", "anna", Some("anna"), None)
        .unwrap();
    assert_eq!(db.targets().unwrap()[0].member_count, 2);
    db.remove_member_everywhere("anna").unwrap();
    assert_eq!(db.targets().unwrap()[0].member_count, 1);
    db.upsert_member("#general", "anna", Some("anna"), None)
        .unwrap();
    db.update_member_profile("anna", "Anna Example").unwrap();
    assert_eq!(
        db.members(Some("#general")).unwrap()[0].display_name,
        "Anna Example"
    );
    db.mark_read("#general", Some("m1")).unwrap();
    assert_eq!(db.targets().unwrap()[0].unread_count, 0);
    db.insert_message(&message(
        "m3",
        "#general",
        "2026-01-01T00:00:07.000Z",
        "unread after anchor",
    ))
    .unwrap();
    assert_eq!(db.targets().unwrap()[0].unread_count, 1);
    // Marking an older message read must not resurrect newer unreads.
    db.mark_read("#general", Some("m1")).unwrap();
    assert_eq!(db.targets().unwrap()[0].unread_count, 1);
    db.mark_read("#general", Some("m3")).unwrap();
    assert_eq!(db.targets().unwrap()[0].unread_count, 0);
    db.link_activity("activity-1", "#general", Some("codex"))
        .unwrap();
    assert_eq!(
        db.activity_link("activity-1").unwrap(),
        Some(("#general".into(), Some("codex".into())))
    );

    db.ensure_target("anna", ChatTargetKind::Direct, false, None)
        .unwrap();
    db.set_hidden("anna", true).unwrap();
    assert!(db
        .targets()
        .unwrap()
        .iter()
        .all(|target| target.id != "anna"));
    db.set_hidden("anna", false).unwrap();
    assert!(db
        .targets()
        .unwrap()
        .iter()
        .any(|target| target.id == "anna"));
}
