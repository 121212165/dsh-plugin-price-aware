import { formatMoney, type Micros } from './money.ts';
import type { LedgerTotals } from './ledger.ts';
import type { BudgetPolicy } from './gate.ts';
import type { ResolveResult } from './pricing/resolve.ts';
import type { CostBreakdown } from './pricing/cost.ts';
import type { Estimate, TierPlan } from './estimate.ts';
import { formatDuration, isPeakAt, nextRegimeChange, type RegimeRules } from './pricing/window.ts';

export interface MoneyContext {
  resolution: ResolveResult;
  now: Date;
  rules?: RegimeRules;
  balanceMicros: Micros | null;
  spentMicros: Micros;
  policy: BudgetPolicy;
  totals: LedgerTotals;
  catalogStale?: boolean;
  /** the agent should price a plan before spending more than this in one step */
  askAboveMicros?: Micros;
}

/**
 * The block the model re-reads every turn. It is itself billed as context, so it stays
 * short on purpose — a "helpful" 2k-token cost essay would be a joke.
 */
export function renderMoneyContext(input: MoneyContext): string {
  const lines: string[] = [];
  const resolution = input.resolution;

  if (resolution.kind === 'unknown') {
    lines.push(
      `钱: 模型 ${resolution.modelId} 不在价表内，花费未知。不要声称知道价格，也不要做花钱的承诺；用 /price-add 补一条价目。`,
    );
    return lines.join('\n');
  }

  const { entry } = resolution;
  const peak = isPeakAt(input.now, input.rules ?? {});
  const p = entry.perMillion;
  const peakLabel = entry.peakMultiplier && entry.peakMultiplier > 1 ? `/${trimMoney(p.output * entry.peakMultiplier)}` : '';
  lines.push(
    `钱: ${entry.id} 单价(每百万 token, ${entry.currency}) 输入 ${trimMoney(p.uncachedInput)}${
      entry.peakMultiplier && entry.peakMultiplier > 1 ? `/${trimMoney(p.uncachedInput * entry.peakMultiplier)}` : ''
    } · 缓存命中 ${trimMoney(p.cacheRead)} · 输出 ${trimMoney(p.output)}${peakLabel}${
      entry.peakMultiplier && entry.peakMultiplier > 1 ? (peak ? '【当前高峰，价×' + entry.peakMultiplier + '】' : '【当前低谷】') : ''
    }`,
  );

  if (entry.peakMultiplier && entry.peakMultiplier > 1) {
    const next = nextRegimeChange(input.now, input.rules ?? {});
    const wait = Math.max(0, Math.round((next.at.getTime() - input.now.getTime()) / 60_000));
    lines.push(
      `钱: ${peak ? '大批量动作等 ' : '下次转高峰在 '}${formatDuration(wait)} 后（${
        next.regime === 'offpeak' ? '错峰可省一半' : '届时价×' + entry.peakMultiplier
      }）`,
    );
  }

  const balance = input.balanceMicros == null ? '未知' : formatMoney(input.balanceMicros, entry.currency);
  const cap = Number.isFinite(input.policy.sessionCapMicros) ? formatMoney(input.policy.sessionCapMicros, entry.currency) : '未设上限';
  lines.push(
    `钱: 账户余额 ${balance} · 本会话已花 ${formatMoney(input.spentMicros, entry.currency)}/${cap}（模式 ${input.policy.mode}） · ${
      input.totals.turns
    } 轮 · 缓存命中 ${Math.round(input.totals.cacheHitRate * 100)}%`,
  );

  if (input.totals.unpricedEvents > 0) {
    lines.push(`钱: 有 ${input.totals.unpricedEvents} 次调用没价目，上面的数字是下限。`);
  }
  const outputTokens = input.totals.buckets.output ?? 0;
  const reasoning = input.totals.reasoningTokens;
  if (outputTokens > 0 && reasoning / outputTokens > 0.3) {
    lines.push(
      `钱: ${Math.round((reasoning / outputTokens) * 100)}% 的输出 token（${reasoning.toLocaleString()}）花在看不见的推理上——按输出价收费。若某次 max_tokens 太小，可能全部预算被推理吃掉、正文一个字都不返回。`,
    );
  }
  if (input.catalogStale) {
    lines.push('钱: 价表快照超过 45 天，跑 /price-refresh 核对官方页。');
  }

  const threshold = input.askAboveMicros ?? input.policy.taskSoftCapMicros;
  lines.push(
    `纪律: 单步预计 ≥ ${formatMoney(threshold, entry.currency)} 时，先给 A/B/C 三档让用户选档再开工；` +
      '不重复读大文件，保持前缀稳定以命中缓存；能用 flash 解决就别用 pro。',
  );
  return lines.join('\n');
}

export function renderTiers(tiers: TierPlan[], calibration?: { bias: number; n: number }): string {
  const width = Math.max(...tiers.map((t) => t.label.length));
  const lines = tiers.map((tier) => {
    const cost = tier.cost;
    return `${tier.label.padEnd(width)} ${formatMoney(cost.micros, cost.currency)}（±${tier.estimate.errorPct}% · ${
      tier.estimate.turns
    } 轮）— ${tier.whatYouGet}`;
  });
  lines.push(
    calibration && calibration.n > 0
      ? `误差带来自本仓库 ${calibration.n} 次同类任务的实际花费；选哪一档由你定，我不替你花钱。`
      : '首次估算无历史校准，误差带是启发式给的；选档后我再按实际用量修正。',
  );
  return lines.join('\n');
}

export function renderEstimate(estimate: Estimate, cost: CostBreakdown, recon?: CostBreakdown): string {
  const lines = [`预计 ${formatMoney(cost.micros, cost.currency)}（${estimate.turns} 轮，±${estimate.errorPct}%）`];
  for (const line of cost.lines) {
    lines.push(`  ${line.kind}: ${line.tokens.toLocaleString()} token × ${line.pricePerMillion}/M = ${formatMoney(line.micros, cost.currency)}`);
  }
  for (const driver of estimate.drivers) lines.push(`  · ${driver}`);
  if (recon) lines.push(`  侦察一次以把误差压到 ±12% 需要 ${formatMoney(recon.micros, recon.currency)}`);
  return lines.join('\n');
}

function trimMoney(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
}
