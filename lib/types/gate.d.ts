import { type Micros } from './money.ts';
import { type TokenBuckets } from './pricing/cost.ts';
import type { PriceEntry } from './pricing/catalog.ts';
import { type RegimeRules } from './pricing/window.ts';
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
export declare const MODE_PRESETS: Record<Exclude<BudgetMode, 'custom'>, Omit<BudgetPolicy, 'mode'>>;
export declare function preset(mode: Exclude<BudgetMode, 'custom'>): BudgetPolicy;
export interface GateInput {
    spentMicros: Micros;
    /** what the next chunk of work is estimated to cost; 0 when unknown */
    projectedMicros: Micros;
    entry: PriceEntry;
    /** cheaper entry to fall back to, if the session can switch models */
    downgradeTo?: PriceEntry | undefined;
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
export type GateDecision = {
    kind: 'allow';
    headline: string;
} | {
    kind: 'ask';
    headline: string;
    options: GateOption[];
} | {
    kind: 'block';
    headline: string;
    options: GateOption[];
};
/**
 * The one decision the plugin makes every time money is about to leave the account:
 * say nothing, ask a single question, or refuse.
 */
export declare function decide(input: GateInput): GateDecision;
export declare function renderGateDecision(decision: GateDecision, currency: string): string;
//# sourceMappingURL=gate.d.ts.map