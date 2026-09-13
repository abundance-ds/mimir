use super::*;
use crate::business_graph::{GraphLinkStatus, GraphScopeKind};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Barrier};
use tempfile::TempDir;

fn root(files: &[(&str, &str)]) -> TempDir {
    let root = TempDir::new().unwrap();
    fs::create_dir(root.path().join("graph")).unwrap();
    for (id, body) in files {
        fs::write(
            root.path().join("graph").join(format!("{id}.md")),
            format!("---\nkind: note\ntitle: {id}\n---\n{body}"),
        )
        .unwrap();
    }
    root
}

fn runtime(root: &TempDir) -> GraphRuntime {
    GraphRuntime::from_roots(vec![GraphSourceRoot::new(
        "project:test",
        GraphScopeKind::Project,
        root.path(),
    )])
}

#[test]
fn watcher_reconciles_only_changed_flat_sources_and_ignores_own_save() {
    let root = root(&[
        ("source", "[Target](mimir://graph/target)"),
        ("target", "Target"),
    ]);
    let runtime = runtime(&root);
    let node = runtime.get("source").unwrap().unwrap();
    runtime
        .update(GraphNodePatch {
            id: node.id,
            expected_revision: Some(node.provenance.source_revision),
            body: Some("Changed [Target](mimir://graph/target)".into()),
            ..Default::default()
        })
        .unwrap();
    let revision = runtime.open_result().unwrap().graph_revision;
    let path = root.path().join("graph/source.md");
    assert!(runtime
        .refresh_watched(vec![path.to_string_lossy().into_owned()], 0, false)
        .unwrap()
        .is_none());
    assert_eq!(runtime.open_result().unwrap().graph_revision, revision);
    assert_eq!(
        runtime
            .references("target", &BTreeSet::new())
            .unwrap()
            .backlinks
            .len(),
        1
    );

    fs::write(
        &path,
        "---\nkind: note\ntitle: source\n---\nReference removed.",
    )
    .unwrap();
    assert!(runtime
        .refresh_watched(vec![path.to_string_lossy().into_owned()], 0, false)
        .unwrap()
        .is_some());
    assert!(runtime
        .references("target", &BTreeSet::new())
        .unwrap()
        .backlinks
        .is_empty());
    assert!(runtime
        .refresh_watched(vec![path.to_string_lossy().into_owned()], 0, false)
        .unwrap()
        .is_none());

    let nested = root.path().join("graph/nested");
    fs::create_dir(&nested).unwrap();
    let path = nested.join("ignored.md");
    fs::write(&path, "Should not enter the flat graph").unwrap();
    assert!(runtime
        .refresh_watched(vec![path.to_string_lossy().into_owned()], 0, false)
        .unwrap()
        .is_none());
    assert!(runtime.get("ignored").unwrap().is_none());
}

#[test]
fn duplicate_winner_deletion_promotes_remaining_source_and_retains_links() {
    let project = root(&[
        ("same", "Project winner"),
        ("source", "[Same](mimir://graph/same)"),
    ]);
    let team = root(&[("same", "Team fallback")]);
    let runtime = GraphRuntime::from_roots(vec![
        GraphSourceRoot::new("project:test", GraphScopeKind::Project, project.path()),
        GraphSourceRoot::new("team:main", GraphScopeKind::Team, team.path()),
    ]);
    assert_eq!(runtime.get("same").unwrap().unwrap().body, "Project winner");
    assert!(runtime
        .diagnostics()
        .unwrap()
        .iter()
        .any(|d| d.code == "duplicate-id"));
    let path = project.path().join("graph/same.md");
    let old_revision = runtime.open_result().unwrap().graph_revision;
    assert!(runtime
        .refresh_watched(vec![path.to_string_lossy().into_owned()], 0, false)
        .unwrap()
        .is_none());
    assert_eq!(runtime.open_result().unwrap().graph_revision, old_revision);
    fs::remove_file(&path).unwrap();
    runtime
        .refresh(vec![path.to_string_lossy().into_owned()])
        .unwrap();
    assert_eq!(runtime.get("same").unwrap().unwrap().body, "Team fallback");
    assert!(!runtime
        .diagnostics()
        .unwrap()
        .iter()
        .any(|d| d.code == "duplicate-id"));
    assert_eq!(
        runtime
            .references("same", &BTreeSet::new())
            .unwrap()
            .backlinks
            .len(),
        1
    );
}

