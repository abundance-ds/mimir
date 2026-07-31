//! Golden IPC fixtures: canonical JSON serializations of high-traffic Tauri
//! command responses, shared with the renderer test suite so the two sides
//! cannot silently drift. See `src-tauri/tests/fixtures/ipc/`.
//!
//! Each fixture is a representative response value constructed from the real
//! Rust types and serialized with serde. The golden test compares the
//! serialization against the committed JSON file; renderer tests load the same
//! file through `src/test/ipcFixtures.js` instead of hand-writing shapes.
//! Regenerate after intentional shape changes with:
//!
//! ```sh
//! UPDATE_IPC_FIXTURES=1 cargo test --manifest-path src-tauri/Cargo.toml ipc_fixtures
//! ```

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Map};

use crate::activities::{
    ActivityHistorySearchHit, ActivityHost, ActivityKind, ActivityLaunchSpec, ActivityOrigin,
    ActivityRecord, ActivityRetention, ActivitySessionRecord, ActivityStatus, SessionExitReason,
    SessionExitRecord,
};
use crate::apps::{
    AppCatalog, AppDefinition, AppDiagnostic, AppMode, AppToolDefinition, InstalledApp,
};
use crate::business_graph::{
    GraphNode, GraphNodeSummary, GraphOpenResult, GraphProvenance, GraphQueryResult, GraphRelation,
    GraphScopeDescriptor, GraphScopeKind, GraphSourceFormat,
};
use crate::file_index::{ContentSearchMatch, ContentSearchReport, FileIndexEntry, IndexRefresh};
use crate::git::GitStatusEntry;
use crate::launchers::{
    AgentDefinition, DetectedAgent, LauncherConfigResponse, LauncherKind, LauncherPreset,
    ResolvedLaunch, ResumeStrategy, WorkingDirectory,
};
use crate::meetings::commands::{MeetingStartConsentDisclosure, MeetingStartConsentGrant};
use crate::meetings::runtime::{
    MeetingCandidate, MeetingConfig, MeetingExport, MeetingGapView, MeetingJobView,
    MeetingLibraryCursor, MeetingLibraryPage, MeetingModel, MeetingPermissions, MeetingSegmentView,
    MeetingSnapshot, MeetingTranscriptCursor, MeetingTranscriptPage, MeetingView,
};
use crate::routine_runtime::{RoutineRuntimeCatalog, RoutineRuntimeEntry};
use crate::routines::{
    MissedFirePolicy, RoutineDefinition, RoutineDiagnostic, RoutineFire, RoutineFireReason,
    RoutineOverlap, RoutineTick,
};
use crate::workspace_files::WorkspaceEntry;

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ipc")
}

fn string_map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).into(), (*value).into()))
        .collect()
}

