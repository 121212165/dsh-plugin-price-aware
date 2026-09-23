import { formatMoney, type Micros } from './money.ts';
import { blendedPricePerMillion, regimeFor, tokensWithinBudget, type TokenBuckets } from './pricing/cost.ts';
import type { PriceEntry } from './pricing/catalog.ts';
import { deferralAdvice, formatDuration, type RegimeRules } from './pricing/window.ts';

export type BudgetMode = 'economy' | 'normal' | 'max' | 'custom';

export interface BudgetPolicy {
  mode: BudgetMode;
  /** hard ceiling for this session; Number.POSITIVE_INFINITY = uncapped */
  sessionCapMicros: Micros;
  /** spending this fraction of the cap is when we stop and ask */
  warnFraction: number;
  /** a single task estimated above this gets a pre-flight ask even when the session is young */
  taskSoftCapMicros: Micros;
  /** stop early so the account never hits a hard 402 */
  balanceFloorMicros: Micros;
}

export const MODE_PRESETS: Record<Exclude<BudgetMode, 'custom'>, Omit<BudgetPolicy, 'mode'>> = {
  economy: { sessionCapMicros: 2_000_000, warnFraction: 0.6, taskSoftCapMicros: 400_000, balanceFloorMicros: 1_000_000 },
  normal: { sessionCapMicros: 10_000_000, warnFraction: 0.75, taskSoftCapMicros: 1_500_000, balanceFloorMicros: 3_000_000 },
  max: { sessionCapMicros: Number.POSITIVE_INFINITY, warnFraction: 1, taskSoftCapMicros: Number.POSITIVE_INFINITY, balanceFloorMicros: 0 },
};

export function preset(mode: Exclude<BudgetMode, 'custom'>): BudgetPolicy {
  return { mode, ...MODE_PRESETS[mode] };
}

export interface GateInput {
  spentMicros: Micros;
  /** what the next chunk of work is estimated to cost; 0 when unknown */
  projectedMicros: Micros;
  entry: PriceEntry;
  /** cheaper entry to fall back to, if the session can switch models */
  downgradeTo?: PriceEntry;
  balanceMicros?: Micros | null;
  ratio: TokenBuckets;
  policy: BudgetPolicy;
  rules?: RegimeRules;
  now?: Date;
}

export interface GateOption {
  id: 'continue' | 'downgrade' | 'narrow' | 'defer' | 'raise' | 'stop';
  label: string;
  detail: string;
  costMicros: Micros | null;
  savingMicros?: Micros;
}

export type GateDecision =
  | { kind: 'allow'; headline: string }
  | { kind: 'ask'; headline: string; options: GateOption[] }
  | { kind: 'block'; headline: string; options: GateOption[] };

const NARROW_FACTOR = 0.35;

function blend(entry: PriceEntry, ratio: TokenBuckets, now: Date, rules: RegimeRules): number {
  const regime = regimeFor(entry, now, rules);
  return blendedPricePerMillion(
    entry,
    { input: ratio.uncachedInput, output: ratio.output, cacheRead: ratio.cacheRead ?? 0 },
    regime,
  );
}

/**
 * The one decision the plugin makes every time money is about to leave the account:
 * say nothing, ask a single question, or refuse.
 */
