use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The five user-visible execution surfaces share one durable identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityKind {
    Terminal,
    Agent,
    Files,
    App,
    Routine,
}

/// Status vocabulary shared by Rust persistence, Tauri events, and the renderer.
///
/// `Done` may be a live agent's short-lived completion signal or a terminal
/// process outcome. The status tracker keeps those cases distinct internally so
/// only a live completion settles back to `Idle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityStatus {
    Ready,
    Starting,
    Working,
    NeedsInput,
    Idle,
    Done,
    Error,
    Stopped,
    Interrupted,
}

impl ActivityStatus {
    pub fn is_live(self) -> bool {
        matches!(
            self,
            Self::Starting | Self::Working | Self::NeedsInput | Self::Idle
        )
    }

    pub fn is_ended(self) -> bool {
        matches!(
            self,
            Self::Done | Self::Error | Self::Stopped | Self::Interrupted
        )
    }

    /// Renderer-originated transitions are deliberately narrower than
    /// authoritative backend reconciliation. The backend may still restore any
    /// status after process inspection or corrupt-state recovery.
    pub fn can_transition_to(self, next: Self) -> bool {
        if self == next {
            return true;
        }

        match self {
            Self::Ready => matches!(
                next,
                Self::Starting | Self::Working | Self::Stopped | Self::Error
            ),
            Self::Starting => matches!(
                next,
                Self::Working
                    | Self::NeedsInput
                    | Self::Idle
                    | Self::Done
                    | Self::Error
                    | Self::Stopped
                    | Self::Interrupted
            ),
            Self::Working => matches!(
                next,
                Self::Ready
                    | Self::NeedsInput
                    | Self::Idle
                    | Self::Done
                    | Self::Error
                    | Self::Stopped
                    | Self::Interrupted
            ),
            Self::NeedsInput => matches!(
                next,
                Self::Working
                    | Self::Idle
                    | Self::Done
                    | Self::Error
                    | Self::Stopped
                    | Self::Interrupted
            ),
            Self::Idle => matches!(
                next,
                Self::Working
                    | Self::NeedsInput
                    | Self::Done
                    | Self::Error
                    | Self::Stopped
                    | Self::Interrupted
            ),
            Self::Done | Self::Error | Self::Stopped | Self::Interrupted => {
                matches!(next, Self::Starting)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityRetention {
    /// The process and record disappear when Mimir exits unless the user closes
    /// or archives a plain terminal, which promotes that record to durable.
    Ephemeral,
    /// Metadata and bounded scrollback survive restart until explicitly
    /// archived or cleared.
    Durable,
}

impl ActivityRetention {
    pub fn should_persist(self) -> bool {
        matches!(self, Self::Durable)
    }
}

/// Whether an Activity follows one workspace Sidebar or remains available in
/// every workspace. Optional origin metadata keeps older persisted records
/// readable while new launches retain their scope even if a preset changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityWorkspaceScope {
    Global,
    Workspace,
}

/// Describes why an activity exists without introducing separate domain
/// models for launchers, presets, apps, and schedules.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityOrigin {
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub source_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launcher_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_scope: Option<ActivityWorkspaceScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routine_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_for: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_activity_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch_job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meeting_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meeting_hook_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meeting_transcript_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_node_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub graph_scope_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_section: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_server_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_message_id: Option<String>,
}

/// Runtime surface selected by the Activity pane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ActivityHost {
    Pty {
        #[serde(
            default,
            rename = "resumeStrategy",
            skip_serializing_if = "Option::is_none"
        )]
        resume_strategy: Option<String>,
    },
    Files,
    Embedded {
        #[serde(rename = "appId")]
        app_id: String,
        entry: String,
    },
    Process {
        #[serde(default)]
        headless: bool,
    },
    Window {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    #[serde(rename = "rust")]
    RustHelper {
        helper: String,
    },
}

impl ActivityHost {
    pub fn pty(resume_strategy: Option<String>) -> Self {
        Self::Pty { resume_strategy }
    }
}

