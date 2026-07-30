// Adapted from Fastrepl Anarlog crates/audio-sync/src/drift.rs at
// 08aad83f0c5cef1317d74a31519ae3190d726504 (MIT).
// Mimir adds configuration validation, discontinuity resets, observation
// counts, and finite/bounded outputs for long-running capture sessions.

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DriftConfig {
    /// EWMA weight assigned to the newest measurement.
    pub smoothing_alpha: f64,
    /// Observations beyond this rate are treated as discontinuities.
    pub max_abs_ppm: f64,
    /// A single lag jump larger than this resets the trend.
    pub max_lag_jump_samples: f64,
    /// Ignore updates closer together than this interval.
    pub min_interval_seconds: f64,
}

impl Default for DriftConfig {
    fn default() -> Self {
        Self {
            smoothing_alpha: 0.2,
            max_abs_ppm: 5_000.0,
            max_lag_jump_samples: 4_800.0,
            min_interval_seconds: 0.001,
        }
    }
}

impl DriftConfig {
    fn validate(self) -> Result<Self, DriftConfigError> {
        if !self.smoothing_alpha.is_finite()
            || self.smoothing_alpha <= 0.0
            || self.smoothing_alpha > 1.0
        {
            return Err(DriftConfigError::Alpha);
        }
        if !self.max_abs_ppm.is_finite() || self.max_abs_ppm <= 0.0 {
            return Err(DriftConfigError::PpmLimit);
        }
        if !self.max_lag_jump_samples.is_finite() || self.max_lag_jump_samples <= 0.0 {
            return Err(DriftConfigError::LagLimit);
        }
        if !self.min_interval_seconds.is_finite() || self.min_interval_seconds < 0.0 {
            return Err(DriftConfigError::Interval);
        }
        Ok(self)
    }
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum DriftConfigError {
    #[error("smoothing_alpha must be finite and within (0, 1]")]
    Alpha,
    #[error("max_abs_ppm must be finite and positive")]
    PpmLimit,
    #[error("max_lag_jump_samples must be finite and positive")]
    LagLimit,
    #[error("min_interval_seconds must be finite and non-negative")]
    Interval,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriftResetReason {
    NonFiniteObservation,
    NonMonotonicTime,
    SampleRateChanged,
    LagDiscontinuity,
    RateOutlier,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DriftSnapshot {
    pub capture_time_seconds: f64,
    pub lag_samples: f64,
    pub sample_rate_hz: u32,
    pub observations: u64,
    pub instant_drift_ppm: f64,
    pub smoothed_drift_ppm: f64,
    pub smoothed_drift_samples_per_second: f64,
    pub smoothed_drift_ms_per_minute: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DriftUpdate {
    Primed,
    Measured(DriftSnapshot),
    Reset { reason: DriftResetReason },
}

/// Tracks the rate at which measured mic/system lag changes.
#[derive(Debug, Clone)]
pub struct DriftTracker {
    config: DriftConfig,
    last_time: Option<f64>,
    last_lag: Option<f64>,
    sample_rate_hz: Option<u32>,
    smoothed_ppm: Option<f64>,
    observations: u64,
}

impl DriftTracker {
    pub fn new(config: DriftConfig) -> Result<Self, DriftConfigError> {
        Ok(Self {
            config: config.validate()?,
            last_time: None,
            last_lag: None,
            sample_rate_hz: None,
            smoothed_ppm: None,
            observations: 0,
        })
    }

    pub fn reset(&mut self) {
        self.last_time = None;
        self.last_lag = None;
        self.sample_rate_hz = None;
        self.smoothed_ppm = None;
        self.observations = 0;
    }

    fn reset_with_observation(
        &mut self,
        reason: DriftResetReason,
        capture_time_seconds: f64,
        lag_samples: f64,
        sample_rate_hz: u32,
    ) -> DriftUpdate {
        self.last_time = Some(capture_time_seconds);
        self.last_lag = Some(lag_samples);
        self.sample_rate_hz = Some(sample_rate_hz);
        self.smoothed_ppm = None;
        self.observations = 1;
        DriftUpdate::Reset { reason }
    }

    pub fn update(
        &mut self,
        capture_time_seconds: f64,
        lag_samples: f64,
        sample_rate_hz: u32,
    ) -> DriftUpdate {
        if !capture_time_seconds.is_finite() || !lag_samples.is_finite() || sample_rate_hz == 0 {
            self.reset();
            return DriftUpdate::Reset {
                reason: DriftResetReason::NonFiniteObservation,
            };
        }

        let (Some(last_time), Some(last_lag), Some(previous_rate)) =
            (self.last_time, self.last_lag, self.sample_rate_hz)
        else {
            self.last_time = Some(capture_time_seconds);
            self.last_lag = Some(lag_samples);
            self.sample_rate_hz = Some(sample_rate_hz);
            self.observations = 1;
            return DriftUpdate::Primed;
        };

        if sample_rate_hz != previous_rate {
            return self.reset_with_observation(
                DriftResetReason::SampleRateChanged,
                capture_time_seconds,
                lag_samples,
                sample_rate_hz,
            );
        }
        let elapsed = capture_time_seconds - last_time;
        if elapsed <= 0.0 {
            return self.reset_with_observation(
                DriftResetReason::NonMonotonicTime,
                capture_time_seconds,
                lag_samples,
                sample_rate_hz,
            );
        }
        if elapsed < self.config.min_interval_seconds {
            return DriftUpdate::Primed;
        }

        let lag_delta = lag_samples - last_lag;
        if lag_delta.abs() > self.config.max_lag_jump_samples {
            return self.reset_with_observation(
                DriftResetReason::LagDiscontinuity,
                capture_time_seconds,
                lag_samples,
                sample_rate_hz,
            );
        }

        let samples_per_second = lag_delta / elapsed;
        let instant_ppm = samples_per_second * 1_000_000.0 / f64::from(sample_rate_hz);
        if !instant_ppm.is_finite() || instant_ppm.abs() > self.config.max_abs_ppm {
            return self.reset_with_observation(
                DriftResetReason::RateOutlier,
                capture_time_seconds,
                lag_samples,
                sample_rate_hz,
            );
        }

        let smoothed_ppm = self.smoothed_ppm.map_or(instant_ppm, |previous| {
            previous * (1.0 - self.config.smoothing_alpha)
                + instant_ppm * self.config.smoothing_alpha
        });
        self.last_time = Some(capture_time_seconds);
        self.last_lag = Some(lag_samples);
        self.smoothed_ppm = Some(smoothed_ppm);
        self.observations = self.observations.saturating_add(1);

        let smoothed_samples_per_second = smoothed_ppm * f64::from(sample_rate_hz) / 1_000_000.0;
        DriftUpdate::Measured(DriftSnapshot {
            capture_time_seconds,
            lag_samples,
            sample_rate_hz,
            observations: self.observations,
            instant_drift_ppm: instant_ppm,
            smoothed_drift_ppm: smoothed_ppm,
            smoothed_drift_samples_per_second: smoothed_samples_per_second,
            smoothed_drift_ms_per_minute: smoothed_samples_per_second * 60_000.0
                / f64::from(sample_rate_hz),
        })
    }
}

impl Default for DriftTracker {
    fn default() -> Self {
        Self::new(DriftConfig::default()).expect("default drift config is valid")
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    #[test]
    fn reports_known_positive_drift() {
        let mut tracker = DriftTracker::default();
        assert_eq!(tracker.update(1.0, 100.0, 16_000), DriftUpdate::Primed);
        let DriftUpdate::Measured(snapshot) = tracker.update(11.0, 108.0, 16_000) else {
            panic!("expected measurement");
        };
        assert!((snapshot.smoothed_drift_ppm - 50.0).abs() < 1e-9);
    }

    #[test]
    fn discontinuity_resets_instead_of_polluting_trend() {
        let mut tracker = DriftTracker::default();
        tracker.update(0.0, 0.0, 48_000);
        assert_eq!(
            tracker.update(1.0, 5_000.0, 48_000),
            DriftUpdate::Reset {
                reason: DriftResetReason::LagDiscontinuity
            }
        );
        let DriftUpdate::Measured(snapshot) = tracker.update(2.0, 5_000.0, 48_000) else {
            panic!("expected post-reset measurement");
        };
        assert_eq!(snapshot.smoothed_drift_ppm, 0.0);
    }

    proptest! {
        #[test]
        fn accepted_measurements_are_finite_and_bounded(
            deltas in prop::collection::vec(-0.1_f64..0.1, 1..200)
        ) {
            let config = DriftConfig {
                max_abs_ppm: 10_000.0,
                ..DriftConfig::default()
            };
            let mut tracker = DriftTracker::new(config).unwrap();
            let mut lag = 0.0;
            tracker.update(0.0, lag, 48_000);
            for (index, delta) in deltas.into_iter().enumerate() {
                lag += delta;
                if let DriftUpdate::Measured(snapshot) =
                    tracker.update((index + 1) as f64, lag, 48_000)
                {
                    prop_assert!(snapshot.smoothed_drift_ppm.is_finite());
                    prop_assert!(snapshot.smoothed_drift_ppm.abs() <= config.max_abs_ppm);
                    prop_assert!(snapshot.smoothed_drift_samples_per_second.is_finite());
                }
            }
        }
    }
}
