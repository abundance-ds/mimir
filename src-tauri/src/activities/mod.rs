pub mod model;
pub mod scrollback;
pub mod status;
pub mod store;
pub mod supervisor;

pub use model::{
    ActivityHost, ActivityKind, ActivityLaunchSpec, ActivityOrigin, ActivityRecord,
    ActivityRetention, ActivitySessionRecord, ActivityStatus, ActivityWorkspaceScope,
    SessionExitReason, SessionExitRecord,
};
pub use scrollback::{OutputChunk, RawScrollback, ScrollbackReplay};
pub use status::{
    is_spinner_prefix, AgentStatusChange, AgentStatusSnapshot, AgentStatusTracker,
    AgentStatusTrackerConfig,
};
pub use store::{
    SaveTerminalCheckpoint, SavedTerminalCheckpoint, TerminalCheckpoint, TerminalEvent,
    TerminalRestoreState, TERMINAL_CHECKPOINT_FORMAT_VERSION,
};
pub use supervisor::{
    ActivityAttachment, ActivityEvent, ActivityEventSink, ActivityHistorySearchHit,
    ActivitySnapshot, ActivitySubscriptionId, ActivitySupervisor, ActivitySupervisorConfig,
    ActivityTerminalAttachment, ActivityTerminalCheckpointRequest, SpawnActivityRequest,
    SupervisorError, DEFAULT_DURABLE_SCROLLBACK_BYTES, DEFAULT_TERMINAL_SCROLLBACK_BYTES,
};