/// `activity_list` → `Vec<ActivityRecord>`: one live agent with every optional
/// populated, one ended archived terminal with optionals absent.
fn activity_list() -> Vec<ActivityRecord> {
    vec![
        ActivityRecord {
            id: "agent:01HZX3R8KQ".into(),
            kind: ActivityKind::Agent,
            title: "Codex — fix sidebar ordering".into(),
            auto_title_eligible: false,
            workspace_path: Some("/Users/me/work/mimir".into()),
            status: ActivityStatus::Working,
            created_at: "2026-07-25T10:00:00.000Z".into(),
            updated_at: "2026-07-25T10:04:12.000Z".into(),
            last_viewed_at: Some("2026-07-25T10:03:00.000Z".into()),
            archived_at: None,
            close_requested_at: None,
            retention: ActivityRetention::Durable,
            source: ActivityOrigin {
                source_type: Some("launcher".into()),
                launcher_id: Some("codex".into()),
                preset_id: Some("codex-full".into()),
                graph_node_id: Some("issue-sidebar-ordering".into()),
                graph_scope_ids: vec!["project:mimir".into()],
                graph_revision: Some(17),
                ..ActivityOrigin::default()
            },
            host: ActivityHost::pty(Some("codex".into())),
            launch: Some(ActivityLaunchSpec {
                command: "/opt/homebrew/bin/codex".into(),
                args: vec!["--full-auto".into()],
                cwd: Some("/Users/me/work/mimir".into()),
                env: string_map(&[("MIMIR_ACTIVITY_ID", "agent:01HZX3R8KQ")]),
            }),
            session: Some(ActivitySessionRecord {
                run_id: "run-01HZX3RA".into(),
                started_at: "2026-07-25T10:00:01.000Z".into(),
                ended_at: None,
                agent_id: Some("codex".into()),
                cli_session_id: Some("0197c2f1-4b2d-7d10-a1e2-3f4a5b6c7d8e".into()),
                exit: None,
                last_output_sequence: 412,
                scrollback_bytes: 65536,
            }),
            error: None,
        },
        ActivityRecord {
            id: "terminal:01HZX40000".into(),
            kind: ActivityKind::Terminal,
            title: "Terminal".into(),
            auto_title_eligible: false,
            workspace_path: None,
            status: ActivityStatus::Stopped,
            created_at: "2026-07-24T18:30:00.000Z".into(),
            updated_at: "2026-07-24T19:02:45.000Z".into(),
            last_viewed_at: None,
            archived_at: Some("2026-07-25T08:00:00.000Z".into()),
            close_requested_at: None,
            retention: ActivityRetention::Durable,
            source: ActivityOrigin::default(),
            host: ActivityHost::pty(None),
            launch: Some(ActivityLaunchSpec {
                command: "/bin/zsh".into(),
                args: vec!["-l".into()],
                cwd: None,
                env: BTreeMap::new(),
            }),
            session: Some(ActivitySessionRecord {
                run_id: "run-01HZX40001".into(),
                started_at: "2026-07-24T18:30:00.000Z".into(),
                ended_at: Some("2026-07-24T19:02:45.000Z".into()),
                agent_id: None,
                cli_session_id: None,
                exit: Some(SessionExitRecord {
                    reason: SessionExitReason::Stopped,
                    code: None,
                    signal: Some("SIGTERM".into()),
                    message: None,
                }),
                last_output_sequence: 88,
                scrollback_bytes: 16384,
            }),
            error: None,
        },
    ]
}

/// `activity_search_history` → `Vec<ActivityHistorySearchHit>`.
fn activity_search_history() -> Vec<ActivityHistorySearchHit> {
    vec![
        ActivityHistorySearchHit {
            activity_id: "agent:01HZX3R8KQ".into(),
            snippet: "… reordered the sidebar rows by recency …".into(),
        },
        ActivityHistorySearchHit {
            activity_id: "terminal:01HZX40000".into(),
            snippet: "grep -rn \"sidebar\" src/mimir/components".into(),
        },
    ]
}

/// `git_status` → `Vec<GitStatusEntry>` (path-sorted, as production returns).
fn git_status() -> Vec<GitStatusEntry> {
    vec![
        GitStatusEntry {
            path: "README.md".into(),
            status: "new".into(),
        },
        GitStatusEntry {
            path: "gone.md".into(),
            status: "deleted".into(),
        },
        GitStatusEntry {
            path: "src/z.js".into(),
            status: "modified".into(),
        },
    ]
}

/// `launcher_detect_agents` → `Vec<DetectedAgent>`: one installed, one missing.
fn launcher_detect_agents() -> Vec<DetectedAgent> {
    vec![
        DetectedAgent {
            definition: AgentDefinition {
                id: "codex".into(),
                title: "Codex".into(),
                binary: "codex".into(),
                resume_strategy: ResumeStrategy::Codex,
            },
            installed: true,
            binary_path: Some("/opt/homebrew/bin/codex".into()),
            version: Some("codex-cli 0.21.0".into()),
            diagnostic: None,
        },
        DetectedAgent {
            definition: AgentDefinition {
                id: "claude".into(),
                title: "Claude".into(),
                binary: "claude".into(),
                resume_strategy: ResumeStrategy::Claude,
            },
            installed: false,
            binary_path: None,
            version: None,
            diagnostic: Some("'claude' was not found in the login-shell environment.".into()),
        },
    ]
}

