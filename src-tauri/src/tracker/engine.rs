use super::{
    model::{ActivityCategory, Observation, TrackerConfig},
    store::{NewActivityBlock, TrackerStore},
};

#[derive(Debug, Clone)]
struct CurrentActivity {
    block_id: i64,
    key: String,
    start_ms: i64,
    activity: ActivityCategory,
}

#[derive(Debug, Clone)]
struct Candidate {
    key: String,
    first_seen_ms: i64,
    observation: Observation,
}

#[derive(Debug, Default)]
pub struct TrackerEngine {
    current: Option<CurrentActivity>,
    candidate: Option<Candidate>,
}

impl TrackerEngine {
    pub fn observe(
        &mut self,
        store: &TrackerStore,
        config: &TrackerConfig,
        observation: Observation,
    ) -> Result<bool, String> {
        if observation.observed_at_ms <= 0 {
            return Err("Tracker observation timestamp is invalid.".into());
        }

        if observation.idle_seconds >= config.afk_threshold_seconds {
            let idle_start = observation
                .observed_at_ms
                .saturating_sub((observation.idle_seconds as i64).saturating_mul(1000));
            return self.transition_system(
                store,
                "__afk__",
                ActivityCategory::Afk,
                None,
                idle_start,
                observation.observed_at_ms,
                "native",
                None,
            );
        }

        if observation.app_name.trim().is_empty() {
            return self.extend_current(store, observation.observed_at_ms);
        }

        let key = observation.activity_key();
        if self
            .current
            .as_ref()
            .is_some_and(|current| current.key == key)
        {
            self.candidate = None;
            return self.extend_current(store, observation.observed_at_ms);
        }

        if self.current.is_none() {
            self.candidate = None;
            return self.start_observation(store, config, observation.observed_at_ms, observation);
        }

        let confirmation_ms = (config.change_confirmation_seconds as i64).saturating_mul(1000);
        if confirmation_ms == 0 {
            self.candidate = None;
            return self.start_observation(store, config, observation.observed_at_ms, observation);
        }

        match self.candidate.as_mut() {
            Some(candidate) if candidate.key == key => {
                candidate.observation = observation.clone();
                if observation
                    .observed_at_ms
                    .saturating_sub(candidate.first_seen_ms)
                    >= confirmation_ms
                {
                    let candidate = self.candidate.take().expect("candidate exists");
                    self.start_observation(
                        store,
                        config,
                        candidate.first_seen_ms,
                        candidate.observation,
                    )
                } else {
                    self.extend_current(store, observation.observed_at_ms)
                }
            }
            _ => {
                self.candidate = Some(Candidate {
                    key,
                    first_seen_ms: observation.observed_at_ms,
                    observation,
                });
                self.extend_current(store, self.candidate.as_ref().unwrap().first_seen_ms)
            }
        }
    }

    pub fn pause(
        &mut self,
        store: &TrackerStore,
        at_ms: i64,
        reason: &str,
    ) -> Result<bool, String> {
        self.candidate = None;
        self.transition_system(
            store,
            &format!("__off__:{reason}"),
            ActivityCategory::Off,
            None,
            at_ms,
            at_ms,
            "native",
            Some(reason),
        )
    }

    pub fn start_break(
        &mut self,
        store: &TrackerStore,
        at_ms: i64,
        minutes: u64,
    ) -> Result<bool, String> {
        self.candidate = None;
        self.transition_system(
            store,
            "__break__",
            ActivityCategory::Break,
            Some(&format!("{minutes}min break")),
            at_ms,
            at_ms,
            "manual",
            None,
        )
    }

    pub fn extend_break(&mut self, store: &TrackerStore, at_ms: i64) -> Result<bool, String> {
        if self
            .current
            .as_ref()
            .is_some_and(|current| current.activity == ActivityCategory::Break)
        {
            return self.extend_current(store, at_ms);
        }
        Ok(false)
    }

    pub fn close(&mut self, store: &TrackerStore, at_ms: i64) -> Result<bool, String> {
        self.candidate = None;
        let Some(current) = self.current.take() else {
            return Ok(false);
        };
        store.update_block_end(current.block_id, at_ms.max(current.start_ms))?;
        Ok(true)
    }

