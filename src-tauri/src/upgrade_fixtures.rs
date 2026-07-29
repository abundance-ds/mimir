//! Upgrade fixtures: sanitized `~/.mimir` data-dir snapshots per released
//! version, loaded by tests to prove every loader upgrades old data cleanly.
//! Snapshots live under `src-tauri/tests/fixtures/mimir-home/`.
//!
//! # Policy
//!
//! - One directory per shipped version (`v0.1.0`, `v0.2.0`, ...). A snapshot is
//!   frozen once its version ships: never edit checked-in snapshots, only add
//!   the next version's directory with the ignored generator test below.
//! - Every snapshot populates every persisted area so the harness can apply
//!   the same generic assertions to all versions: `settings.json`,
//!   `session.json`, `models.json`, `launchers.json`, `routines/` +
//!   `routines-state.json`, one durable activity under `activities/`, one
//!   local app under `apps/` + JSON under `app-data/`, and graph markdown
//!   under `graph/private/`.
//! - Snapshots are sanitized: fake `/Users/tester/...` paths only, and no
//!   secrets (API keys live in the OS keychain, never in these files).
//!
//! # Loader rewrite contracts (documented, not bugs)
//!
//! - `ai_models::load_registry` rewrites `models.json` when the stored
//!   `version` is older than the embedded defaults (migration) or when the
//!   file is missing/corrupt. Snapshots are written at their era's current
//!   version, so loading them with the same era's loader is read-only; a later
//!   loader that migrates is expected to rewrite. The harness checks parse
//!   compatibility with the current serde schema, which is the part that must
//!   never break.
//! - Activity hydration rewrites a persisted record only when it was saved in
//!   a live status (marking it interrupted). Snapshots persist ended
//!   activities, so hydration is read-only; the harness asserts no bytes
//!   changed and would surface any new rewrite-on-load behavior.
//! - `launchers::load_config`, settings, and session loaders write only when
//!   the file is missing or quarantined; snapshots always provide valid files.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::activities::{ActivityStatus, ActivitySupervisor, ActivitySupervisorConfig};
use crate::ai_models::ModelRegistry;
use crate::business_graph::{build_migration_report, GraphScopeKind, GraphSourceRoot, GraphStore};
use crate::launchers::{self, LauncherKind, LauncherPreset, WorkingDirectory};
use crate::persistence::{load_json_optional_quarantining, QuarantinedLoad};
use crate::routine_runtime::{RoutineRuntime, RoutineRuntimeConfig};
use crate::routines;

const CURRENT_SNAPSHOT: &str = concat!("v", env!("CARGO_PKG_VERSION"));

fn fixtures_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("mimir-home")
}

/// Every checked-in version snapshot, sorted by directory name. Future
/// `vX.Y.Z` directories are picked up automatically.
fn shipped_snapshot_dirs() -> Vec<(String, PathBuf)> {
    let root = fixtures_root();
    let mut versions = fs::read_dir(&root)
        .unwrap_or_else(|error| {
            panic!(
                "upgrade fixture root {} should exist and be readable: {error}",
                root.display()
            )
        })
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .map(|path| {
            let name = path
                .file_name()
                .expect("snapshot directory should have a name")
                .to_string_lossy()
                .into_owned();
            (name, path)
        })
        .collect::<Vec<_>>();
    versions.sort();
    versions
}

fn copy_tree(source: &Path, target: &Path) {
    fs::create_dir_all(target).expect("fixture copy target should be creatable");
    for entry in fs::read_dir(source).expect("fixture source should be readable") {
        let entry = entry.expect("fixture source entry should be readable");
        let path = entry.path();
        let destination = target.join(entry.file_name());
        if path.is_dir() {
            copy_tree(&path, &destination);
        } else {
            fs::copy(&path, &destination).expect("fixture file should copy");
        }
    }
}

/// Relative path -> exact bytes for every file under `root`.
fn tree_bytes(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, directory: &Path, files: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(directory).expect("fixture directory should be readable") {
            let path = entry
                .expect("fixture directory entry should be readable")
                .path();
            if path.is_dir() {
                walk(root, &path, files);
            } else {
                let relative = path
                    .strip_prefix(root)
                    .expect("walked path should stay under the root")
                    .to_string_lossy()
                    .into_owned();
                let bytes = fs::read(&path).expect("fixture file should be readable");
                files.insert(relative, bytes);
            }
        }
    }

    let mut files = BTreeMap::new();
    walk(root, root, &mut files);
    files
}

