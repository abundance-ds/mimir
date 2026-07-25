use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use cron::Schedule;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
    str::FromStr,
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoutineOverlap {
    #[default]
    Skip,
    Parallel,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MissedFirePolicy {
    Skip,
    #[default]
    RunOnce,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineDefinition {
    pub id: String,
    pub title: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    pub schedule: String,
    #[serde(default = "default_timezone")]
    pub timezone: String,
    pub preset: String,
    pub prompt: String,
    #[serde(default)]
    pub overlap: RoutineOverlap,
    #[serde(default)]
    pub missed: MissedFirePolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineDiagnostic {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineCatalog {
    pub directory: String,
    pub routines: Vec<RoutineDefinition>,
    pub diagnostics: Vec<RoutineDiagnostic>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoutineFireReason {
    Scheduled,
    Missed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineFire {
    pub routine_id: String,
    pub scheduled_for: String,
    pub observed_at: String,
    pub reason: RoutineFireReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineSkip {
    pub routine_id: String,
    pub scheduled_for: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineTick {
    pub fires: Vec<RoutineFire>,
    pub skips: Vec<RoutineSkip>,
    pub next_fires: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutinePlannerState {
    #[serde(default)]
    pub next_fires: BTreeMap<String, String>,
}

pub fn default_routines_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".mim").join("routines"))
        .ok_or_else(|| "Could not resolve the home directory for routines.".to_string())
}

pub fn load_catalog(directory: &Path) -> RoutineCatalog {
    let mut catalog = RoutineCatalog {
        directory: directory.to_string_lossy().into_owned(),
        ..RoutineCatalog::default()
    };

    let mut paths = match fs::read_dir(directory) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("toml"))
            .collect::<Vec<_>>(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return catalog,
        Err(error) => {
            catalog.diagnostics.push(RoutineDiagnostic {
                path: catalog.directory.clone(),
                field: None,
                message: format!("Could not read routines directory: {error}"),
            });
            return catalog;
        }
    };
    paths.sort();

    let mut ids = HashSet::new();
    for path in paths {
        let display_path = path.to_string_lossy().into_owned();
        let source = match fs::read_to_string(&path) {
            Ok(source) => source,
            Err(error) => {
                catalog.diagnostics.push(RoutineDiagnostic {
                    path: display_path,
                    field: None,
                    message: format!("Could not read routine: {error}"),
                });
                continue;
            }
        };
        let definition = match toml::from_str::<RoutineDefinition>(&source) {
            Ok(definition) => definition,
            Err(error) => {
                catalog.diagnostics.push(RoutineDiagnostic {
                    path: display_path,
                    field: None,
                    message: format!("Invalid TOML: {error}"),
                });
                continue;
            }
        };
        if let Err((field, message)) = validate_definition(&definition) {
            catalog.diagnostics.push(RoutineDiagnostic {
                path: display_path,
                field: Some(field),
                message,
            });
            continue;
        }
        if !ids.insert(definition.id.clone()) {
            catalog.diagnostics.push(RoutineDiagnostic {
                path: display_path,
                field: Some("id".into()),
                message: format!("Duplicate routine id '{}'.", definition.id),
            });
            continue;
        }
        catalog.routines.push(definition);
    }

    catalog
        .routines
        .sort_by(|left, right| left.title.cmp(&right.title).then(left.id.cmp(&right.id)));
    catalog
}

pub fn validate_definition(definition: &RoutineDefinition) -> Result<(), (String, String)> {
    validate_id(&definition.id).map_err(|message| ("id".into(), message))?;
    if definition.title.trim().is_empty() {
        return Err(("title".into(), "Title must not be empty.".into()));
    }
    if definition.preset.trim().is_empty() {
        return Err(("preset".into(), "Preset must not be empty.".into()));
    }
    if definition.prompt.trim().is_empty() {
        return Err(("prompt".into(), "Prompt must not be empty.".into()));
    }
    if definition.prompt.contains('\0') {
        return Err(("prompt".into(), "Prompt must not contain NUL bytes.".into()));
    }
    if let Some(workspace) = &definition.workspace {
        if workspace.trim().is_empty() || workspace.contains('\0') {
            return Err((
                "workspace".into(),
                "Workspace must be a non-empty path without NUL bytes.".into(),
            ));
        }
    }
    parse_timezone(&definition.timezone).map_err(|message| ("timezone".into(), message))?;
    parse_schedule(&definition.schedule).map_err(|message| ("schedule".into(), message))?;
    Ok(())
}

pub fn next_fire(
    definition: &RoutineDefinition,
    after: DateTime<Utc>,
) -> Result<DateTime<Utc>, String> {
    let timezone = parse_timezone(&definition.timezone)?;
    let schedule = parse_schedule(&definition.schedule)?;
    schedule
        .after(&after.with_timezone(&timezone))
        .next()
        .map(|next| next.with_timezone(&Utc))
        .ok_or_else(|| format!("Routine '{}' has no future fire time.", definition.id))
}

pub fn reconcile_tick(
    catalog: &RoutineCatalog,
    state: &mut RoutinePlannerState,
    observed_at: DateTime<Utc>,
    running_routines: &HashSet<String>,
) -> RoutineTick {
    let mut tick = RoutineTick::default();
    let live_ids = catalog
        .routines
        .iter()
        .map(|routine| routine.id.as_str())
        .collect::<HashSet<_>>();
    state
        .next_fires
        .retain(|routine_id, _| live_ids.contains(routine_id.as_str()));

    for routine in &catalog.routines {
        if !routine.enabled {
            state.next_fires.remove(&routine.id);
            continue;
        }

        let stored_next = state
            .next_fires
            .get(&routine.id)
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&Utc));

        let Some(scheduled_for) = stored_next else {
            if let Ok(next) = next_fire(routine, observed_at) {
                state
                    .next_fires
                    .insert(routine.id.clone(), next.to_rfc3339());
            }
            continue;
        };

        if scheduled_for > observed_at {
            continue;
        }

        let overdue = observed_at
            .signed_duration_since(scheduled_for)
            .num_seconds()
            > 1;
        if overdue && routine.missed == MissedFirePolicy::Skip {
            tick.skips.push(RoutineSkip {
                routine_id: routine.id.clone(),
                scheduled_for: scheduled_for.to_rfc3339(),
                reason: "missed-fire-policy".into(),
            });
        } else if running_routines.contains(&routine.id) && routine.overlap == RoutineOverlap::Skip
        {
            tick.skips.push(RoutineSkip {
                routine_id: routine.id.clone(),
                scheduled_for: scheduled_for.to_rfc3339(),
                reason: "previous-run-active".into(),
            });
        } else {
            tick.fires.push(RoutineFire {
                routine_id: routine.id.clone(),
                scheduled_for: scheduled_for.to_rfc3339(),
                observed_at: observed_at.to_rfc3339(),
                reason: if overdue {
                    RoutineFireReason::Missed
                } else {
                    RoutineFireReason::Scheduled
                },
            });
        }

        match next_fire(routine, observed_at) {
            Ok(next) => {
                state
                    .next_fires
                    .insert(routine.id.clone(), next.to_rfc3339());
            }
            Err(_) => {
                state.next_fires.remove(&routine.id);
            }
        }
    }

    tick.next_fires = state.next_fires.clone();
    tick
}

fn default_enabled() -> bool {
    true
}

fn default_timezone() -> String {
    "local".into()
}

fn parse_timezone(value: &str) -> Result<Tz, String> {
    let requested = if value.trim().is_empty() || value == "local" {
        std::env::var("TZ").unwrap_or_else(|_| "UTC".into())
    } else {
        value.to_string()
    };
    requested
        .parse::<Tz>()
        .map_err(|_| format!("Unknown IANA timezone '{requested}'."))
}

fn parse_schedule(value: &str) -> Result<Schedule, String> {
    let normalized = normalize_schedule(value)?;
    Schedule::from_str(&normalized).map_err(|error| format!("Invalid cron expression: {error}"))
}

fn normalize_schedule(value: &str) -> Result<String, String> {
    let fields = value.split_whitespace().collect::<Vec<_>>();
    match fields.len() {
        5 => {
            // Five-field files use conventional cron numbering (0/7 Sunday,
            // 1 Monday). The parser's seconds-aware syntax uses 1 Sunday, so
            // translate only the day-of-week field while adding seconds/year.
            let day_of_week = normalize_standard_day_of_week(fields[4])?;
            Ok(format!(
                "0 {} {} {} {} {} *",
                fields[0], fields[1], fields[2], fields[3], day_of_week
            ))
        }
        6 | 7 => Ok(fields.join(" ")),
        count => Err(format!(
            "Cron expression must have 5, 6, or 7 fields; found {count}."
        )),
    }
}

fn normalize_standard_day_of_week(value: &str) -> Result<String, String> {
    value
        .split(',')
        .map(|part| {
            let (base, step) = part
                .split_once('/')
                .map(|(base, step)| (base, Some(step)))
                .unwrap_or((part, None));
            let normalized = if base == "*"
                || base
                    .chars()
                    .any(|character| character.is_ascii_alphabetic())
            {
                base.to_string()
            } else if let Some((start, end)) = base.split_once('-') {
                format!(
                    "{}-{}",
                    map_standard_weekday(start)?,
                    map_standard_weekday(end)?
                )
            } else {
                map_standard_weekday(base)?.to_string()
            };
            Ok(match step {
                Some(step) => format!("{normalized}/{step}"),
                None => normalized,
            })
        })
        .collect::<Result<Vec<_>, String>>()
        .map(|parts| parts.join(","))
}

fn map_standard_weekday(value: &str) -> Result<u8, String> {
    let weekday = value
        .parse::<u8>()
        .map_err(|_| format!("Invalid day-of-week value '{value}'."))?;
    match weekday {
        0 | 7 => Ok(1),
        1..=6 => Ok(weekday + 1),
        _ => Err(format!(
            "Day-of-week value '{weekday}' must be between 0 and 7."
        )),
    }
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Id must be 1-64 ASCII letters, numbers, hyphens, or underscores.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, TimeZone, Timelike};
    use tempfile::tempdir;

    fn routine(schedule: &str) -> RoutineDefinition {
        RoutineDefinition {
            id: "daily-review".into(),
            title: "Daily review".into(),
            enabled: true,
            schedule: schedule.into(),
            timezone: "Europe/Berlin".into(),
            preset: "claude-headless".into(),
            prompt: "Review recent changes and leave comments.".into(),
            overlap: RoutineOverlap::Skip,
            missed: MissedFirePolicy::RunOnce,
            workspace: None,
        }
    }

    #[test]
    fn five_field_cron_is_normalized_and_computes_in_requested_timezone() {
        let definition = routine("30 8 * * 1-5");
        let after = Utc.with_ymd_and_hms(2026, 7, 24, 12, 0, 0).unwrap();
        let next = next_fire(&definition, after).unwrap();
        let berlin = next.with_timezone(&chrono_tz::Europe::Berlin);
        assert_eq!(berlin.weekday(), chrono::Weekday::Mon);
        assert_eq!((berlin.hour(), berlin.minute()), (8, 30));
    }

    #[test]
    fn dst_transition_never_synthesizes_a_nonexistent_local_time() {
        let definition = routine("30 2 * * *");
        let after = Utc.with_ymd_and_hms(2026, 3, 28, 23, 0, 0).unwrap();
        let next = next_fire(&definition, after).unwrap();
        let berlin = next.with_timezone(&chrono_tz::Europe::Berlin);
        assert!(berlin.date_naive() >= chrono::NaiveDate::from_ymd_opt(2026, 3, 29).unwrap());
        assert_ne!(
            (berlin.date_naive(), berlin.hour(), berlin.minute()),
            (chrono::NaiveDate::from_ymd_opt(2026, 3, 29).unwrap(), 2, 30)
        );
    }

    #[test]
    fn catalog_keeps_valid_files_and_reports_precise_invalid_ones() {
        let directory = tempdir().unwrap();
        fs::write(
            directory.path().join("review.toml"),
            r#"
id = "review"
title = "Review"
schedule = "0 9 * * 1-5"
timezone = "Europe/Berlin"
preset = "codex"
prompt = "Review the latest files."
"#,
        )
        .unwrap();
        fs::write(
            directory.path().join("broken.toml"),
            r#"
id = "broken"
title = "Broken"
schedule = "whenever"
preset = "codex"
prompt = "Try."
"#,
        )
        .unwrap();

        let catalog = load_catalog(directory.path());
        assert_eq!(catalog.routines.len(), 1);
        assert_eq!(catalog.routines[0].id, "review");
        assert_eq!(catalog.diagnostics.len(), 1);
        assert_eq!(catalog.diagnostics[0].field.as_deref(), Some("schedule"));
        assert!(catalog.diagnostics[0].path.ends_with("broken.toml"));
    }

    #[test]
    fn catalog_reports_duplicate_ids_without_hiding_first_definition() {
        let directory = tempdir().unwrap();
        let source = r#"
id = "review"
title = "Review"
schedule = "0 9 * * *"
timezone = "UTC"
preset = "codex"
prompt = "Review."
"#;
        fs::write(directory.path().join("a.toml"), source).unwrap();
        fs::write(directory.path().join("b.toml"), source).unwrap();

        let catalog = load_catalog(directory.path());
        assert_eq!(catalog.routines.len(), 1);
        assert_eq!(catalog.diagnostics.len(), 1);
        assert!(catalog.diagnostics[0].message.contains("Duplicate"));
    }

    #[test]
    fn first_tick_arms_without_backfilling_and_due_tick_runs_once() {
        let definition = routine("* * * * *");
        let catalog = RoutineCatalog {
            routines: vec![definition],
            ..RoutineCatalog::default()
        };
        let mut state = RoutinePlannerState::default();
        let start = Utc.with_ymd_and_hms(2026, 7, 25, 10, 0, 10).unwrap();

        let armed = reconcile_tick(&catalog, &mut state, start, &HashSet::new());
        assert!(armed.fires.is_empty());
        let scheduled = DateTime::parse_from_rfc3339(state.next_fires.get("daily-review").unwrap())
            .unwrap()
            .with_timezone(&Utc);

        let due = reconcile_tick(
            &catalog,
            &mut state,
            scheduled + chrono::Duration::seconds(1),
            &HashSet::new(),
        );
        assert_eq!(due.fires.len(), 1);
        assert_eq!(due.fires[0].reason, RoutineFireReason::Scheduled);
    }

    #[test]
    fn sleep_wake_collapses_missed_fires_to_one_and_rearms_after_now() {
        let definition = routine("* * * * *");
        let catalog = RoutineCatalog {
            routines: vec![definition],
            ..RoutineCatalog::default()
        };
        let mut state = RoutinePlannerState::default();
        let start = Utc.with_ymd_and_hms(2026, 7, 25, 10, 0, 10).unwrap();
        reconcile_tick(&catalog, &mut state, start, &HashSet::new());

        let wake = start + chrono::Duration::hours(5);
        let tick = reconcile_tick(&catalog, &mut state, wake, &HashSet::new());
        assert_eq!(tick.fires.len(), 1);
        assert_eq!(tick.fires[0].reason, RoutineFireReason::Missed);
        let next = DateTime::parse_from_rfc3339(state.next_fires.get("daily-review").unwrap())
            .unwrap()
            .with_timezone(&Utc);
        assert!(next > wake);
    }

    #[test]
    fn overlap_and_missed_policies_skip_with_explicit_reasons() {
        let overlap = routine("* * * * *");
        let mut missed = overlap.clone();
        missed.id = "missed".into();
        missed.missed = MissedFirePolicy::Skip;
        let catalog = RoutineCatalog {
            routines: vec![overlap.clone(), missed],
            ..RoutineCatalog::default()
        };
        let start = Utc.with_ymd_and_hms(2026, 7, 25, 10, 0, 10).unwrap();
        let due = start + chrono::Duration::hours(1);
        let scheduled = (start + chrono::Duration::minutes(1)).to_rfc3339();
        let mut state = RoutinePlannerState {
            next_fires: BTreeMap::from([
                (overlap.id.clone(), scheduled.clone()),
                ("missed".into(), scheduled),
            ]),
        };
        let running = HashSet::from([overlap.id.clone()]);

        let tick = reconcile_tick(&catalog, &mut state, due, &running);
        assert_eq!(tick.fires.len(), 0);
        assert_eq!(tick.skips.len(), 2);
        assert!(tick
            .skips
            .iter()
            .any(|skip| skip.reason == "previous-run-active"));
        assert!(tick
            .skips
            .iter()
            .any(|skip| skip.reason == "missed-fire-policy"));
    }

    #[test]
    fn disabled_routine_is_removed_from_planner_state() {
        let mut definition = routine("* * * * *");
        definition.enabled = false;
        let catalog = RoutineCatalog {
            routines: vec![definition],
            ..RoutineCatalog::default()
        };
        let mut state = RoutinePlannerState {
            next_fires: BTreeMap::from([("daily-review".into(), Utc::now().to_rfc3339())]),
        };
        let tick = reconcile_tick(&catalog, &mut state, Utc::now(), &HashSet::new());
        assert!(tick.fires.is_empty());
        assert!(state.next_fires.is_empty());
    }
}