#[test]
fn periodic_reconciliation_repairs_missed_events_without_idle_revision_churn() {
    let root = root(&[("source", "Initial"), ("target", "Target")]);
    let runtime = runtime(&root);
    assert!(runtime
        .refresh_watched(Vec::new(), 0, true)
        .unwrap()
        .is_none());
    let path = root.path().join("graph/source.md");
    fs::write(
        &path,
        "---\ntitle: Updated\n---\n[Target](mimir://graph/target)",
    )
    .unwrap();
    assert!(runtime
        .refresh_watched(Vec::new(), 0, true)
        .unwrap()
        .is_some());
    assert_eq!(
        runtime.lookup("updated", &BTreeSet::new(), 12).unwrap()[0].id,
        "source"
    );
    assert_eq!(
        runtime
            .references("target", &BTreeSet::new())
            .unwrap()
            .backlinks
            .len(),
        1
    );
    assert!(runtime
        .refresh_watched(Vec::new(), 0, true)
        .unwrap()
        .is_none());
}

#[test]
fn obsolete_root_generation_cannot_apply_old_watcher_results() {
    let root = root(&[("source", "Original")]);
    let runtime = runtime(&root);
    let path = root.path().join("graph/source.md");
    fs::write(&path, "An external change").unwrap();
    runtime.root_generation.store(1, Ordering::Release);
    assert!(runtime
        .refresh_watched(vec![path.to_string_lossy().into_owned()], 0, false)
        .unwrap()
        .is_none());
    assert_eq!(runtime.get("source").unwrap().unwrap().body, "Original");
    assert!(runtime
        .refresh_watched(vec![path.to_string_lossy().into_owned()], 1, false)
        .unwrap()
        .is_some());
}

#[test]
fn invalid_source_is_preserved_and_recovers_without_stale_backlinks() {
    let root = root(&[
        ("source", "[Target](mimir://graph/target)"),
        ("target", "Target"),
    ]);
    let runtime = runtime(&root);
    let path = root.path().join("graph/source.md");
    let broken = "---\ntitle: [broken\n---\nDo not overwrite me";
    fs::write(&path, broken).unwrap();
    runtime
        .refresh(vec![path.to_string_lossy().into_owned()])
        .unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), broken);
    assert!(runtime
        .references("target", &BTreeSet::new())
        .unwrap()
        .backlinks
        .is_empty());
    assert!(runtime
        .diagnostics()
        .unwrap()
        .iter()
        .any(|d| d.code == "source-file-invalid"));
    assert!(runtime
        .refresh_watched(vec![path.to_string_lossy().into_owned()], 0, false)
        .unwrap()
        .is_none());
    fs::write(
        &path,
        "---\ntitle: Repaired\n---\n[Target](mimir://graph/target)",
    )
    .unwrap();
    runtime
        .refresh(vec![path.to_string_lossy().into_owned()])
        .unwrap();
    assert_eq!(
        runtime
            .references("target", &BTreeSet::new())
            .unwrap()
            .backlinks
            .len(),
        1
    );
    assert!(!runtime
        .diagnostics()
        .unwrap()
        .iter()
        .any(|d| d.code == "source-file-invalid"));
}

#[test]
fn scope_filters_cover_lookup_resolution_and_backlinks() {
    let project = root(&[("source", "[Private](mimir://graph/private)")]);
    let private = root(&[("private", "[Source](mimir://graph/source)")]);
    let runtime = GraphRuntime::from_roots(vec![
        GraphSourceRoot::new("project:test", GraphScopeKind::Project, project.path()),
        GraphSourceRoot::new("private:local", GraphScopeKind::Private, private.path()),
    ]);
    let scopes = BTreeSet::from(["project:test".into()]);
    assert!(runtime.lookup("private", &scopes, 12).unwrap().is_empty());
    let resolved = runtime.link_targets(&["private".into()], &scopes).unwrap();
    assert_eq!(resolved[0].status, GraphLinkStatus::Unavailable);
    assert!(resolved[0].title.is_none());
    let links = runtime.references("source", &scopes).unwrap();
    assert!(links.backlinks.is_empty());
    assert_eq!(links.outgoing[0].status, GraphLinkStatus::Unavailable);
    assert!(links.outgoing[0].node.is_none());
}

#[test]
fn restore_rejects_an_unmounted_source_before_writing_or_resolving_another_entry() {
    let original = root(&[("same", "Original workspace")]);
    let replacement = root(&[("same", "Other workspace")]);
    let runtime = runtime(&original);
    let deleted = runtime
        .delete(GraphNodeDelete {
            expected_source_path: None,
            id: "same".into(),
            expected_revision: None,
        })
        .unwrap();
    let roots = vec![GraphSourceRoot::new(
        "project:other",
        GraphScopeKind::Project,
        replacement.path(),
    )];
    *runtime.store.write().unwrap() = GraphStore::load(&roots);
    *runtime.roots.write().unwrap() = roots;
    let result = runtime.restore(GraphRestoreRequest {
        undo_token: deleted.undo_token.unwrap(),
    });
    assert!(matches!(result, Err(GraphMutationError::Invalid(_))));
    assert!(!original.path().join("graph/same.md").exists());
    assert_eq!(
        runtime.get("same").unwrap().unwrap().body,
        "Other workspace"
    );
}

