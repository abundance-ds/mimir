use super::*;
use std::sync::{Arc, Barrier};
use tempfile::TempDir;

fn root() -> (TempDir, GraphSourceRoot) {
    let temp = TempDir::new().unwrap();
    let path = temp.path().canonicalize().unwrap();
    fs::create_dir_all(path.join("graph")).unwrap();
    (
        temp,
        GraphSourceRoot::new("team:test", GraphScopeKind::Team, path),
    )
}

fn write(root: &GraphSourceRoot, id: &str, content: &str) -> String {
    let path = root.root.join("graph").join(format!("{id}.md"));
    fs::write(&path, content).unwrap();
    path.to_string_lossy().into_owned()
}

fn save(path: &str, content: &str, revision: &str) -> GraphSourceSaveRequest {
    GraphSourceSaveRequest {
        path: path.into(),
        content: content.into(),
        expected_revision: revision.into(),
        base_content: None,
    }
}

#[test]
fn shared_source_boundary_fixtures_match_native_frontmatter() {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Boundary {
        name: String,
        content: String,
        body_from: usize,
    }
    let fixtures: Vec<Boundary> = serde_json::from_str(include_str!(
        "../../tests/fixtures/graph_source_boundaries.json"
    ))
    .unwrap();
    let (_temp, root) = root();
    for fixture in fixtures {
        let document = GraphSourceDocument::from_source(
            &root.root.join("graph/source.md"),
            &root,
            fixture.content,
        );
        assert_eq!(document.body_from, fixture.body_from, "{}", fixture.name);
    }
}

#[test]
fn recovery_export_formats_all_fields_without_a_mounted_or_existing_source() {
    let (temp, root) = root();
    let content = "---\nkind: issue\ntitle: Original\ncustom:\n  nested: kept\nstatus: planned\nrank: abc\n---\nOriginal body.";
    let path = write(&root, "recover", content);
    let mut node = GraphSourceDocument::from_source(Path::new(&path), &root, content.into())
        .node
        .unwrap();
    node.title = "Recovered title".into();
    node.body = "Draft [Jon](mimir://graph/jon).\n".into();
    node.properties.insert("status".into(), json!("done"));
    drop(temp);
    let output = graph_source_serialize(node).unwrap();
    let recovered = GraphSourceDocument::from_source(Path::new(&path), &root, output)
        .node
        .unwrap();
    assert_eq!(recovered.title, "Recovered title");
    assert_eq!(recovered.body, "Draft [Jon](mimir://graph/jon).\n");
    assert_eq!(recovered.properties["custom"], json!({ "nested": "kept" }));
    assert_eq!(recovered.properties["status"], "done");
    assert_eq!(recovered.properties["rank"], "abc");
    assert!(!Path::new(&path).exists());
}

#[test]
fn source_read_preserves_bytes_and_uses_utf16_native_body_boundary() {
    let (_temp, root) = root();
    let content = "---\r\n# 🌙 comment\r\nkind: note\r\ntitle: Jón\r\nunknown: kept\r\n---  \r\n\r\nBody 🌱.  \r\n";
    let path = write(&root, "source", content);
    let runtime = GraphRuntime::from_roots(vec![root]);
    let source = runtime.source(&path).unwrap().unwrap();
    assert_eq!(source.content, content);
    assert_eq!(source.source_revision, source_revision(content));
    let node = source.node.unwrap();
    assert_eq!(node.title, "Jón");
    assert_eq!(node.properties["unknown"], "kept");
    assert_eq!(node.body, "\r\nBody 🌱.  \r\n");
    assert_eq!(
        source.body_from,
        content.encode_utf16().count() - node.body.encode_utf16().count()
    );
    assert_eq!(fs::read_to_string(path).unwrap(), content);
    assert_eq!(runtime.store.read().unwrap().revision(), 1);
}

