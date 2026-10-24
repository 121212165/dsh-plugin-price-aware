import type { Micros } from './money.ts';
import { type CostBreakdown, type TokenBuckets } from './pricing/cost.ts';
import type { PriceEntry } from './pricing/catalog.ts';
import type { RegimeRules } from './pricing/window.ts';
export type TaskKind = 'answer' | 'small-edit' | 'refactor' | 'test-fix-loop' | 'greenfield' | 'bulk-read';
/** code is mostly ASCII, so a written character costs well under a full token */
export declare const OUTPUT_TOKENS_PER_CHAR = 0.28;
/** CJK costs roughly a token per glyph, Latin about a token per 4 characters. */
export declare function tokensForText(text: string): number;
export interface TaskShape {
    kind: TaskKind;
    /** agent steps expected; defaults per kind */
    turns?: number | undefined;
    /** tokens that ride along on every turn: system prompt, tool schemas, conversation history */
    residentTokens?: number | undefined;
    /** new tokens pulled in per turn from files/search results */
    growthTokensPerTurn?: number;
    /** characters the agent will write out (code, patches, prose) */
    charsWritten?: number | undefined;
}
export interface EstimateOptions {
    /** share of the repeated prompt the provider serves from cache (DeepSeek prefixes are auto-cached) */
    cacheableShare?: number;
    /** overhead of reasoning + tool-call JSON on every turn */
    perTurnOutputTokens?: number;
    /** multiplicative correction learned from this repo's history */
    calibration?: number;
}
export interface Estimate {
    buckets: TokenBuckets;
    turns: number;
    errorPct: number;
    drivers: string[];
}
export declare function estimateTask(shape: TaskShape, options?: EstimateOptions): Estimate;
export declare function priceEstimate(estimate: Estimate, entry: PriceEntry, options?: {
    at?: Date;
    rules?: RegimeRules;
}): CostBreakdown;
/**
 * A single shot has no agent history to model: its input is literally the text you
 * are about to send. Measuring it beats guessing it, which is why the live test
 * over-predicted by ~40% until this existed.
 */
export declare function estimateCall(messages: {
    role: string;
    content: string;
}[], maxTokens: number, options?: {
    cacheHitRate?: number;
    reasoningShare?: number;
}): Estimate;
export type TierId = 'minimal' | 'standard' | 'thorough';
export interface TierPlan {
    id: TierId;
    label: string;
    whatYouGet: string;
    estimate: Estimate;
    cost: CostBreakdown;
}
export declare function buildTiers(shape: TaskShape, entry: PriceEntry, options?: EstimateOptions & {
    at?: Date;
    rules?: RegimeRules;
}): TierPlan[];
/** A ±50% guess is only worth money when the bill is big, so recon is gated by cost. */
export declare function shouldRecon(estimate: Estimate, entry: PriceEntry, thresholdMicros: Micros, at?: Date): boolean;
/** The read-only recon pass itself: it reads, never writes, and its own bill is small by design. */
export declare function reconEstimate(shape: TaskShape, options?: EstimateOptions): Estimate;
export declare function reconCost(recon: Estimate, entry: PriceEntry, at?: Date): Micros;
export interface CalibrationSample {
    predicted: Micros;
    actual: Micros;
}
export interface Calibration {
    /** multiply future predictions by this to remove the learned bias */
    bias: number;
    /** mean |predicted - actual| / predicted — how much headroom the quote wasted */
    mape: number;
    /** mean (predicted - actual) / predicted: >0 means the quote is an upper bound */
    headroom: number;
    /** worst single overestimate, as a multiple of what was actually billed */
    worstOver: number;
    n: number;
}
/** How wrong have we been on this kind of task, and what factor fixes it. */
export declare function calibrate(samples: CalibrationSample[]): Calibration;
//# sourceMappingURL=estimate.d.ts.map