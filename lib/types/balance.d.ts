import type { Micros } from './money.ts';
export interface BalanceInfo {
    currency: string;
    totalBalance: number;
    grantedBalance: number;
    toppedUpBalance: number;
}
export type BalanceState = 'ok' | 'unavailable' | 'unknown';
export interface BalanceSnapshot {
    state: BalanceState;
    infos: BalanceInfo[];
    fetchedAt: number;
    error?: string;
    hint?: string;
}
export interface BalanceOptions {
    apiKey?: string | undefined;
    baseUrl?: string | undefined;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    now?: () => number;
}
/**
 * DeepSeek's account balance endpoint. Failures are values, not exceptions: a plugin that
 * cannot read the balance must still let the model work, it just has to say "unknown".
 */
export declare function fetchBalance(options?: BalanceOptions): Promise<BalanceSnapshot>;
export declare function spendableMicros(snapshot: BalanceSnapshot, currency: string): Micros | null;
export declare function formatBalance(snapshot: BalanceSnapshot): string;
/** Reads the balance at most once per TTL, and keeps the last good value on transient failure. */
export declare class BalanceTracker {
    #private;
    constructor(options?: BalanceOptions & {
        ttlMs?: number;
    });
    get current(): BalanceSnapshot;
    refresh(force?: boolean): Promise<BalanceSnapshot>;
}
//# sourceMappingURL=balance.d.ts.map