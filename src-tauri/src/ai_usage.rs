use crate::ai_models::AiModelConfig;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedUsage {
    pub input_tokens: u64,
    pub input_no_cache_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_write_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
    pub estimated_cost: f64,
}

impl NormalizedUsage {
    pub fn with_cost(mut self, model: &AiModelConfig) -> Self {
        self.sync_cache_aliases();

        self.estimated_cost = (self.input_no_cache_tokens as f64 / 1_000_000.0)
            * input_price(model)
            + (self.cache_read_input_tokens as f64 / 1_000_000.0) * cache_read_price(model)
            + (self.cache_write_input_tokens as f64 / 1_000_000.0) * cache_write_price(model)
            + (self.output_tokens as f64 / 1_000_000.0) * model.pricing.output_per_million;
        self
    }

    pub fn sync_cache_aliases(&mut self) {
        if self.cache_read_input_tokens == 0 && self.cached_input_tokens > 0 {
            self.cache_read_input_tokens = self.cached_input_tokens;
        }
        self.cached_input_tokens = self.cache_read_input_tokens;
        if self.input_no_cache_tokens == 0 {
            self.input_no_cache_tokens = self
                .input_tokens
                .saturating_sub(self.cache_read_input_tokens)
                .saturating_sub(self.cache_write_input_tokens);
        }
    }
}

fn input_price(model: &AiModelConfig) -> f64 {
    model.pricing.input_per_million
}

fn cache_read_price(model: &AiModelConfig) -> f64 {
    if model.pricing.cache_read_input_per_million > 0.0 {
        return model.pricing.cache_read_input_per_million;
    }

    match model.provider.as_str() {
        "anthropic" => model.pricing.input_per_million * 0.1,
        _ => model.pricing.input_per_million,
    }
}

