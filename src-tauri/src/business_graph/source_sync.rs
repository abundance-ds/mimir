//! File discovery for the graph's single, flat Markdown source collection.
//! Parsing happens before acquiring the GraphStore write lock.

use super::{parse_graph_markdown, GraphDiagnostic, GraphNode, GraphSourceFormat, GraphSourceRoot};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SourceStamp {
    length: u64,
    modified: Option<SystemTime>,
}

pub(crate) fn source_stamp(path: &Path) -> Option<SourceStamp> {
    let metadata = fs::symlink_metadata(path).ok()?;
    metadata.is_file().then(|| SourceStamp {
        length: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

pub(crate) fn source_stamps(
    roots: &[GraphSourceRoot],
) -> Result<BTreeMap<PathBuf, SourceStamp>, String> {
    let mut stamps = BTreeMap::new();
    for root in roots {
        let directory = root.root.join("graph");
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Could not inspect {}: {error}",
                    directory.display()
                ))
            }
        };
        for entry in entries {
            let path = entry.map_err(|error| error.to_string())?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("md") {
                continue;
            }
            if let Some(stamp) = source_stamp(&path) {
                stamps.insert(path, stamp);
            }
        }
    }
    Ok(stamps)
}

pub(crate) fn graph_markdown_path(root: &Path, path: &Path) -> bool {
    path.extension().and_then(|value| value.to_str()) == Some("md")
        && path.parent() == Some(root.join("graph").as_path())
}

pub(crate) fn source_id(path: &Path) -> Option<String> {
    path.file_stem()?.to_str().map(str::to_string)
}

pub(crate) fn reconcile_sources(
    roots: &[GraphSourceRoot],
    ids: &BTreeSet<String>,
) -> (Vec<(String, Option<GraphNode>)>, Vec<GraphDiagnostic>) {
    let mut changes = Vec::with_capacity(ids.len());
    let mut diagnostics = Vec::new();
    for id in ids {
        let mut winner: Option<GraphNode> = None;
        // The same root order as GraphStore::load owns duplicate identity.
        for root in roots {
            let path = root.root.join("graph").join(format!("{id}.md"));
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_file() => {}
                Ok(_) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    diagnostics.push(GraphDiagnostic::error(
                        "source-file-unreadable",
                        format!(
                            "Could not inspect graph source '{}': {error}",
                            path.display()
                        ),
                        Some(path.to_string_lossy().into_owned()),
                    ));
                    continue;
                }
            }
            let raw = match fs::read_to_string(&path) {
                Ok(raw) => raw,
                Err(error) => {
                    diagnostics.push(GraphDiagnostic::error(
                        "source-file-unreadable",
                        format!("Could not read graph source '{}': {error}", path.display()),
                        Some(path.to_string_lossy().into_owned()),
                    ));
                    continue;
                }
            };
            match parse_graph_markdown(
                &path,
                &root.scope_id,
                root.scope_kind,
                GraphSourceFormat::Graph,
                &raw,
            ) {
                Ok(parsed) => {
                    diagnostics.extend(parsed.diagnostics);
                    if let Some(existing) = winner.as_ref() {
                        diagnostics.push(GraphDiagnostic::warning(
                            "duplicate-id",
                            format!(
                                "Graph id '{id}' appears in both '{}' and '{}'. The first source remains authoritative.",
                                existing.provenance.source_path, parsed.node.provenance.source_path,
                            ),
                            Some(id.clone()),
                            Some(parsed.node.provenance.source_path),
                        ));
                    } else {
                        winner = Some(parsed.node);
                    }
                }
                Err(error) => diagnostics.push(GraphDiagnostic::error(
                    "source-file-invalid",
                    format!("Could not load graph source '{}': {error}", path.display()),
                    Some(path.to_string_lossy().into_owned()),
                )),
            }
        }
        changes.push((id.clone(), winner));
    }
    (changes, diagnostics)
}
