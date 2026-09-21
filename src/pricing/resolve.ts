import type { PriceCatalog, PriceEntry } from './catalog.ts';

export type MatchVia = 'exact' | 'provider-scoped' | 'alias' | 'normalized' | 'contains';

export type ResolveResult =
  | { kind: 'known'; entry: PriceEntry; via: MatchVia; confidence: number }
  | { kind: 'unknown'; modelId: string; candidates: { entry: PriceEntry; score: number }[] };

const CONFIDENCE: Record<MatchVia, number> = {
  exact: 1,
  'provider-scoped': 1,
  alias: 0.95,
  normalized: 0.85,
  contains: 0.5,
};

/** lowercases, unifies separators, and drops a trailing date/digest segment */
export function normalizeModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[_\s.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/-(?:\d{6,8}|\d{2}\d{2}|\d{4}|v\d+(?:\.\d+)*)$/g, '')
    .replace(/-+$/g, '');
}

function overlap(needle: string, hay: string): number {
  if (!needle || !hay) return 0;
  if (hay === needle) return 1;
  if (hay.includes(needle) || needle.includes(hay)) return 0.6;
  const a = new Set(needle.split('-'));
  const b = new Set(hay.split('-'));
  let hits = 0;
  for (const token of a) if (b.has(token)) hits++;
  return hits / Math.max(a.size, b.size);
}

function known(entry: PriceEntry, via: MatchVia, confidence = CONFIDENCE[via]): ResolveResult {
  return { kind: 'known', entry, via, confidence };
}

export function resolveModel(
  modelId: string,
  catalog: PriceCatalog,
  options: { provider?: string } = {},
): ResolveResult {
  const raw = modelId.trim();
  const lower = raw.toLowerCase();
  const normalized = normalizeModelId(raw);
  const provider = options.provider?.toLowerCase();
  const scoped = provider ? `${provider}/${normalized}` : undefined;
  const near: { entry: PriceEntry; score: number }[] = [];

  // A row written as `jiyuan/deepseek-v4-flash` only answers requests from that provider,
  // and it answers them before any generic row gets a chance to mis-price the call.
  if (scoped) {
    for (const entry of catalog.entries) {
      const id = normalizeModelId(entry.id);
      if (entry.id.toLowerCase() === `${provider}/${lower}` || id === scoped) return known(entry, 'provider-scoped');
      for (const alias of entry.aliases ?? []) {
        if (normalizeModelId(alias) === scoped || alias.toLowerCase() === `${provider}/${lower}`) {
          return known(entry, 'provider-scoped');
        }
      }
    }
  }

  const rawLower = lower;
  for (const entry of catalog.entries) {
    const id = entry.id.toLowerCase();
    const aliases = (entry.aliases ?? []).map((a) => a.toLowerCase());

    if (id === rawLower) return known(entry, 'exact');
    if (aliases.includes(rawLower)) return known(entry, 'alias');
    if (id === normalized || aliases.includes(normalized)) return known(entry, 'normalized');
    if (normalizeModelId(id) === normalized) return known(entry, 'normalized');
    for (const alias of aliases) {
      if (normalizeModelId(alias) === normalized) return known(entry, 'normalized');
    }

    const score = Math.max(overlap(normalized, normalizeModelId(id)), ...aliases.map((a) => overlap(normalized, normalizeModelId(a))));
    if (score >= 0.5) near.push({ entry, score });
  }

  const best = near.sort((a, b) => b.score - a.score)[0];
  if (best && best.score >= 0.6) return known(best.entry, 'contains', Math.min(CONFIDENCE.contains, best.score));
  return { kind: 'unknown', modelId: raw, candidates: best ? [best] : [] };
}

export function describeResolution(result: ResolveResult): string {
  if (result.kind === 'known') {
    const caveat = result.confidence < 0.9 ? `（按 ${result.entry.id} 价目估算，匹配方式 ${result.via}，建议核对）` : '';
    return `${result.entry.id}${caveat}`;
  }
  const hint = result.candidates.length
    ? `最接近 ${result.candidates.map((c) => c.entry.id).join(' / ')}`
    : '价表中无相近模型';
  return `未知模型 ${result.modelId}（${hint}）`;
}
