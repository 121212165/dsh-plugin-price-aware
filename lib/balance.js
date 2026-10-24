const DEFAULT_BASE = 'https://api.deepseek.com';
function num(value) {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(value ?? '');
    return Number.isFinite(parsed) ? parsed : 0;
}
/**
 * DeepSeek's account balance endpoint. Failures are values, not exceptions: a plugin that
 * cannot read the balance must still let the model work, it just has to say "unknown".
 */
export async function fetchBalance(options = {}) {
    const now = options.now ?? (() => Date.now());
    const apiKey = options.apiKey?.trim();
    if (!apiKey) {
        return { state: 'unknown', infos: [], fetchedAt: now(), error: 'no-api-key', hint: '设置 DEEPSEEK_API_KEY 或在插件配置里填 apiKey' };
    }
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    const doFetch = options.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4000);
    try {
        const response = await doFetch(`${baseUrl}/user/balance`, {
            headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'Accept-Language': 'en-US' },
            signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
            return {
                state: 'unknown',
                infos: [],
                fetchedAt: now(),
                error: `auth-${response.status}`,
                hint: '余额接口可能要求「用量接口密码」而非聊天用的 API key，或该 key 无查询权限',
            };
        }
        if (!response.ok) {
            return { state: 'unknown', infos: [], fetchedAt: now(), error: `http-${response.status}` };
        }
        const body = (await response.json());
        if (body.is_available === false) {
            return { state: 'unavailable', infos: [], fetchedAt: now(), error: 'balance-unavailable' };
        }
        const infos = (body.balance_infos ?? []).map((info) => ({
            currency: (info.currency ?? 'CNY').toUpperCase(),
            totalBalance: num(info.total_balance),
            grantedBalance: num(info.granted_balance),
            toppedUpBalance: num(info.topped_up_balance),
        }));
        return infos.length ? { state: 'ok', infos, fetchedAt: now() } : { state: 'unknown', infos, fetchedAt: now(), error: 'empty' };
    }
    catch (error) {
        return {
            state: 'unknown',
            infos: [],
            fetchedAt: now(),
            error: error instanceof Error ? error.name : 'network',
            hint: '离线、被墙或域名不可达；余额未知时插件只会停止承诺“还剩多少钱”，不会拦你干活',
        };
    }
    finally {
        clearTimeout(timer);
    }
}
export function spendableMicros(snapshot, currency) {
    if (snapshot.state !== 'ok')
        return null;
    const info = snapshot.infos.find((i) => i.currency === currency.toUpperCase()) ?? (currency ? null : snapshot.infos[0]);
    if (!info)
        return null;
    return Math.round(info.totalBalance * 1_000_000);
}
export function formatBalance(snapshot) {
    if (snapshot.state === 'unknown')
        return `余额未知（${snapshot.error ?? 'unreachable'}）`;
    if (snapshot.state === 'unavailable')
        return '余额接口报告不可用';
    return snapshot.infos
        .map((i) => `${i.currency} ${i.totalBalance.toFixed(2)}（赠送 ${i.grantedBalance.toFixed(2)} / 充值 ${i.toppedUpBalance.toFixed(2)}）`)
        .join(' · ');
}
/** Reads the balance at most once per TTL, and keeps the last good value on transient failure. */
export class BalanceTracker {
    #snapshot = { state: 'unknown', infos: [], fetchedAt: 0, error: 'never-fetched' };
    #pending = null;
    #options;
    constructor(options = {}) {
        this.#options = options;
    }
    get current() {
        return this.#snapshot;
    }
    async refresh(force = false) {
        const ttl = this.#options.ttlMs ?? 60_000;
        const age = (this.#options.now ?? (() => Date.now()))() - this.#snapshot.fetchedAt;
        if (!force && this.#snapshot.state === 'ok' && age < ttl)
            return this.#snapshot;
        this.#pending ??= (async () => {
            try {
                const next = await fetchBalance(this.#options);
                // a dead lookup must not erase the last number we were sure about
                this.#snapshot = next.state === 'ok' || this.#snapshot.state !== 'ok' ? next : this.#snapshot;
                return this.#snapshot;
            }
            finally {
                this.#pending = null;
            }
        })();
        return this.#pending;
    }
}
//# sourceMappingURL=balance.js.map