    pub fn recover_off_gap(
        &mut self,
        store: &TrackerStore,
        start_ms: i64,
        end_ms: i64,
        reason: &str,
    ) -> Result<bool, String> {
        if end_ms <= start_ms {
            return Ok(false);
        }
        self.candidate = None;
        self.transition_system(
            store,
            &format!("__off__:{reason}"),
            ActivityCategory::Off,
            None,
            start_ms,
            end_ms,
            "recovery",
            Some(reason),
        )
    }

    fn start_observation(
        &mut self,
        store: &TrackerStore,
        config: &TrackerConfig,
        transition_ms: i64,
        observation: Observation,
    ) -> Result<bool, String> {
        let classification_key = observation.classification_key();
        let (activity, subcategory, source) = classification_for_observation(store, &observation)?;
        if activity == ActivityCategory::Unknown && config.classification_enabled {
            store.queue_classification(&observation)?;
        }
        let transition_ms = self
            .current
            .as_ref()
            .map(|current| transition_ms.max(current.start_ms))
            .unwrap_or(transition_ms);
        if let Some(current) = self.current.take() {
            store.update_block_end(current.block_id, transition_ms)?;
        }
        let block_id = store.insert_block(NewActivityBlock {
            start_ms: transition_ms,
            end_ms: observation.observed_at_ms.max(transition_ms),
            activity,
            subcategory: subcategory.as_deref(),
            app_name: Some(&observation.app_name),
            bundle_id: observation.bundle_id.as_deref(),
            domain: observation.domain.as_deref(),
            window_title: observation.window_title.as_deref(),
            classification_key: Some(&classification_key),
            source,
            off_reason: None,
        })?;
        self.current = Some(CurrentActivity {
            block_id,
            key: observation.activity_key(),
            start_ms: transition_ms,
            activity,
        });
        Ok(true)
    }

    #[allow(clippy::too_many_arguments)]
    fn transition_system(
        &mut self,
        store: &TrackerStore,
        key: &str,
        activity: ActivityCategory,
        subcategory: Option<&str>,
        transition_ms: i64,
        observed_ms: i64,
        source: &str,
        off_reason: Option<&str>,
    ) -> Result<bool, String> {
        if self
            .current
            .as_ref()
            .is_some_and(|current| current.key == key)
        {
            return self.extend_current(store, observed_ms);
        }
        let transition_ms = self
            .current
            .as_ref()
            .map(|current| transition_ms.max(current.start_ms))
            .unwrap_or(transition_ms);
        if let Some(current) = self.current.take() {
            store.update_block_end(current.block_id, transition_ms)?;
        }
        let block_id = store.insert_block(NewActivityBlock {
            start_ms: transition_ms,
            end_ms: observed_ms.max(transition_ms),
            activity,
            subcategory,
            app_name: None,
            bundle_id: None,
            domain: None,
            window_title: None,
            classification_key: None,
            source,
            off_reason,
        })?;
        self.current = Some(CurrentActivity {
            block_id,
            key: key.to_string(),
            start_ms: transition_ms,
            activity,
        });
        Ok(true)
    }

    fn extend_current(&mut self, store: &TrackerStore, at_ms: i64) -> Result<bool, String> {
        let Some(current) = self.current.as_ref() else {
            return Ok(false);
        };
        store.update_block_end(current.block_id, at_ms.max(current.start_ms))?;
        Ok(false)
    }
}

