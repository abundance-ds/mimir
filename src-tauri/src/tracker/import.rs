use super::{
    model::{ActivityCategory, Classification, ImportPreview, ImportReport},
    platform,
    store::{
        insert_block_transaction, now_ms, save_classification_transaction, NewActivityBlock,
        TrackerStore,
    },
};
use chrono::{DateTime, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use rusqlite::params;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    str::FromStr,
};

#[derive(Debug, Clone, Deserialize)]
struct ArgusBlock {
    start: String,
    end: String,
    activity: String,
    #[serde(default)]
    subcategory: Option<String>,
    #[serde(default)]
    app: Option<String>,
    #[serde(default)]
    domain: Option<String>,
    #[serde(default)]
    window_title: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ArgusClassification {
    activity: String,
    #[serde(default)]
    subcategory: Option<String>,
    #[serde(default)]
    classified_by: Option<String>,
    #[serde(default)]
    date_added: Option<String>,
}

struct ArgusSources {
    directory: PathBuf,
    activities_bytes: Option<Vec<u8>>,
    classifications_bytes: Option<Vec<u8>>,
    hash: String,
}

pub fn default_argus_directory() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".argus"))
        .ok_or_else(|| "Could not resolve the Argus data directory.".to_string())
}

pub fn preview(store: &TrackerStore, directory: &Path) -> Result<ImportPreview, String> {
    let sources = read_sources(directory)?;
    let mut diagnostics = Vec::new();
    let activities = parse_activities(&sources, &mut diagnostics)?;
    let classifications = parse_classifications(&sources, &mut diagnostics)?;
    if platform::legacy_argus_running() {
        diagnostics.push(
            "The legacy Argus app is running. Quit it before importing or enabling Tracker.".into(),
        );
    }
    Ok(ImportPreview {
        source_directory: sources.directory.to_string_lossy().into_owned(),
        activities_found: sources.activities_bytes.is_some(),
        classifications_found: sources.classifications_bytes.is_some(),
        total_blocks: activities.len() as u64,
        total_classifications: classifications.len() as u64,
        first_timestamp: activities.first().map(|block| block.start.clone()),
        last_timestamp: activities.last().map(|block| block.end.clone()),
        source_hash: sources.hash.clone(),
        already_imported: store.import_exists(&sources.hash)?,
        diagnostics,
    })
}