fn load_fixture_json_object(version: &str, path: &Path) -> Map<String, Value> {
    // `session_load`/`settings_load` are thin private wrappers over exactly
    // this call (same type parameter, same quarantine semantics); the wrappers
    // are only reachable through $HOME, which tests must not mutate.
    match load_json_optional_quarantining::<Map<String, Value>>(path) {
        Ok(QuarantinedLoad::Loaded(object)) => object,
        other => panic!(
            "[{version}] {} should load as a clean JSON object, got {other:?}",
            path.display()
        ),
    }
}

#[test]
fn every_shipped_snapshot_loads_cleanly_and_is_left_untouched() {
    let versions = shipped_snapshot_dirs();
    assert!(
        versions.iter().any(|(name, _)| name == "v0.1.0"),
        "the v0.1.0 snapshot must stay checked in under {}",
        fixtures_root().display()
    );

    for (version, source) in versions {
        let temp = tempfile::tempdir().expect("harness tempdir should be creatable");
        let home = temp.path().join("home");
        let mimir = home.join(".mimir");
        copy_tree(&source, &mimir);
        let before = tree_bytes(&mimir);

        check_settings(&version, &mimir);
        check_session(&version, &mimir);
        check_model_registry(&version, &mimir);
        check_launchers(&version, &mimir);
        check_routine_definitions(&version, &mimir);
        check_apps(&version, &mimir);
        check_app_data(&version, &mimir);
        check_graph(&version, &mimir);
        check_activities_and_routine_runtime(&version, &home, &mimir);

        let after = tree_bytes(&mimir);
        assert_eq!(
            before.keys().collect::<Vec<_>>(),
            after.keys().collect::<Vec<_>>(),
            "[{version}] loading must not create or delete files (quarantine or rewrite artifacts)"
        );
        for (path, bytes) in &before {
            assert!(
                after.get(path) == Some(bytes),
                "[{version}] loading must not rewrite {path}"
            );
        }
    }
}

fn check_settings(version: &str, mimir: &Path) {
    let settings = load_fixture_json_object(version, &mimir.join("settings.json"));
    assert!(
        !settings.is_empty(),
        "[{version}] settings.json should carry representative settings"
    );
    if version == "v0.1.0" {
        assert_eq!(
            settings["editor"]["workbenchZoom"],
            json!(110),
            "[{version}] editor.workbenchZoom spot check"
        );
        assert_eq!(settings["editor"]["editorTheme"], json!("parchment"));
    }
}

fn check_session(version: &str, mimir: &Path) {
    let session = load_fixture_json_object(version, &mimir.join("session.json"));
    let open_files = session
        .get("openFiles")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("[{version}] session.json should list openFiles"));
    assert!(
        !open_files.is_empty(),
        "[{version}] session.json should keep open tabs"
    );
    if version == "v0.1.0" {
        assert_eq!(
            open_files[0]["path"],
            json!("/Users/tester/projects/acme/notes/roadmap.md")
        );
        assert_eq!(
            open_files[1]["dirty"],
            json!(true),
            "[{version}] the dirty tab keeps its unsaved buffer"
        );
        assert_eq!(
            open_files[2]["path"],
            Value::Null,
            "[{version}] the untitled draft survives with a null path"
        );
        assert_eq!(session["activeFileIndex"], json!(1));
    }
}

fn check_model_registry(version: &str, mimir: &Path) {
    // `ai_models::load_registry` parses with exactly these serde types before
    // deciding whether to migrate; parse compatibility is the durable
    // contract. The full loader is only reachable through $HOME (see module
    // docs for its rewrite-on-migrate contract).
    let registry =
        match load_json_optional_quarantining::<ModelRegistry>(&mimir.join("models.json")) {
            Ok(QuarantinedLoad::Loaded(registry)) => registry,
            other => {
                panic!("[{version}] models.json should parse as a model registry, got {other:?}")
            }
        };
    assert!(registry.version >= 1, "[{version}] registry version");
    assert!(
        !registry.models.is_empty(),
        "[{version}] models.json should carry models"
    );
    assert!(
        !registry.providers.is_empty(),
        "[{version}] models.json should carry providers"
    );
    if version == "v0.1.0" {
        assert!(
            registry
                .models
                .iter()
                .any(|model| model.provider == "anthropic"),
            "[{version}] the registry keeps an anthropic model"
        );
    }
}

