import type { Micros } from './money.ts';
import type { PriceEntry } from './pricing/catalog.ts';
/**
 * What a live call taught us. Everything here was measured in round 2 of the
 * paid test: several models spent 100% of max_tokens on invisible reasoning and
 * returned zero visible characters, and cost per *useful* character varied by
 * three orders of magnitude across the same price sheet.
 */
/** mixed code and Chinese prose averages out at ~2.5 written characters per token */
export declare const FALLBACK_CHARS_PER_TOKEN = 2.5;
export interface CallObservation {
    modelId: string;
    actualMicros: Micros;
    promptTokens: number;
    completionTokens: number;
    requestedMaxTokens: number;
    reasoningTokens: number;
    visibleChars: number;
}
export interface ModelProfile {
    modelId: string;
    calls: number;
    medianActualMicros: Micros;
    /** completion_tokens / max_completion_tokens, i.e. how much of the cap gets used */
    fillRate: number;
    /** share of completion tokens that are reasoning and therefore invisible */
    reasoningShare: number;
    /** median visible characters per call */
    visibleChars: number;
    /** how much readable text one completion token actually yields (0 when it only thinks) */
    charsPerCompletionToken: number;
    /** what 1000 characters of readable output costs, or null if this model has never produced any */
    microPerKiloChar: number | null;
    /** true when every call so far came back with an empty body */
    starving: boolean;
    /** share of calls that spent exactly the cap they were given, i.e. were cut off mid-sentence */
    capHitRate: number;
    /** 1 - capHitRate: how often this model stops on its own, which is the only honest signal that a quote meant anything */
    selfFinishedRate: number;
}
export declare function profileModels(observations: CallObservation[]): Map<string, ModelProfile>;
/**
 * "花同样的钱，谁能真的把字写出来" — the ranking a budget should use.
 * Unknown models are placed after observed ones, never before them.
 */
export interface UsableFit {
    modelId: string;
    entry: PriceEntry;
    profile: ModelProfile | null;
    estMicros: Micros | null;
    estVisibleChars: number | null;
    fits: boolean;
}
export declare function rankByUsableCost(catalog: PriceEntry[], profiles: Map<string, ModelProfile>, options: {
    wantChars: number;
    remainingMicros: Micros;
    promptTokens?: number;
}): UsableFit[];
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
export declare function recommendMaxTokens(profile: ModelProfile | null, wantChars: number, options?: {
    safety?: number;
    ceiling?: number;
}): number;
/**
 * When a model runs to its cap, doubling the cap is not a quote — it is an
 * experiment. Round 4 proved that: 4320 -> 6263 and the model filled every token
 * again. So escalate until it stops on its own, and charge honestly for each
 * attempt that failed to finish.
 */
export declare function escalateCap(currentCap: number, ceiling?: number): number | null;
/** Say out loud when the number about to be shown is not actually a bound. */
export declare function quoteTrust(profile: ModelProfile | null): {
    label: string;
    boundIsReal: boolean;
};
//# sourceMappingURL=profile.d.ts.map