/// `launcher_load_config` → `LauncherConfigResponse`.
fn launcher_load_config() -> LauncherConfigResponse {
    LauncherConfigResponse {
        path: "/home/me/.mimir/launchers.json".into(),
        presets: vec![
            LauncherPreset {
                id: "review".into(),
                title: "Review".into(),
                kind: LauncherKind::Agent,
                enabled: true,
                agent_id: Some("codex".into()),
                binary: None,
                args: vec!["review".into()],
                env: string_map(&[("CODEX_HOME", "/Users/me/.codex")]),
                cwd: WorkingDirectory::Workspace,
            },
            LauncherPreset {
                id: "claude".into(),
                title: "Claude".into(),
                kind: LauncherKind::Agent,
                enabled: true,
                agent_id: Some("claude".into()),
                binary: None,
                args: vec![],
                env: BTreeMap::new(),
                cwd: WorkingDirectory::Workspace,
            },
            LauncherPreset {
                id: "terminal".into(),
                title: "Terminal".into(),
                kind: LauncherKind::Terminal,
                enabled: true,
                agent_id: None,
                binary: None,
                args: vec![],
                env: BTreeMap::new(),
                cwd: WorkingDirectory::Home,
            },
        ],
        diagnostic: None,
    }
}

/// `launcher_resolve` → `ResolvedLaunch`.
fn launcher_resolve() -> ResolvedLaunch {
    ResolvedLaunch {
        preset_id: "review".into(),
        title: "Review".into(),
        kind: LauncherKind::Agent,
        agent_id: Some("codex".into()),
        resume_strategy: ResumeStrategy::Codex,
        cli_session_id: None,
        command: "/opt/homebrew/bin/codex".into(),
        args: vec!["review".into()],
        cwd: "/Users/me/work/mimir".into(),
        env: string_map(&[("CODEX_HOME", "/Users/me/.codex")]),
    }
}

/// `app_catalog` → `AppCatalog`: one builtin embedded app with manifest tools,
/// one local launch-only process app, one diagnostic.
fn app_catalog() -> AppCatalog {
    AppCatalog {
        directory: "/Users/me/.mimir/apps".into(),
        apps: vec![
            InstalledApp {
                definition: AppDefinition {
                    id: "today".into(),
                    title: "Today".into(),
                    description: "Daily notes at a glance.".into(),
                    mode: AppMode::Embedded,
                    entry: Some("index.html".into()),
                    command: None,
                    args: vec![],
                    env: BTreeMap::new(),
                    preset: None,
                    helper: None,
                    action_tool: None,
                    launch_only: false,
                    tools: vec![AppToolDefinition {
                        name: "today_read".into(),
                        description: "Read today's note.".into(),
                        input_schema: json!({"type": "object", "properties": {}}),
                        mcp_alias: Some("today_read".into()),
                    }],
                },
                directory: "/Users/me/.mimir/apps/today".into(),
                manifest_path: "/Users/me/.mimir/apps/today/app.toml".into(),
                builtin: true,
            },
            InstalledApp {
                definition: AppDefinition {
                    id: "ledger-sync".into(),
                    title: "Ledger Sync".into(),
                    description: String::new(),
                    mode: AppMode::Process,
                    entry: None,
                    command: Some("/usr/local/bin/ledger-sync".into()),
                    args: vec!["--watch".into()],
                    env: string_map(&[("LEDGER_HOME", "/Users/me/ledger")]),
                    preset: None,
                    helper: None,
                    action_tool: None,
                    launch_only: true,
                    tools: vec![],
                },
                directory: "/Users/me/.mimir/apps/ledger-sync".into(),
                manifest_path: "/Users/me/.mimir/apps/ledger-sync/app.toml".into(),
                builtin: false,
            },
        ],
        diagnostics: vec![AppDiagnostic {
            path: "/Users/me/.mimir/apps/broken/app.toml".into(),
            field: Some("entry".into()),
            message: "Missing entry for embedded app.".into(),
        }],
    }
}