fn check_launchers(version: &str, mimir: &Path) {
    let response = launchers::load_config(&mimir.join("launchers.json"))
        .unwrap_or_else(|error| panic!("[{version}] launchers.json should load: {error}"));
    assert!(
        response.diagnostic.is_none(),
        "[{version}] launchers.json should load without quarantine: {:?}",
        response.diagnostic
    );
    assert!(
        !response.presets.is_empty(),
        "[{version}] launchers.json should keep presets"
    );
    if version == "v0.1.0" {
        let preset = response
            .presets
            .iter()
            .find(|preset| preset.id == "claude-headless")
            .unwrap_or_else(|| panic!("[{version}] the claude-headless preset survives"));
        assert_eq!(preset.title, "Claude (headless)");
        assert_eq!(preset.binary.as_deref(), Some("claude"));
        assert_eq!(preset.cwd, WorkingDirectory::Home);
    }
}

fn check_routine_definitions(version: &str, mimir: &Path) {
    let catalog = routines::load_catalog(&mimir.join("routines"));
    assert!(
        catalog.diagnostics.is_empty(),
        "[{version}] routine TOML should load without diagnostics: {:?}",
        catalog.diagnostics
    );
    assert!(
        !catalog.routines.is_empty(),
        "[{version}] routines/ should keep at least one definition"
    );
    if version == "v0.1.0" {
        let routine = &catalog.routines[0];
        assert_eq!(routine.id, "daily-review");
        assert_eq!(routine.schedule.as_deref(), Some("30 8 * * 1-5"));
        assert_eq!(routine.preset, "claude-headless");
    }
}

fn check_apps(version: &str, mimir: &Path) {
    let catalog = crate::apps::load_catalog(&mimir.join("apps"));
    assert!(
        catalog.diagnostics.is_empty(),
        "[{version}] app manifests should load without diagnostics: {:?}",
        catalog.diagnostics
    );
    assert!(
        catalog.apps.iter().any(|app| !app.builtin),
        "[{version}] apps/ should keep at least one local app"
    );
    if version == "v0.1.0" {
        let app = catalog
            .apps
            .iter()
            .find(|app| app.definition.id == "field-notes")
            .unwrap_or_else(|| panic!("[{version}] the field-notes app survives"));
        assert!(!app.builtin);
        assert_eq!(app.definition.title, "Field notes");
    }
}

fn check_app_data(version: &str, mimir: &Path) {
    // `app_data_load` is a plain `fs::read_to_string` of
    // `~/.mimir/app-data/<app>/<key>.json` with no injectable path; mirror it.
    let root = mimir.join("app-data");
    let mut loaded = 0usize;
    for app_directory in fs::read_dir(&root)
        .unwrap_or_else(|error| panic!("[{version}] app-data/ should be readable: {error}"))
    {
        let app_directory = app_directory
            .expect("app-data entry should be readable")
            .path();
        if !app_directory.is_dir() {
            continue;
        }
        for entry in fs::read_dir(&app_directory).expect("app-data app dir should be readable") {
            let path = entry.expect("app-data file should be readable").path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let raw = fs::read_to_string(&path)
                .unwrap_or_else(|error| panic!("[{version}] app data should read: {error}"));
            let value: Value = serde_json::from_str(&raw).unwrap_or_else(|error| {
                panic!(
                    "[{version}] app data {} should stay valid JSON: {error}",
                    path.display()
                )
            });
            if version == "v0.1.0" && path.ends_with(Path::new("scratch/note.json")) {
                assert_eq!(value["text"], json!("Ship the v0.1 fixture harness."));
            }
            loaded += 1;
        }
    }
    assert!(
        loaded > 0,
        "[{version}] app-data/ should keep at least one JSON document"
    );
}