#[test]
fn source_save_preserves_user_yaml_and_updates_only_this_filename() {
    let (_temp, root) = root();
    let path = write(&root, "source", "---\ntitle: Source\n---\nOld body.");
    write(&root, "jon", "---\nkind: person\ntitle: Jon\n---\n");
    let runtime = GraphRuntime::from_roots(vec![root.clone()]);
    let before = runtime.source(&path).unwrap().unwrap();
    write(&root, "not-yet-indexed", "---\ntitle: Later\n---\n");
    let content = "---\r\n# Retain the authored order.\r\ncustom: 'kept exactly'\r\ntitle: Changed\r\nkind: note\r\n---\r\n[Jon](mimir://graph/jon)  \r\n";
    let next = runtime
        .source_save(save(&path, content, &before.source_revision))
        .unwrap();
    assert_eq!(next.content, content);
    assert_eq!(fs::read_to_string(&path).unwrap(), content);
    assert_eq!(runtime.get("source").unwrap().unwrap().title, "Changed");
    assert_eq!(
        runtime
            .references("jon", &BTreeSet::new())
            .unwrap()
            .backlinks
            .len(),
        1
    );
    assert!(runtime.get("not-yet-indexed").unwrap().is_none());
    let events = runtime.events.lock().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].action, "graph.source-save");
    assert_eq!(events[0].actor.kind, GraphActorKind::Human);
    drop(events);
    let revision = runtime.store.read().unwrap().revision();
    runtime
        .source_save(save(&path, content, &next.source_revision))
        .unwrap();
    assert_eq!(runtime.store.read().unwrap().revision(), revision);
    assert_eq!(runtime.events.lock().unwrap().len(), 1);
}

#[test]
fn malformed_source_stays_editable_and_recovers_with_diagnostics_and_revisions() {
    let (_temp, root) = root();
    let malformed = "---\ntitle: [unfinished\n---\nOld body.";
    let path = write(&root, "source", malformed);
    let runtime = GraphRuntime::from_roots(vec![root]);
    let before = runtime.source(&path).unwrap().unwrap();
    assert!(before.node.is_none());
    assert_eq!(before.content, malformed);
    assert_eq!(before.body_from, malformed.find("Old body.").unwrap());
    let revision = runtime.store.read().unwrap().revision();
    let still_malformed = malformed.replace("Old body.", "New body.");
    let next = runtime
        .source_save(save(&path, &still_malformed, &before.source_revision))
        .unwrap();
    assert!(next.node.is_none());
    assert_eq!(next.content, still_malformed);
    assert_eq!(runtime.store.read().unwrap().revision(), revision + 1);
    assert!(runtime
        .diagnostics()
        .unwrap()
        .iter()
        .any(|row| row.code == "source-file-invalid"));
    let repaired = "---\ntitle: Repaired\n---\nKeep this draft.";
    let final_source = runtime
        .source_save(save(&path, repaired, &next.source_revision))
        .unwrap();
    assert_eq!(final_source.node.as_ref().unwrap().title, "Repaired");
    assert!(runtime.diagnostics().unwrap().is_empty());
    assert_eq!(fs::read_to_string(&path).unwrap(), repaired);
    assert_eq!(runtime.events.lock().unwrap()[0].event_type, "updated");
    runtime
        .source_save(save(&path, malformed, &final_source.source_revision))
        .unwrap();
    assert!(runtime.get("source").unwrap().is_none());
    let events = runtime.events.lock().unwrap();
    assert_eq!(events[0].event_type, "updated");
    assert!(!events[0].summary.contains("Trash"));
    assert_eq!(fs::read_to_string(path).unwrap(), malformed);
}

#[test]
fn source_save_and_rich_update_share_revision_conflicts() {
    let (_temp, root) = root();
    let path = write(&root, "source", "---\ntitle: Source\n---\nOld body.");
    let runtime = GraphRuntime::from_roots(vec![root]);
    let before = runtime.source(&path).unwrap().unwrap();
    let updated = runtime
        .update(GraphNodePatch {
            id: "source".into(),
            expected_revision: Some(before.source_revision.clone()),
            expected_source_path: Some(path.clone()),
            title: Some("Rich edit".into()),
            ..GraphNodePatch::default()
        })
        .unwrap();
    assert!(runtime
        .source_save(save(&path, "Raw edit", &before.source_revision))
        .unwrap_err()
        .contains("source changed"));
    let raw = runtime
        .source_save(save(
            &path,
            "---\ntitle: Raw edit\n---\nBody.",
            &updated.provenance.source_revision,
        ))
        .unwrap();
    assert!(runtime
        .update(GraphNodePatch {
            id: "source".into(),
            expected_revision: Some(updated.provenance.source_revision),
            expected_source_path: Some(path.clone()),
            title: Some("Stale rich edit".into()),
            ..GraphNodePatch::default()
        })
        .is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), raw.content);
}

