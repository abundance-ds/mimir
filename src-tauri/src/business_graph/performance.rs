use super::{
    GraphNode, GraphNodePatch, GraphProvenance, GraphQuery, GraphRelation, GraphScopeKind,
    GraphSourceFormat, GraphSourceRoot, GraphStore,
};
use serde_json::{json, Map};
use std::{
    collections::BTreeSet,
    fs,
    time::{Duration, Instant},
};
use tempfile::TempDir;

const SYNTHETIC_NODES: usize = 5_000;

#[test]
fn graph_performance_budget_covers_index_query_search_and_traversal() {
    let nodes = (0..SYNTHETIC_NODES)
        .map(|index| synthetic_node(index, SYNTHETIC_NODES))
        .collect::<Vec<_>>();

    let started = Instant::now();
    let store = GraphStore::from_nodes(nodes, Vec::new());
    let index_time = started.elapsed();

    let started = Instant::now();
    let query = store.query(&GraphQuery {
        kinds: BTreeSet::from(["issue".into()]),
        status: Some("in-progress".into()),
        limit: 100,
        ..GraphQuery::default()
    });
    let query_time = started.elapsed();

    let started = Instant::now();
    let search = store.search("comparative evidence 4242", &BTreeSet::new(), 25);
    let search_time = started.elapsed();

    let started = Instant::now();
    let neighbors = store.neighbors("node-2500", &BTreeSet::new());
    let traversal_time = started.elapsed();

    eprintln!(
        "business_graph_benchmark={}",
        json!({
            "nodes": SYNTHETIC_NODES,
            "indexMs": millis(index_time),
            "queryMs": millis(query_time),
            "searchMs": millis(search_time),
            "traversalMs": millis(traversal_time),
        })
    );
    assert_eq!(store.len(), SYNTHETIC_NODES);
    assert!(!query.items.is_empty());
    assert!(!search.is_empty());
    assert!(!neighbors.is_empty());

    // Debug-test budgets are intentionally several times looser than the
    // shipped optimized build, but still catch accidental quadratic work.
    assert_budget("5k-node index", index_time, Duration::from_millis(2_000));
    assert_budget("bounded query", query_time, Duration::from_millis(100));
    assert_budget("ranked search", search_time, Duration::from_millis(500));
    assert_budget(
        "one-hop traversal",
        traversal_time,
        Duration::from_millis(100),
    );
}

#[test]
fn markdown_startup_board_mutation_and_refresh_stay_within_budget() {
    const SOURCE_COUNT: usize = 600;
    let root = TempDir::new().unwrap();
    let graph = root.path().join("graph");
    fs::create_dir_all(&graph).unwrap();
    for index in 0..SOURCE_COUNT {
        fs::write(
            graph.join(format!("issue-benchmark-{index}.md")),
            format!(
                "---\ntitle: Benchmark issue {index}\nstatus: plan\npriority: normal\nproject: project-benchmark\n---\nReviewable body {index}."
            ),
        )
        .unwrap();
    }
    let roots = [GraphSourceRoot::new(
        "project:benchmark",
        GraphScopeKind::Project,
        root.path(),
    )];

    let started = Instant::now();
    let mut store = GraphStore::load(&roots);
    let startup_time = started.elapsed();

    let revision = store
        .get("issue-benchmark-300")
        .unwrap()
        .provenance
        .source_revision
        .clone();
    let started = Instant::now();
    store
        .update_node(GraphNodePatch {
            id: "issue-benchmark-300".into(),
            expected_revision: Some(revision),
            set_properties: Map::from_iter([("status".into(), json!("in-progress"))]),
            ..GraphNodePatch::default()
        })
        .unwrap();
    let mutation_time = started.elapsed();

    let started = Instant::now();
    let refreshed = GraphStore::load(&roots);
    let refresh_time = started.elapsed();

    eprintln!(
        "business_graph_markdown_benchmark={}",
        json!({
            "sources": SOURCE_COUNT,
            "startupMs": millis(startup_time),
            "boardMutationMs": millis(mutation_time),
            "refreshMs": millis(refresh_time),
        })
    );
    assert_eq!(refreshed.len(), SOURCE_COUNT);
    assert_eq!(
        refreshed.get("issue-benchmark-300").unwrap().status(),
        Some("in-progress")
    );
    assert_budget(
        "600-source Markdown startup",
        startup_time,
        Duration::from_millis(3_000),
    );
    assert_budget(
        "revision-aware board mutation",
        mutation_time,
        Duration::from_millis(250),
    );
    assert_budget(
        "600-source full refresh",
        refresh_time,
        Duration::from_millis(3_000),
    );
}

fn synthetic_node(index: usize, total: usize) -> GraphNode {
    let kind = if index.is_multiple_of(3) {
        "issue"
    } else {
        "evidence"
    };
    let mut properties = Map::new();
    if kind == "issue" {
        properties.insert(
            "status".into(),
            json!(if index.is_multiple_of(2) {
                "in-progress"
            } else {
                "plan"
            }),
        );
        properties.insert("priority".into(), json!("normal"));
    }
    GraphNode {
        id: format!("node-{index}"),
        kind: kind.into(),
        title: format!("Comparative evidence item {index}"),
        summary: format!("Synthetic HEOR retrieval fixture {index}"),
        body: format!(
            "Evidence body for benchmark node {index}. It contains source-level comparative evidence."
        ),
        tags: vec!["heor".into(), format!("batch-{}", index % 20)],
        relations: vec![GraphRelation {
            relation: "related_to".into(),
            target: format!("node-{}", (index + 1) % total),
            legacy: false,
        }],
        properties,
        created_at: "2026-07-26T00:00:00Z".into(),
        updated_at: "2026-07-26T00:00:00Z".into(),
        provenance: GraphProvenance {
            scope_id: if index.is_multiple_of(5) {
                "team:main".into()
            } else {
                "project:benchmark".into()
            },
            scope_kind: if index.is_multiple_of(5) {
                GraphScopeKind::Team
            } else {
                GraphScopeKind::Project
            },
            source_path: format!("/benchmark/graph/node-{index}.md"),
            source_revision: format!("revision-{index}"),
            source_format: GraphSourceFormat::Graph,
        },
    }
}

fn assert_budget(label: &str, actual: Duration, budget: Duration) {
    assert!(
        actual <= budget,
        "{label} exceeded debug acceptance budget: {}ms > {}ms",
        millis(actual),
        millis(budget)
    );
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}