/// `routine_catalog` → `RoutineRuntimeCatalog`.
fn routine_catalog() -> RoutineRuntimeCatalog {
    RoutineRuntimeCatalog {
        directory: "/Users/me/.mimir/routines".into(),
        state_path: "/Users/me/.mimir/routines-state.json".into(),
        revision: 4,
        routines: vec![RoutineRuntimeEntry {
            definition: RoutineDefinition {
                id: "morning-brief".into(),
                title: "Morning brief".into(),
                enabled: true,
                schedule: Some("0 0 7 * * *".into()),
                timezone: "Europe/Berlin".into(),
                preset: "codex".into(),
                prompt: "Summarize overnight repository activity.".into(),
                overlap: RoutineOverlap::Skip,
                missed: MissedFirePolicy::RunOnce,
                workspace: Some("/Users/me/work/mimir".into()),
                interactive: false,
            },
            available: true,
            next_fire: Some("2026-07-28T05:00:00Z".into()),
            diagnostic: None,
            running_activity_ids: vec!["routine:01HZX5Y2".into()],
            last_error: None,
            path: "/Users/me/.mimir/routines/morning-brief.toml".into(),
            source_revision: "9c2f4b1a".into(),
        }],
        diagnostics: vec![RoutineDiagnostic {
            path: "/Users/me/.mimir/routines/broken.toml".into(),
            field: Some("schedule".into()),
            message: "Invalid cron expression.".into(),
        }],
        last_tick: Some(RoutineTick {
            fires: vec![RoutineFire {
                routine_id: "morning-brief".into(),
                scheduled_for: "2026-07-27T05:00:00Z".into(),
                observed_at: "2026-07-27T05:00:01Z".into(),
                reason: RoutineFireReason::Scheduled,
            }],
            skips: vec![],
            next_fires: BTreeMap::from([("morning-brief".into(), "2026-07-28T05:00:00Z".into())]),
        }),
    }
}

/// `graph_open` (and `graph_status`) → `GraphOpenResult`.
fn graph_open() -> GraphOpenResult {
    GraphOpenResult {
        scopes: vec![
            GraphScopeDescriptor {
                id: "private".into(),
                kind: GraphScopeKind::Private,
                root: "/Users/me/.mimir/graph".into(),
            },
            GraphScopeDescriptor {
                id: "project:mimir".into(),
                kind: GraphScopeKind::Project,
                root: "/Users/me/work/mimir/.graph".into(),
            },
        ],
        node_count: 42,
        diagnostic_count: 1,
        graph_revision: 17,
    }
}

