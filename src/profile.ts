import type { Micros } from './money.ts';
import type { PriceEntry } from './pricing/catalog.ts';
import { costOf } from './pricing/cost.ts';

/**
 * What a live call taught us. Everything here was measured in round 2 of the
 * paid test: several models spent 100% of max_tokens on invisible reasoning and
 * returned zero visible characters, and cost per *useful* character varied by
 * three orders of magnitude across the same price sheet.
 */
/** mixed code and Chinese prose averages out at ~2.5 written characters per token */
export const FALLBACK_CHARS_PER_TOKEN = 2.5;

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

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

export function profileModels(observations: CallObservation[]): Map<string, ModelProfile> {
  const grouped = new Map<string, CallObservation[]>();
  for (const observation of observations) {
    const list = grouped.get(observation.modelId) ?? [];
    list.push(observation);
    grouped.set(observation.modelId, list);
  }
  const profiles = new Map<string, ModelProfile>();
  for (const [modelId, list] of grouped) {
    const completion = list.reduce((sum, o) => sum + o.completionTokens, 0);
    const reasoning = list.reduce((sum, o) => sum + o.reasoningTokens, 0);
    const cap = list.reduce((sum, o) => sum + o.requestedMaxTokens, 0);
    const chars = list.map((o) => o.visibleChars);
    const charTotal = chars.reduce((a, b) => a + b, 0);
    const charsPerCompletionToken = completion > 0 ? charTotal / completion : 0;
    const billed = list.filter((o) => o.visibleChars > 0);
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

export function rankByUsableCost(
  catalog: PriceEntry[],
  profiles: Map<string, ModelProfile>,
  options: { wantChars: number; remainingMicros: Micros; promptTokens?: number },
): UsableFit[] {
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
      if (a.fits !== b.fits) return a.fits ? -1 : 1;
      const aCost = a.profile?.microPerKiloChar ?? a.estMicros ?? Number.MAX_SAFE_INTEGER;
      const bCost = b.profile?.microPerKiloChar ?? b.estMicros ?? Number.MAX_SAFE_INTEGER;
      if (a.profile && !b.profile) return -1;
      if (!a.profile && b.profile) return 1;
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
export function recommendMaxTokens(
  profile: ModelProfile | null,
  wantChars: number,
  options: { safety?: number; ceiling?: number } = {},
): number {
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
export function escalateCap(currentCap: number, ceiling = 64_000): number | null {
  const next = Math.min(ceiling, Math.round(currentCap * 2));
  return next > currentCap ? next : null;
}

/** Say out loud when the number about to be shown is not actually a bound. */
export function quoteTrust(profile: ModelProfile | null): { label: string; boundIsReal: boolean } {
  if (!profile) return { label: '首次调用该模型，报价只是按平均产出猜的', boundIsReal: false };
  if (profile.selfFinishedRate < 0.34) {
    return {
      label: `该模型 ${Math.round(profile.capHitRate * 100)}% 的调用会写满上限——下面的数是下限，不是上限`,
      boundIsReal: false,
    };
  }
  return { label: `该模型 ${Math.round(profile.selfFinishedRate * 100)}% 的调用会自己收尾，报价可当上限看`, boundIsReal: true };
}
