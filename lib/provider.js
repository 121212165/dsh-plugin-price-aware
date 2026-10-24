import { fromMajor } from './money.js';
import { costOf } from './pricing/cost.js';
function price(value) {
    if (value === null || value === undefined || value === '')
        return null;
    const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
}
export function catalogFromProviderModels(models, options = { provider: 'provider' }) {
    const entries = [];
    const unpriced = [];
    for (const model of models) {
        const input = price(model.effective_input_price_per_million) ?? price(model.input_price_per_million);
        const output = price(model.effective_output_price_per_million) ?? price(model.output_price_per_million);
        // a number with no currency is not a price: assuming CNY silently scaled a USD
        // relay's sheet by ~7x, so such rows are refused until the caller says the unit
        const currency = (model.currency ?? options.defaultCurrency ?? '').toUpperCase();
        if (input === null || output === null || !model.id || !currency) {
            if (model.id)
                unpriced.push(model.id);
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
            ...(model.has_discount ? { note: 'provider 显示处于折扣价，折扣结束后价格会回到 list price' } : {}),
        });
    }
    return {
        catalog: { asOf: options.asOf ?? new Date().toISOString().slice(0, 10), source: options.baseUrl ?? `provider:${options.provider}`, entries },
        priced: entries.length,
        unpriced,
    };
}
export function normalizeOpenAiUsage(usage) {
    const prompt = Math.max(0, usage.prompt_tokens ?? 0);
    const cached = Math.max(0, usage.prompt_tokens_details?.cached_tokens ?? 0);
    return {
        uncachedInput: Math.max(0, prompt - cached),
        cacheRead: Math.min(prompt, cached),
        output: Math.max(0, usage.completion_tokens ?? 0),
        cacheWrite: 0,
    };
}
export function usageCostMicros(usage, entry, at = new Date()) {
    return costOf(normalizeOpenAiUsage(usage), entry, { at }).micros;
}
/**
 * Rank a price sheet by what the remaining credits can actually afford, cheapest
 * first, so "spend what's left where it buys the most" is a computed answer.
 */
export function selectModelsByBudget(catalog, request) {
    const reserve = Math.min(0.95, Math.max(0, request.reserveFraction ?? 0));
    const spendable = request.remainingMicros * (1 - reserve);
    const exclude = new Set(request.exclude ?? []);
    const fits = [];
    for (const entry of catalog.entries) {
        const short = entry.id.includes('/') ? entry.id.slice(entry.id.indexOf('/') + 1) : entry.id;
        if (exclude.has(short) || exclude.has(entry.id))
            continue;
        if (request.candidates?.length && !request.candidates.includes(short) && !request.candidates.includes(entry.id))
            continue;
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
export function pickModelByBudget(catalog, request) {
    const ranking = selectModelsByBudget(catalog, request);
    return { pick: ranking.find((fit) => fit.fits), ranking };
}
export function budgetFromMajor(major) {
    return fromMajor(major);
}
//# sourceMappingURL=provider.js.map