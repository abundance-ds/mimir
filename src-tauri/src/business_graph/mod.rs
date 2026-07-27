//! Typed, source-aware business graph primitives.
//!
//! Markdown remains canonical. The in-memory store is rebuildable and composes
//! private, project, and team roots without erasing source provenance.

mod context;
mod markdown;
mod migration;
mod model;
#[cfg(test)]
mod performance;
pub(crate) mod runtime;
mod store;
pub(crate) mod tools;

pub use context::{GraphContextNode, GraphContextPack, GraphContextRequest};
pub use markdown::{
    parse_graph_markdown, serialize_graph_markdown, GraphMarkdownError, ParsedGraphNode,
};
pub use migration::{
    build_migration_report, GraphMigrationCollision, GraphMigrationReference, GraphMigrationReport,
    GraphMigrationScope,
};
pub use model::{
    canonical_kind, is_known_kind, is_valid_id, GraphActor, GraphActorKind, GraphChanged,
    GraphDeleteResult, GraphDiagnostic, GraphDiagnosticLevel, GraphEvent, GraphEventPage,
    GraphEventQuery, GraphFieldChange, GraphNeighbor, GraphNode, GraphNodeCreate, GraphNodeDelete,
    GraphNodePatch, GraphNodeSummary, GraphOpenResult, GraphProvenance, GraphQuery,
    GraphQueryResult, GraphRelation, GraphRelationDirection, GraphRestoreRequest,
    GraphScopeDescriptor, GraphScopeKind, GraphSearchResult, GraphSourceFormat, GraphSourceRoot,
    ENTITY_KINDS, ISSUE_PRIORITIES, ISSUE_STATUSES,
};
pub use runtime::GraphRuntime;
pub use store::{GraphMutationError, GraphStore};