#[test]
fn ten_thousand_files_keep_lookup_available_during_refresh_and_writes() {
    const NODES: usize = 10_000;
    let root = TempDir::new().unwrap();
    let graph = root.path().join("graph");
    fs::create_dir(&graph).unwrap();
    for i in 0..NODES {
        let body = "Context and evidence. ".repeat(10 + i % 180);
        fs::write(
            graph.join(format!("node-{i}.md")),
            format!(
                "---\nkind: note\ntitle: Person {i:05}\n---\n{body}\n[Next](mimir://graph/node-{})",
                (i + 1) % NODES,
            ),
        )
        .unwrap();
    }
    let started = Instant::now();
    let runtime = Arc::new(runtime(&root));
    let startup_ms = started.elapsed().as_secs_f64() * 1000.0;
    let barrier = Arc::new(Barrier::new(2));
    let reader = {
        let runtime = runtime.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            barrier.wait();
            let mut latencies = Vec::new();
            for _ in 0..100 {
                let started = Instant::now();
                let result = runtime
                    .lookup("person 09999", &BTreeSet::new(), 12)
                    .unwrap();
                assert_eq!(result[0].id, "node-9999");
                latencies.push(started.elapsed().as_secs_f64() * 1000.0);
                std::thread::yield_now();
            }
            latencies
        })
    };
    barrier.wait();
    let started = Instant::now();
    runtime.refresh(Vec::new()).unwrap();
    let full_refresh_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut latencies = reader.join().unwrap();
    // Use a separate overlapping phase: the scan reader can finish before
    // writes start, which by itself would not prove lookup during mutation.
    let writing = Arc::new(AtomicBool::new(true));
    let barrier = Arc::new(Barrier::new(2));
    let update_reader = {
        let runtime = runtime.clone();
        let writing = writing.clone();
        let barrier = barrier.clone();
        std::thread::spawn(move || {
            barrier.wait();
            let mut samples = Vec::new();
            while writing.load(Ordering::Acquire) || samples.is_empty() {
                let started = Instant::now();
                assert_eq!(
                    runtime
                        .lookup("person 09999", &BTreeSet::new(), 12)
                        .unwrap()[0]
                        .id,
                    "node-9999"
                );
                samples.push(started.elapsed().as_secs_f64() * 1000.0);
                std::thread::yield_now();
            }
            samples
        })
    };
    barrier.wait();
    let started = Instant::now();
    for i in 0..20 {
        runtime
            .update(GraphNodePatch {
                id: "node-0".into(),
                body: Some(format!("Changed {i}. [Target](mimir://graph/node-9999)")),
                ..Default::default()
            })
            .unwrap();
    }
    let update_ms = started.elapsed().as_secs_f64() * 1000.0 / 20.0;
    writing.store(false, Ordering::Release);
    let update_latencies = update_reader.join().unwrap();
    let update_lookup_max_ms = update_latencies.iter().copied().fold(0.0, f64::max);
    let update_lookup_samples = update_latencies.len();
    latencies.extend(update_latencies);
    let path = graph.join("node-1.md");
    fs::write(
        &path,
        "---\nkind: note\ntitle: Updated person\n---\n[Target](mimir://graph/node-9999)",
    )
    .unwrap();
    let started = Instant::now();
    runtime
        .refresh(vec![path.to_string_lossy().into_owned()])
        .unwrap();
    let changed_file_ms = started.elapsed().as_secs_f64() * 1000.0;
    latencies.sort_by(f64::total_cmp);
    let p95_ms = latencies[(latencies.len() * 95 / 100).min(latencies.len() - 1)];
    eprintln!(
        "graph_links_runtime_benchmark={}",
        json!({
            "files": NODES, "startupMs": startup_ms, "fullRefreshMs": full_refresh_ms,
            "lookupP95Ms": p95_ms, "lookupMaxMs": latencies.last().unwrap(),
            "lookupDuringWritesMaxMs": update_lookup_max_ms, "lookupDuringWritesSamples": update_lookup_samples,
            "updateMeanMs": update_ms, "changedFileMs": changed_file_ms,
        })
    );
    // Debug regression ceilings tolerate loaded CI hosts. These do not stand
    // in for native webview, energy, or thermal measurements.
    assert!(
        p95_ms < 150.0,
        "Indexed title lookup regressed: {p95_ms} ms"
    );
    assert!(
        changed_file_ms < 250.0,
        "One-file refresh regressed: {changed_file_ms} ms"
    );
    assert_eq!(
        runtime
            .references("node-9999", &BTreeSet::new())
            .unwrap()
            .backlinks
            .len(),
        3
    );
    let node = runtime.get("node-0").unwrap().unwrap();
    assert_eq!(node.body, "Changed 19. [Target](mimir://graph/node-9999)");
}