/// Exact argv launch metadata. Commands are never reconstructed as shell
/// strings, so user flags retain their original argument boundaries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityLaunchSpec {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionExitReason {
    Completed,
    Stopped,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExitRecord {
    pub reason: SessionExitReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl SessionExitRecord {
    pub fn activity_status(&self) -> ActivityStatus {
        match self.reason {
            SessionExitReason::Completed => ActivityStatus::Done,
            SessionExitReason::Stopped => ActivityStatus::Stopped,
            SessionExitReason::Failed => ActivityStatus::Error,
            SessionExitReason::Interrupted => ActivityStatus::Interrupted,
        }
    }
}

/// Persisted run metadata. PTY handles, child handles, renderer objects, and
/// subscription callbacks intentionally never enter this record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySessionRecord {
    pub run_id: String,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit: Option<SessionExitRecord>,
    #[serde(default)]
    pub last_output_sequence: u64,
    #[serde(default)]
    pub scrollback_bytes: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityTitleSource {
    /// Compatibility value for records written before title provenance existed.
    #[default]
    Legacy,
    Launcher,
    Provisional,
    Agent,
    Manual,
}

/// Complete serializable record shared with the renderer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRecord {
    pub id: String,
    pub kind: ActivityKind,
    pub title: String,
    #[serde(default)]
    pub title_source: ActivityTitleSource,
    /// Read-only bridge for records written before `titleSource` existed.
    #[serde(default, rename = "autoTitleEligible", skip_serializing)]
    pub legacy_auto_title_eligible: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    pub status: ActivityStatus,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_viewed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_requested_at: Option<String>,
    pub retention: ActivityRetention,
    #[serde(default)]
    pub source: ActivityOrigin,
    pub host: ActivityHost,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch: Option<ActivityLaunchSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<ActivitySessionRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ActivityRecord {
    pub fn is_archived(&self) -> bool {
        self.archived_at.is_some()
    }

    pub fn is_clearable(&self) -> bool {
        !self.status.is_live()
    }

    /// Migrate records written before title provenance existed. Known built-in
    /// launcher placeholders stay eligible. Every other legacy title is locked
    /// so an old explicit or manual title can never be replaced.
    pub fn normalize_legacy_title_source(&mut self) -> bool {
        if self.title_source != ActivityTitleSource::Legacy {
            return false;
        }
        let was_eligible = self.legacy_auto_title_eligible.take();
        self.title_source = if was_eligible != Some(false)
            && self.kind == ActivityKind::Agent
            && self
                .source
                .launcher_id
                .as_deref()
                .is_some_and(|agent_id| launcher_title_matches(agent_id, &self.title))
        {
            ActivityTitleSource::Launcher
        } else {
            ActivityTitleSource::Manual
        };
        true
    }
}

fn launcher_title_matches(agent_id: &str, title: &str) -> bool {
    let expected = match agent_id.trim().to_ascii_lowercase().as_str() {
        "codex" => "Codex",
        "claude" => "Claude",
        "pi" => "Pi",
        "gemini" => "Gemini",
        _ => return false,
    };
    title.trim() == expected
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_the_shared_kind_status_and_retention_vocabulary() {
        assert_eq!(
            serde_json::to_value(ActivityKind::Routine).unwrap(),
            "routine"
        );
        assert_eq!(
            serde_json::to_value(ActivityStatus::NeedsInput).unwrap(),
            "needs-input"
        );
        assert_eq!(
            serde_json::to_value(ActivityStatus::Interrupted).unwrap(),
            "interrupted"
        );
        assert_eq!(
            serde_json::to_value(ActivityRetention::Durable).unwrap(),
            "durable"
        );
    }

    #[test]
    fn serializes_frontend_field_names_and_exact_argv() {
        let record = ActivityRecord {
            id: "agent:one".into(),
            kind: ActivityKind::Agent,
            title: "Codex".into(),
            title_source: ActivityTitleSource::Launcher,
            legacy_auto_title_eligible: None,
            workspace_path: Some("/work".into()),
            status: ActivityStatus::Ready,
            created_at: "2026-07-25T10:00:00Z".into(),
            updated_at: "2026-07-25T10:00:00Z".into(),
            last_viewed_at: None,
            archived_at: None,
            close_requested_at: None,
            retention: ActivityRetention::Durable,
            source: ActivityOrigin {
                launcher_id: Some("codex".into()),
                preset_id: Some("codex-full".into()),
                workspace_scope: Some(ActivityWorkspaceScope::Workspace),
                source_type: Some("business-graph-work".into()),
                graph_node_id: Some("issue-1".into()),
                graph_scope_ids: vec!["project:test".into()],
                graph_revision: Some(7),
                meeting_id: Some("meeting-1".into()),
                meeting_hook_id: Some("title-summary".into()),
                meeting_transcript_revision: Some(4),
                ..ActivityOrigin::default()
            },
            host: ActivityHost::pty(Some("codex".into())),
            launch: Some(ActivityLaunchSpec {
                command: "/opt/bin/codex".into(),
                args: vec!["--full-auto".into(), "two words".into()],
                cwd: Some("/work".into()),
                env: BTreeMap::from([("MIMIR_ACTIVITY_ID".into(), "agent:one".into())]),
            }),
            session: None,
            error: None,
        };

        let value = serde_json::to_value(&record).unwrap();
        assert_eq!(value["titleSource"], "launcher");
        assert!(value.get("autoTitleEligible").is_none());
        assert_eq!(value["workspacePath"], "/work");
        assert_eq!(value["source"]["launcherId"], "codex");
        assert_eq!(value["source"]["workspaceScope"], "workspace");
        assert_eq!(value["source"]["type"], "business-graph-work");
        assert_eq!(value["source"]["graphNodeId"], "issue-1");
        assert_eq!(value["source"]["graphScopeIds"][0], "project:test");
        assert_eq!(value["source"]["graphRevision"], 7);
        assert_eq!(value["source"]["meetingId"], "meeting-1");
        assert_eq!(value["source"]["meetingHookId"], "title-summary");
        assert_eq!(value["source"]["meetingTranscriptRevision"], 4);
        assert_eq!(value["host"]["type"], "pty");
        assert_eq!(value["host"]["resumeStrategy"], "codex");
        assert_eq!(value["launch"]["args"][1], "two words");
        assert!(value.get("session").is_none());
        assert!(value.get("error").is_none());

        let round_trip: ActivityRecord = serde_json::from_value(value).unwrap();
        assert_eq!(round_trip, record);
    }

    #[test]
    fn migrates_only_known_legacy_launcher_placeholders() {
        let mut launcher = serde_json::from_value::<ActivityRecord>(serde_json::json!({
            "id": "agent:legacy",
            "kind": "agent",
            "title": "Codex",
            "autoTitleEligible": true,
            "status": "idle",
            "createdAt": "2026-07-25T10:00:00Z",
            "updatedAt": "2026-07-25T10:00:00Z",
            "retention": "durable",
            "source": { "launcherId": "codex" },
            "host": { "type": "pty" }
        }))
        .unwrap();
        assert!(launcher.normalize_legacy_title_source());
        assert_eq!(launcher.title_source, ActivityTitleSource::Launcher);

        let mut locked_launcher = serde_json::from_value::<ActivityRecord>(serde_json::json!({
            "id": "agent:locked-legacy",
            "kind": "agent",
            "title": "Codex",
            "autoTitleEligible": false,
            "status": "idle",
            "createdAt": "2026-07-25T10:00:00Z",
            "updatedAt": "2026-07-25T10:00:00Z",
            "retention": "durable",
            "source": { "launcherId": "codex" },
            "host": { "type": "pty" }
        }))
        .unwrap();
        assert!(locked_launcher.normalize_legacy_title_source());
        assert_eq!(locked_launcher.title_source, ActivityTitleSource::Manual);

        let mut explicit = launcher.clone();
        explicit.title_source = ActivityTitleSource::Legacy;
        explicit.title = "My task".into();
        assert!(explicit.normalize_legacy_title_source());
        assert_eq!(explicit.title_source, ActivityTitleSource::Manual);
    }

    #[test]
    fn enforces_sane_local_lifecycle_transitions() {
        assert!(ActivityStatus::Ready.can_transition_to(ActivityStatus::Starting));
        assert!(!ActivityStatus::Ready.can_transition_to(ActivityStatus::Done));
        assert!(ActivityStatus::Starting.can_transition_to(ActivityStatus::Working));
        assert!(ActivityStatus::Working.can_transition_to(ActivityStatus::NeedsInput));
        assert!(ActivityStatus::NeedsInput.can_transition_to(ActivityStatus::Working));
        assert!(ActivityStatus::Working.can_transition_to(ActivityStatus::Done));
        assert!(ActivityStatus::Done.can_transition_to(ActivityStatus::Starting));
        assert!(!ActivityStatus::Done.can_transition_to(ActivityStatus::Working));
    }

    #[test]
    fn classifies_persistence_liveness_and_exit_outcomes() {
        assert!(!ActivityRetention::Ephemeral.should_persist());
        assert!(ActivityRetention::Durable.should_persist());
        assert!(ActivityStatus::Working.is_live());
        assert!(!ActivityStatus::Ready.is_live());
        assert!(ActivityStatus::Interrupted.is_ended());

        let failed = SessionExitRecord {
            reason: SessionExitReason::Failed,
            code: Some(2),
            signal: None,
            message: Some("bad flags".into()),
        };
        assert_eq!(failed.activity_status(), ActivityStatus::Error);
    }
}