/// `graph_query` → `GraphQueryResult`: one issue summary with the optional
/// projection fields populated, one minimal person summary.
fn graph_query() -> GraphQueryResult {
    GraphQueryResult {
        items: vec![
            GraphNodeSummary {
                id: "issue-sidebar-ordering".into(),
                kind: "issue".into(),
                title: "Sidebar rows lose recency ordering".into(),
                summary: "Archived rows jump to the top after respawn.".into(),
                tags: vec!["mimir".into(), "ui".into()],
                status: Some("in-progress".into()),
                priority: Some("high".into()),
                due_date: Some("2026-08-01".into()),
                project_id: Some("project-mimir".into()),
                assignee_id: Some("person-paul".into()),
                waiting_for: None,
                remind_at: None,
                snooze_until: None,
                rank: Some(3),
                slug: Some("sidebar-ordering".into()),
                needs_detail: false,
                deliverables: vec![],
                relations: vec![
                    GraphRelation {
                        relation: "part_of".into(),
                        target: "project-mimir".into(),
                        legacy: false,
                    },
                    GraphRelation {
                        relation: "assigned_to".into(),
                        target: "person-paul".into(),
                        legacy: false,
                    },
                ],
                updated_at: "2026-07-26T09:15:00Z".into(),
                scope_id: "project:mimir".into(),
                source_revision: "4f6a2c88".into(),
            },
            GraphNodeSummary {
                id: "person-paul".into(),
                kind: "person".into(),
                title: "Paul".into(),
                summary: String::new(),
                tags: vec![],
                status: None,
                priority: None,
                due_date: None,
                project_id: None,
                assignee_id: None,
                waiting_for: None,
                remind_at: None,
                snooze_until: None,
                rank: None,
                slug: None,
                needs_detail: true,
                deliverables: vec![],
                relations: vec![],
                updated_at: "2026-07-20T08:00:00Z".into(),
                scope_id: "private".into(),
                source_revision: "1a2b3c4d".into(),
            },
        ],
        total: 2,
        offset: 0,
        limit: 100,
        graph_revision: 17,
    }
}

/// `graph_get` → `Option<GraphNode>` (the `Some` case).
fn graph_get() -> Option<GraphNode> {
    let mut properties = Map::new();
    properties.insert("status".into(), json!("in-progress"));
    properties.insert("priority".into(), json!("high"));
    properties.insert("dueDate".into(), json!("2026-08-01"));
    properties.insert("rank".into(), json!(3));
    Some(GraphNode {
        id: "issue-sidebar-ordering".into(),
        kind: "issue".into(),
        title: "Sidebar rows lose recency ordering".into(),
        summary: "Archived rows jump to the top after respawn.".into(),
        body: "Repro:\n\n1. Archive a durable agent.\n2. Respawn it from the sidebar.\n".into(),
        tags: vec!["mimir".into(), "ui".into()],
        relations: vec![
            GraphRelation {
                relation: "part_of".into(),
                target: "project-mimir".into(),
                legacy: false,
            },
            GraphRelation {
                relation: "assigned_to".into(),
                target: "person-paul".into(),
                legacy: false,
            },
        ],
        properties,
        created_at: "2026-07-19T12:00:00Z".into(),
        updated_at: "2026-07-26T09:15:00Z".into(),
        provenance: GraphProvenance {
            scope_id: "project:mimir".into(),
            scope_kind: GraphScopeKind::Project,
            source_path: "/Users/me/work/mimir/.graph/issues/sidebar-ordering.md".into(),
            source_revision: "4f6a2c88".into(),
            source_format: GraphSourceFormat::Issue,
        },
    })
}

/// `file_index_files` → recent-first entries; `FileIndexSnapshot` serializes
/// exactly like `Vec<FileIndexEntry>`.
fn file_index_files() -> Vec<FileIndexEntry> {
    vec![
        FileIndexEntry {
            path: "/w/new.md".into(),
            name: "new.md".into(),
            relative_path: "new.md".into(),
            mtime: 1753600000000,
            size: 532,
            text_readable: true,
        },
        FileIndexEntry {
            path: "/w/src/old.rs".into(),
            name: "old.rs".into(),
            relative_path: "src/old.rs".into(),
            mtime: 1753500000000,
            size: 2048,
            text_readable: true,
        },
    ]
}

/// `file_index_refresh` → `IndexRefresh`.
fn file_index_refresh() -> IndexRefresh {
    IndexRefresh {
        generation: 8,
        added: 0,
        removed: 0,
        changed: 1,
        total: 2,
    }
}

/// `file_index_search` → `ContentSearchReport`.
fn file_index_search() -> ContentSearchReport {
    ContentSearchReport {
        matches: vec![ContentSearchMatch {
            path: "/w/src/old.rs".into(),
            name: "old.rs".into(),
            relative_path: "src/old.rs".into(),
            line: 4,
            column: 2,
            excerpt: "let needle = haystack.find(pattern);".into(),
        }],
        scanned_files: 2,
        skipped_files: 0,
        bytes_scanned: 2580,
        cancelled: false,
        truncated: false,
    }
}

