import type { Currency } from '../money.ts';

export interface PricePerMillion {
  /** input tokens served from prompt cache */
  cacheRead: number;
  /** input tokens not served from cache */
  uncachedInput: number;
  output: number;
  /** undefined/0 = cache writes are billed as plain input (DeepSeek behaves this way) */
  cacheWrite?: number;
}

export interface PriceEntry {
  id: string;
  currency: Currency;
  /** off-peak prices; `peakMultiplier` scales them during billable peak hours */
  perMillion: PricePerMillion;
  peakMultiplier?: number;
  contextTokens: number;
  maxOutputTokens: number;
  aliases?: string[];
  /** a relay/reseller endpoint whose price we guessed at rather than read from a price sheet */
  lowConfidence?: boolean;
  note?: string;
}

export interface PriceCatalog {
  asOf: string;
  source: string;
  entries: PriceEntry[];
}

export const CATALOG_STALE_AFTER_DAYS = 45;

/**
 * Snapshot of https://api-docs.deepseek.com/quick_start/pricing taken 2026-09-21.
 * Peak = off-peak x2; peak hours are Beijing workday 09:00-12:00 and 14:00-18:00.
 * Keep this fresh: `dsh-price refresh` prints what the live page says.
 */
export const DEEPSEEK_CATALOG: PriceCatalog = {
  asOf: '2026-09-21',
  source: 'https://api-docs.deepseek.com/quick_start/pricing',
  entries: [
    {
      id: 'deepseek-flash',
      currency: 'CNY',
      perMillion: { cacheRead: 0.02, uncachedInput: 1, output: 4 },
      peakMultiplier: 2,
      contextTokens: 1_000_000,
      maxOutputTokens: 384_000,
      aliases: ['deepseek-chat', 'deepseek-v4-flash'],
    },
    {
      id: 'deepseek-v4-pro',
      currency: 'CNY',
      perMillion: { cacheRead: 0.15, uncachedInput: 4.5, output: 13.5 },
      peakMultiplier: 2,
      contextTokens: 1_000_000,
      maxOutputTokens: 384_000,
      aliases: ['deepseek-reasoner', 'deepseek-pro'],
    },
  ],
};

export function mergeCatalog(base: PriceCatalog, overrides: PriceEntry[] = []): PriceCatalog {
  const byId = new Map<string, PriceEntry>();
  for (const entry of base.entries) byId.set(entry.id, entry);
  for (const entry of overrides) {
    const prev = byId.get(entry.id);
    if (!prev) {
      byId.set(entry.id, entry);
      continue;
    }
    // A user row that says "this model costs 4.5 in / 13.5 out" is a price edit, not a
    // declaration that the model has no peak multiplier. Spreading the row wholesale
    // silently turned peak billing off and under-charged by 2x.
    byId.set(entry.id, {
      ...prev,
      ...entry,
      currency: entry.currency ?? prev.currency,
      peakMultiplier: entry.peakMultiplier ?? prev.peakMultiplier,
      contextTokens: entry.contextTokens ?? prev.contextTokens,
      maxOutputTokens: entry.maxOutputTokens ?? prev.maxOutputTokens,
      aliases: entry.aliases?.length ? entry.aliases : prev.aliases,
      perMillion: { ...prev.perMillion, ...sparse(entry.perMillion) },
    });
  }
  return { ...base, entries: [...byId.values()] };
}

/** drop undefined so an absent field cannot overwrite a known one */
function sparse(values: Partial<PricePerMillion> = {}): Partial<PricePerMillion> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<PricePerMillion>;
}

export function catalogAgeDays(asOf: string, now: Date = new Date()): number {
  const then = Date.parse(asOf);
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

export function isCatalogStale(catalog: PriceCatalog, now: Date = new Date()): boolean {
  return catalogAgeDays(catalog.asOf, now) > CATALOG_STALE_AFTER_DAYS;
}
