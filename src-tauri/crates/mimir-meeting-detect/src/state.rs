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
    first_seen_millis: u64,
    last_seen_millis: u64,
    evidence: BTreeMap<i32, AppEvidence>,
    suggestion_open: bool,
}

impl TrackedApp {
    fn new(now_millis: u64, evidence: AppEvidence) -> Self {
        Self {
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

    fn candidate(&self, identity: &str) -> DetectionCandidate {
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
            id: format!("mic:{identity}"),
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
                    let candidate = tracked.candidate(&identity);
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
                events.push(DetectionEvent::CandidateSuggested(
                    tracked.candidate(&identity),
                ));
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
        let Some(identity) = candidate_id.strip_prefix("mic:") else {
            return Ok(None);
        };
        let Some(tracked) = self.tracked.remove(identity) else {
            return Ok(None);
        };
        if !tracked.suggestion_open {
            return Ok(None);
        }

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

    pub fn candidates(&self) -> Vec<DetectionCandidate> {
        self.tracked
            .iter()
            .filter(|(_, tracked)| tracked.suggestion_open)
            .map(|(identity, tracked)| tracked.candidate(identity))
            .collect()
    }

    pub fn reset(&mut self, reason: CandidateEndReason) -> Vec<DetectionEvent> {
        let events = self
            .tracked
            .iter()
            .filter(|(_, tracked)| tracked.suggestion_open)
            .map(|(identity, tracked)| DetectionEvent::CandidateEnded {
                candidate_id: tracked.candidate(identity).id,
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
        self.config.excludes(app)
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
