//! One-file source editing shares the graph mutation gate and source parser.

use super::*;
use crate::business_graph::markdown::split_frontmatter;
use crate::business_graph::{is_valid_id, parse_graph_markdown, GraphSourceFormat};
use serde::{Deserialize, Serialize};
use std::path::Component;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSourceDocument {
    pub node: Option<GraphNode>,
    pub content: String,
    pub source_revision: String,
    /// UTF-16 offset of the body in `content`, using the Graph parser's fence.
    pub body_from: usize,
}

impl GraphSourceDocument {
    pub(crate) fn from_source(path: &Path, root: &GraphSourceRoot, content: String) -> Self {
        let (_, body) = split_frontmatter(&content);
        let body_start = content.len() - body.len();
        let body_from = content[..body_start].encode_utf16().count();
        let node = parse_graph_markdown(
            path,
            &root.scope_id,
            root.scope_kind,
            GraphSourceFormat::Graph,
            &content,
        )
        .ok()
        .map(|parsed| parsed.node);
        Self {
            node,
            source_revision: source_revision(&content),
            content,
            body_from,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSourceSaveRequest {
    pub path: String,
    pub content: String,
    pub expected_revision: String,
    #[serde(default)]
    pub base_content: Option<String>,
}

struct SourceLocation {
    root: GraphSourceRoot,
    path: PathBuf,
}

impl GraphRuntime {
    /// Read only this source. The gate keeps root and source ownership stable;
    /// ordinary graph queries remain available while the file is read.
    pub fn source(&self, path: &str) -> Result<Option<GraphSourceDocument>, String> {
        let _mutation = self
            .mutation_gate
            .lock()
            .map_err(|error| error.to_string())?;
        let Some(location) = self.source_location_locked(Path::new(path))? else {
            return Ok(None);
        };
        let content = fs::read_to_string(&location.path).map_err(|error| {
            format!(
                "Could not read Graph source '{}': {error}",
                location.path.display()
            )
        })?;
        Ok(Some(GraphSourceDocument::from_source(
            &location.path,
            &location.root,
            content,
        )))
    }

    pub fn source_save(
        &self,
        request: GraphSourceSaveRequest,
    ) -> Result<GraphSourceDocument, String> {
        let _mutation = self
            .mutation_gate
            .lock()
            .map_err(|error| error.to_string())?;
        let location = self
            .source_location_locked(Path::new(&request.path))?
            .ok_or_else(|| {
                "This file is no longer an available Graph source. Reload it before saving."
                    .to_string()
            })?;
        let current = fs::read_to_string(&location.path).map_err(|error| {
            format!(
                "Could not read Graph source '{}': {error}",
                location.path.display()
            )
        })?;
        let actual = source_revision(&current);
        let mut content = request.content;
        if actual != request.expected_revision {
            let rebased = request
                .base_content
                .as_deref()
                .filter(|base| source_revision(base) == request.expected_revision)
                .and_then(|base| {
                    crate::business_graph::project_home::rebase_context_source(
                        &location.path,
                        base,
                        &content,
                        &current,
                    )
                });
            if let Some(rebased) = rebased {
                content = rebased;
            } else {
                return Err(GraphMutationError::Conflict {
                    id: source_id(&location.path).unwrap_or_default(),
                    expected: request.expected_revision,
                    actual,
                }
                .to_string());
            }
        }
        let mut next = GraphSourceDocument::from_source(&location.path, &location.root, content);
        if next.content == current {
            return Ok(next);
        }
        let before = GraphSourceDocument::from_source(&location.path, &location.root, current).node;
        if let Some(node) = next.node.as_mut() {
            let authored_home = node.properties.get("home").cloned();
            crate::business_graph::project_home::stamp(
                node,
                before.as_ref().and_then(|node| node.properties.get("home")),
                &GraphActor::human(),
            )?;
            if node.properties.get("home") != authored_home.as_ref() {
                let content = crate::business_graph::serialize_graph_markdown(node)
                    .map_err(|error| error.to_string())?;
                next = GraphSourceDocument::from_source(&location.path, &location.root, content);
            }
        }
        // Preserve authored YAML, whitespace, and line endings. Structured Graph
        // saves and source saves share this gate and the same revision hash.
        persistence::write_bytes_atomic(&location.path, next.content.as_bytes()).map_err(
            |error| {
                format!(
                    "Could not write Graph source '{}': {error}",
                    location.path.display()
                )
            },
        )?;
        let source_path = location.path.to_string_lossy().into_owned();
        self.remember_source_revision(
            source_path.clone(),
            next.node
                .as_ref()
                .map(|node| node.provenance.source_revision.clone()),
        )
        .map_err(|error| error.to_string())?;
        let previous_revision = self
            .store
            .read()
            .map_err(|error| error.to_string())?
            .revision();
        self.refresh_locked(vec![source_path.clone()])?;
        {
            let mut store = self.store.write().map_err(|error| error.to_string())?;
            // Two malformed revisions can have the same diagnostic and no
            // indexed node. The changed source still invalidates open editors.
            if store.revision() == previous_revision {
                store.set_revision(previous_revision.saturating_add(1));
            }
        }
        if before.is_some() || next.node.is_some() {
            self.record_mutation(
                "graph.source-save",
                GraphActor::human(),
                before,
                next.node.clone(),
                source_path,
            )?;
        }
        Ok(next)
    }

    fn source_location_locked(&self, path: &Path) -> Result<Option<SourceLocation>, String> {
        if !path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
            || path.extension().and_then(|value| value.to_str()) != Some("md")
        {
            return Ok(None);
        }
        let Some(id) = source_id(path).filter(|id| is_valid_id(id)) else {
            return Ok(None);
        };
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => return Ok(None),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "Could not inspect Graph source '{}': {error}",
                    path.display()
                ))
            }
        }
        let canonical = fs::canonicalize(path).map_err(|error| error.to_string())?;
        let roots = self.roots.read().map_err(|error| error.to_string())?;
        let Some((position, root)) = roots.iter().enumerate().find(|(_, root)| {
            let directory = root.root.join("graph");
            // The graph collection is flat; directory and file symlinks do not
            // grant Graph source access to unrelated Markdown.
            fs::symlink_metadata(&directory).is_ok_and(|metadata| metadata.is_dir())
                && fs::canonicalize(directory).ok().as_deref() == canonical.parent()
        }) else {
            return Ok(None);
        };
        let store = self.store.read().map_err(|error| error.to_string())?;
        if let Some(owner) = store.get(&id) {
            if fs::canonicalize(&owner.provenance.source_path)
                .ok()
                .as_ref()
                != Some(&canonical)
            {
                return Ok(None);
            }
        } else if roots[..position].iter().any(|earlier| {
            fs::symlink_metadata(earlier.root.join("graph").join(format!("{id}.md")))
                .is_ok_and(|metadata| metadata.is_file())
        }) {
            // All sources for this ID can be malformed. Use the existing root
            // order conservatively without reading any other Markdown file.
            return Ok(None);
        }
        Ok(Some(SourceLocation {
            root: root.clone(),
            path: root.root.join("graph").join(format!("{id}.md")),
        }))
    }
}

#[cfg(test)]
#[path = "runtime_source_tests.rs"]
mod tests;