fn check_graph(version: &str, mimir: &Path) {
    let private_root = mimir.join("graph").join("private");
    let roots = [GraphSourceRoot::new(
        "private:local",
        GraphScopeKind::Private,
        private_root.as_path(),
    )];

    let store = GraphStore::load(&roots);
    assert!(
        store.diagnostics().is_empty(),
        "[{version}] graph sources should load without diagnostics: {:?}",
        store.diagnostics()
    );
    assert!(
        store.len() >= 3,
        "[{version}] graph/private should keep a small connected graph"
    );

    let report = build_migration_report(&roots);
    assert!(report.dry_run, "[{version}] migration report is a dry run");
    assert!(
        report.collisions.is_empty(),
        "[{version}] graph ids should not collide: {:?}",
        report.collisions
    );
    assert!(
        report.diagnostics.is_empty(),
        "[{version}] migration dry run should be clean: {:?}",
        report.diagnostics
    );

    if version == "v0.1.0" {
        let company = store
            .get("acme-health")
            .unwrap_or_else(|| panic!("[{version}] the acme-health company node survives"));
        assert_eq!(company.title, "Acme Health");
        assert_eq!(company.kind, "company");
        assert_eq!(
            company.properties.get("website"),
            Some(&json!("https://acme-health.example"))
        );

        let project = store.get("evidence-roadmap").unwrap();
        assert!(
            project
                .relations
                .iter()
                .any(|relation| relation.relation == "for_company"
                    && relation.target == "acme-health")
        );

        let issue = store.get("issue-1753600000-fx01").unwrap();
        assert_eq!(issue.kind, "issue");
        assert_eq!(issue.status(), Some("in-progress"));
        assert_eq!(issue.priority(), Some("high"));
        assert!(issue
            .relations
            .iter()
            .any(|relation| relation.relation == "assigned_to" && relation.target == "dana-reyes"));
        assert_eq!(report.issue_count, 1);
        assert_eq!(report.parsed_count, 5);
    }
}

fn check_activities_and_routine_runtime(version: &str, home: &Path, mimir: &Path) {
    let supervisor =
        ActivitySupervisor::new(ActivitySupervisorConfig::new(mimir.join("activities")))
            .unwrap_or_else(|error| {
                panic!("[{version}] activity hydration should succeed: {error}")
            });
    assert!(
        supervisor.quarantined_files().is_empty(),
        "[{version}] no persisted activity should be quarantined: {:?}",
        supervisor.quarantined_files()
    );
    let records = supervisor.list();
    assert!(
        !records.is_empty(),
        "[{version}] activities/ should keep at least one durable record"
    );
    for record in &records {
        // A record persisted in a live status would be rewritten as
        // interrupted during hydration; snapshots must persist ended runs.
        assert!(
            !record.status.is_live(),
            "[{version}] activity '{}' hydrated live ({:?}); hydration rewrote its file",
            record.id,
            record.status
        );
    }
    if version == "v0.1.0" {
        let record = records
            .iter()
            .find(|record| record.id == "agent-fixture-0001")
            .unwrap_or_else(|| panic!("[{version}] the fixture agent activity survives"));
        assert_eq!(record.title, "Codex review");
        assert_eq!(record.status, ActivityStatus::Done);
        assert_eq!(
            record.workspace_path.as_deref(),
            Some("/Users/tester/projects/acme")
        );
        let replay = supervisor
            .replay(&record.id, None)
            .expect("fixture activity scrollback should replay");
        let bytes = replay
            .chunks
            .iter()
            .flat_map(|chunk| chunk.bytes.iter().copied())
            .collect::<Vec<u8>>();
        let needle = b"fixture scrollback line";
        assert!(
            bytes.windows(needle.len()).any(|window| window == needle),
            "[{version}] scrollback replay keeps the persisted output"
        );
    }

    // The routine runtime loads routines-state.json, the routine TOML, and
    // launchers.json together at construction. It is only constructed, never
    // ticked or started: a tick would legitimately rewrite planner state.
    let runtime = RoutineRuntime::new(
        RoutineRuntimeConfig {
            routines_dir: mimir.join("routines"),
            planner_state_path: mimir.join("routines-state.json"),
            launcher_config_path: mimir.join("launchers.json"),
            home_path: home.to_path_buf(),
            default_shell: PathBuf::from("/bin/sh"),
            tick_interval: Duration::from_secs(3600),
            mcp_url: "http://127.0.0.1:17532/mcp".into(),
        },
        supervisor.clone(),
    )
    .unwrap_or_else(|error| panic!("[{version}] routine runtime should construct: {error}"));
    let catalog = runtime.catalog();
    assert!(
        catalog.diagnostics.is_empty(),
        "[{version}] routine runtime should load without diagnostics: {:?}",
        catalog.diagnostics
    );
    assert!(
        !catalog.routines.is_empty(),
        "[{version}] routine runtime should surface the fixture routines"
    );
    for routine in &catalog.routines {
        assert!(
            routine.available,
            "[{version}] routine '{}' should resolve against the fixture launchers: {:?}",
            routine.definition.id, routine.diagnostic
        );
    }
    if version == "v0.1.0" {
        let routine = catalog
            .routines
            .iter()
            .find(|routine| routine.definition.id == "daily-review")
            .unwrap_or_else(|| panic!("[{version}] the daily-review routine survives"));
        assert!(
            routine.next_fire.is_some(),
            "[{version}] planner state keeps the armed next fire"
        );
    }

    supervisor
        .flush_persistence()
        .unwrap_or_else(|error| panic!("[{version}] persistence flush should succeed: {error}"));
    assert!(
        supervisor.take_persistence_errors().is_empty(),
        "[{version}] hydration should not queue persistence errors"
    );
}