/// `workspace_file_list_directory` → `Vec<WorkspaceEntry>`: one directory, one
/// text file.
fn workspace_file_list_directory() -> Vec<WorkspaceEntry> {
    vec![
        WorkspaceEntry {
            path: "/w/docs".into(),
            relative_path: "docs".into(),
            name: "docs".into(),
            is_directory: true,
            mtime: 1753510000000,
            size: 0,
            text_readable: false,
            open_behavior: "directory".into(),
        },
        WorkspaceEntry {
            path: "/w/new.md".into(),
            relative_path: "new.md".into(),
            name: "new.md".into(),
            is_directory: false,
            mtime: 1753600000000,
            size: 532,
            text_readable: true,
            open_behavior: "text".into(),
        },
    ]
}

fn live_meeting() -> MeetingView {
    MeetingView {
        id: "meeting-live-01".into(),
        title: "Architecture sync".into(),
        lifecycle: "capturing".into(),
        transcription: "live".into(),
        started_at: Some("2026-07-31T08:00:00.000Z".into()),
        stopped_at: None,
        duration_ms: 754_321,
        // Native workspace paths are intentionally absent from this renderer
        // contract. The meeting ID is the public capability boundary.
        workspace_path: None,
        source_app: Some("Zoom".into()),
        tags: vec!["architecture".into()],
        mic_muted: false,
        channels: vec!["microphone".into(), "system".into()],
        gaps: vec![],
        gap_count: 0,
        transcript_revision: 12,
        transcript_final: false,
        segment_count: 2,
        transcript_all_final: false,
        // Snapshot/library projections stay bounded; transcript bodies are
        // available only through `meetings_transcript_page`.
        segments: vec![],
        summary: None,
        summary_truncated: false,
        summary_state: "not-started".into(),
        kg_state: "not-offered".into(),
        jobs: vec![],
        error: None,
        updated_at: Some("2026-07-31T08:12:34.321Z".into()),
    }
}

fn finalized_meeting() -> MeetingView {
    MeetingView {
        id: "meeting-final-01".into(),
        title: "Launch readiness".into(),
        lifecycle: "ready".into(),
        transcription: "final".into(),
        started_at: Some("2026-07-30T14:00:00.000Z".into()),
        stopped_at: Some("2026-07-30T14:42:17.000Z".into()),
        duration_ms: 2_537_000,
        workspace_path: None,
        source_app: Some("Google Meet".into()),
        tags: vec!["launch".into(), "reviewed".into()],
        mic_muted: false,
        channels: vec!["microphone".into(), "system".into()],
        gaps: vec![MeetingGapView {
            channel: "system".into(),
            start_ms: 1_201_000,
            end_ms: 1_204_500,
            reason: "device-change".into(),
        }],
        gap_count: 1,
        transcript_revision: 48,
        transcript_final: true,
        segment_count: 2,
        transcript_all_final: true,
        segments: vec![],
        summary: Some("Release readiness is confirmed; prepare the deployment checklist.".into()),
        summary_truncated: false,
        summary_state: "succeeded".into(),
        kg_state: "awaiting-decision".into(),
        jobs: vec![
            MeetingJobView {
                id: "job-summary-01".into(),
                kind: "title-summary".into(),
                status: "succeeded".into(),
                activity_id: Some("agent:summary-01".into()),
                attempt: 1,
                error: None,
            },
            MeetingJobView {
                id: "job-kg-01".into(),
                kind: "kg-proposal".into(),
                status: "failed".into(),
                activity_id: Some("agent:kg-01".into()),
                attempt: 2,
                error: Some("Agent exited before writing a proposal.".into()),
            },
        ],
        error: None,
        updated_at: Some("2026-07-30T14:43:02.000Z".into()),
    }
}

