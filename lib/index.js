/**
 * Entry point for the dsh runtime: cordis reads `name`, `inject`, `Config` and
 * `apply` from here. The pure money modules are re-exported for library use
 * (a CLI, a dashboard, or another harness) without pulling in dsh.
 */
export { apply, Config, inject, name } from './plugin.js';
export * from './money.js';
export * from './pricing/index.js';
export { Ledger, toBuckets } from './ledger.js';
export { decide, MODE_PRESETS, preset, renderGateDecision, } from './gate.js';
export { buildTiers, calibrate, estimateTask, priceEstimate, reconCost, reconEstimate, shouldRecon, tokensForText, } from './estimate.js';
export { BalanceTracker, fetchBalance, formatBalance, spendableMicros, } from './balance.js';
export { DEFAULT_CONFIG, describeBudget, resolveBudget, validateConfig, } from './config.js';
export { renderMoneyContext, renderTiers as renderTierTable } from './advice.js';
export { catalogFromProviderModels, normalizeOpenAiUsage, pickModelByBudget, selectModelsByBudget, usageCostMicros, } from './provider.js';
export { profileModels, quoteTrust, rankByUsableCost, recommendMaxTokens, escalateCap, } from './profile.js';
//# sourceMappingURL=index.js.map