export function decide(input: GateInput): GateDecision {
  const now = input.now ?? new Date();
  const rules = input.rules ?? {};
  const { policy } = input;
  const currency = input.entry.currency;
  const projected = input.projectedMicros;
  const after = input.spentMicros + projected;

  // NaN slips in from a bad price row or an unpriced event; every comparison below
  // would then be false and the gate would report "within budget" for an unknown spend
  if (!Number.isFinite(input.spentMicros) || !Number.isFinite(projected)) {
    return {
      kind: 'ask',
      headline: `账本算不出总额（已花 ${input.spentMicros}，本步预计 ${projected}），先问一句再花`,
      options: [
        { id: 'continue', label: '继续', detail: '确认按未知花费继续，本次不记账拦截', costMicros: null },
        { id: 'stop', label: '停在这里', detail: '账本坏了就先修价目，别在盲区里烧钱', costMicros: 0 },
      ],
    };
  }

  const capHit = policy.sessionCapMicros !== Number.POSITIVE_INFINITY && after >= policy.sessionCapMicros;
  const capWarn =
    policy.sessionCapMicros !== Number.POSITIVE_INFINITY &&
    input.spentMicros >= policy.sessionCapMicros * policy.warnFraction;
  const taskBig = projected > 0 && projected >= policy.taskSoftCapMicros;
  const balanceTight =
    input.balanceMicros != null && input.balanceMicros - after < policy.balanceFloorMicros;

  if (!capHit && !capWarn && !taskBig && !balanceTight) {
    return { kind: 'allow', headline: 'within budget' };
  }

  const headline = capHit
    ? `已花 ${formatMoney(input.spentMicros, currency)}，本步预计 ${formatMoney(projected, currency)}，超出会话预算 ${formatMoney(policy.sessionCapMicros, currency)}`
    : balanceTight
      ? `余额 ${formatMoney(input.balanceMicros ?? 0, currency)} 将被本步消耗到安全线以下`
      : `已花 ${formatMoney(input.spentMicros, currency)} / ${
          Number.isFinite(policy.sessionCapMicros) ? formatMoney(policy.sessionCapMicros, currency) : '预算未设上限'
        }，下一步预计 ${formatMoney(projected, currency)}`;

  const options: GateOption[] = [];

  if (!capHit) {
    options.push({ id: 'continue', label: '继续', detail: `预计 ${formatMoney(projected, currency)}`, costMicros: projected });
  }

  if (input.downgradeTo && input.downgradeTo.id !== input.entry.id) {
    const here = blend(input.entry, input.ratio, now, rules);
    const cheaper = blend(input.downgradeTo, input.ratio, now, rules);
    if (cheaper < here) {
      const scaled = Math.round((projected * cheaper) / here);
      options.push({
        id: 'downgrade',
        label: `降级到 ${input.downgradeTo.id}`,
        detail: `预计 ${formatMoney(scaled, currency)}，省 ${formatMoney(projected - scaled, currency)}；复杂推理会变弱`,
        costMicros: scaled,
        savingMicros: projected - scaled,
      });
    }
  }

  if (projected > 0) {
    const narrowed = Math.round(projected * NARROW_FACTOR);
    options.push({
      id: 'narrow',
      label: '缩小范围',
      detail: `只做会影响正确性的部分，约 ${formatMoney(narrowed, currency)}（省 ${formatMoney(projected - narrowed, currency)}）`,
      costMicros: narrowed,
      savingMicros: projected - narrowed,
    });
  }

  const defer = deferralAdvice(projected, input.entry, rules, now);
  if (defer) {
    options.push({
      id: 'defer',
      label: `等 ${formatDuration(defer.waitMinutes)} 后错峰`,
      detail: `低谷价省 ${formatMoney(defer.savingMicros, currency)}（当前为高峰时段，价×${input.entry.peakMultiplier}）`,
      costMicros: projected - defer.savingMicros,
      savingMicros: defer.savingMicros,
    });
  }

  if (capHit) {
    options.push({
      id: 'raise',
      label: '追加预算',
      detail: `再放行 ${formatMoney(projected, currency)} 后仍会询问`,
      costMicros: projected,
    });
  }

  const within = tokensWithinBudget(Math.max(0, policy.sessionCapMicros - after), input.entry, {
    uncachedInput: input.ratio.uncachedInput,
    output: input.ratio.output,
    cacheRead: input.ratio.cacheRead ?? 0,
  }, { at: now, rules });
  const withinTotal = within.uncachedInput + within.output + within.cacheRead;
  const cachedShare = withinTotal > 0 ? Math.round((within.cacheRead / withinTotal) * 100) : 0;
  options.push({
    id: 'stop',
    label: '停在这里',
    detail: Number.isFinite(policy.sessionCapMicros)
      ? `预算还剩 ${formatMoney(Math.max(0, policy.sessionCapMicros - after), currency)}，按本会话结构约够 ${(withinTotal / 10000).toFixed(1)} 万 token（其中 ${cachedShare}% 是缓存价 token，真新读进来的只有 ${((within.uncachedInput + within.output) / 10000).toFixed(1)} 万）`
      : '不记账地继续会一路烧到余额耗尽',
    costMicros: 0,
  });

  return { kind: capHit || balanceTight ? 'block' : 'ask', headline, options };
}

export function renderGateDecision(decision: GateDecision, currency: string): string {
  if (decision.kind === 'allow') return decision.headline;
  const lines = decision.options.map((o, i) => `  ${i + 1}. ${o.label} — ${o.detail}`);
  return `${decision.headline}${currency ? ` [${currency}]` : ''}\n${lines.join('\n')}`;
}
