// Detection-policy behavior is adapted from Fastrepl Anarlog
// plugins/detect/src/{mic_usage_tracker.rs,timer_registry.rs,policy.rs} and
// crates/detect/src/mic/macos/state.rs at
// 08aad83f0c5cef1317d74a31519ae3190d726504 (MIT).
// https://github.com/fastrepl/anarlog
//
// Mimir replaces timer tasks with a deterministic monotonic state machine.

use crate::{
    AppEvidence, CandidateEndReason, DetectError, DetectionCandidate, DetectionConfig,
    DetectionEvent,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
struct TrackedApp {
    candidate_id: String,
    first_seen_millis: u64,
    last_seen_millis: u64,
    evidence: BTreeMap<i32, AppEvidence>,
    suggestion_open: bool,
}

impl TrackedApp {
    fn new(now_millis: u64, evidence: AppEvidence) -> Self {
        Self {
            candidate_id: format!("mic:{}", uuid::Uuid::new_v4()),
            first_seen_millis: now_millis,
            last_seen_millis: now_millis,
            evidence: BTreeMap::from([(evidence.process_id, evidence)]),
            suggestion_open: false,
        }
    }

    fn update(&mut self, now_millis: u64, evidence: Vec<AppEvidence>) {
        self.last_seen_millis = now_millis;
        self.evidence = evidence
            .into_iter()
            .map(|item| (item.process_id, item))
            .collect();
    }

    fn candidate(&self) -> DetectionCandidate {
        let process_ids = self.evidence.keys().copied().collect::<Vec<_>>();
        let best = self
            .evidence
            .values()
            .min_by_key(|item| (is_helper_name(&item.app_name), item.process_id))
            .expect("tracked apps always retain at least one evidence item");
        let app_id = best
            .bundle_id
            .clone()
            .unwrap_or_else(|| format!("pid:{}", best.process_id));
        let confidence = if best.bundle_id.is_some() && !best.app_name.trim().is_empty() {
            0.95
        } else if best.bundle_id.is_some() {
            0.85
        } else {
            0.55
        };

        DetectionCandidate {
            id: self.candidate_id.clone(),
            app_id,
            app_name: best.app_name.clone(),
            detected_at_millis: self.first_seen_millis,
            confidence,
            process_ids,
        }
    }
}

fn is_helper_name(name: &str) -> bool {
    name.to_ascii_lowercase().contains("helper")
}

#[derive(Debug, Clone, Copy)]
struct Suppression {
    until_millis: u64,
    require_absence: bool,
}

/// Deterministic debounce, deduplication, and cooldown owner.
///
/// Time is supplied by the caller as milliseconds from one monotonic clock.
/// The policy never reads wall time and owns no timer tasks, making every
/// transition reproducible under tests and after listener/poll coalescing.
#[derive(Debug)]
pub struct DetectionPolicy {
    config: DetectionConfig,
    tracked: BTreeMap<String, TrackedApp>,
    suppressions: BTreeMap<String, Suppression>,
    last_now_millis: Option<u64>,
}

impl DetectionPolicy {
    pub fn new(config: DetectionConfig) -> Result<Self, DetectError> {
        config.validate()?;
        Ok(Self {
            config,
            tracked: BTreeMap::new(),
            suppressions: BTreeMap::new(),
            last_now_millis: None,
        })
    }

    pub fn observe(
        &mut self,
        now_millis: u64,
        apps: Vec<AppEvidence>,
    ) -> Result<Vec<DetectionEvent>, DetectError> {
        self.validate_now(now_millis)?;

        let grouped = self.group_evidence(apps);
        let seen = grouped.keys().cloned().collect::<BTreeSet<_>>();
        let mut events = Vec::new();

        let stale = self
            .tracked
            .iter()
            .filter(|(identity, tracked)| {
                !seen.contains(*identity)
                    && now_millis.saturating_sub(tracked.last_seen_millis)
                        >= duration_millis(self.config.absence_grace)
            })
            .map(|(identity, _)| identity.clone())
            .collect::<Vec<_>>();

        for identity in stale {
            if let Some(tracked) = self.tracked.remove(&identity) {
                if tracked.suggestion_open {
                    let candidate = tracked.candidate();
                    self.suppressions.insert(
                        identity,
                        Suppression {
                            until_millis: now_millis
                                .saturating_add(duration_millis(self.config.cooldown)),
                            require_absence: false,
                        },
                    );
                    events.push(DetectionEvent::CandidateEnded {
                        candidate_id: candidate.id,
                        reason: CandidateEndReason::Inactive,
                    });
                }
            }
        }

        self.expire_suppressions(now_millis, &seen);

        for (identity, evidence) in grouped {
            if self.suppressions.contains_key(&identity) {
                self.tracked.remove(&identity);
                continue;
            }

            let first_evidence = evidence
                .first()
                .cloned()
                .expect("grouped app evidence is never empty");
            let tracked = self
                .tracked
                .entry(identity.clone())
                .or_insert_with(|| TrackedApp::new(now_millis, first_evidence));
            tracked.update(now_millis, evidence);

            if !tracked.suggestion_open
                && now_millis.saturating_sub(tracked.first_seen_millis)
                    >= duration_millis(self.config.sustained_use)
            {
                tracked.suggestion_open = true;
                events.push(DetectionEvent::CandidateSuggested(tracked.candidate()));
            }
        }

        Ok(events)
    }

    pub fn dismiss(
        &mut self,
        candidate_id: &str,
        now_millis: u64,
    ) -> Result<Option<DetectionEvent>, DetectError> {
        self.validate_now(now_millis)?;
        let Some(identity) = self.tracked.iter().find_map(|(identity, tracked)| {
            (tracked.suggestion_open && tracked.candidate_id == candidate_id)
                .then(|| identity.clone())
        }) else {
            return Ok(None);
        };
        self.tracked.remove(&identity);

        self.suppressions.insert(
            identity.to_owned(),
            Suppression {
                until_millis: now_millis.saturating_add(duration_millis(self.config.cooldown)),
                // A dismissal is consent-sensitive: never nag again during the
                // same uninterrupted microphone use, even after the timer.
                require_absence: true,
            },
        );
        Ok(Some(DetectionEvent::CandidateEnded {
            candidate_id: candidate_id.to_owned(),
            reason: CandidateEndReason::Dismissed,
        }))
    }

    /// End only excluded occurrences; retain all other detection state.
    pub fn set_ignored_bundle_ids(&mut self, ids: BTreeSet<String>) -> Vec<DetectionEvent> {
        if self.config.ignored_bundle_ids == ids {
            return Vec::new();
        }
        self.config.ignored_bundle_ids = ids;
        let mut events = Vec::new();
        self.tracked.retain(|_, tracked| {
            if tracked
                .evidence
                .values()
                .any(|app| self.config.excludes(app))
            {
                if tracked.suggestion_open {
                    events.push(DetectionEvent::CandidateEnded {
                        candidate_id: tracked.candidate_id.clone(),
                        reason: CandidateEndReason::Ignored,
                    });
                }
                false
            } else {
                true
            }
        });
        events
    }

    pub fn candidates(&self) -> Vec<DetectionCandidate> {
        self.tracked
            .iter()
            .filter(|(_, tracked)| tracked.suggestion_open)
            .map(|(_, tracked)| tracked.candidate())
            .collect()
    }

    pub fn reset(&mut self, reason: CandidateEndReason) -> Vec<DetectionEvent> {
        let events = self
            .tracked
            .iter()
            .filter(|(_, tracked)| tracked.suggestion_open)
            .map(|(_, tracked)| DetectionEvent::CandidateEnded {
                candidate_id: tracked.candidate().id,
                reason,
            })
            .collect();
        self.tracked.clear();
        self.suppressions.clear();
        events
    }

    pub fn tracked_len(&self) -> usize {
        self.tracked.len()
    }

    pub(crate) fn config_excludes(&self, app: &AppEvidence) -> bool {
        self.config.excludes(&app.clone().canonicalized())
    }

    fn validate_now(&mut self, now_millis: u64) -> Result<(), DetectError> {
        if self.last_now_millis.is_some_and(|last| now_millis < last) {
            return Err(DetectError::MonotonicTimeRegression);
        }
        self.last_now_millis = Some(now_millis);
        Ok(())
    }

    fn group_evidence(&self, apps: Vec<AppEvidence>) -> BTreeMap<String, Vec<AppEvidence>> {
        let mut grouped = BTreeMap::<String, Vec<AppEvidence>>::new();
        for app in apps.into_iter().map(AppEvidence::canonicalized) {
            if self.config.excludes(&app) {
                continue;
            }
            grouped.entry(app.identity()).or_default().push(app);
        }
        for evidence in grouped.values_mut() {
            evidence.sort_by_key(|item| item.process_id);
            evidence.dedup_by_key(|item| item.process_id);
        }
        grouped
    }

    fn expire_suppressions(&mut self, now_millis: u64, seen: &BTreeSet<String>) {
        self.suppressions.retain(|identity, suppression| {
            let timer_active = now_millis < suppression.until_millis;
            let still_active = suppression.require_absence && seen.contains(identity);
            timer_active || still_active
        });
    }
}

fn duration_millis(duration: std::time::Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exclusions_end_only_matching_apps_and_can_be_removed() {
        let mut policy = DetectionPolicy::new(DetectionConfig {
            sustained_use: std::time::Duration::ZERO,
            ..DetectionConfig::default()
        })
        .unwrap();
        let dictate = AppEvidence {
            process_id: 8,
            bundle_id: Some("com.example.dictate".into()),
            app_name: "Example Dictation".into(),
        };
        let zoom = AppEvidence {
            process_id: 9,
            bundle_id: Some("us.zoom.xos".into()),
            app_name: "Zoom".into(),
        };
        policy
            .observe(0, vec![dictate.clone(), zoom.clone()])
            .unwrap();
        let before = policy.candidates();
        let ignored = before
            .iter()
            .find(|app| app.app_id == "com.example.dictate")
            .unwrap();
        let retained = before
            .iter()
            .find(|app| app.app_id == "us.zoom.xos")
            .unwrap();
        assert_eq!(
            policy.set_ignored_bundle_ids(BTreeSet::from(["COM.EXAMPLE.DICTATE".into()])),
            vec![DetectionEvent::CandidateEnded {
                candidate_id: ignored.id.clone(),
                reason: CandidateEndReason::Ignored,
            }]
        );
        assert!(policy
            .observe(100_000, vec![dictate.clone(), zoom.clone()])
            .unwrap()
            .is_empty());
        assert_eq!(policy.candidates(), vec![retained.clone()]);
        assert!(policy.set_ignored_bundle_ids(BTreeSet::new()).is_empty());
        let events = policy.observe(100_001, vec![dictate, zoom]).unwrap();
        assert!(
            matches!(&events[..], [DetectionEvent::CandidateSuggested(app)] if app.app_id == ignored.app_id && app.id != ignored.id)
        );
    }

    #[test]
    fn occurrence_ids_survive_updates_but_never_recur_after_end_or_reset() {
        let mut policy = DetectionPolicy::new(DetectionConfig {
            sustained_use: std::time::Duration::ZERO,
            absence_grace: std::time::Duration::ZERO,
            cooldown: std::time::Duration::ZERO,
            ..DetectionConfig::default()
        })
        .unwrap();
        let app = AppEvidence {
            process_id: 7,
            bundle_id: Some("us.zoom.xos".into()),
            app_name: "Zoom".into(),
        };
        policy.observe(0, vec![app.clone()]).unwrap();
        let first = policy.candidates()[0].id.clone();
        policy.observe(1, vec![app.clone()]).unwrap();
        assert_eq!(policy.candidates()[0].id, first);
        policy.observe(2, Vec::new()).unwrap();
        policy.observe(3, vec![app.clone()]).unwrap();
        let second = policy.candidates()[0].id.clone();
        assert_ne!(second, first);
        assert!(policy.dismiss(&first, 3).unwrap().is_none());
        assert_eq!(policy.candidates()[0].id, second);
        policy.reset(CandidateEndReason::DetectionDisabled);
        policy.observe(3, vec![app]).unwrap(); // even the same clock tick
        assert_ne!(policy.candidates()[0].id, second);
        let third = policy.candidates()[0].id.clone();
        assert!(policy.dismiss(&third, 3).unwrap().is_some());
        assert!(policy.candidates().is_empty());
    }

    #[test]
    fn ended_candidate_is_cooled_down_after_absence() {
        let mut policy = DetectionPolicy::new(DetectionConfig {
            sustained_use: std::time::Duration::ZERO,
            absence_grace: std::time::Duration::from_millis(10),
            cooldown: std::time::Duration::from_millis(100),
            ..DetectionConfig::default()
        })
        .unwrap();
        let app = AppEvidence {
            process_id: 7,
            bundle_id: Some("us.zoom.xos".into()),
            app_name: "Zoom".into(),
        };

        policy.observe(0, vec![app.clone()]).unwrap();
        let events = policy.observe(10, Vec::new()).unwrap();
        assert!(matches!(
            events.as_slice(),
            [DetectionEvent::CandidateEnded {
                reason: CandidateEndReason::Inactive,
                ..
            }]
        ));
        assert!(policy.observe(20, vec![app.clone()]).unwrap().is_empty());
        assert!(policy.observe(110, vec![app]).unwrap().len() == 1);
    }
}