#[test]
fn simultaneous_rich_and_source_saves_have_one_revision_winner() {
    let (_temp, root) = root();
    let path = write(&root, "source", "---\ntitle: Source\n---\nOld body.");
    let runtime = Arc::new(GraphRuntime::from_roots(vec![root]));
    let before = runtime.source(&path).unwrap().unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let thread_runtime = runtime.clone();
    let thread_barrier = barrier.clone();
    let thread_path = path.clone();
    let revision = before.source_revision.clone();
    let raw_writer = std::thread::spawn(move || {
        thread_barrier.wait();
        thread_runtime
            .source_save(save(&thread_path, "---\ntitle: Raw\n---\nBody.", &revision))
            .is_ok()
    });
    barrier.wait();
    let rich_won = runtime
        .update(GraphNodePatch {
            id: "source".into(),
            expected_revision: Some(before.source_revision),
            expected_source_path: Some(path.clone()),
            title: Some("Rich".into()),
            ..GraphNodePatch::default()
        })
        .is_ok();
    assert_ne!(rich_won, raw_writer.join().unwrap());
    let loaded = runtime.source(&path).unwrap().unwrap().node.unwrap();
    assert_eq!(loaded, runtime.get("source").unwrap().unwrap());
}

#[test]
fn fresh_source_revision_preserves_external_fields_before_the_watcher_runs() {
    let (_temp, root) = root();
    let (_other_temp, mut other) = self::root();
    other.scope_id = "project:other".into();
    let path = write(&root, "source", "---\ntitle: Source\n---\nOld body.");
    let runtime = GraphRuntime::from_roots(vec![root, other.clone()]);
    let external = "---\ntitle: External title\nexternal: retain me\n---\nExternal body.";
    fs::write(&path, external).unwrap();
    let source = runtime.source(&path).unwrap().unwrap();
    assert_eq!(runtime.get("source").unwrap().unwrap().title, "Source");
    let updated = runtime
        .update(GraphNodePatch {
            id: "source".into(),
            expected_revision: Some(source.source_revision),
            expected_source_path: Some(path.clone()),
            title: Some("Rich edit".into()),
            ..GraphNodePatch::default()
        })
        .unwrap();
    assert_eq!(updated.properties["external"], "retain me");
    assert_eq!(updated.body, "External body.");
    fs::write(&path, external.replace("retain me", "retain on move")).unwrap();
    let source = runtime.source(&path).unwrap().unwrap();
    let moved = runtime
        .move_scope(GraphNodeMove {
            id: "source".into(),
            target_scope_id: other.scope_id,
            expected_revision: Some(source.source_revision),
            expected_source_path: Some(path),
        })
        .unwrap();
    assert_eq!(moved.properties["external"], "retain on move");
    assert_eq!(moved.title, "External title");
    assert_eq!(moved.body, "External body.");
}