pub fn import(
    store: &mut TrackerStore,
    directory: &Path,
    timezone: &str,
) -> Result<ImportReport, String> {
    if store.config()?.enabled {
        return Err(
            "Disable Tracker before importing Argus so the two timelines cannot overlap.".into(),
        );
    }
    if platform::legacy_argus_running() {
        return Err(
            "Quit the legacy Argus app before importing. This prevents a changing source file and overlapping timelines."
                .into(),
        );
    }
    let timezone = timezone
        .parse::<Tz>()
        .map_err(|_| format!("Import timezone '{timezone}' is invalid."))?;
    let sources = read_sources(directory)?;
    if store.import_exists(&sources.hash)? {
        return Ok(ImportReport {
            source_directory: sources.directory.to_string_lossy().into_owned(),
            source_hash: sources.hash,
            already_imported: true,
            ..ImportReport::default()
        });
    }

    let mut diagnostics = Vec::new();
    let activities = parse_activities(&sources, &mut diagnostics)?;
    let classifications = parse_classifications(&sources, &mut diagnostics)?;
    let mut prepared_blocks = Vec::new();
    let mut skipped_zero_blocks = 0u64;
    let mut skipped_invalid_blocks = 0u64;
    let mut first_ms = None;
    let mut last_ms = None;

    for (index, block) in activities.into_iter().enumerate() {
        let start_ms = match parse_argus_timestamp(&block.start, timezone, false) {
            Ok(value) => value,
            Err(error) => {
                skipped_invalid_blocks += 1;
                push_limited(
                    &mut diagnostics,
                    format!("Block {} start was skipped: {error}", index + 1),
                );
                continue;
            }
        };
        let end_ms = match parse_argus_timestamp(&block.end, timezone, true) {
            Ok(value) => value,
            Err(error) => {
                skipped_invalid_blocks += 1;
                push_limited(
                    &mut diagnostics,
                    format!("Block {} end was skipped: {error}", index + 1),
                );
                continue;
            }
        };
        if end_ms <= start_ms {
            if end_ms == start_ms {
                skipped_zero_blocks += 1;
            } else {
                skipped_invalid_blocks += 1;
                push_limited(
                    &mut diagnostics,
                    format!(
                        "Block {} ended before it started ({} → {}).",
                        index + 1,
                        block.start,
                        block.end
                    ),
                );
            }
            continue;
        }
        let activity = match ActivityCategory::from_str(&block.activity) {
            Ok(value) => value,
            Err(error) => {
                skipped_invalid_blocks += 1;
                push_limited(
                    &mut diagnostics,
                    format!("Block {} was skipped: {error}", index + 1),
                );
                continue;
            }
        };
        let classification_key =
            classification_key(block.app.as_deref(), block.domain.as_deref(), activity);
        first_ms = Some(first_ms.map_or(start_ms, |value: i64| value.min(start_ms)));
        last_ms = Some(last_ms.map_or(end_ms, |value: i64| value.max(end_ms)));
        prepared_blocks.push((
            start_ms,
            end_ms,
            activity,
            block.subcategory,
            block.app,
            block.domain,
            block.window_title,
            classification_key,
        ));
    }

    let mut prepared_classifications = Vec::new();
    for (key, value) in classifications {
        let activity = match ActivityCategory::from_str(&value.activity) {
            Ok(value)
                if !matches!(
                    value,
                    ActivityCategory::Afk | ActivityCategory::Off | ActivityCategory::Break
                ) =>
            {
                value
            }
            Ok(_) => {
                push_limited(
                    &mut diagnostics,
                    format!("Classification '{key}' uses a system category and was skipped."),
                );
                continue;
            }
            Err(error) => {
                push_limited(
                    &mut diagnostics,
                    format!("Classification '{key}' was skipped: {error}"),
                );
                continue;
            }
        };
        let classified_by = value
            .classified_by
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("argus")
            .to_string();
        let created_at_ms = value
            .date_added
            .as_deref()
            .and_then(|date| parse_argus_date(date, timezone).ok())
            .unwrap_or_else(now_ms);
        prepared_classifications.push(Classification {
            key,
            activity,
            subcategory: clean(value.subcategory),
            manual: classified_by == "manual",
            classified_by,
            created_at_ms,
            updated_at_ms: created_at_ms,
        });
    }

    let mut report = ImportReport {
        source_directory: sources.directory.to_string_lossy().into_owned(),
        source_hash: sources.hash.clone(),
        imported_blocks: prepared_blocks.len() as u64,
        skipped_zero_blocks,
        skipped_invalid_blocks,
        imported_classifications: prepared_classifications.len() as u64,
        already_imported: false,
        first_ms,
        last_ms,
        diagnostics,
    };
    let report_json = serde_json::to_string(&report)
        .map_err(|error| format!("Could not serialize Argus import report: {error}"))?;
    let source_hash = sources.hash.clone();
    let source_directory = sources.directory.to_string_lossy().into_owned();
    store.with_transaction(|transaction| {
        for (
            start_ms,
            end_ms,
            activity,
            subcategory,
            app,
            domain,
            window_title,
            classification_key,
        ) in &prepared_blocks
        {
            insert_block_transaction(
                transaction,
                NewActivityBlock {
                    start_ms: *start_ms,
                    end_ms: *end_ms,
                    activity: *activity,
                    subcategory: subcategory.as_deref(),
                    app_name: app.as_deref(),
                    bundle_id: None,
                    domain: domain.as_deref(),
                    window_title: window_title.as_deref(),
                    classification_key: classification_key.as_deref(),
                    source: "argus-import",
                    off_reason: if *activity == ActivityCategory::Off {
                        Some("argus-off")
                    } else {
                        None
                    },
                },
            )?;
        }
        for classification in &prepared_classifications {
            save_classification_transaction(transaction, classification)?;
        }
        transaction
            .execute(
                "INSERT INTO imports(
                   source_hash, source_directory, imported_at_ms,
                   blocks, classifications, report_json
                ) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    source_hash.as_str(),
                    source_directory.as_str(),
                    now_ms(),
                    prepared_blocks.len() as u64,
                    prepared_classifications.len() as u64,
                    report_json,
                ],
            )
            .map_err(|error| format!("Could not record Argus import: {error}"))?;
        Ok(())
    })?;
    report.imported_blocks = prepared_blocks.len() as u64;
    report.imported_classifications = prepared_classifications.len() as u64;
    Ok(report)
}

