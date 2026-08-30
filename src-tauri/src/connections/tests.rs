use super::*;

fn google_bundle_for_test(expires_at: Option<i64>, refresh: Option<&str>) -> GoogleBundle {
    GoogleBundle {
        access_token: "token".into(),
        refresh_token: refresh.map(str::to_string),
        expires_at,
        scope: GOOGLE_SCOPES.into(),
        auth: Some(json!({ "email": "work@example.com", "client_id": "client" })),
    }
}

fn google_store_for_test(emails: &[&str]) -> GoogleStore {
    let accounts = emails
        .iter()
        .map(|email| GoogleAccount {
            id: email.to_lowercase(),
            email: (*email).into(),
            name: None,
            bundle: google_bundle_for_test(None, Some("refresh")),
        })
        .collect::<Vec<_>>();
    GoogleStore {
        default_account: accounts.first().map(|account| account.id.clone()),
        accounts,
    }
}

#[test]
fn expired_google_connection_only_needs_sign_in_without_refresh_token() {
    assert!(google_needs_sign_in(&google_bundle_for_test(
        Some(unix_seconds() - 1),
        None,
    )));
    assert!(!google_needs_sign_in(&google_bundle_for_test(
        Some(unix_seconds() - 1),
        Some("refresh"),
    )));
}

#[test]
fn utility_encoders_keep_queries_and_headers_safe() {
    assert_eq!(escape_drive_query("Rob's \\ draft"), "Rob\\'s \\\\ draft");
    assert_eq!(safe_header("hello\r\nBcc: x"), "hello  Bcc: x");
    assert_eq!(reply_subject("Status"), "Re: Status");
    assert_eq!(reply_subject("RE: Status"), "RE: Status");
}

#[test]
fn slack_personal_token_accepts_only_user_tokens() {
    assert_eq!(
        slack_personal_token(" xoxp-example ").unwrap(),
        "xoxp-example"
    );
    assert!(slack_personal_token("xoxb-example").is_err());
    assert!(slack_personal_token("").is_err());
}

#[test]
fn google_scopes_cover_calendar_discovery_and_availability() {
    assert!(
        GOOGLE_SCOPES.contains("https://www.googleapis.com/auth/calendar.calendarlist.readonly")
    );
    assert!(GOOGLE_SCOPES.contains("https://www.googleapis.com/auth/calendar.events.freebusy"));
}

#[test]
fn google_registration_includes_calendar_discovery_and_freebusy() {
    let registry = ToolRegistry::default();
    let runtime = ConnectionRuntime {
        http: Client::new(),
        slack_account: DEFAULT_ACCOUNT.into(),
    };
    let store = google_store_for_test(&["work@example.com", "me@example.net"]);
    register_google_tools(&registry, &runtime, &store).unwrap();
    let names = registry
        .snapshot()
        .tools
        .into_iter()
        .map(|tool| tool.canonical_name)
        .collect::<std::collections::HashSet<_>>();
    assert!(names.contains("calendar.calendars"));
    assert!(names.contains("calendar.freebusy"));
    assert!(names.contains("drive.read"));
    let gmail = registry.descriptor("gmail.search").unwrap();
    assert_eq!(
        gmail.input_schema["properties"]["account"]["enum"],
        json!(["work@example.com", "me@example.net"])
    );
    assert_eq!(
        gmail.input_schema["properties"]["account"]["default"],
        "work@example.com"
    );
}

#[test]
fn google_accounts_keep_one_default_and_resolve_explicit_email() {
    let mut store = google_store_for_test(&["work@example.com"]);
    upsert_google_account(
        &mut store,
        GoogleAccount {
            id: "ME@EXAMPLE.NET".into(),
            email: "me@example.net".into(),
            name: Some("Personal".into()),
            bundle: google_bundle_for_test(None, Some("refresh")),
        },
    );
    assert_eq!(
        resolve_google_account(&store, None).unwrap().email,
        "work@example.com"
    );
    assert_eq!(
        resolve_google_account(&store, Some("ME@example.net"))
            .unwrap()
            .email,
        "me@example.net"
    );
    store.default_account = Some("me@example.net".into());
    normalize_google_store(&mut store);
    assert_eq!(
        resolve_google_account(&store, None).unwrap().email,
        "me@example.net"
    );
}

#[test]
fn spreadsheet_content_keeps_tabs_rows_and_sheet_names() {
    let spreadsheet = json!({
        "properties": { "title": "Pipeline" },
        "sheets": [{
            "properties": { "title": "Q3" },
            "data": [{
                "startRow": 1,
                "startColumn": 0,
                "rowData": [
                    { "values": [
                        { "formattedValue": "Client" },
                        { "formattedValue": "Value" }
                    ] },
                    { "values": [
                        { "formattedValue": "Acme\nLabs" },
                        { "effectiveValue": { "numberValue": 42 } }
                    ] }
                ]
            }]
        }]
    });
    assert_eq!(
        spreadsheet_text(&spreadsheet),
        "# Spreadsheet: Pipeline\n\n## Sheet: Q3\n2\tClient\tValue\n3\tAcme Labs\t42"
    );
}

#[test]
fn presentation_content_includes_shapes_tables_groups_and_notes() {
    let presentation = json!({
        "title": "Pitch",
        "slides": [{
            "pageElements": [
                { "shape": { "text": { "textElements": [
                    { "textRun": { "content": "Opening\n" } }
                ] } } },
                { "table": { "tableRows": [{ "tableCells": [
                    { "text": { "textElements": [
                        { "textRun": { "content": "A" } }
                    ] } },
                    { "text": { "textElements": [
                        { "textRun": { "content": "B" } }
                    ] } }
                ] }] } },
                { "elementGroup": { "children": [
                    { "wordArt": { "renderedText": "Grouped" } }
                ] } }
            ],
            "slideProperties": { "notesPage": { "pageElements": [
                { "shape": { "text": { "textElements": [
                    { "textRun": { "content": "Ask about timing." } }
                ] } } }
            ] } }
        }]
    });
    assert_eq!(
            presentation_text(&presentation),
            "# Presentation: Pitch\n\n## Slide 1\nOpening\nA\tB\nGrouped\n\nSpeaker notes:\nAsk about timing."
        );
}

#[test]
fn provider_tools_have_provider_ownership() {
    let registry = ToolRegistry::default();
    let runtime = ConnectionRuntime {
        http: Client::new(),
        slack_account: DEFAULT_ACCOUNT.into(),
    };
    register_slack_tools(&registry, &runtime).unwrap();
    assert!(registry.snapshot().tools.iter().all(|tool| {
        tool.owner == ToolOwner::Provider("slack".into())
            && tool.source == ToolSource::Integration("slack".into())
    }));
}