#[test]
fn unsupported_missing_deleted_moved_and_unmounted_paths_are_never_created() {
    let (_temp, mut root) = root();
    root.scope_id = "project:test".into();
    let path = write(&root, "source", "---\ntitle: Source\n---\nBody.");
    let (_other_temp, other) = self::root();
    let runtime = GraphRuntime::from_roots(vec![root.clone(), other.clone()]);
    let before = runtime.source(&path).unwrap().unwrap();
    let ordinary = root.root.join("ordinary.md");
    fs::write(&ordinary, "Ordinary Markdown").unwrap();
    let nested = root.root.join("graph/sub/nested.md");
    fs::create_dir_all(nested.parent().unwrap()).unwrap();
    fs::write(&nested, "Nested Markdown").unwrap();
    let invalid = write(&root, "Invalid ID", "Invalid source");
    let missing = root.root.join("graph/missing.md");
    for candidate in [
        ordinary.to_string_lossy().into_owned(),
        nested.to_string_lossy().into_owned(),
        invalid,
        missing.to_string_lossy().into_owned(),
    ] {
        assert!(runtime.source(&candidate).unwrap().is_none(), "{candidate}");
        assert!(runtime
            .source_save(save(&candidate, "Do not write", &before.source_revision))
            .is_err());
    }
    assert!(!missing.exists());
    let moved = runtime
        .move_scope(GraphNodeMove {
            id: "source".into(),
            target_scope_id: other.scope_id,
            expected_source_path: Some(path.clone()),
            expected_revision: Some(before.source_revision.clone()),
        })
        .unwrap();
    assert!(runtime.source(&path).unwrap().is_none());
    assert!(runtime
        .source_save(save(&path, "Do not recreate", &before.source_revision))
        .is_err());
    assert!(!Path::new(&path).exists());
    runtime.roots.write().unwrap().clear();
    assert!(runtime
        .source(&moved.provenance.source_path)
        .unwrap()
        .is_none());
    assert!(runtime
        .source_save(save(
            &moved.provenance.source_path,
            "Unmounted",
            &moved.provenance.source_revision
        ))
        .is_err());
    assert_ne!(
        fs::read_to_string(&moved.provenance.source_path).unwrap(),
        "Unmounted"
    );
}

#[test]
fn duplicate_losing_sources_are_not_graph_editor_targets() {
    let (_first_temp, first) = root();
    let (_second_temp, mut second) = root();
    second.scope_id = "project:other".into();
    let winner = write(&first, "source", "---\ntitle: First\n---\nBody.");
    let loser = write(&second, "source", "---\ntitle: Second\n---\nBody.");
    let runtime = GraphRuntime::from_roots(vec![first, second]);
    assert!(runtime.source(&winner).unwrap().is_some());
    assert!(runtime.source(&loser).unwrap().is_none());
    assert!(runtime
        .source_save(save(
            &loser,
            "Keep loser",
            &source_revision("---\ntitle: Second\n---\nBody.")
        ))
        .is_err());
    fs::remove_file(&winner).unwrap();
    runtime.refresh(vec![winner]).unwrap();
    assert_eq!(
        runtime.source(&loser).unwrap().unwrap().node.unwrap().title,
        "Second"
    );
}

#[cfg(unix)]
#[test]
fn symlink_sources_and_graph_directories_do_not_grant_source_access() {
    use std::os::unix::fs::symlink;
    let (_temp, root) = root();
    let path = write(&root, "source", "---\ntitle: Source\n---\nBody.");
    let alias = root.root.join("graph/alias.md");
    symlink(&path, &alias).unwrap();
    let runtime = GraphRuntime::from_roots(vec![root.clone()]);
    assert!(runtime.source(alias.to_str().unwrap()).unwrap().is_none());
    assert!(runtime
        .source_save(save(alias.to_str().unwrap(), "No", "revision"))
        .is_err());
    let (_other_temp, other) = self::root();
    fs::remove_dir(other.root.join("graph")).unwrap();
    symlink(root.root.join("graph"), other.root.join("graph")).unwrap();
    let runtime = GraphRuntime::from_roots(vec![other.clone()]);
    assert!(runtime
        .source(other.root.join("graph/source.md").to_str().unwrap())
        .unwrap()
        .is_none());
}

