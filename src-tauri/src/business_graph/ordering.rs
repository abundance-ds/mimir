use super::model::{GraphNode, GraphOrder, GraphSortBy, GraphSortDirection};
use super::references::normalize_title;
use std::cmp::Reverse;

#[derive(PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum SortKey {
    Text(bool, String),
    ReverseText(bool, Reverse<String>),
    Date(bool, i64),
    Score(u32),
}

// Cache keys once per query. Missing dates and projects sort last in either
// direction. Title and id break ties, so paging has a stable order.
pub(super) fn order_key(
    node: &GraphNode,
    order: &GraphOrder,
    score: u32,
    project: &str,
) -> (SortKey, String, String) {
    let title = normalize_title(&node.title);
    let descending = order.direction == GraphSortDirection::Desc;
    let sort = match order.sort_by {
        GraphSortBy::Title | GraphSortBy::Kind | GraphSortBy::Project => {
            let text = match order.sort_by {
                GraphSortBy::Title => title.clone(),
                GraphSortBy::Project => normalize_title(project),
                _ => match node.kind.as_str() {
                    "issue" => "task".to_owned(),
                    "timesheet" => "time sheet".to_owned(),
                    other => other.replace('-', " "),
                },
            };
            let missing = order.sort_by == GraphSortBy::Project && text.is_empty();
            if descending {
                SortKey::ReverseText(missing, Reverse(text))
            } else {
                SortKey::Text(missing, text)
            }
        }
        GraphSortBy::Updated | GraphSortBy::Created => {
            let value = timestamp(if order.sort_by == GraphSortBy::Created {
                &node.created_at
            } else {
                &node.updated_at
            });
            let date = value.unwrap_or_default();
            SortKey::Date(value.is_none(), if descending { -date } else { date })
        }
        GraphSortBy::Relevance => SortKey::Score(if descending { u32::MAX - score } else { score }),
    };
    (sort, title, node.id.clone())
}

fn timestamp(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|date| date.timestamp_millis())
        .ok()
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .ok()
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|date| date.and_utc().timestamp_millis())
        })
}
