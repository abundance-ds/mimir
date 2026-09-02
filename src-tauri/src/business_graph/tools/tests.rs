use super::{
    add_private_scope_warning, execute_native_tool, native_tool_definitions, PRIVATE_SCOPE_WARNING,
};
use crate::business_graph::{GraphRuntime, GraphScopeKind, GraphSourceRoot};
use crate::tool_registry::{
    ToolCallContext, ToolCaller, ToolDescriptor, ToolErrorCode, ToolOwner, ToolRegistration,
    ToolRegistry, ToolResult, ToolSource,
};
use serde_json::{json, Value};
use std::fs;
use tempfile::TempDir;

fn fixture() -> (TempDir, GraphRuntime) {
    let root = TempDir::new().unwrap();
    fs::create_dir_all(root.path().join("graph")).unwrap();
    fs::write(
        root.path().join("graph/client.md"),
        "---\ntitle: Client\ntype: company\n---\n",
    )
    .unwrap();
    fs::write(
        root.path().join("graph/project-alpha.md"),
        "---\ntitle: Project Alpha\ntype: project\nlinks: [\"for_company client\"]\n---\n",
    )
    .unwrap();
    fs::write(
        root.path().join("graph/alex.md"),
        "---\ntitle: Alex Researcher\ntype: person\n---\n",
    )
    .unwrap();
    fs::write(
        root.path().join("graph/issue-1.md"),
        "---\ntitle: Extract evidence\nstatus: plan\npriority: high\nproject: project-alpha\n---\nBody",
    )
    .unwrap();
    let runtime = GraphRuntime::from_roots(vec![GraphSourceRoot::new(
        "project:test",
        GraphScopeKind::Project,
        root.path(),
    )]);
    (root, runtime)
}

#[test]
fn definitions_are_accepted_by_the_canonical_registry() {
    let registry = ToolRegistry::new();
    for (name, alias, description, schema) in native_tool_definitions() {
        registry
            .register(ToolRegistration::new(
                ToolDescriptor::new(
                    name,
                    alias,
                    description,
                    schema,
                    ToolOwner::Core,
                    ToolSource::Native,
                ),
                |_context, _input| async { Ok(ToolResult::new(Value::Null)) },
            ))
            .unwrap();
    }
    assert_eq!(registry.list().len(), 40);
}

#[test]
fn graph_find_schema_matches_its_bounded_search_limit() {
    let (_, _, _, schema) = native_tool_definitions()
        .into_iter()
        .find(|(name, _, _, _)| *name == "graph.find")
        .unwrap();
    assert_eq!(schema["properties"]["limit"]["maximum"], 100);
}

#[test]
fn graph_find_scans_the_whole_graph_past_the_store_page_size() {
    let root = TempDir::new().unwrap();
    fs::create_dir_all(root.path().join("graph")).unwrap();
    for index in 0..505 {
        fs::write(
            root.path().join(format!("graph/note-{index:03}.md")),
            format!(
                "---\ntitle: Note {index}\ntype: note\nupdated: 2026-01-01T00:00:00.{index:03}Z\n---\n"
            ),
        )
        .unwrap();
    }
    fs::write(
        root.path().join("graph/ancient-needle.md"),
        "---\ntitle: Ancient needle\ntype: note\nupdated: 2020-06-01T00:00:00.000Z\n---\n",
    )
    .unwrap();
    let runtime = GraphRuntime::from_roots(vec![GraphSourceRoot::new(
        "project:test",
        GraphScopeKind::Project,
        root.path(),
    )]);

    let found = execute_native_tool(&runtime, "graph.find", json!({ "limit": 1 })).unwrap();
    assert_eq!(found.value["total"], 506);

    let tail = execute_native_tool(
        &runtime,
        "graph.find",
        json!({ "limit": 100, "offset": 500 }),
    )
    .unwrap();
    assert_eq!(tail.value["total"], 506);
    assert_eq!(tail.value["items"].as_array().unwrap().len(), 6);

    // The needle sorts oldest of 506, so it only exists in results if find
    // filters over the whole graph rather than the newest store page.
    let filtered = execute_native_tool(
        &runtime,
        "graph.find",
        json!({ "updatedBefore": "2021-01-01T00:00:00.000Z" }),
    )
    .unwrap();
    assert_eq!(filtered.value["total"], 1);
    assert_eq!(filtered.value["items"][0]["id"], "ancient-needle");
}

