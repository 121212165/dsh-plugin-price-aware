import { type Micros } from './money.ts';
import { type TokenBuckets } from './pricing/cost.ts';
import type { PriceCatalog, PriceEntry } from './pricing/catalog.ts';
/**
 * Some OpenAI-compatible gateways publish their own price sheet on /v1/models.
 * TokenRhythm does: `input_price_per_million`, `output_price_per_million`,
 * `cache_read_price_per_million`, an `effective_*` pair and `has_discount`.
 * When a provider tells us its price we must believe it over any bundled sheet —
 * a relay's rate for `deepseek-v4-flash-0731` is not DeepSeek's own rate.
 */
export interface ProviderModelRecord {
    id: string;
    owned_by?: string;
    context_length?: number;
    max_completion_tokens?: number;
    currency?: string;
    input_price_per_million?: string | number | null;
    output_price_per_million?: string | number | null;
    cache_read_price_per_million?: string | number | null;
    has_discount?: boolean;
    effective_input_price_per_million?: string | number | null;
    effective_output_price_per_million?: string | number | null;
    effective_cache_read_price_per_million?: string | number | null;
    supports_tools?: boolean;
    supports_reasoning?: boolean;
    supports_vision?: boolean;
}
export interface ProviderCatalogResult {
    catalog: PriceCatalog;
    priced: number;
    unpriced: string[];
}
export declare function catalogFromProviderModels(models: ProviderModelRecord[], options?: {
    provider: string;
    baseUrl?: string;
    asOf?: string;
    defaultCurrency?: string;
}): ProviderCatalogResult;
/**
 * OpenAI-shaped usage: `prompt_tokens` CONTAINS `cached_tokens`, and
 * `reasoning_tokens` is a subset of `completion_tokens`. Both facts were read
 * off a live TokenRhythm response, not assumed.
 */
export interface OpenAiUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
    completion_tokens_details?: {
        reasoning_tokens?: number;
    };
}
export declare function normalizeOpenAiUsage(usage: OpenAiUsage): TokenBuckets;
export declare function usageCostMicros(usage: OpenAiUsage, entry: PriceEntry, at?: Date): Micros;
export interface SelectionRequest {
    /** tokens the step is expected to consume */
    need: TokenBuckets;
    /** what is left of the declared budget, in micro-units */
    remainingMicros: Micros;
    /** only these model ids are candidates (post provider-prefix) */
    candidates?: string[];
    /** never pick these (e.g. a provider that is 503ing) */
    exclude?: string[];
    /** reserve this much of the remaining budget for the steps after this one */
    reserveFraction?: number;
}
export interface ModelFit {
    entry: PriceEntry;
    costMicros: Micros;
    fits: boolean;
    headroom: number;
}
/**
 * Rank a price sheet by what the remaining credits can actually afford, cheapest
 * first, so "spend what's left where it buys the most" is a computed answer.
 */
export declare function selectModelsByBudget(catalog: PriceCatalog, request: SelectionRequest): ModelFit[];
export declare function pickModelByBudget(catalog: PriceCatalog, request: SelectionRequest): {
    pick?: ModelFit | undefined;
    ranking: ModelFit[];
};
export declare function budgetFromMajor(major: number): Micros;
//# sourceMappingURL=provider.d.ts.map