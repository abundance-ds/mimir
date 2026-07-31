use super::{
    model::{ActivityCategory, DailyBucket, DurationBucket, HeatCell, TrackerReport},
    store::TrackerStore,
};
use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDateTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use std::collections::{BTreeMap, HashMap};

pub fn build_report(
    store: &TrackerStore,
    start_ms: i64,
    end_ms: i64,
    timezone: &str,
) -> Result<TrackerReport, String> {
    if end_ms <= start_ms {
        return Err("Tracker report end must be after its start.".into());
    }
    let timezone = timezone
        .parse::<Tz>()
        .map_err(|_| format!("Tracker timezone '{timezone}' is invalid."))?;
    let mut totals = ActivityCategory::ALL
        .into_iter()
        .map(|category| (category.as_str().to_string(), 0))
        .collect::<BTreeMap<_, _>>();
    let mut app_seconds: HashMap<String, (String, i64)> = HashMap::new();
    let mut subcategory_seconds: HashMap<(String, String), i64> = HashMap::new();
    let mut days: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    let mut heatmap: HashMap<(u32, u32), i64> = HashMap::new();
    let mut longest_work_streak_seconds = 0;
    let mut current_work_streak_seconds = 0;
    let mut previous_work_end: Option<i64> = None;

    let total_blocks = store.visit_blocks_in_range(start_ms, end_ms, |block| {
        let clipped_start = block.start_ms.max(start_ms);
        let clipped_end = block.end_ms.min(end_ms);
        if clipped_end <= clipped_start {
            return Ok(());
        }
        let seconds = (clipped_end - clipped_start) / 1000;
        *totals.entry(block.activity.as_str().into()).or_default() += seconds;

        if block.activity == ActivityCategory::Work {
            if previous_work_end.is_some_and(|end| clipped_start > end + 1_000) {
                longest_work_streak_seconds =
                    longest_work_streak_seconds.max(current_work_streak_seconds);
                current_work_streak_seconds = 0;
            }
            current_work_streak_seconds += seconds;
            previous_work_end = Some(clipped_end);
        } else {
            longest_work_streak_seconds =
                longest_work_streak_seconds.max(current_work_streak_seconds);
            current_work_streak_seconds = 0;
            previous_work_end = None;
        }

        if !matches!(
            block.activity,
            ActivityCategory::Afk | ActivityCategory::Off
        ) {
            if let Some(app_name) = block
                .app_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                let key = block
                    .bundle_id
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(app_name)
                    .to_string();
                let entry = app_seconds
                    .entry(key)
                    .or_insert_with(|| (app_name.to_string(), 0));
                entry.1 += seconds;
            }
            let subcategory = block
                .subcategory
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("Uncategorized");
            *subcategory_seconds
                .entry((block.activity.as_str().to_string(), subcategory.to_string()))
                .or_default() += seconds;
        }

        split_local_hours(clipped_start, clipped_end, timezone, |segment| {
            let date_key = segment.local_start.format("%Y-%m-%d").to_string();
            *days
                .entry(date_key)
                .or_default()
                .entry(block.activity.as_str().to_string())
                .or_default() += segment.seconds;
            if !matches!(
                block.activity,
                ActivityCategory::Afk | ActivityCategory::Off
            ) {
                *heatmap
                    .entry((
                        segment.local_start.weekday().num_days_from_monday(),
                        segment.local_start.hour(),
                    ))
                    .or_default() += segment.seconds;
            }
        })?;
        Ok(())
    })?;
    longest_work_streak_seconds = longest_work_streak_seconds.max(current_work_streak_seconds);

    let work = *totals.get(ActivityCategory::Work.as_str()).unwrap_or(&0);
    let leisure = *totals.get(ActivityCategory::Leisure.as_str()).unwrap_or(&0);
    let off = *totals.get(ActivityCategory::Off.as_str()).unwrap_or(&0);
    let total_seconds: i64 = totals.values().sum();
    let total_tracked_seconds = total_seconds.saturating_sub(off);
    let work_leisure_ratio = if leisure > 0 {
        Some(work as f64 / leisure as f64)
    } else {
        None
    };

    let mut top_apps = app_seconds
        .into_iter()
        .map(|(key, (label, seconds))| DurationBucket {
            key,
            label,
            seconds,
            activity: None,
        })
        .collect::<Vec<_>>();
    top_apps.sort_by(|left, right| {
        right
            .seconds
            .cmp(&left.seconds)
            .then_with(|| left.label.cmp(&right.label))
    });
    top_apps.truncate(12);

    let mut subcategories = subcategory_seconds
        .into_iter()
        .filter_map(|((activity, label), seconds)| {
            activity
                .parse::<ActivityCategory>()
                .ok()
                .map(|activity| DurationBucket {
                    key: format!("{}:{}", activity.as_str(), label),
                    label,
                    seconds,
                    activity: Some(activity),
                })
        })
        .collect::<Vec<_>>();
    subcategories.sort_by(|left, right| {
        right
            .seconds
            .cmp(&left.seconds)
            .then_with(|| left.label.cmp(&right.label))
    });
    subcategories.truncate(16);

    let days = days
        .into_iter()
        .map(|(date, mut day_totals)| {
            for category in ActivityCategory::ALL {
                day_totals.entry(category.as_str().to_string()).or_default();
            }
            DailyBucket {
                date,
                totals: day_totals,
            }
        })
        .collect::<Vec<_>>();

    let mut heatmap = heatmap
        .into_iter()
        .map(|((weekday, hour), seconds)| HeatCell {
            weekday,
            hour,
            seconds,
        })
        .collect::<Vec<_>>();
    heatmap.sort_by_key(|cell| (cell.weekday, cell.hour));

    Ok(TrackerReport {
        start_ms,
        end_ms,
        totals,
        total_tracked_seconds,
        work_leisure_ratio,
        longest_work_streak_seconds,
        top_apps,
        subcategories,
        days,
        heatmap,
        total_blocks,
    })
}

