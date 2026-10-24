import { sumMicros } from './money.js';
import { costOf, totalTokens } from './pricing/cost.js';
export function toBuckets(usage, inputIncludesCache = false) {
    const cacheRead = Math.max(0, usage.cacheReadTokens ?? 0);
    const rawInput = Math.max(0, usage.inputTokens ?? 0);
    return {
        uncachedInput: inputIncludesCache ? Math.max(0, rawInput - cacheRead) : rawInput,
        cacheRead,
        // reasoning tokens are a subset of output for every provider we know of
        output: Math.max(0, usage.outputTokens ?? 0),
        cacheWrite: Math.max(0, usage.cacheWriteTokens ?? 0),
    };
}
function usage_reasoning(usage) {
    return usage.reasoningTokens ?? 0;
}
/** Accumulates what a session has actually cost, one priced event at a time. */
export class Ledger {
    entries = [];
    #unpriced = 0;
    #price;
    #options;
    constructor(price, options = {}) {
        this.#price = price;
        this.#options = options;
    }
    record(event) {
        const resolved = this.#price(event);
        const at = (this.#options.now ?? (() => new Date()))();
        if (resolved.kind === 'unknown') {
            this.#unpriced++;
            return null;
        }
        const buckets = toBuckets(event.usage, this.#options.inputIncludesCache ?? false);
        const cost = costOf(buckets, resolved.entry, { at, rules: this.#options.rules ?? {} });
        this.entries.push({
            turn: event.turn,
            step: event.step,
            buckets,
            cost,
            pricedAs: resolved.entry.id,
            at,
            reasoningTokens: Math.max(0, usage_reasoning(event.usage)),
        });
        return cost;
    }
    spentMicros() {
        return sumMicros(...this.entries.map((e) => e.cost.micros));
    }
    spentInTurn(turn) {
        return sumMicros(...this.entries.filter((e) => e.turn === turn).map((e) => e.cost.micros));
    }
    totals() {
        const buckets = this.entries.reduce((acc, e) => ({
            uncachedInput: acc.uncachedInput + e.buckets.uncachedInput,
            output: acc.output + e.buckets.output,
            cacheRead: acc.cacheRead + (e.buckets.cacheRead ?? 0),
            cacheWrite: (acc.cacheWrite ?? 0) + (e.buckets.cacheWrite ?? 0),
        }), { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
        const micros = this.spentMicros();
        const turns = new Set(this.entries.map((e) => e.turn));
        const input = buckets.uncachedInput + buckets.cacheRead;
        return {
            micros,
            buckets,
            tokens: totalTokens(buckets),
            turns: turns.size,
            steps: this.entries.length,
            cacheHitRate: input > 0 ? buckets.cacheRead / input : 0,
            costPerTurnMicros: turns.size > 0 ? Math.round(micros / turns.size) : 0,
            reasoningTokens: this.entries.reduce((sum, entry) => sum + entry.reasoningTokens, 0),
            ratio: {
                uncachedInput: buckets.uncachedInput,
                output: buckets.output,
                cacheRead: buckets.cacheRead,
            },
            unpricedEvents: this.#unpriced,
        };
    }
    /** currency of the heaviest-spend entry, which is the one worth showing */
    currency(fallback = 'CNY') {
        const top = [...this.entries].sort((a, b) => b.cost.micros - a.cost.micros)[0];
        return top?.cost.currency ?? fallback;
    }
}
//# sourceMappingURL=ledger.js.map