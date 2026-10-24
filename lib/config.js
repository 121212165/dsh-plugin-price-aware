import { fromMajor } from './money.js';
import { MODE_PRESETS, preset } from './gate.js';
export const DEFAULT_CONFIG = {
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
    injectIntoPrompt: true,
};
export function resolveBudget(config) {
    if (config.mode !== 'custom') {
        const base = preset(config.mode);
        // 'max' means no asking at all: overwriting its Infinity sentinels with the
        // config defaults made /budget max still interrupt at ¥1.5 and still block
        if (base.taskSoftCapMicros === Number.POSITIVE_INFINITY)
            return base;
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
/** A mis-typed budget is worse than no budget: a silently-ignored cap reads as permission. */
export function validateConfig(config) {
    const problems = [];
    const positive = (field, value, allowInfinity = false) => {
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
    if (!(warn > 0 && warn <= 100))
        problems.push({ field: 'warnPercent', message: `warnPercent 需在 (0,100]，收到 ${warn}` });
    if (config.mode && !(config.mode in MODE_PRESETS) && config.mode !== 'custom') {
        problems.push({ field: 'mode', message: `mode 需为 economy|normal|max|custom，收到 ${config.mode}` });
    }
    for (const [index, entry] of (config.prices ?? []).entries()) {
        if (!entry?.id) {
            problems.push({ field: 'prices', message: `prices[${index}] 缺少 id` });
            continue;
        }
        // a NaN price is worse than no price: it poisons the ledger total and every
        // comparison in the gate then reads false, which silently means "allow"
        const perMillion = entry.perMillion ?? {};
        for (const key of ['uncachedInput', 'output', 'cacheRead', 'cacheWrite']) {
            const value = perMillion[key];
            if (value === undefined) {
                if (key !== 'cacheWrite')
                    problems.push({ field: 'prices', message: `prices[${index}] (${entry.id}) 缺 perMillion.${key}` });
                continue;
            }
            if (!Number.isFinite(value) || value < 0) {
                problems.push({ field: 'prices', message: `prices[${index}] (${entry.id}) 的 ${key} 不是 ≥0 的有限数，收到 ${value}` });
            }
        }
        if (entry.peakMultiplier !== undefined && (!Number.isFinite(entry.peakMultiplier) || entry.peakMultiplier < 1)) {
            problems.push({ field: 'prices', message: `prices[${index}] (${entry.id}) 的 peakMultiplier 需 ≥1，收到 ${entry.peakMultiplier}` });
        }
        if (entry.currency && !['CNY', 'USD', 'EUR'].includes(entry.currency.toUpperCase())) {
            problems.push({ field: 'prices', message: `prices[${index}] (${entry.id}) 的币种 ${entry.currency} 未被支持，会被当成别的币种混算` });
        }
    }
    return problems;
}
export function describeBudget(policy, currency) {
    const cap = Number.isFinite(policy.sessionCapMicros) ? money(policy.sessionCapMicros, currency) : '不设上限';
    return `${policy.mode} 模式：会话 ${cap}，花到 ${Math.round(policy.warnFraction * 100)}% 或单步 ≥${money(policy.taskSoftCapMicros, currency)} 时问一句，余额留底 ${money(policy.balanceFloorMicros, currency)}`;
}
function money(micros, currency) {
    const value = micros / 1_000_000;
    return `${currency === 'USD' ? '$' : '¥'}${value.toFixed(2)}`;
}
//# sourceMappingURL=config.js.map