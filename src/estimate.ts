import type { Micros } from './money.ts';
import { costOf, type CostBreakdown, type TokenBuckets } from './pricing/cost.ts';
import type { PriceEntry } from './pricing/catalog.ts';
import type { RegimeRules } from './pricing/window.ts';

export type TaskKind = 'answer' | 'small-edit' | 'refactor' | 'test-fix-loop' | 'greenfield' | 'bulk-read';

/** code is mostly ASCII, so a written character costs well under a full token */
export const OUTPUT_TOKENS_PER_CHAR = 0.28;

const CJK = /[　-〿一-鿿㐀-䶿豈-﫿぀-ヿ가-힯＀-￯]/g;

/** CJK costs roughly a token per glyph, Latin about a token per 4 characters. */
export function tokensForText(text: string): number {
  const cjk = (text.match(CJK) ?? []).length;
  return Math.round(cjk * 0.7 + (text.length - cjk) * 0.25);
}

export interface TaskShape {
  kind: TaskKind;
  /** agent steps expected; defaults per kind */
  turns?: number;
  /** tokens that ride along on every turn: system prompt, tool schemas, conversation history */
  residentTokens?: number;
  /** new tokens pulled in per turn from files/search results */
  growthTokensPerTurn?: number;
  /** characters the agent will write out (code, patches, prose) */
  charsWritten?: number;
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

const KIND_DEFAULTS: Record<TaskKind, { turns: number; growth: number; written: number; errorPct: number }> = {
  answer: { turns: 2, growth: 6_000, written: 1_500, errorPct: 60 },
  'small-edit': { turns: 5, growth: 9_000, written: 2_000, errorPct: 45 },
  refactor: { turns: 14, growth: 12_000, written: 7_000, errorPct: 40 },
  'test-fix-loop': { turns: 22, growth: 10_000, written: 6_000, errorPct: 50 },
  greenfield: { turns: 18, growth: 8_000, written: 16_000, errorPct: 55 },
  'bulk-read': { turns: 8, growth: 26_000, written: 1_200, errorPct: 35 },
};

export function estimateTask(shape: TaskShape, options: EstimateOptions = {}): Estimate {
  const base = KIND_DEFAULTS[shape.kind];
  const turns = Math.max(1, shape.turns ?? base.turns);
  const resident = Math.max(0, shape.residentTokens ?? 12_000);
  const growth = shape.growthTokensPerTurn ?? base.growth;
  const perTurnOutput = options.perTurnOutputTokens ?? 420;
  const cacheable = clamp01(options.cacheableShare ?? 0.72);
  const calibration = options.calibration ?? 1;

  // Each turn re-sends everything before it: turn t carries resident + (t-1) * growth.
  const promptTokens = turns * resident + (growth * turns * (turns - 1)) / 2;
  const cacheRead = Math.round(promptTokens * cacheable);
  const uncachedInput = Math.round((promptTokens - cacheRead) * calibration);
  const output = Math.round((shape.charsWritten ?? base.written) * OUTPUT_TOKENS_PER_CHAR + turns * perTurnOutput);
  const drivers = [
    `${turns} 轮 × 约 ${Math.round(resident + (growth * (turns - 1)) / 2).toLocaleString()} token 常驻上下文 = ${Math.round(
      (promptTokens / (promptTokens + output)) * 100,
    )}% 的 token 是重复发送历史，其中 ${Math.round(cacheable * 100)}% 走缓存价`,
    `输出约 ${output.toLocaleString()} token（写 ${shape.charsWritten ?? base.written} 字符 + 每轮 ${perTurnOutput} token 推理/工具调用）`,
  ];
  if (calibration !== 1) drivers.push(`按历史同类任务校准 ×${calibration.toFixed(2)}`);

  return {
    buckets: { uncachedInput, cacheRead, output, cacheWrite: 0 },
    turns,
    errorPct: base.errorPct,
    drivers,
  };
}

export function priceEstimate(
  estimate: Estimate,
  entry: PriceEntry,
  options: { at?: Date; rules?: RegimeRules } = {},
): CostBreakdown {
  return costOf(estimate.buckets, entry, options);
}

/**
 * A single shot has no agent history to model: its input is literally the text you
 * are about to send. Measuring it beats guessing it, which is why the live test
 * over-predicted by ~40% until this existed.
 */
export function estimateCall(
  messages: { role: string; content: string }[],
  maxTokens: number,
  options: { cacheHitRate?: number; reasoningShare?: number } = {},
): Estimate {
  const chars = messages.reduce((sum, message) => sum + message.content.length, 0);
  const cacheHitRate = clamp01(options.cacheHitRate ?? 0);
  const prompt = tokensForText(messages.map((message) => message.content).join('\n'));
  const billedOutput = Math.round(maxTokens * (options.reasoningShare == null ? 1 : 1 + options.reasoningShare));
  return {
    buckets: {
      uncachedInput: Math.round(prompt * (1 - cacheHitRate)),
      cacheRead: Math.round(prompt * cacheHitRate),
      output: billedOutput,
      cacheWrite: 0,
    },
    turns: 1,
    // the guess that remains is how much of max_tokens the model actually spends
    errorPct: 35,
    drivers: [
      `${chars} 字符输入 ≈ ${prompt.toLocaleString()} token${cacheHitRate > 0 ? `（按观测到的 ${(cacheHitRate * 100).toFixed(0)}% 缓存命中拆分）` : '，全部按未命中计'}`,
      `上限 ${maxTokens.toLocaleString()} 输出 token${
        options.reasoningShare ? `，其中约 ${Math.round((options.reasoningShare / (1 + options.reasoningShare)) * 100)}% 可能是看不见的推理 token` : ''
      }`,
    ],
  };
}

export type TierId = 'minimal' | 'standard' | 'thorough';

export interface TierPlan {
  id: TierId;
  label: string;
  whatYouGet: string;
  estimate: Estimate;
  cost: CostBreakdown;
}

const TIERS: Record<TierId, { label: string; turns: number; growth: number; written: number; extra: number; whatYouGet: string }> = {
  minimal: {
    label: 'A 最小可用',
    turns: 0.4,
    growth: 0.6,
    written: 0.3,
    extra: 0,
    whatYouGet: '只动会影响正确性的地方，不跑测试、不改风格、不留注释',
  },
  standard: {
    label: 'B 达标',
    turns: 1,
    growth: 1,
    written: 1,
    extra: 0,
    whatYouGet: '按需求做完并自测关键路径，符合仓库现有写法',
  },
  thorough: {
    label: 'C 彻底',
    turns: 2.1,
    growth: 1.35,
    written: 1.6,
    extra: 12,
    whatYouGet: 'B 的全部 + 跑全量测试修失败 + 补边界与注释 + 回归复查',
  },
};

export function buildTiers(
  shape: TaskShape,
  entry: PriceEntry,
  options: EstimateOptions & { at?: Date; rules?: RegimeRules } = {},
): TierPlan[] {
  return (['minimal', 'standard', 'thorough'] as TierId[]).map((id) => {
    const t = TIERS[id];
    const base = KIND_DEFAULTS[shape.kind];
    const estimate = estimateTask(
      {
        ...shape,
        turns: Math.max(1, Math.round((shape.turns ?? base.turns) * t.turns) + t.extra),
        growthTokensPerTurn: Math.round((shape.growthTokensPerTurn ?? base.growth) * t.growth),
        charsWritten: Math.round((shape.charsWritten ?? base.written) * t.written),
      },
      options,
    );
    estimate.errorPct = Math.round(base.errorPct * (id === 'thorough' ? 1.25 : 1));
    return {
      id,
      label: t.label,
      whatYouGet: t.whatYouGet,
      estimate,
      cost: priceEstimate(estimate, entry, options),
    };
  });
}

/** A ±50% guess is only worth money when the bill is big, so recon is gated by cost. */
export function shouldRecon(estimate: Estimate, entry: PriceEntry, thresholdMicros: Micros, at?: Date): boolean {
  return priceEstimate(estimate, entry, { at }).micros >= thresholdMicros;
}

/** The read-only recon pass itself: it reads, never writes, and its own bill is small by design. */
export function reconEstimate(shape: TaskShape, options: EstimateOptions = {}): Estimate {
  const est = estimateTask(
    {
      kind: 'bulk-read',
      turns: Math.max(1, Math.min(6, Math.round((shape.turns ?? KIND_DEFAULTS[shape.kind].turns) * 0.25))),
      // a subagent starts its own context; inheriting the parent's would make the estimate
      // more expensive than the work it is supposed to be pricing
      residentTokens: Math.min(8_000, shape.residentTokens ?? 8_000),
      growthTokensPerTurn: Math.round((shape.growthTokensPerTurn ?? KIND_DEFAULTS[shape.kind].growth) * 1.4),
      charsWritten: 900,
    },
    { ...options, cacheableShare: 0.3, perTurnOutputTokens: 260 },
  );
  est.errorPct = 12;
  return est;
}

export function reconCost(recon: Estimate, entry: PriceEntry, at?: Date): Micros {
  return priceEstimate(recon, entry, { at }).micros;
}

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
export function calibrate(samples: CalibrationSample[]): Calibration {
  const usable = samples.filter((s) => s.predicted > 0 && s.actual > 0);
  if (usable.length === 0) return { bias: 1, mape: 0, headroom: 0, worstOver: 1, n: 0 };
  const ratios = usable.map((s) => s.actual / s.predicted).sort((a, b) => a - b);
  const median = ratios[Math.floor((ratios.length - 1) / 2)] ?? 1;
  const relative = usable.map((s) => Math.abs(s.predicted - s.actual) / s.predicted);
  const signed = usable.map((s) => (s.predicted - s.actual) / s.predicted);
  const worstOver = Math.max(...usable.map((s) => s.predicted / s.actual));
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  return {
    bias: Number(median.toFixed(3)),
    mape: Math.round(mean(relative) * 100),
    headroom: Math.round(mean(signed) * 100),
    worstOver: Number(worstOver.toFixed(1)),
    n: usable.length,
  };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
