/**
 * Entry point for the dsh runtime: cordis reads `name`, `inject`, `Config` and
 * `apply` from here. The pure money modules are re-exported for library use
 * (a CLI, a dashboard, or another harness) without pulling in dsh.
 */
export { apply, Config, inject, name } from './plugin.ts';
export type { Config as PluginConfig } from './plugin.ts';

export * from './money.ts';
export * from './pricing/index.ts';
export { Ledger, toBuckets, type LedgerTotals, type RawUsage, type UsageEvent } from './ledger.ts';
export {
  decide,
  MODE_PRESETS,
  preset,
  renderGateDecision,
  type BudgetMode,
  type BudgetPolicy,
  type GateDecision,
  type GateInput,
  type GateOption,
} from './gate.ts';
export {
  buildTiers,
  calibrate,
  estimateTask,
  priceEstimate,
  reconCost,
  reconEstimate,
  shouldRecon,
  tokensForText,
  type Calibration,
  type Estimate,
  type TaskKind,
  type TaskShape,
  type TierPlan,
} from './estimate.ts';
export {
  BalanceTracker,
  fetchBalance,
  formatBalance,
  spendableMicros,
  type BalanceSnapshot,
  type BalanceState,
} from './balance.ts';
export {
  DEFAULT_CONFIG,
  describeBudget,
  resolveBudget,
  validateConfig,
  type ConfigProblem,
  type PriceAwareConfig,
} from './config.ts';
export { renderMoneyContext, renderTiers as renderTierTable, type MoneyContext } from './advice.ts';

export {
  catalogFromProviderModels,
  normalizeOpenAiUsage,
  pickModelByBudget,
  selectModelsByBudget,
  usageCostMicros,
  type OpenAiUsage,
  type ProviderModelRecord,
  type SelectionRequest,
} from './provider.ts';
export {
  profileModels,
  quoteTrust,
  rankByUsableCost,
  recommendMaxTokens,
  escalateCap,
  type CallObservation,
  type ModelProfile,
  type UsableFit,
} from './profile.ts';