fn meetings_snapshot() -> MeetingSnapshot {
    MeetingSnapshot {
        revision: 73,
        meetings: vec![live_meeting(), finalized_meeting()],
        meetings_truncated: true,
        next_meetings_before: Some(MeetingLibraryCursor {
            created_at: "2026-07-30T14:00:00.000Z".into(),
            meeting_id: "meeting-final-01".into(),
        }),
        active_meeting_id: Some("meeting-live-01".into()),
        candidates: vec![MeetingCandidate {
            id: "candidate-teams-01".into(),
            app_id: "com.microsoft.teams2".into(),
            app_name: "Microsoft Teams".into(),
            detected_at: Some("2026-07-31T08:13:00.000Z".into()),
            confidence: 0.98,
        }],
        config: MeetingConfig {
            detection_enabled: true,
            auto_record: false,
            transcription_mode: "custom".into(),
            custom_url: "https://speech.example.test/v1/listen".into(),
            custom_model: "nova-3".into(),
            api_key_configured: true,
            local_model: "whisper-small".into(),
            summary_enabled: true,
            summary_template: "standard".into(),
            summary_preset: "meeting-follow-up".into(),
            kg_prompt: "ask".into(),
            kg_preset: "meeting-kg-draft".into(),
            retention_days: Some(30),
        },
        permissions: MeetingPermissions {
            microphone: "granted".into(),
            system_audio: "granted".into(),
        },
        models: vec![MeetingModel {
            id: "whisper-small".into(),
            title: "Whisper Small".into(),
            status: "installed".into(),
            bytes: 466_000_000,
            downloaded_bytes: 466_000_000,
            checksum: Some("sha256:fixture-checksum".into()),
            error: None,
        }],
        diagnostic: Some("Custom STT is available; local fallback is installed.".into()),
    }
}

fn meetings_library_page() -> MeetingLibraryPage {
    MeetingLibraryPage {
        meetings: vec![finalized_meeting()],
        has_more: true,
        next_before: Some(MeetingLibraryCursor {
            created_at: "2026-07-30T14:00:00.000Z".into(),
            meeting_id: "meeting-final-01".into(),
        }),
    }
}

fn meetings_transcript_page() -> MeetingTranscriptPage {
    MeetingTranscriptPage {
        meeting_id: "meeting-final-01".into(),
        revision: 48,
        total_segments: 482,
        has_more: true,
        next_before: Some(MeetingTranscriptCursor {
            start_ms: 1_120,
            end_ms: 3_870,
            segment_id: "segment-final-01".into(),
        }),
        segments: vec![
            MeetingSegmentView {
                id: "segment-final-01".into(),
                text: "The release candidate passed the smoke test.".into(),
                start_ms: 1_120,
                end_ms: 3_870,
                channel: "system".into(),
                speaker: Some("Avery".into()),
                is_final: true,
                revision: 47,
            },
            MeetingSegmentView {
                id: "segment-final-02".into(),
                text: "I will prepare the deployment checklist.".into(),
                start_ms: 4_110,
                end_ms: 6_640,
                channel: "microphone".into(),
                speaker: Some("You".into()),
                is_final: true,
                revision: 48,
            },
        ],
        summary: Some("Release readiness is confirmed; prepare the deployment checklist.".into()),
    }
}

fn meetings_issue_start_consent() -> MeetingStartConsentGrant {
    MeetingStartConsentGrant::fixture(
        "fixture-consent-token-never-valid",
        "scribe-start-fixture-01",
        45_000,
        MeetingStartConsentDisclosure {
            candidate_id: Some("candidate-teams-01".into()),
            candidate_app_name: Some("Microsoft Teams".into()),
            transcription_mode: "custom".into(),
            destination: Some("https://speech.example.test/v1/listen".into()),
            model: "nova-3".into(),
        },
    )
}

fn meetings_export() -> MeetingExport {
    MeetingExport {
        format: "markdown".into(),
        path: "/Users/me/Exports/Launch readiness.md".into(),
    }
}

