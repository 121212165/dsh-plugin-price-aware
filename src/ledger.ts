import { sumMicros, type Micros } from './money.ts';
import { costOf, totalTokens, type CostBreakdown, type TokenBuckets } from './pricing/cost.ts';
import type { PriceEntry } from './pricing/catalog.ts';
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
  provider?: string;
}

export function toBuckets(usage: RawUsage, inputIncludesCache = false): TokenBuckets {
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

function usage_reasoning(usage: RawUsage): number {
  return usage.reasoningTokens ?? 0;
}

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
  ratio: { uncachedInput: number; output: number; cacheRead: number };
  unpricedEvents: number;
}

export interface LedgerOptions {
  rules?: RegimeRules;
  inputIncludesCache?: boolean;
  now?: () => Date;
}

/** Accumulates what a session has actually cost, one priced event at a time. */
export class Ledger {
  readonly entries: LedgerEntry[] = [];
  #unpriced = 0;
  #price: (event: UsageEvent) => ResolveResult;
  #options: LedgerOptions;

  constructor(price: (event: UsageEvent) => ResolveResult, options: LedgerOptions = {}) {
    this.#price = price;
    this.#options = options;
  }

  record(event: UsageEvent): CostBreakdown | null {
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

  spentMicros(): Micros {
    return sumMicros(...this.entries.map((e) => e.cost.micros));
  }

  spentInTurn(turn: number): Micros {
    return sumMicros(...this.entries.filter((e) => e.turn === turn).map((e) => e.cost.micros));
  }

  totals(): LedgerTotals {
    const buckets = this.entries.reduce<TokenBuckets>(
      (acc, e) => ({
        uncachedInput: acc.uncachedInput + e.buckets.uncachedInput,
        output: acc.output + e.buckets.output,
        cacheRead: acc.cacheRead + (e.buckets.cacheRead ?? 0),
        cacheWrite: (acc.cacheWrite ?? 0) + (e.buckets.cacheWrite ?? 0),
      }),
      { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
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
  currency(fallback = 'CNY'): string {
    const top = [...this.entries].sort((a, b) => b.cost.micros - a.cost.micros)[0];
    return top?.cost.currency ?? fallback;
  }
}