#[test]
fn cli_and_activity_calls_read_the_workspace_descriptor() {
    let root = TempDir::new().unwrap();
    fs::create_dir(root.path().join(".mimir")).unwrap();
    fs::write(
        root.path().join(".mimir/workspace.toml"),
        concat!(
            "version = 1\n",
            "id = \"ws-test\"\n",
            "project = \"project-alpha\"\n",
            "graphScope = \"team\"\n"
        ),
    )
    .unwrap();

    let cli = ToolCallContext {
        caller: ToolCaller::MimirCli,
        cwd: Some(root.path().to_string_lossy().into_owned()),
        ..ToolCallContext::default()
    };
    assert_eq!(
        super::agent_workspace_config(&cli)
            .unwrap()
            .unwrap()
            .project_id
            .as_deref(),
        Some("project-alpha")
    );

    let mut activity = ToolCallContext {
        caller: ToolCaller::Mcp,
        cwd: cli.cwd,
        ..ToolCallContext::default()
    };
    activity
        .metadata
        .insert("activityId".into(), json!("agent:one"));
    assert!(super::agent_workspace_config(&activity).unwrap().is_some());

    activity.metadata.clear();
    assert!(super::agent_workspace_config(&activity).unwrap().is_some());

    let ui = ToolCallContext {
        caller: ToolCaller::Ui,
        cwd: activity.cwd,
        ..ToolCallContext::default()
    };
    assert!(super::agent_workspace_config(&ui).unwrap().is_none());
}

#[test]
fn legacy_facades_and_generic_queries_share_one_store() {
    let (_root, runtime) = fixture();
    let graph = execute_native_tool(
        &runtime,
        "graph.query",
        json!({ "kinds": ["issue"], "limit": 10 }),
    )
    .unwrap();
    assert_eq!(graph.value["total"], 1);

    let issues = execute_native_tool(&runtime, "issues.list", json!({})).unwrap();
    assert_eq!(issues.value["items"][0]["id"], "issue-1");
    assert_eq!(issues.value["items"][0]["project"], json!("project-alpha"));

    let catalog = execute_native_tool(&runtime, "knowledge.catalog", json!({})).unwrap();
    assert_eq!(catalog.value["entries"].as_array().unwrap().len(), 3);
}

#[test]
fn compatibility_writes_create_real_relations_and_revisions() {
    let (root, runtime) = fixture();
    let created = execute_native_tool(
        &runtime,
        "issues.create",
        json!({
            "title": "Draft value story",
            "project": "project-alpha",
            "labels": [{ "name": "strategy", "color": "purple" }]
        }),
    )
    .unwrap();
    let id = created.value["id"].as_str().unwrap();
    assert!(root.path().join("graph").join(format!("{id}.md")).is_file());
    assert!(created.value["sourceRevision"].as_str().unwrap().len() > 20);
    let full = runtime.get(id).unwrap().unwrap();
    assert!(full
        .relations
        .iter()
        .any(|edge| edge.relation == "part_of" && edge.target == "project-alpha"));
}

#[test]
fn knowledge_redaction_is_explicit_and_applies_only_to_automatic_context() {
    let (_root, runtime) = fixture();
    let created = execute_native_tool(
        &runtime,
        "knowledge.create",
        json!({
            "title": "Confidential launch",
            "body": "Direct reads keep this body.",
            "redactFromContext": true
        }),
    )
    .unwrap();
    let id = created.value["id"].as_str().unwrap();
    assert_eq!(created.value["redactFromContext"], true);
    assert_eq!(created.value["body"], "Direct reads keep this body.");

    let context = execute_native_tool(
        &runtime,
        "graph.context",
        json!({ "focusId": id, "maxNodes": 1 }),
    )
    .unwrap();
    assert_eq!(context.value["nodes"][0]["redacted"], true);
    assert_eq!(
        context.value["nodes"][0]["title"],
        "[sensitive record redacted]"
    );
}