/// Every golden fixture, keyed by the registered Tauri command name and
/// pre-rendered as pretty JSON. Rendering straight from the typed value keeps
/// serde's struct field order (a `Value` round-trip would sort keys).
fn fixtures() -> Vec<(&'static str, String)> {
    fn entry<T: serde::Serialize>(name: &'static str, value: T) -> (&'static str, String) {
        let rendered = serde_json::to_string_pretty(&value)
            .unwrap_or_else(|error| panic!("could not serialize fixture '{name}': {error}"));
        (name, format!("{rendered}\n"))
    }
    vec![
        entry("activity_list", activity_list()),
        entry("activity_search_history", activity_search_history()),
        entry("git_status", git_status()),
        entry("launcher_detect_agents", launcher_detect_agents()),
        entry("launcher_load_config", launcher_load_config()),
        entry("launcher_resolve", launcher_resolve()),
        entry("app_catalog", app_catalog()),
        entry("routine_catalog", routine_catalog()),
        entry("graph_open", graph_open()),
        entry("graph_query", graph_query()),
        entry("graph_get", graph_get()),
        entry("file_index_files", file_index_files()),
        entry("file_index_refresh", file_index_refresh()),
        entry("file_index_search", file_index_search()),
        entry(
            "workspace_file_list_directory",
            workspace_file_list_directory(),
        ),
        entry("meetings_snapshot", meetings_snapshot()),
        entry("meetings_library_page", meetings_library_page()),
        entry("meetings_transcript_page", meetings_transcript_page()),
        entry(
            "meetings_issue_start_consent",
            meetings_issue_start_consent(),
        ),
        entry("meetings_start", meetings_snapshot()),
        entry("meetings_export", meetings_export()),
    ]
}

/// Golden test: each fixture value must serialize byte-for-byte to its
/// committed JSON file, and no stray fixture files may accumulate. Run with
/// `UPDATE_IPC_FIXTURES=1` to rewrite the files after an intentional change.
#[test]
fn ipc_fixtures_match_serialization() {
    let directory = fixtures_dir();
    let update = std::env::var("UPDATE_IPC_FIXTURES").is_ok_and(|value| value == "1");
    let fixtures = fixtures();

    if update {
        std::fs::create_dir_all(&directory).expect("create fixtures directory");
    }

    let mut failures = Vec::new();
    for (name, rendered) in &fixtures {
        let path = directory.join(format!("{name}.json"));
        if update {
            std::fs::write(&path, rendered)
                .unwrap_or_else(|error| panic!("could not write {}: {error}", path.display()));
            continue;
        }
        match std::fs::read_to_string(&path) {
            Ok(on_disk) if &on_disk == rendered => {}
            Ok(_) => failures.push(format!(
                "'{name}' drifted: Rust serialization no longer matches {}",
                path.display()
            )),
            Err(error) => failures.push(format!("'{name}' missing ({}): {error}", path.display())),
        }
    }

    if !update {
        let expected: std::collections::BTreeSet<String> = fixtures
            .iter()
            .map(|(name, _)| format!("{name}.json"))
            .collect();
        let on_disk = std::fs::read_dir(&directory)
            .map(|entries| {
                entries
                    .filter_map(|entry| entry.ok())
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .filter(|name| name.ends_with(".json"))
                    .collect::<std::collections::BTreeSet<String>>()
            })
            .unwrap_or_default();
        for stray in on_disk.difference(&expected) {
            failures.push(format!(
                "stray fixture file '{stray}' has no builder in ipc_fixtures.rs — remove the file or add a fixture"
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "IPC fixture drift ({}):\n- {}\n\nIf the Rust shape change is intentional, regenerate with:\n  UPDATE_IPC_FIXTURES=1 cargo test --manifest-path src-tauri/Cargo.toml ipc_fixtures\nand update the renderer tests that consume the fixture.",
        failures.len(),
        failures.join("\n- ")
    );
}