fn read_sources(directory: &Path) -> Result<ArgusSources, String> {
    let directory = directory.canonicalize().map_err(|error| {
        format!(
            "Could not open Argus directory '{}': {error}",
            directory.display()
        )
    })?;
    if !directory.is_dir() {
        return Err(format!(
            "Argus source '{}' is not a directory.",
            directory.display()
        ));
    }
    let activities_bytes = read_optional(&directory.join("activities.json"))?;
    let classifications_bytes = read_optional(&directory.join("classifications.json"))?;
    if activities_bytes.is_none() && classifications_bytes.is_none() {
        return Err(format!(
            "No activities.json or classifications.json exists in '{}'.",
            directory.display()
        ));
    }
    let mut hasher = Sha256::new();
    hasher.update(b"argus-import-v1\0activities\0");
    if let Some(bytes) = &activities_bytes {
        hasher.update(bytes);
    }
    hasher.update(b"\0classifications\0");
    if let Some(bytes) = &classifications_bytes {
        hasher.update(bytes);
    }
    Ok(ArgusSources {
        directory,
        activities_bytes,
        classifications_bytes,
        hash: format!("{:x}", hasher.finalize()),
    })
}

fn parse_activities(
    sources: &ArgusSources,
    diagnostics: &mut Vec<String>,
) -> Result<Vec<ArgusBlock>, String> {
    let Some(bytes) = &sources.activities_bytes else {
        diagnostics.push("Argus activities.json was not found.".into());
        return Ok(Vec::new());
    };
    serde_json::from_slice::<Vec<ArgusBlock>>(bytes)
        .map_err(|error| format!("Argus activities.json is invalid: {error}"))
}

fn parse_classifications(
    sources: &ArgusSources,
    diagnostics: &mut Vec<String>,
) -> Result<BTreeMap<String, ArgusClassification>, String> {
    let Some(bytes) = &sources.classifications_bytes else {
        diagnostics.push("Argus classifications.json was not found.".into());
        return Ok(BTreeMap::new());
    };
    serde_json::from_slice::<BTreeMap<String, ArgusClassification>>(bytes)
        .map_err(|error| format!("Argus classifications.json is invalid: {error}"))
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read '{}': {error}", path.display())),
    }
}

fn parse_argus_timestamp(value: &str, timezone: Tz, prefer_late: bool) -> Result<i64, String> {
    if let Ok(value) = DateTime::parse_from_rfc3339(value) {
        return Ok(value.with_timezone(&Utc).timestamp_millis());
    }
    let naive = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f")
        .map_err(|error| format!("timestamp '{value}' is invalid: {error}"))?;
    match timezone.from_local_datetime(&naive) {
        LocalResult::Single(value) => Ok(value.with_timezone(&Utc).timestamp_millis()),
        LocalResult::Ambiguous(early, late) => Ok(if prefer_late { late } else { early }
            .with_timezone(&Utc)
            .timestamp_millis()),
        LocalResult::None => Err(format!(
            "timestamp '{value}' does not exist in timezone {timezone}"
        )),
    }
}

