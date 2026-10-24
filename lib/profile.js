import { costOf } from './pricing/cost.js';
/**
 * What a live call taught us. Everything here was measured in round 2 of the
 * paid test: several models spent 100% of max_tokens on invisible reasoning and
 * returned zero visible characters, and cost per *useful* character varied by
 * three orders of magnitude across the same price sheet.
 */
/** mixed code and Chinese prose averages out at ~2.5 written characters per token */
export const FALLBACK_CHARS_PER_TOKEN = 2.5;
function median(values) {
    if (!values.length)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}
export function profileModels(observations) {
    const grouped = new Map();
    for (const observation of observations) {
        const list = grouped.get(observation.modelId) ?? [];
        list.push(observation);
        grouped.set(observation.modelId, list);
    }
    const profiles = new Map();
    for (const [modelId, list] of grouped) {
        const completion = list.reduce((sum, o) => sum + o.completionTokens, 0);
        const reasoning = list.reduce((sum, o) => sum + o.reasoningTokens, 0);
        const cap = list.reduce((sum, o) => sum + o.requestedMaxTokens, 0);
        const chars = list.map((o) => o.visibleChars);
        const charTotal = chars.reduce((a, b) => a + b, 0);
        const charsPerCompletionToken = completion > 0 ? charTotal / completion : 0;
        const capHitRate = list.length
            ? list.filter((o) => o.requestedMaxTokens > 0 && o.completionTokens >= o.requestedMaxTokens).length / list.length
            : 0;
        profiles.set(modelId, {
            modelId,
            calls: list.length,
            medianActualMicros: Math.round(median(list.map((o) => o.actualMicros))),
            fillRate: cap > 0 ? completion / cap : 0,
            reasoningShare: completion > 0 ? reasoning / completion : 0,
            visibleChars: Math.round(median(chars)),
            charsPerCompletionToken: Number(charsPerCompletionToken.toFixed(3)),
            capHitRate,
            selfFinishedRate: Number((1 - capHitRate).toFixed(3)),
            // every cent this model was charged goes into the numerator, including the calls
            // that billed a full cap and returned no text: hiding them makes a silently
            // useless model look like a cheap one
            microPerKiloChar: charTotal > 0 ? Math.round(list.reduce((sum, o) => sum + o.actualMicros, 0) / (charTotal / 1000)) : null,
            starving: charTotal === 0,
        });
    }
    return profiles;
}
export function rankByUsableCost(catalog, profiles, options) {
    const promptTokens = options.promptTokens ?? 0;
    return catalog
        .map((entry) => {
        const short = entry.id.includes('/') ? entry.id.slice(entry.id.indexOf('/') + 1) : entry.id;
        const profile = profiles.get(short) ?? null;
        if (!profile) {
            // never observed: assume the output is real code and let it prove itself
            const tokens = Math.ceil(options.wantChars / 2.5);
            const estMicros = costOf({ uncachedInput: promptTokens, output: tokens, cacheRead: 0 }, entry, {}).micros;
            return { modelId: short, entry, profile, estMicros, estVisibleChars: null, fits: estMicros <= options.remainingMicros };
        }
        const usableShare = 1 - profile.reasoningShare;
        if (usableShare <= 0.05) {
            return { modelId: short, entry, profile, estMicros: null, estVisibleChars: 0, fits: false };
        }
        // a model that has already run into its cap is not done talking; give it room
        // same yield assumption as recommendMaxTokens: a model that has been observed
        // producing text is priced on that measurement, not on a generic constant
        const charsPerToken = profile.charsPerCompletionToken > 0 ? profile.charsPerCompletionToken : FALLBACK_CHARS_PER_TOKEN;
        const tokensForWant = Math.ceil((options.wantChars / charsPerToken) * (1 + (profile.capHitRate ?? 0)));
        const estMicros = costOf({ uncachedInput: promptTokens, output: tokensForWant, cacheRead: 0 }, entry, {}).micros;
        return {
            modelId: short,
            entry,
            profile,
            estMicros,
            estVisibleChars: Math.round(tokensForWant * charsPerToken * usableShare),
            fits: estMicros <= options.remainingMicros,
        };
    })
        .sort((a, b) => {
        if (a.fits !== b.fits)
            return a.fits ? -1 : 1;
        const aCost = a.profile?.microPerKiloChar ?? a.estMicros ?? Number.MAX_SAFE_INTEGER;
        const bCost = b.profile?.microPerKiloChar ?? b.estMicros ?? Number.MAX_SAFE_INTEGER;
        if (a.profile && !b.profile)
            return -1;
        if (!a.profile && b.profile)
            return 1;
        return aCost - bCost;
    });
}
/**
 * Size max_tokens from what this model actually spends, so a request stops being a
 * lottery where the whole budget goes to hidden reasoning. `wantChars` is the
 * visible body you expect back.
 */
/**
 * Size max_tokens from what this model actually yields, so a request stops being a
 * lottery where the whole budget goes to hidden reasoning. `wantChars` is the
 * visible body you expect back. A model that returns ~0.01 chars per completion
 * token needs an absurd cap to say 4000 characters — and the honest answer is
 * usually "do not use it for this", which rankByUsableCost already encodes.
 */
export function recommendMaxTokens(profile, wantChars, options = {}) {
    const safety = options.safety ?? 1.35;
    const ceiling = options.ceiling ?? 64_000;
    // mixed code + Chinese prose averages out at ~2.5 written characters per token
    const observed = profile?.charsPerCompletionToken;
    const rate = observed && observed > 0 ? observed : 2.5;
    const capPenalty = profile ? 1 + profile.capHitRate : 1;
    return Math.min(ceiling, Math.max(200, Math.round((wantChars / rate) * safety * capPenalty)));
}
/**
 * When a model runs to its cap, doubling the cap is not a quote — it is an
 * experiment. Round 4 proved that: 4320 -> 6263 and the model filled every token
 * again. So escalate until it stops on its own, and charge honestly for each
 * attempt that failed to finish.
 */
export function escalateCap(currentCap, ceiling = 64_000) {
    const next = Math.min(ceiling, Math.round(currentCap * 2));
    return next > currentCap ? next : null;
}
/** Say out loud when the number about to be shown is not actually a bound. */
export function quoteTrust(profile) {
    if (!profile)
        return { label: '首次调用该模型，报价只是按平均产出猜的', boundIsReal: false };
    if (profile.selfFinishedRate < 0.34) {
        return {
            label: `该模型 ${Math.round(profile.capHitRate * 100)}% 的调用会写满上限——下面的数是下限，不是上限`,
            boundIsReal: false,
        };
    }
    return { label: `该模型 ${Math.round(profile.selfFinishedRate * 100)}% 的调用会自己收尾，报价可当上限看`, boundIsReal: true };
}
//# sourceMappingURL=profile.js.map