#[test]
fn same_id_and_revision_in_another_root_cannot_accept_stale_rich_saves_or_moves() {
    let (_old_temp, old_root) = root();
    let (_new_temp, new_root) = root();
    let raw = "---\ntitle: Same entry\n---\nIdentical text.";
    let old_path = write(&old_root, "source", raw);
    let new_path = write(&new_root, "source", raw);
    let runtime = GraphRuntime::from_roots(vec![new_root.clone()]);
    let revision = source_revision(raw);
    let error = runtime
        .update(GraphNodePatch {
            id: "source".into(),
            expected_revision: Some(revision.clone()),
            expected_source_path: Some(old_path.clone()),
            title: Some("Wrong root".into()),
            ..GraphNodePatch::default()
        })
        .unwrap_err();
    assert!(error.to_string().contains("source location changed"));
    let error = runtime
        .move_scope(GraphNodeMove {
            id: "source".into(),
            target_scope_id: new_root.scope_id,
            expected_revision: Some(revision),
            expected_source_path: Some(old_path),
        })
        .unwrap_err();
    assert!(error.to_string().contains("source location changed"));
    assert_eq!(fs::read_to_string(new_path).unwrap(), raw);
    let error = runtime
        .delete(GraphNodeDelete {
            id: "source".into(),
            expected_revision: Some(source_revision(raw)),
            expected_source_path: Some(
                old_root
                    .root
                    .join("graph/source.md")
                    .to_string_lossy()
                    .into_owned(),
            ),
        })
        .unwrap_err();
    assert!(error.to_string().contains("source location changed"));
    assert!(new_root.root.join("graph/source.md").is_file());
}

#[test]
fn project_canvas_has_its_own_metadata_search_and_links() {
    let (_temp, root) = root();
    let path = write(
        &root,
        "atlas",
        "---\nkind: project\ntitle: Atlas\n---\nStable context.",
    );
    write(&root, "jon", "---\nkind: person\ntitle: Jon\n---\n");
    let runtime = GraphRuntime::from_roots(vec![root]);
    let mut actor = GraphActor::human();
    actor.label = "Anna".into();
    let updated = runtime.update_as(GraphNodePatch { id: "atlas".into(), set_properties: serde_json::from_value(json!({"home": {"canvas": "A quokka [Jon](mimir://graph/jon)", "updatedAt": "fake"}})).unwrap(), ..Default::default() }, &actor).unwrap();
    let home = updated.properties.get("home").unwrap().clone();
    assert_ne!(home["updatedAt"], "fake");
    assert_eq!(home["updatedBy"]["label"], "Anna");
    let context_edit = runtime
        .update(GraphNodePatch {
            id: "atlas".into(),
            body: Some("New stable context.".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(context_edit.properties["home"], home);
    let backlinks = runtime
        .references("jon", &BTreeSet::new())
        .unwrap()
        .backlinks;
    assert_eq!(
        backlinks[0].occurrences[0].source_field.as_deref(),
        Some("home.canvas")
    );
    let store = runtime.store.read().unwrap();
    assert_eq!(
        store.search("quokka", &BTreeSet::new(), 25)[0].node.id,
        "atlas"
    );
    drop(store);
    let before = runtime.source(&path).unwrap().unwrap();
    let content = before.content.replace("quokka", "wombat");
    let saved = runtime
        .source_save(save(&path, &content, &before.source_revision))
        .unwrap();
    assert_eq!(
        saved.node.unwrap().properties["home"]["updatedBy"]["kind"],
        "human"
    );
}

#[test]
fn source_context_edit_rebases_over_canvas_only_and_rejects_other_changes() {
    let (_temp, root) = root();
    let path = write(
        &root,
        "atlas",
        "---\nkind: project\ntitle: Atlas\nhome:\n  canvas: Old canvas\n---\nStable context.",
    );
    let runtime = GraphRuntime::from_roots(vec![root]);
    let before = runtime.source(&path).unwrap().unwrap();
    runtime
        .update(GraphNodePatch {
            id: "atlas".into(),
            set_properties: serde_json::from_value(json!({"home": {"canvas": "New canvas"}}))
                .unwrap(),
            ..Default::default()
        })
        .unwrap();
    let mut request = save(
        &path,
        &before.content.replace("Stable context.", "New context."),
        &before.source_revision,
    );
    request.base_content = Some(before.content.clone());
    let next = runtime.source_save(request).unwrap();
    assert_eq!(next.node.as_ref().unwrap().body, "New context.");
    assert_eq!(
        next.node.as_ref().unwrap().properties["home"]["canvas"],
        "New canvas"
    );
    let mut competing = save(
        &path,
        &before
            .content
            .replace("Stable context.", "Competing context."),
        &before.source_revision,
    );
    competing.base_content = Some(before.content);
    assert!(runtime.source_save(competing).is_err());
}
