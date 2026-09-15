//! Validation for Markdown time sheets. Computed totals are never persisted.
use super::GraphNode;
use chrono::NaiveDate;
use std::collections::HashSet;

pub(super) fn problems(node: &GraphNode) -> Vec<String> {
    if node.kind != "timesheet" {
        return Vec::new();
    }
    let mut errors = Vec::new();
    let period = node
        .properties
        .get("period")
        .and_then(|value| value.as_str());
    let valid_period =
        period.is_some_and(|value| value.len() == 7 && valid_date(&format!("{value}-01")));
    if !valid_period {
        errors.push("Enter a month as YYYY-MM.".into());
    }
    let Some(entries) = node
        .properties
        .get("entries")
        .and_then(|value| value.as_array())
    else {
        errors.push("Time entries must be a list. Repair the list in Source.".into());
        return errors;
    };
    if entries.len() > 10_000 {
        errors.push("A time sheet can contain at most 10,000 rows.".into());
    }
    let mut ids = HashSet::new();
    for (index, value) in entries.iter().enumerate() {
        let mut add = |message: &str| errors.push(format!("Row {}: {message}", index + 1));
        let Some(entry) = value.as_object() else {
            add("Repair this row in Source.");
            continue;
        };
        match entry.get("id").and_then(|value| value.as_str()) {
            Some(id)
                if !id.is_empty()
                    && id.len() <= 128
                    && id.as_bytes()[0].is_ascii_alphanumeric()
                    && id.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
                    }) =>
            {
                if !ids.insert(id) {
                    add("Row IDs must be unique. Repair this ID in Source.");
                }
            }
            _ => add("Each row needs a permanent ID. Repair it in Source."),
        }
        match entry.get("date").and_then(|value| value.as_str()) {
            Some(date) if valid_date(date) => {
                if valid_period && !date.starts_with(&format!("{}-", period.unwrap_or_default())) {
                    add("Choose a date within this month.");
                }
            }
            _ => add("Choose a valid date."),
        }
        if !entry
            .get("minutes")
            .and_then(|value| value.as_u64())
            .is_some_and(|value| (1..=1440).contains(&value))
        {
            add("Enter a duration from 1m to 24h.");
        }
        if !entry
            .get("description")
            .and_then(|value| value.as_str())
            .is_some_and(|value| !value.trim().is_empty())
        {
            add("Describe the work.");
        }
        if entry
            .get("invoice")
            .is_some_and(|value| value.as_str().is_none_or(|value| value.trim().is_empty()))
        {
            add("Enter an invoice reference, or clear it to mark the row Open.");
        }
    }
    errors
}

fn valid_date(value: &str) -> bool {
    value.len() == 10
        && !value.starts_with("0000")
        && NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .is_ok_and(|date| date.format("%Y-%m-%d").to_string() == value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::business_graph::{parse_graph_markdown, GraphScopeKind, GraphSourceFormat};
    use serde_json::Value;
    use std::path::Path;

    #[test]
    fn timesheet_validation_matches_renderer_fixture_and_preserves_invalid_source() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../tests/fixtures/timesheets.json")).unwrap();
        for case in cases {
            let mut fields = case["properties"].as_object().unwrap().clone();
            fields.insert("kind".into(), Value::String("timesheet".into()));
            fields.insert("title".into(), Value::String("September time".into()));
            let source = format!(
                "---\n{}---\nClient notes.",
                serde_yaml::to_string(&fields).unwrap()
            );
            let parsed = parse_graph_markdown(
                Path::new("/graph/time.md"),
                "team:main",
                GraphScopeKind::Team,
                GraphSourceFormat::Graph,
                &source,
            )
            .unwrap();
            assert_eq!(
                problems(&parsed.node).is_empty(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(parsed.node.body.trim(), "Client notes.");
            assert_eq!(
                parsed.node.properties,
                *case["properties"].as_object().unwrap()
            );
            assert_eq!(
                parsed
                    .diagnostics
                    .iter()
                    .any(|diagnostic| diagnostic.code == "invalid-timesheet"),
                !case["valid"].as_bool().unwrap()
            );
        }
    }
}
