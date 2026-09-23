import { fromMajor, type Micros } from './money.ts';
import { costOf, type TokenBuckets } from './pricing/cost.ts';
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

function price(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface ProviderCatalogResult {
  catalog: PriceCatalog;
  priced: number;
  unpriced: string[];
}

export function catalogFromProviderModels(
  models: ProviderModelRecord[],
  options: { provider: string; baseUrl?: string; asOf?: string; defaultCurrency?: string } = { provider: 'provider' },
): ProviderCatalogResult {
  const entries: PriceEntry[] = [];
  const unpriced: string[] = [];
  for (const model of models) {
    const input = price(model.effective_input_price_per_million) ?? price(model.input_price_per_million);
    const output = price(model.effective_output_price_per_million) ?? price(model.output_price_per_million);
    // a number with no currency is not a price: assuming CNY silently scaled a USD
    // relay's sheet by ~7x, so such rows are refused until the caller says the unit
    const currency = (model.currency ?? options.defaultCurrency ?? '').toUpperCase();
    if (input === null || output === null || !model.id || !currency) {
      if (model.id) unpriced.push(model.id);
      continue;
    }
    entries.push({
      id: `${options.provider}/${model.id}`,
      currency: (model.currency ?? options.defaultCurrency ?? '').toUpperCase(),
      perMillion: {
        uncachedInput: input,
        output,
        cacheRead: price(model.effective_cache_read_price_per_million) ?? price(model.cache_read_price_per_million) ?? input,
      },
      // a provider sheet is a rate card, not a time-of-day table; peak rules would be invented
      contextTokens: model.context_length ?? 200_000,
      maxOutputTokens: model.max_completion_tokens ?? 8_000,
      lowConfidence: model.has_discount === true,
      note: model.has_discount ? 'provider 显示处于折扣价，折扣结束后价格会回到 list price' : undefined,
    });
  }
  return {
    catalog: { asOf: options.asOf ?? new Date().toISOString().slice(0, 10), source: options.baseUrl ?? `provider:${options.provider}`, entries },
    priced: entries.length,
    unpriced,
  };
}

/**
 * OpenAI-shaped usage: `prompt_tokens` CONTAINS `cached_tokens`, and
 * `reasoning_tokens` is a subset of `completion_tokens`. Both facts were read
 * off a live TokenRhythm response, not assumed.
 */
export interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export function normalizeOpenAiUsage(usage: OpenAiUsage): TokenBuckets {
  const prompt = Math.max(0, usage.prompt_tokens ?? 0);
  const cached = Math.max(0, usage.prompt_tokens_details?.cached_tokens ?? 0);
  return {
    uncachedInput: Math.max(0, prompt - cached),
    cacheRead: Math.min(prompt, cached),
    output: Math.max(0, usage.completion_tokens ?? 0),
    cacheWrite: 0,
  };
}

export function usageCostMicros(usage: OpenAiUsage, entry: PriceEntry, at: Date = new Date()): Micros {
  return costOf(normalizeOpenAiUsage(usage), entry, { at }).micros;
}

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
export function selectModelsByBudget(catalog: PriceCatalog, request: SelectionRequest): ModelFit[] {
  const reserve = Math.min(0.95, Math.max(0, request.reserveFraction ?? 0));
  const spendable = request.remainingMicros * (1 - reserve);
  const exclude = new Set(request.exclude ?? []);
  const fits: ModelFit[] = [];
  for (const entry of catalog.entries) {
    const short = entry.id.includes('/') ? entry.id.slice(entry.id.indexOf('/') + 1) : entry.id;
    if (exclude.has(short) || exclude.has(entry.id)) continue;
    if (request.candidates?.length && !request.candidates.includes(short) && !request.candidates.includes(entry.id)) continue;
    const costMicros = costOf(request.need, entry, {}).micros;
    fits.push({
      entry,
      costMicros,
      fits: costMicros <= spendable,
      headroom: spendable > 0 ? spendable / Math.max(1, costMicros) : Number.POSITIVE_INFINITY,
    });
  }
  return fits.sort((a, b) => Number(b.fits) - Number(a.fits) || a.costMicros - b.costMicros);
}

export function pickModelByBudget(catalog: PriceCatalog, request: SelectionRequest): { pick?: ModelFit; ranking: ModelFit[] } {
  const ranking = selectModelsByBudget(catalog, request);
  return { pick: ranking.find((fit) => fit.fits), ranking };
}

export function budgetFromMajor(major: number): Micros {
  return fromMajor(major);
}
