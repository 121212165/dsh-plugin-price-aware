import { type Micros } from './money.ts';
import { type CostBreakdown, type TokenBuckets } from './pricing/cost.ts';
import type { RegimeRules } from './pricing/window.ts';
import type { ResolveResult } from './pricing/resolve.ts';
/**
 * dsh's `assistant/message.usage` counts are DISJOINT by contract: `inputTokens` is
 * uncached input only, and adapters whose providers fold the cache into a single
 * `prompt_tokens` subtract it before publishing. So the ledger never subtracts here —
 * doing so would bill the same tokens short by their cached share and loosen the gate.
 * `inputIncludesCache` exists only for callers feeding raw OpenAI-shaped JSON that has
 * not been through dsh's translation (see normalizeOpenAiUsage in provider.ts).
 */
export interface RawUsage {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}
export interface UsageEvent {
    turn: number;
    step: number;
    usage: RawUsage;
    modelId?: string;
    provider?: string | undefined;
}
export declare function toBuckets(usage: RawUsage, inputIncludesCache?: boolean): TokenBuckets;
export interface LedgerEntry {
    turn: number;
    step: number;
    buckets: TokenBuckets;
    cost: CostBreakdown;
    pricedAs: string;
    at: Date;
    reasoningTokens: number;
}
export interface LedgerTotals {
    micros: Micros;
    buckets: TokenBuckets;
    tokens: number;
    turns: number;
    steps: number;
    /** share of billed input tokens that came from cache */
    cacheHitRate: number;
    costPerTurnMicros: Micros;
    /** tokens billed as output that the user never sees */
    reasoningTokens: number;
    /** in:out:cacheRead split, used to answer "how many more tokens fit in what's left" */
    ratio: {
        uncachedInput: number;
        output: number;
        cacheRead: number;
    };
    unpricedEvents: number;
}
export interface LedgerOptions {
    rules?: RegimeRules;
    inputIncludesCache?: boolean;
    now?: () => Date;
}
/** Accumulates what a session has actually cost, one priced event at a time. */
export declare class Ledger {
    #private;
    readonly entries: LedgerEntry[];
    constructor(price: (event: UsageEvent) => ResolveResult, options?: LedgerOptions);
    record(event: UsageEvent): CostBreakdown | null;
    spentMicros(): Micros;
    spentInTurn(turn: number): Micros;
    totals(): LedgerTotals;
    /** currency of the heaviest-spend entry, which is the one worth showing */
    currency(fallback?: string): string;
}
//# sourceMappingURL=ledger.d.ts.map