/// One-time generator for the CURRENT version's snapshot. Run it before
/// cutting a release so the shipped on-disk formats are captured by the real
/// save APIs, then commit the new directory:
///
/// ```sh
/// cargo test --manifest-path src-tauri/Cargo.toml \
///     upgrade_fixtures::generate_current_version_snapshot -- --ignored
/// ```
///
/// It refuses to overwrite an existing snapshot; shipped snapshots are frozen.
#[test]
#[ignore = "writes the current version's snapshot into tests/fixtures/mimir-home/"]
fn generate_current_version_snapshot() {
    use crate::activities::{
        ActivityHost, ActivityKind, ActivityLaunchSpec, ActivityOrigin, ActivityRecord,
        ActivityRetention, SpawnActivityRequest,
    };
    use crate::business_graph::{GraphNodeCreate, GraphRelation};
    use crate::persistence::{write_bytes_atomic, write_json_atomic};
    use crate::routines::{MissedFirePolicy, RoutineDefinition, RoutineOverlap};

    let target = fixtures_root().join(CURRENT_SNAPSHOT);
    assert!(
        !target.exists(),
        "snapshot {} already exists; shipped snapshots are frozen (delete it only to regenerate an unreleased one)",
        target.display()
    );
    fs::create_dir_all(&target).expect("snapshot directory should be creatable");

    // settings.json / session.json: written through the same atomic JSON
    // writer the settings/session savers use.
    write_json_atomic(
        target.join("settings.json"),
        &json!({
            "editor": {
                "workbenchZoom": 110,
                "editorFontFamily": "mono",
                "editorFontSize": 16,
                "editorTheme": "parchment",
                "editorWordWrap": true,
                "editorLineNumbers": false,
                "editorAutoSave": true,
                "mimirTerminalFontSize": 12,
                "mimirWorkspaceFolder": "/Users/tester/projects/acme",
                "recentWorkspaceFolders": ["/Users/tester/projects/acme"],
                "workbenchLayout": {
                    "sidebar": { "state": "expanded", "width": 240 },
                    "activity": { "state": "expanded", "width": 560 },
                    "editor": { "state": "expanded", "width": 520 }
                }
            },
            "apps": { "scratch": { "expanded": true } }
        }),
    )
    .expect("settings.json should be written");
    write_json_atomic(
        target.join("session.json"),
        &json!({
            "openFiles": [
                { "path": "/Users/tester/projects/acme/notes/roadmap.md" },
                {
                    "path": "/Users/tester/projects/acme/notes/meeting.md",
                    "content": "# Meeting\n\nUnsaved meeting notes line.\n",
                    "dirty": true
                },
                {
                    "path": null,
                    "content": "Scratch draft that was never saved.",
                    "draftId": "draft-0001"
                }
            ],
            "recentFiles": [
                "/Users/tester/projects/acme/notes/roadmap.md",
                "/Users/tester/projects/acme/README.md"
            ],
            "activeFileIndex": 1,
            "zoomLevel": 1.1
        }),
    )
    .expect("session.json should be written");

    // models.json: the embedded defaults, exactly as `load_registry`
    // materializes them on first launch.
    let registry: ModelRegistry = serde_json::from_str(include_str!("../resources/ai-models.json"))
        .expect("embedded model registry should parse");
    write_json_atomic(target.join("models.json"), &registry)
        .expect("models.json should be written");

    // launchers.json through the real saver: the default presets plus one
    // headless preset with an exact binary, which routines resolve without
    // machine-dependent agent detection.
    let mut presets = launchers::default_config().presets;
    presets.push(LauncherPreset {
        id: "claude-headless".into(),
        title: "Claude (headless)".into(),
        kind: LauncherKind::Agent,
        enabled: true,
        agent_id: Some("claude".into()),
        binary: Some("claude".into()),
        args: vec!["--output-format".into(), "text".into()],
        env: BTreeMap::from([("MIMIR_ROUTINE_RUN".into(), "1".into())]),
        cwd: WorkingDirectory::Home,
    });
    launchers::save_config(&target.join("launchers.json"), presets)
        .expect("launchers.json should be written");

    // graph/private through the real store mutations (serializer + writer).
    let private_root = target.join("graph").join("private");
    let root = GraphSourceRoot::new(
        "private:local",
        GraphScopeKind::Private,
        private_root.as_path(),
    );
    let mut store = GraphStore::load(std::slice::from_ref(&root));
    let mut create = |create: GraphNodeCreate| {
        store
            .create_node(&root, create)
            .expect("fixture graph node should be created");
    };
    create(GraphNodeCreate {
        id: Some("acme-health".into()),
        kind: "company".into(),
        title: "Acme Health".into(),
        summary: "HEOR consultancy client.".into(),
        body: "Regional health analytics company; renewal expected in Q4.\n".into(),
        tags: vec!["client".into(), "heor".into()],
        properties: Map::from_iter([("website".into(), json!("https://acme-health.example"))]),
        ..GraphNodeCreate::default()
    });
    create(GraphNodeCreate {
        id: Some("dana-reyes".into()),
        kind: "person".into(),
        title: "Dana Reyes".into(),
        summary: "Director of market access at Acme Health.".into(),
        tags: vec!["contact".into()],
        relations: vec![GraphRelation {
            relation: "works_at".into(),
            target: "acme-health".into(),
            legacy: false,
        }],
        ..GraphNodeCreate::default()
    });
    create(GraphNodeCreate {
        id: Some("evidence-roadmap".into()),
        kind: "project".into(),
        title: "Evidence roadmap".into(),
        summary: "2026 evidence generation plan.".into(),
        body: "Milestones:\n\n- Gap analysis\n- Study shortlist\n- Publication plan\n".into(),
        relations: vec![GraphRelation {
            relation: "for_company".into(),
            target: "acme-health".into(),
            legacy: false,
        }],
        ..GraphNodeCreate::default()
    });
    create(GraphNodeCreate {
        id: Some("kickoff-notes".into()),
        kind: "note".into(),
        title: "Kickoff notes".into(),
        body: "Agreed on a value evidence roadmap and monthly checkpoints.\n".into(),
        tags: vec!["meeting".into()],
        relations: vec![GraphRelation {
            relation: "references".into(),
            target: "evidence-roadmap".into(),
            legacy: false,
        }],
        ..GraphNodeCreate::default()
    });
    create(GraphNodeCreate {
        id: Some("issue-1753600000-fx01".into()),
        kind: "issue".into(),
        title: "Draft evidence gap analysis".into(),
        summary: "First deliverable of the roadmap.".into(),
        body: "Collect published endpoints and map coverage gaps.\n".into(),
        properties: Map::from_iter([
            ("status".into(), json!("in-progress")),
            ("priority".into(), json!("high")),
        ]),
        relations: vec![
            GraphRelation {
                relation: "part_of".into(),
                target: "evidence-roadmap".into(),
                legacy: false,
            },
            GraphRelation {
                relation: "assigned_to".into(),
                target: "dana-reyes".into(),
                legacy: false,
            },
        ],
        ..GraphNodeCreate::default()
    });

    // apps/ through the real installer; app-data mirrors the builtin Today
    // (scratch) instrument's saved note, written with the app-data writer.
    crate::apps::create_local_app(
        &target.join("apps"),
        "field-notes",
        "Field notes",
        Some("A tiny working notebook."),
    )
    .expect("fixture app should be created");
    write_bytes_atomic(
        target.join("app-data").join("scratch").join("note.json"),
        br#"{"text":"Ship the v0.1 fixture harness.","updatedAt":"2026-07-27T09:30:00.000Z"}"#,
    )
    .expect("app data should be written");

    // One durable activity persisted by the real supervisor: spawn a short
    // PTY run and let completion persist the ended record plus scrollback.
    let supervisor =
        ActivitySupervisor::new(ActivitySupervisorConfig::new(target.join("activities")))
            .expect("generator supervisor should start");
    let record = ActivityRecord {
        id: "agent-fixture-0001".into(),
        kind: ActivityKind::Agent,
        title: "Codex review".into(),
        workspace_path: Some("/Users/tester/projects/acme".into()),
        status: ActivityStatus::Ready,
        created_at: "2026-07-27T09:00:00Z".into(),
        updated_at: "2026-07-27T09:00:00Z".into(),
        last_viewed_at: None,
        archived_at: None,
        close_requested_at: None,
        retention: ActivityRetention::Durable,
        source: ActivityOrigin {
            source_type: Some("launcher".into()),
            launcher_id: Some("codex".into()),
            preset_id: Some("codex".into()),
            ..ActivityOrigin::default()
        },
        host: ActivityHost::pty(Some("codex".into())),
        launch: Some(ActivityLaunchSpec {
            command: "/bin/echo".into(),
            args: vec!["fixture scrollback line".into()],
            cwd: None,
            env: BTreeMap::from([("MIMIR_ACTIVITY_ID".into(), "agent-fixture-0001".into())]),
        }),
        session: None,
        error: None,
    };
    supervisor
        .spawn(SpawnActivityRequest::new(record, 80, 24))
        .expect("fixture activity should spawn");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let record = supervisor
            .list()
            .into_iter()
            .find(|record| record.id == "agent-fixture-0001")
            .expect("spawned fixture activity should be listed");
        if record.status.is_ended() {
            assert_eq!(record.status, ActivityStatus::Done, "echo should complete");
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "fixture echo child should exit quickly"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // Let the reader drain the last PTY bytes, then force the final persist.
    std::thread::sleep(Duration::from_millis(200));
    supervisor
        .flush_persistence()
        .expect("generator persistence should flush");
    assert!(
        supervisor.take_persistence_errors().is_empty(),
        "generator persistence should be clean"
    );

    // routines/ + routines-state.json through the real runtime: the TOML via
    // create_definition, the planner state via one arming tick.
    let generator_home = tempfile::tempdir().expect("generator home should be creatable");
    let runtime = RoutineRuntime::new(
        RoutineRuntimeConfig {
            routines_dir: target.join("routines"),
            planner_state_path: target.join("routines-state.json"),
            launcher_config_path: target.join("launchers.json"),
            home_path: generator_home.path().to_path_buf(),
            default_shell: PathBuf::from("/bin/sh"),
            tick_interval: Duration::from_secs(3600),
            mcp_url: "http://127.0.0.1:17532/mcp".into(),
        },
        supervisor.clone(),
    )
    .expect("generator routine runtime should construct");
    runtime
        .create_definition(RoutineDefinition {
            id: "daily-review".into(),
            title: "Daily review".into(),
            enabled: true,
            schedule: Some("30 8 * * 1-5".into()),
            timezone: "Europe/Berlin".into(),
            preset: "claude-headless".into(),
            prompt: "Summarise yesterday's work and plan today.".into(),
            overlap: RoutineOverlap::Skip,
            missed: MissedFirePolicy::RunOnce,
            workspace: None,
            interactive: false,
        })
        .expect("fixture routine should be created");
    runtime
        .tick_at(chrono::Utc::now())
        .expect("arming tick should succeed");
    assert!(
        target.join("routines-state.json").is_file(),
        "the arming tick should persist planner state"
    );

    // The persisted activity file must hold the scrollback we expect; catch a
    // silent persistence regression at generation time, not at review time.
    let activities = fs::read_dir(target.join("activities"))
        .expect("generated activities directory should be readable")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".activity.json"))
        })
        .collect::<Vec<_>>();
    assert_eq!(activities.len(), 1, "exactly one persisted activity");
    let persisted: Value = serde_json::from_slice(
        &fs::read(&activities[0]).expect("persisted activity should be readable"),
    )
    .expect("persisted activity should be JSON");
    assert_eq!(persisted["record"]["status"], json!("done"));
    assert!(
        !persisted["scrollback"]["chunks"]
            .as_array()
            .expect("persisted scrollback chunks")
            .is_empty(),
        "persisted scrollback should retain the echo output"
    );
}