#[test]
fn semantic_issue_actions_validate_and_mutate_real_entities() {
    let (_root, runtime) = fixture();
    let moved = execute_native_tool(
        &runtime,
        "issues.move",
        json!({ "id": "issue-1", "status": "in-progress" }),
    )
    .unwrap();
    assert_eq!(moved.value["status"], "in-progress");

    let assigned = execute_native_tool(
        &runtime,
        "issues.assign",
        json!({ "id": "issue-1", "personId": "alex" }),
    )
    .unwrap();
    assert_eq!(assigned.value["assignee"], "alex");
    let issue = runtime.get("issue-1").unwrap().unwrap();
    assert!(issue
        .relations
        .iter()
        .any(|edge| edge.relation == "assigned_to" && edge.target == "alex"));

    let invalid = execute_native_tool(
        &runtime,
        "issues.assign",
        json!({ "id": "issue-1", "personId": "client" }),
    )
    .unwrap_err();
    assert_eq!(invalid.code, ToolErrorCode::InvalidInput);
}

#[test]
fn semantic_project_actions_are_idempotent_and_kind_safe() {
    let (_root, runtime) = fixture();
    execute_native_tool(
        &runtime,
        "projects.link_company",
        json!({ "id": "project-alpha", "companyId": "client" }),
    )
    .unwrap();
    execute_native_tool(
        &runtime,
        "projects.add_contact",
        json!({ "id": "project-alpha", "personId": "alex" }),
    )
    .unwrap();
    execute_native_tool(
        &runtime,
        "projects.add_contact",
        json!({ "id": "project-alpha", "personId": "alex" }),
    )
    .unwrap();

    let project = runtime.get("project-alpha").unwrap().unwrap();
    assert_eq!(
        project
            .relations
            .iter()
            .filter(|edge| edge.relation == "for_company" && edge.target == "client")
            .count(),
        1
    );
    assert_eq!(
        project
            .relations
            .iter()
            .filter(|edge| edge.relation == "has_contact" && edge.target == "alex")
            .count(),
        1
    );

    let invalid = execute_native_tool(
        &runtime,
        "projects.link_company",
        json!({ "id": "project-alpha", "companyId": "alex" }),
    )
    .unwrap_err();
    assert_eq!(invalid.code, ToolErrorCode::InvalidInput);
}

#[test]
fn migration_report_tool_is_read_only_and_exposes_legacy_references() {
    let (root, runtime) = fixture();
    let issue_path = root.path().join("graph/issue-1.md");
    let before = fs::read_to_string(&issue_path).unwrap();

    let report = execute_native_tool(&runtime, "graph.migration_report", json!({})).unwrap();

    assert_eq!(report.value["dryRun"], true);
    assert_eq!(report.value["sourceCount"], 4);
    assert_eq!(
        report.value["legacyReferences"][0]["resolution"],
        "exact-id"
    );
    assert_eq!(fs::read_to_string(issue_path).unwrap(), before);
}

#[test]
fn context_tool_returns_bounded_agent_ready_provenance() {
    let (_root, runtime) = fixture();
    let context = execute_native_tool(
        &runtime,
        "graph.context",
        json!({ "focusId": "issue-1", "maxNodes": 2 }),
    )
    .unwrap();
    assert_eq!(context.value["focusId"], "issue-1");
    assert_eq!(context.value["nodes"][0]["id"], "issue-1");
    assert_eq!(context.value["nodes"].as_array().unwrap().len(), 2);
    assert!(context.value["markdown"]
        .as_str()
        .unwrap()
        .contains("Business graph context"));
}

#[test]
fn private_graph_reads_add_one_short_scope_warning() {
    let root = TempDir::new().unwrap();
    fs::create_dir_all(root.path().join("graph")).unwrap();
    fs::write(
        root.path().join("graph/private-note.md"),
        "---\ntitle: Private note\ntype: note\n---\nPrivate body",
    )
    .unwrap();
    let runtime = GraphRuntime::from_roots(vec![GraphSourceRoot::new(
        "private:local",
        GraphScopeKind::Private,
        root.path(),
    )]);

    let found = execute_native_tool(&runtime, "graph.find", json!({})).unwrap();
    assert_eq!(found.value["scopeWarning"], PRIVATE_SCOPE_WARNING);

    let got = execute_native_tool(&runtime, "graph.get", json!({ "id": "private-note" })).unwrap();
    assert_eq!(got.value["scopeWarning"], PRIVATE_SCOPE_WARNING);

    let context = execute_native_tool(
        &runtime,
        "graph.context",
        json!({ "focusId": "private-note" }),
    )
    .unwrap();
    assert!(context.value.get("scopeWarning").is_none());
    assert!(context.value["markdown"]
        .as_str()
        .unwrap()
        .starts_with(&format!(
            "# Business graph context\n\n> {PRIVATE_SCOPE_WARNING}\n\n"
        )));

    let mut events = json!({ "items": [{ "scopeId": "private:local" }] });
    add_private_scope_warning("graph.events", &mut events);
    assert_eq!(events["scopeWarning"], PRIVATE_SCOPE_WARNING);

    let (_root, project_runtime) = fixture();
    let project_result = execute_native_tool(&project_runtime, "graph.find", json!({})).unwrap();
    assert!(project_result.value.get("scopeWarning").is_none());
}