fn cache_write_price(model: &AiModelConfig) -> f64 {
    if model.pricing.cache_write_input_per_million > 0.0 {
        return model.pricing.cache_write_input_per_million;
    }

    match model.provider.as_str() {
        "anthropic" => model.pricing.input_per_million * 1.25,
        _ => model.pricing.input_per_million,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPSILON: f64 = 1e-9;

    fn model(provider: &str, pricing: serde_json::Value) -> AiModelConfig {
        serde_json::from_value(serde_json::json!({
            "id": "m",
            "name": "M",
            "provider": provider,
            "model": "m-1",
            "pricing": pricing
        }))
        .unwrap()
    }

    #[test]
    fn sync_cache_aliases_backfills_read_from_legacy_cached_field() {
        let mut usage = NormalizedUsage {
            input_tokens: 100,
            cached_input_tokens: 30,
            ..NormalizedUsage::default()
        };
        usage.sync_cache_aliases();
        assert_eq!(usage.cache_read_input_tokens, 30);
        assert_eq!(usage.cached_input_tokens, 30);
        assert_eq!(usage.input_no_cache_tokens, 70);
    }

    #[test]
    fn sync_cache_aliases_mirrors_read_into_cached() {
        let mut usage = NormalizedUsage {
            input_tokens: 100,
            cache_read_input_tokens: 40,
            cache_write_input_tokens: 10,
            ..NormalizedUsage::default()
        };
        usage.sync_cache_aliases();
        assert_eq!(usage.cached_input_tokens, 40);
        // input_no_cache derives from input minus reads and writes.
        assert_eq!(usage.input_no_cache_tokens, 50);
    }

    #[test]
    fn sync_cache_aliases_saturates_and_keeps_explicit_no_cache() {
        // Reads exceeding total input saturate to zero rather than underflow.
        let mut usage = NormalizedUsage {
            input_tokens: 10,
            cache_read_input_tokens: 40,
            ..NormalizedUsage::default()
        };
        usage.sync_cache_aliases();
        assert_eq!(usage.input_no_cache_tokens, 0);

        // An explicitly provided no-cache count is preserved.
        let mut usage = NormalizedUsage {
            input_tokens: 100,
            input_no_cache_tokens: 5,
            cache_read_input_tokens: 40,
            ..NormalizedUsage::default()
        };
        usage.sync_cache_aliases();
        assert_eq!(usage.input_no_cache_tokens, 5);
    }

    #[test]
    fn with_cost_uses_explicit_pricing_when_present() {
        let model = model(
            "anthropic",
            serde_json::json!({
                "inputPerMillion": 3.0,
                "cacheReadInputPerMillion": 0.3,
                "cacheWriteInputPerMillion": 3.75,
                "outputPerMillion": 15.0
            }),
        );
        let usage = NormalizedUsage {
            input_tokens: 3_000_000,
            cache_read_input_tokens: 1_000_000,
            cache_write_input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            ..NormalizedUsage::default()
        }
        .with_cost(&model);

        // 1M uncached input derived from 3M - 1M read - 1M write.
        assert_eq!(usage.input_no_cache_tokens, 1_000_000);
        let expected = 3.0 + 0.3 + 3.75 + 15.0;
        assert!(
            (usage.estimated_cost - expected).abs() < EPSILON,
            "{}",
            usage.estimated_cost
        );
    }

    #[test]
    fn with_cost_applies_anthropic_cache_fallback_multipliers() {
        // No explicit cache pricing: anthropic falls back to 0.1x reads and
        // 1.25x writes of the input price.
        let model = model(
            "anthropic",
            serde_json::json!({ "inputPerMillion": 10.0, "outputPerMillion": 0.0 }),
        );
        let usage = NormalizedUsage {
            input_tokens: 3_000_000,
            cache_read_input_tokens: 1_000_000,
            cache_write_input_tokens: 1_000_000,
            ..NormalizedUsage::default()
        }
        .with_cost(&model);
        let expected = 10.0 + 1.0 + 12.5;
        assert!(
            (usage.estimated_cost - expected).abs() < EPSILON,
            "{}",
            usage.estimated_cost
        );
    }

    #[test]
    fn with_cost_prices_other_providers_cache_at_input_rate() {
        let model = model(
            "openai",
            serde_json::json!({ "inputPerMillion": 10.0, "outputPerMillion": 0.0 }),
        );
        let usage = NormalizedUsage {
            input_tokens: 3_000_000,
            cache_read_input_tokens: 1_000_000,
            cache_write_input_tokens: 1_000_000,
            ..NormalizedUsage::default()
        }
        .with_cost(&model);
        let expected = 10.0 + 10.0 + 10.0;
        assert!(
            (usage.estimated_cost - expected).abs() < EPSILON,
            "{}",
            usage.estimated_cost
        );
    }

    #[test]
    fn with_cost_promotes_legacy_cached_alias_before_pricing() {
        let model = model(
            "anthropic",
            serde_json::json!({
                "inputPerMillion": 10.0,
                "cacheReadInputPerMillion": 1.0,
                "outputPerMillion": 0.0
            }),
        );
        // Only the legacy cached_input_tokens field is populated, as older
        // call sites do; with_cost must alias it into cache_read before pricing.
        let usage = NormalizedUsage {
            input_tokens: 2_000_000,
            cached_input_tokens: 1_000_000,
            ..NormalizedUsage::default()
        }
        .with_cost(&model);
        assert_eq!(usage.cache_read_input_tokens, 1_000_000);
        assert_eq!(usage.input_no_cache_tokens, 1_000_000);
        let expected = 10.0 + 1.0;
        assert!(
            (usage.estimated_cost - expected).abs() < EPSILON,
            "{}",
            usage.estimated_cost
        );
    }

    #[test]
    fn normalized_usage_serializes_camel_case_for_the_frontend() {
        let usage: NormalizedUsage = serde_json::from_value(serde_json::json!({
            "inputTokens": 10,
            "inputNoCacheTokens": 4,
            "cachedInputTokens": 6,
            "cacheReadInputTokens": 6,
            "cacheWriteInputTokens": 0,
            "outputTokens": 3,
            "reasoningTokens": 1,
            "totalTokens": 13,
            "estimatedCost": 0.5
        }))
        .unwrap();
        assert_eq!(usage.input_tokens, 10);
        assert_eq!(usage.reasoning_tokens, 1);

        let round_tripped = serde_json::to_value(&usage).unwrap();
        assert_eq!(round_tripped["cacheReadInputTokens"], 6);
        assert_eq!(round_tripped["estimatedCost"], 0.5);
    }
}
