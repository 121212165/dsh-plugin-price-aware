import { fromMajor, type Currency, type Micros } from './money.ts';
import type { PriceEntry } from './pricing/catalog.ts';
import { MODE_PRESETS, preset, type BudgetMode, type BudgetPolicy } from './gate.ts';

export interface PriceAwareConfig {
  enabled: boolean;
  mode: BudgetMode;
  /** session ceiling in whole currency units; only used when mode = 'custom' */
  sessionCapMajor: number;
  warnPercent: number;
  /** one step estimated above this (whole currency units) earns a pre-flight question */
  taskAskMajor: number;
  /** stop when this much account balance would be left over */
  balanceFloorMajor: number;
  currency: Currency | 'auto';
  balanceCheck: boolean;
  balanceTtlSeconds: number;
  /** environment variables to look for an API key, in order */
  apiKeyEnv: string[];
  baseUrl?: string;
  prices: PriceEntry[];
  /** Beijing YYYY-MM-DD dates billed at off-peak */
  holidays: string[];
  /** spend money to estimate money only above this bill */
  reconThresholdMajor: number;
  /** set true for relays that report prompt_tokens including the cached prefix */
  inputIncludesCache: boolean;
  injectIntoPrompt: boolean;
}

export const DEFAULT_CONFIG: PriceAwareConfig = {
  enabled: true,
  mode: 'normal',
  sessionCapMajor: 10,
  warnPercent: 75,
  taskAskMajor: 1.5,
  balanceFloorMajor: 3,
  currency: 'auto',
  balanceCheck: true,
  balanceTtlSeconds: 60,
  apiKeyEnv: ['DEEPSEEK_API_KEY', 'DSH_DEEPSEEK_API_KEY'],
  prices: [],
  holidays: [],
  reconThresholdMajor: 0.5,
  inputIncludesCache: false,
  injectIntoPrompt: true,
};

export function resolveBudget(config: PriceAwareConfig): BudgetPolicy {
  if (config.mode !== 'custom') {
    const base = preset(config.mode);
    return {
      ...base,
      warnFraction: config.warnPercent / 100,
      taskSoftCapMicros: fromMajor(config.taskAskMajor),
      balanceFloorMicros: fromMajor(config.balanceFloorMajor),
    };
  }
  return {
    mode: 'custom',
    sessionCapMicros: config.sessionCapMajor <= 0 ? Number.POSITIVE_INFINITY : fromMajor(config.sessionCapMajor),
    warnFraction: Math.min(1, Math.max(0.05, config.warnPercent / 100)),
    taskSoftCapMicros: fromMajor(config.taskAskMajor),
    balanceFloorMicros: fromMajor(config.balanceFloorMajor),
  };
}

export interface ConfigProblem {
  field: keyof PriceAwareConfig;
  message: string;
}

/** A mis-typed budget is worse than no budget: a silently-ignored cap reads as permission. */
export function validateConfig(config: Partial<PriceAwareConfig>): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const positive = (field: keyof PriceAwareConfig, value: unknown, allowInfinity = false) => {
    if (typeof value !== 'number' || (!allowInfinity && !Number.isFinite(value)) || (allowInfinity && Number.isNaN(value)) || value < 0) {
      problems.push({ field, message: `${String(field)} 需要是 ≥0 的数字，收到 ${JSON.stringify(value)}` });
    }
  };
  positive('sessionCapMajor', config.sessionCapMajor ?? DEFAULT_CONFIG.sessionCapMajor, true);
  positive('taskAskMajor', config.taskAskMajor ?? DEFAULT_CONFIG.taskAskMajor);
  positive('balanceFloorMajor', config.balanceFloorMajor ?? DEFAULT_CONFIG.balanceFloorMajor);
  positive('reconThresholdMajor', config.reconThresholdMajor ?? DEFAULT_CONFIG.reconThresholdMajor);
  positive('balanceTtlSeconds', config.balanceTtlSeconds ?? DEFAULT_CONFIG.balanceTtlSeconds);
  const warn = config.warnPercent ?? DEFAULT_CONFIG.warnPercent;
  if (!(warn > 0 && warn <= 100)) problems.push({ field: 'warnPercent', message: `warnPercent 需在 (0,100]，收到 ${warn}` });
  if (config.mode && !(config.mode in MODE_PRESETS) && config.mode !== 'custom') {
    problems.push({ field: 'mode', message: `mode 需为 economy|normal|max|custom，收到 ${config.mode}` });
  }
  for (const [index, entry] of (config.prices ?? []).entries()) {
    if (!entry?.id) problems.push({ field: 'prices', message: `prices[${index}] 缺少 id` });
    else if (!entry.perMillion || !Number.isFinite(entry.perMillion.output)) {
      problems.push({ field: 'prices', message: `prices[${index}] (${entry.id}) 缺少 perMillion.output` });
    }
  }
  return problems;
}

export function describeBudget(policy: BudgetPolicy, currency: Currency): string {
  const cap = Number.isFinite(policy.sessionCapMicros) ? money(policy.sessionCapMicros, currency) : '不设上限';
  return `${policy.mode} 模式：会话 ${cap}，花到 ${Math.round(policy.warnFraction * 100)}% 或单步 ≥${money(
    policy.taskSoftCapMicros,
    currency,
  )} 时问一句，余额留底 ${money(policy.balanceFloorMicros, currency)}`;
}

function money(micros: Micros, currency: Currency): string {
  const value = micros / 1_000_000;
  return `${currency === 'USD' ? '$' : '¥'}${value.toFixed(2)}`;
}
