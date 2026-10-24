import { type Currency } from './money.ts';
import type { PriceEntry } from './pricing/catalog.ts';
import { type BudgetMode, type BudgetPolicy } from './gate.ts';
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
    injectIntoPrompt: boolean;
}
export declare const DEFAULT_CONFIG: PriceAwareConfig;
export declare function resolveBudget(config: PriceAwareConfig): BudgetPolicy;
export interface ConfigProblem {
    field: keyof PriceAwareConfig;
    message: string;
}
/** A mis-typed budget is worse than no budget: a silently-ignored cap reads as permission. */
export declare function validateConfig(config: Partial<PriceAwareConfig>): ConfigProblem[];
export declare function describeBudget(policy: BudgetPolicy, currency: Currency): string;
//# sourceMappingURL=config.d.ts.map