struct LocalSegment {
    local_start: DateTime<Tz>,
    seconds: i64,
}

fn split_local_hours(
    start_ms: i64,
    end_ms: i64,
    timezone: Tz,
    mut visitor: impl FnMut(LocalSegment),
) -> Result<(), String> {
    let mut cursor = DateTime::<Utc>::from_timestamp_millis(start_ms).ok_or_else(|| {
        "Tracker block start timestamp is outside the supported range.".to_string()
    })?;
    let end = DateTime::<Utc>::from_timestamp_millis(end_ms)
        .ok_or_else(|| "Tracker block end timestamp is outside the supported range.".to_string())?;
    while cursor < end {
        let local = cursor.with_timezone(&timezone);
        let next = next_local_hour(cursor, local.naive_local(), timezone).min(end);
        let seconds = (next - cursor).num_seconds().max(0);
        if seconds > 0 {
            visitor(LocalSegment {
                local_start: local,
                seconds,
            });
        }
        if next <= cursor {
            return Err("Tracker report could not advance across a local-hour boundary.".into());
        }
        cursor = next;
    }
    Ok(())
}

fn next_local_hour(cursor: DateTime<Utc>, local: NaiveDateTime, timezone: Tz) -> DateTime<Utc> {
    let hour_start = local
        .date()
        .and_hms_opt(local.hour(), 0, 0)
        .unwrap_or(local);
    let mut candidate = hour_start + Duration::hours(1);
    for _ in 0..4 {
        match timezone.from_local_datetime(&candidate) {
            LocalResult::Single(value) if value.with_timezone(&Utc) > cursor => {
                return value.with_timezone(&Utc)
            }
            LocalResult::Ambiguous(left, right) => {
                let mut candidates = [left.with_timezone(&Utc), right.with_timezone(&Utc)];
                candidates.sort();
                if let Some(value) = candidates.into_iter().find(|value| *value > cursor) {
                    return value;
                }
            }
            _ => {}
        }
        candidate += Duration::hours(1);
    }
    cursor + Duration::hours(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tracker::store::NewActivityBlock;
    use tempfile::TempDir;

    fn timestamp(value: &str) -> i64 {
        value.parse::<DateTime<Utc>>().unwrap().timestamp_millis()
    }

    #[test]
    fn report_clips_blocks_at_range_and_day_boundaries() {
        let directory = TempDir::new().unwrap();
        let store = TrackerStore::open(&directory.path().join("tracker.sqlite")).unwrap();
        store
            .insert_block(NewActivityBlock {
                start_ms: timestamp("2026-07-29T21:30:00Z"),
                end_ms: timestamp("2026-07-30T01:30:00Z"),
                activity: ActivityCategory::Work,
                subcategory: Some("Coding"),
                app_name: Some("Mimir"),
                bundle_id: Some("rs.shoulde.mimir"),
                domain: None,
                window_title: None,
                classification_key: Some("rs.shoulde.mimir"),
                source: "test",
                off_reason: None,
            })
            .unwrap();
        let report = build_report(
            &store,
            timestamp("2026-07-29T22:00:00Z"),
            timestamp("2026-07-30T01:00:00Z"),
            "Europe/Berlin",
        )
        .unwrap();
        assert_eq!(report.totals["Work"], 3 * 60 * 60);
        assert_eq!(report.days.len(), 1);
        assert_eq!(report.days[0].date, "2026-07-30");
    }

    #[test]
    fn spring_forward_does_not_invent_an_hour() {
        let directory = TempDir::new().unwrap();
        let store = TrackerStore::open(&directory.path().join("tracker.sqlite")).unwrap();
        let start = timestamp("2026-03-29T00:30:00Z");
        let end = timestamp("2026-03-29T02:30:00Z");
        store
            .insert_block(NewActivityBlock {
                start_ms: start,
                end_ms: end,
                activity: ActivityCategory::Work,
                subcategory: None,
                app_name: Some("Editor"),
                bundle_id: None,
                domain: None,
                window_title: None,
                classification_key: Some("Editor"),
                source: "test",
                off_reason: None,
            })
            .unwrap();
        let report = build_report(&store, start, end, "Europe/Berlin").unwrap();
        assert_eq!(report.totals["Work"], 2 * 60 * 60);
        assert_eq!(
            report.heatmap.iter().map(|cell| cell.seconds).sum::<i64>(),
            2 * 60 * 60
        );
    }
}