fn classification_for_observation(
    store: &TrackerStore,
    observation: &Observation,
) -> Result<(ActivityCategory, Option<String>, &'static str), String> {
    let is_mimir = observation.bundle_id.as_deref() == Some("rs.shoulde.mimir")
        || observation.app_name.eq_ignore_ascii_case("Mimir");
    if is_mimir {
        let subcategory = match observation.mimir_context.as_deref() {
            Some("editor") => "Writing",
            Some("terminal") => "Coding",
            Some("agent") => "Agent work",
            Some("business-graph") => "Planning",
            Some("tracker") => "Administration",
            Some("files") => "Project navigation",
            _ => "Workbench",
        };
        return Ok((
            ActivityCategory::Work,
            Some(subcategory.to_string()),
            "mimir",
        ));
    }

    if let Some(classification) =
        store.classification_with_fallback(&observation.classification_key())?
    {
        return Ok((
            classification.activity,
            classification.subcategory,
            if classification.manual {
                "manual"
            } else {
                "cache"
            },
        ));
    }
    Ok((ActivityCategory::Unknown, None, "unclassified"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tracker::model::TrackerQuery;
    use tempfile::TempDir;

    fn harness() -> (TempDir, TrackerStore, TrackerEngine, TrackerConfig) {
        let directory = TempDir::new().unwrap();
        let store = TrackerStore::open(&directory.path().join("tracker.sqlite")).unwrap();
        let engine = TrackerEngine::default();
        let config = TrackerConfig::default();
        (directory, store, engine, config)
    }

    fn observation(at_ms: i64, idle_seconds: u64, app: &str) -> Observation {
        Observation {
            observed_at_ms: at_ms,
            idle_seconds,
            app_name: app.into(),
            bundle_id: Some(format!("com.example.{}", app.to_ascii_lowercase())),
            domain: None,
            window_title: Some(format!("{app} window")),
            mimir_context: None,
        }
    }

    #[test]
    fn confirmed_changes_use_first_observation_time() {
        let (_directory, store, mut engine, mut config) = harness();
        config.change_confirmation_seconds = 20;
        engine
            .observe(&store, &config, observation(1_000, 0, "Editor"))
            .unwrap();
        engine
            .observe(&store, &config, observation(11_000, 0, "Browser"))
            .unwrap();
        engine
            .observe(&store, &config, observation(31_000, 0, "Browser"))
            .unwrap();
        let blocks = store.blocks_in_range(0, 100_000).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].end_ms, 11_000);
        assert_eq!(blocks[1].start_ms, 11_000);
        assert_eq!(blocks[1].end_ms, 31_000);
    }

    #[test]
    fn brief_glances_remain_in_the_current_block() {
        let (_directory, store, mut engine, config) = harness();
        engine
            .observe(&store, &config, observation(1_000, 0, "Editor"))
            .unwrap();
        engine
            .observe(&store, &config, observation(11_000, 0, "Browser"))
            .unwrap();
        engine
            .observe(&store, &config, observation(21_000, 0, "Editor"))
            .unwrap();
        assert_eq!(store.blocks_in_range(0, 100_000).unwrap().len(), 1);
        assert_eq!(store.current_block().unwrap().unwrap().end_ms, 21_000);
    }

    #[test]
    fn afk_begins_when_input_stopped_not_when_threshold_was_polled() {
        let (_directory, store, mut engine, config) = harness();
        engine
            .observe(&store, &config, observation(1_000, 0, "Editor"))
            .unwrap();
        engine
            .observe(&store, &config, observation(601_000, 300, "Editor"))
            .unwrap();
        let blocks = store.blocks_in_range(0, 700_000).unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].end_ms, 301_000);
        assert_eq!(blocks[1].activity, ActivityCategory::Afk);
        assert_eq!(blocks[1].start_ms, 301_000);
        assert_eq!(blocks[1].end_ms, 601_000);
    }

    #[test]
    fn mimir_context_is_classified_without_ai() {
        let (_directory, store, mut engine, config) = harness();
        let mut value = observation(1_000, 0, "Mimir");
        value.bundle_id = Some("rs.shoulde.mimir".into());
        value.mimir_context = Some("editor".into());
        engine.observe(&store, &config, value).unwrap();
        let block = store.current_block().unwrap().unwrap();
        assert_eq!(block.activity, ActivityCategory::Work);
        assert_eq!(block.subcategory.as_deref(), Some("Writing"));
        assert_eq!(store.queued_classification_count().unwrap(), 0);
    }

    #[test]
    fn query_filters_do_not_change_engine_ordering() {
        let (_directory, store, mut engine, config) = harness();
        engine
            .observe(&store, &config, observation(1_000, 0, "Editor"))
            .unwrap();
        let page = store
            .query(&TrackerQuery {
                start_ms: 0,
                end_ms: 10_000,
                categories: vec![ActivityCategory::Unknown],
                ..TrackerQuery::default()
            })
            .unwrap();
        assert_eq!(page.total, 1);
    }
}
