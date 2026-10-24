import { type Micros } from './money.ts';
import type { LedgerTotals } from './ledger.ts';
import type { BudgetPolicy } from './gate.ts';
import type { ResolveResult } from './pricing/resolve.ts';
import type { CostBreakdown } from './pricing/cost.ts';
import type { Estimate, TierPlan } from './estimate.ts';
import { type RegimeRules } from './pricing/window.ts';
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
export declare function renderMoneyContext(input: MoneyContext): string;
export declare function renderTiers(tiers: TierPlan[], calibration?: {
    bias: number;
    n: number;
}): string;
export declare function renderEstimate(estimate: Estimate, cost: CostBreakdown, recon?: CostBreakdown): string;
//# sourceMappingURL=advice.d.ts.map