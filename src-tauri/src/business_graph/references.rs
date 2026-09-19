//! Read-only body references. The source Markdown, including fallback labels,
//! remains authoritative; these rows never enter frontmatter relations.

use super::model::{is_valid_id, GraphNode};
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLinkTarget {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub scope_id: String,
}

impl From<&GraphNode> for GraphLinkTarget {
    fn from(node: &GraphNode) -> Self {
        Self {
            id: node.id.clone(),
            title: node.title.clone(),
            kind: node.kind.clone(),
            scope_id: node.provenance.scope_id.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GraphLinkStatus {
    Resolved,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLinkResolution {
    pub id: String,
    pub status: GraphLinkStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphBodyReference {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_field: Option<String>,
    pub target_id: String,
    pub label: String,
    /// Complete Markdown occurrence bounds, in UTF-16 units of the body.
    pub from: usize,
    pub to: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphOutgoingReference {
    #[serde(flatten)]
    pub reference: GraphBodyReference,
    pub status: GraphLinkStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<GraphLinkTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphBacklink {
    pub source: GraphLinkTarget,
    pub source_revision: String,
    pub occurrences: Vec<GraphBodyReference>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphReferences {
    pub source_revision: String,
    pub outgoing: Vec<GraphOutgoingReference>,
    pub backlinks: Vec<GraphBacklink>,
}

/// Deliberately narrower than a generic URL parser: no alternate host, encoded
/// path, trailing slash, query, fragment, or scheme normalization is accepted.
pub fn parse_graph_link_target(destination: &str) -> Option<&str> {
    let id = destination.strip_prefix("mimir://graph/")?;
    is_valid_id(id).then_some(id)
}

pub fn extract_graph_references(body: &str) -> Vec<GraphBodyReference> {
    let mut references = Vec::new();
    let mut active: Option<GraphBodyReference> = None;
    let mut image_depth = 0usize;
    for (event, range) in Parser::new_ext(body, Options::ENABLE_STRIKETHROUGH).into_offset_iter() {
        match event {
            Event::Start(Tag::Image { .. }) => image_depth += 1,
            Event::End(TagEnd::Image) => image_depth = image_depth.saturating_sub(1),
            Event::Start(Tag::Link {
                dest_url,
                link_type,
                ..
            }) if image_depth == 0 => {
                // pulldown-cmark's collapsed-reference span covers `[label]`
                // but omits its immediately following empty reference marks.
                let to = if link_type == LinkType::Collapsed && body[range.end..].starts_with("[]")
                {
                    range.end + 2
                } else {
                    range.end
                };
                active = parse_graph_link_target(&dest_url).map(|id| GraphBodyReference {
                    source_field: None,
                    target_id: id.to_string(),
                    label: String::new(),
                    from: range.start,
                    to,
                });
            }
            Event::End(TagEnd::Link) if image_depth == 0 => {
                if let Some(reference) = active.take() {
                    references.push(reference);
                }
            }
            Event::Text(text) | Event::Code(text) if image_depth == 0 => {
                if let Some(reference) = &mut active {
                    reference.label.push_str(&text);
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if let Some(reference) = &mut active {
                    reference.label.push(' ');
                }
            }
            _ => {}
        }
    }
    // Parser offsets are UTF-8 bytes. Walk the body once to convert sorted,
    // non-overlapping ranges, rather than rescanning each prefix per link.
    let mut byte_offset = 0;
    let mut utf16_offset = 0;
    for reference in &mut references {
        utf16_offset += body[byte_offset..reference.from].encode_utf16().count();
        byte_offset = reference.from;
        reference.from = utf16_offset;
        utf16_offset += body[byte_offset..reference.to].encode_utf16().count();
        byte_offset = reference.to;
        reference.to = utf16_offset;
    }
    references
}

pub(super) fn normalize_title(text: &str) -> String {
    text.nfd()
        .filter(|character| !is_combining_mark(*character))
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Lower ranks sort first. Every query term must match the title.
pub(super) fn title_match_rank(title: &str, query: &str, terms: &[&str]) -> Option<u8> {
    if title == query {
        return Some(0);
    }
    if title.starts_with(query) {
        return Some(1);
    }
    if terms.iter().all(|term| {
        title
            .split(|character: char| !character.is_alphanumeric())
            .any(|word| word.starts_with(term))
    }) {
        return Some(2);
    }
    terms.iter().all(|term| title.contains(term)).then_some(3)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct SyntaxFixture {
        name: String,
        body: String,
        references: Vec<GraphBodyReference>,
    }

    #[test]
    fn shared_markdown_syntax_and_utf16_offsets() {
        let cases: Vec<SyntaxFixture> =
            serde_json::from_str(include_str!("../../tests/fixtures/graph_links.json")).unwrap();
        for case in cases {
            assert_eq!(
                extract_graph_references(&case.body),
                case.references,
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn graph_urls_use_only_the_existing_exact_id_grammar() {
        assert_eq!(
            parse_graph_link_target("mimir://graph/jon-42"),
            Some("jon-42")
        );
        assert_eq!(
            parse_graph_link_target(&format!("mimir://graph/{}", "a".repeat(120))),
            Some("a".repeat(120).as_str())
        );
        assert!(parse_graph_link_target(&format!("mimir://graph/{}", "a".repeat(121))).is_none());
    }

    #[test]
    fn title_matching_normalizes_accents_and_ranks_word_prefixes() {
        assert_eq!(normalize_title("  JÓN   Mínton  "), "jon minton");
        assert_eq!(title_match_rank("jon", "jon", &["jon"]), Some(0));
        assert_eq!(title_match_rank("jon minton", "jo", &["jo"]), Some(1));
        assert_eq!(title_match_rank("meet jon", "jo", &["jo"]), Some(2));
        assert_eq!(title_match_rank("banjo", "jo", &["jo"]), Some(3));
        assert_eq!(
            title_match_rank("jon minton", "mi jo", &["mi", "jo"]),
            Some(2)
        );
        assert_eq!(title_match_rank("jon", "jo mi", &["jo", "mi"]), None);
    }
}
