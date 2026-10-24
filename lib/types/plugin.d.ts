/**
 * dsh wiring for the price-aware plugin.
 *
 * Everything that decides a number lives in the pure modules (pricing/, ledger,
 * gate, estimate, balance, advice); this file only moves events and renders text.
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { type PriceAwareConfig } from './config.ts';
export declare const name = "price-aware";
/**
 * Service names are the strings each service passes to cordis' `Service`
 * constructor — `systemPrompt` and `sessions`, not the package names
 * `system-prompt` / `session`. A name that resolves to no implementation makes
 * cordis mark the plugin inactive, so apply() is never called and nothing errors.
 */
export declare const inject: string[];
export interface Config extends PriceAwareConfig {
}
export declare const Config: Schema<Schemastery.ObjectS<{
    enabled: Schema<boolean, boolean>;
    mode: Schema<"custom" | "economy" | "max" | "normal", "custom" | "economy" | "max" | "normal">;
    sessionCapMajor: Schema<number, number>;
    warnPercent: Schema<number, number>;
    taskAskMajor: Schema<number, number>;
    balanceFloorMajor: Schema<number, number>;
    currency: Schema<"CNY" | "USD" | "auto", "CNY" | "USD" | "auto">;
    balanceCheck: Schema<boolean, boolean>;
    balanceTtlSeconds: Schema<number, number>;
    apiKeyEnv: Schema<string[], string[]>;
    baseUrl: Schema<string, string>;
    prices: Schema<({
        id?: string | null;
        currency?: "CNY" | "EUR" | "USD" | null;
        perMillion?: ({
            cacheRead?: number | null;
            uncachedInput?: number | null;
            output?: number | null;
        } & import("@deepseek-ai/cosmokit").Dict) | null;
        peakMultiplier?: number | null;
        contextTokens?: number | null;
        maxOutputTokens?: number | null;
        aliases?: string[] | null;
        note?: string | null;
    } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
        id: Schema<string, string>;
        currency: Schema<"CNY" | "EUR" | "USD", "CNY" | "EUR" | "USD">;
        perMillion: Schema<Schemastery.ObjectS<{
            cacheRead: Schema<number, number>;
            uncachedInput: Schema<number, number>;
            output: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            cacheRead: Schema<number, number>;
            uncachedInput: Schema<number, number>;
            output: Schema<number, number>;
        }>>;
        peakMultiplier: Schema<number, number>;
        contextTokens: Schema<number, number>;
        maxOutputTokens: Schema<number, number>;
        aliases: Schema<string[], string[]>;
        note: Schema<string, string>;
    }>[]>;
    holidays: Schema<string[], string[]>;
    reconThresholdMajor: Schema<number, number>;
    injectIntoPrompt: Schema<boolean, boolean>;
}>, Schemastery.ObjectT<{
    enabled: Schema<boolean, boolean>;
    mode: Schema<"custom" | "economy" | "max" | "normal", "custom" | "economy" | "max" | "normal">;
    sessionCapMajor: Schema<number, number>;
    warnPercent: Schema<number, number>;
    taskAskMajor: Schema<number, number>;
    balanceFloorMajor: Schema<number, number>;
    currency: Schema<"CNY" | "USD" | "auto", "CNY" | "USD" | "auto">;
    balanceCheck: Schema<boolean, boolean>;
    balanceTtlSeconds: Schema<number, number>;
    apiKeyEnv: Schema<string[], string[]>;
    baseUrl: Schema<string, string>;
    prices: Schema<({
        id?: string | null;
        currency?: "CNY" | "EUR" | "USD" | null;
        perMillion?: ({
            cacheRead?: number | null;
            uncachedInput?: number | null;
            output?: number | null;
        } & import("@deepseek-ai/cosmokit").Dict) | null;
        peakMultiplier?: number | null;
        contextTokens?: number | null;
        maxOutputTokens?: number | null;
        aliases?: string[] | null;
        note?: string | null;
    } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
        id: Schema<string, string>;
        currency: Schema<"CNY" | "EUR" | "USD", "CNY" | "EUR" | "USD">;
        perMillion: Schema<Schemastery.ObjectS<{
            cacheRead: Schema<number, number>;
            uncachedInput: Schema<number, number>;
            output: Schema<number, number>;
        }>, Schemastery.ObjectT<{
            cacheRead: Schema<number, number>;
            uncachedInput: Schema<number, number>;
            output: Schema<number, number>;
        }>>;
        peakMultiplier: Schema<number, number>;
        contextTokens: Schema<number, number>;
        maxOutputTokens: Schema<number, number>;
        aliases: Schema<string[], string[]>;
        note: Schema<string, string>;
    }>[]>;
    holidays: Schema<string[], string[]>;
    reconThresholdMajor: Schema<number, number>;
    injectIntoPrompt: Schema<boolean, boolean>;
}>>;
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=plugin.d.ts.map