fn parse_argus_date(value: &str, timezone: Tz) -> Result<i64, String> {
    let date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|error| format!("date '{value}' is invalid: {error}"))?;
    parse_argus_timestamp(
        &date
            .and_hms_opt(12, 0, 0)
            .ok_or_else(|| format!("date '{value}' is invalid"))?
            .format("%Y-%m-%dT%H:%M:%S")
            .to_string(),
        timezone,
        false,
    )
}

fn classification_key(
    app: Option<&str>,
    domain: Option<&str>,
    category: ActivityCategory,
) -> Option<String> {
    if matches!(
        category,
        ActivityCategory::Afk | ActivityCategory::Off | ActivityCategory::Break
    ) {
        return None;
    }
    let app = app.map(str::trim).filter(|value| !value.is_empty())?;
    Some(
        match domain.map(str::trim).filter(|value| !value.is_empty()) {
            Some(domain) => format!("{app} | {}", domain.to_ascii_lowercase()),
            None => app.to_string(),
        },
    )
}

fn clean(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn push_limited(diagnostics: &mut Vec<String>, message: String) {
    const LIMIT: usize = 50;
    if diagnostics.len() < LIMIT {
        diagnostics.push(message);
    } else if diagnostics.len() == LIMIT {
        diagnostics.push("Additional import diagnostics were omitted.".into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_fixture(directory: &Path) {
        fs::write(
            directory.join("activities.json"),
            br#"[
              {"start":"2026-03-29T01:00:00","end":"2026-03-29T01:30:00","duration_minutes":30,"activity":"Work","subcategory":"Coding","app":"Mimir","domain":null,"window_title":"tracker.rs"},
              {"start":"2026-03-29T02:15:00","end":"2026-03-29T02:45:00","duration_minutes":30,"activity":"Work","subcategory":"Coding","app":"Mimir","domain":null,"window_title":"missing hour"},
              {"start":"2026-03-29T03:00:00","end":"2026-03-29T03:00:00","duration_minutes":0,"activity":"AFK","subcategory":null,"app":null,"domain":null,"window_title":null}
            ]"#,
        )
        .unwrap();
        fs::write(
            directory.join("classifications.json"),
            br#"{
              "Mimir": {"activity":"Work","subcategory":"Coding","classified_by":"manual","date_added":"2026-03-06"}
            }"#,
        )
        .unwrap();
    }

    #[test]
    fn preview_and_import_are_idempotent_and_preserve_manual_rules() {
        let source = TempDir::new().unwrap();
        write_fixture(source.path());
        let target = TempDir::new().unwrap();
        let mut store = TrackerStore::open(&target.path().join("tracker.sqlite")).unwrap();

        let preview = preview(&store, source.path()).unwrap();
        assert_eq!(preview.total_blocks, 3);
        assert_eq!(preview.total_classifications, 1);
        assert!(!preview.already_imported);

        let report = import(&mut store, source.path(), "Europe/Berlin").unwrap();
        assert_eq!(report.imported_blocks, 1);
        assert_eq!(report.skipped_zero_blocks, 1);
        assert_eq!(report.skipped_invalid_blocks, 1);
        assert!(store.classification("Mimir").unwrap().unwrap().manual);

        let again = import(&mut store, source.path(), "Europe/Berlin").unwrap();
        assert!(again.already_imported);
        assert_eq!(store.blocks_in_range(0, i64::MAX).unwrap().len(), 1);
    }

    #[test]
    fn ambiguous_fall_back_uses_earlier_start_and_later_end() {
        let timezone = "Europe/Berlin".parse::<Tz>().unwrap();
        let start = parse_argus_timestamp("2026-10-25T02:15:00", timezone, false).unwrap();
        let end = parse_argus_timestamp("2026-10-25T02:45:00", timezone, true).unwrap();
        assert_eq!((end - start) / 60_000, 90);
    }
}
