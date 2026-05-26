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