#[test]
fn explicit_migration_resolution_replaces_legacy_text_with_a_valid_relation() {
    let (_root, runtime) = fixture();
    let resolved = execute_native_tool(
        &runtime,
        "graph.resolve_reference",
        json!({
            "id": "issue-1",
            "field": "assignee",
            "targetId": "alex"
        }),
    )
    .unwrap();
    assert_eq!(resolved.value["assignee"], "alex");
    let issue = runtime.get("issue-1").unwrap().unwrap();
    assert!(issue
        .relations
        .iter()
        .any(|edge| edge.relation == "assigned_to" && edge.target == "alex"));

    let invalid = execute_native_tool(
        &runtime,
        "graph.resolve_reference",
        json!({
            "id": "issue-1",
            "field": "assignee",
            "targetId": "client"
        }),
    )
    .unwrap_err();
    assert_eq!(invalid.code, ToolErrorCode::InvalidInput);
}

#[test]
fn heor_workflow_actions_persist_decisions_evidence_deliverables_and_follow_up() {
    let (root, runtime) = fixture();
    let deliverable = execute_native_tool(
        &runtime,
        "issues.add_deliverable",
        json!({
            "id": "issue-1",
            "path": "outputs/evidence-map.md",
            "label": "Evidence map"
        }),
    )
    .unwrap();
    assert_eq!(
        deliverable.value["deliverables"][0]["path"],
        "outputs/evidence-map.md"
    );

    let next = execute_native_tool(
        &runtime,
        "issues.create_next_action",
        json!({
            "id": "issue-1",
            "title": "QA extracted outcomes",
            "priority": "high",
            "assigneeId": "alex"
        }),
    )
    .unwrap();
    let next_id = next.value["id"].as_str().unwrap().to_string();
    assert_eq!(next.value["project"], "project-alpha");
    assert_eq!(next.value["assignee"], "alex");

    execute_native_tool(
        &runtime,
        "projects.record_decision",
        json!({
            "id": "project-alpha",
            "decisionId": "decision-extraction",
            "title": "Double extract pivotal outcomes",
            "rationale": "Reduce transcription risk"
        }),
    )
    .unwrap();
    execute_native_tool(
        &runtime,
        "research.capture_evidence",
        json!({
            "focusId": "project-alpha",
            "evidenceId": "evidence-landmark",
            "title": "Landmark comparative study",
            "certainty": "moderate",
            "source": "doi:10.example/sanitized"
        }),
    )
    .unwrap();

    let reopened = GraphRuntime::from_roots(vec![GraphSourceRoot::new(
        "project:test",
        GraphScopeKind::Project,
        root.path(),
    )]);
    let follow_up = reopened.get(&next_id).unwrap().unwrap();
    assert!(follow_up
        .relations
        .iter()
        .any(|edge| edge.relation == "related_to" && edge.target == "issue-1"));
    assert_eq!(
        reopened
            .get("decision-extraction")
            .unwrap()
            .unwrap()
            .properties["rationale"],
        "Reduce transcription risk"
    );
    let evidence = reopened.get("evidence-landmark").unwrap().unwrap();
    assert_eq!(evidence.properties["certainty"], "moderate");
    assert!(evidence
        .relations
        .iter()
        .any(|edge| edge.relation == "part_of" && edge.target == "project-alpha"));
    assert!(
        reopened.get("issue-1").unwrap().unwrap().properties["deliverables"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["path"] == "outputs/evidence-map.md")
    );
}
