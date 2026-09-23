import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BalanceTracker, fetchBalance, formatBalance, spendableMicros } from '../src/balance.ts';
import { renderMoneyContext, renderTiers } from '../src/advice.ts';
import { buildTiers, estimateTask, tokensForText } from '../src/estimate.ts';
import { DEEPSEEK_CATALOG } from '../src/pricing/catalog.ts';
import { resolveModel } from '../src/pricing/resolve.ts';
import { preset } from '../src/gate.ts';
import { emptyBuckets } from '../src/pricing/cost.ts';

const flash = DEEPSEEK_CATALOG.entries[0]!;
const pro = DEEPSEEK_CATALOG.entries[1]!;
const bj = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi) - 8 * 3_600_000);

function stubFetch(body: unknown, init: { status?: number; throw?: Error } = {}) {
  let calls = 0;
  const impl = (async () => {
    calls++;
    if (init.throw) throw init.throw;
    return {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      json: async () => body,
    };
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

const OFFICIAL_PAYLOAD = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '41.20', granted_balance: '1.20', topped_up_balance: '40.00' },
    { currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
  ],
};

test('the official payload shape turns into spendable micro-units', async () => {
  const snapshot = await fetchBalance({ apiKey: 'sk-test', fetchImpl: stubFetch(OFFICIAL_PAYLOAD).impl });
  assert.equal(snapshot.state, 'ok');
  assert.equal(spendableMicros(snapshot, 'CNY'), 41_200_000);
  assert.equal(spendableMicros(snapshot, 'USD'), 0);
  assert.ok(formatBalance(snapshot).includes('赠送 1.20'));
});

test('a missing balance never throws at the model, it degrades to unknown', async () => {
  const unauthorized = await fetchBalance({ apiKey: 'sk-test', fetchImpl: stubFetch({}, { status: 401 }).impl });
  assert.equal(unauthorized.state, 'unknown');
  assert.ok(unauthorized.hint?.includes('用量接口密码'));

  const offline = await fetchBalance({
    apiKey: 'sk-test',
    fetchImpl: stubFetch({}, { throw: new TypeError('fetch failed') }).impl,
  });
  assert.equal(offline.state, 'unknown');
  assert.equal(spendableMicros(offline, 'CNY'), null);

  const noKey = await fetchBalance({ apiKey: '' });
  assert.equal(noKey.error, 'no-api-key');

  const unavailable = await fetchBalance({ apiKey: 'sk-test', fetchImpl: stubFetch({ is_available: false }).impl });
  assert.equal(unavailable.state, 'unavailable');
});

test('the api key never leaks into what the model can read', async () => {
  const snapshot = await fetchBalance({
    apiKey: 'sk-secret-abcdef',
    fetchImpl: stubFetch({}, { throw: new Error('connect ETIMEDOUT sk-secret-abcdef') }).impl,
  });
  const text = JSON.stringify(snapshot) + formatBalance(snapshot);
  assert.ok(!text.includes('sk-secret-abcdef'), text);
});

test('the tracker refreshes on a TTL and keeps the last good number', async () => {
  let clock = 1_000;
  let unreachable = false;
  const impl = (async () => {
    if (unreachable) throw new TypeError('fetch failed');
    return { ok: true, status: 200, json: async () => OFFICIAL_PAYLOAD };
  }) as unknown as typeof fetch;
  const tracker = new BalanceTracker({ apiKey: 'sk-test', fetchImpl: impl, now: () => clock, ttlMs: 500 });

  await tracker.refresh();
  const first = tracker.current;
  assert.equal(spendableMicros(first, 'CNY'), 41_200_000);

  await tracker.refresh();
  assert.equal(tracker.current.fetchedAt, first.fetchedAt, 'inside the TTL nothing is fetched');

  unreachable = true;
  clock += 10_000;
  const afterFailure = await tracker.refresh(true);
  assert.equal(spendableMicros(afterFailure, 'CNY'), 41_200_000, 'a dead lookup must not erase a known balance');
  assert.equal(spendableMicros(await tracker.refresh(true).then(() => tracker.current), 'CNY'), 41_200_000);
});

function contextInput(over: Partial<Parameters<typeof renderMoneyContext>[0]> = {}) {
  return {
    resolution: resolveModel('deepseek-v4-pro', DEEPSEEK_CATALOG),
    now: bj(2026, 9, 16, 10),
    balanceMicros: 41_200_000,
    spentMicros: 3_840_000,
    policy: preset('normal'),
    totals: {
      micros: 3_840_000,
      buckets: emptyBuckets(),
      tokens: 0,
      turns: 34,
      steps: 61,
      cacheHitRate: 0.71,
      costPerTurnMicros: 113_000,
      reasoningTokens: 0,
      ratio: { uncachedInput: 0, output: 0, cacheRead: 0 },
      unpricedEvents: 0,
    },
    ...over,
  };
}

test('the model sees prices, the clock, and its own bill', () => {
  const text = renderMoneyContext(contextInput());
  assert.ok(text.includes('deepseek-v4-pro'));
  assert.ok(text.includes('4.5') && text.includes('13.5'), 'off-peak unit prices');
  assert.ok(text.includes('9') && text.includes('27'), 'peak unit prices');
  assert.ok(text.includes('当前高峰'));
  assert.ok(text.includes('¥41.20'), text);
  assert.ok(text.includes('¥3.84'));
  assert.ok(text.includes('缓存命中 71%'));
  assert.ok(text.includes('A/B/C'));
});

test('an unpriced model gets no invented numbers', () => {
  const text = renderMoneyContext(contextInput({ resolution: resolveModel('glm-5-turbo', DEEPSEEK_CATALOG) }));
  assert.ok(!/¥\d/.test(text), text);
  assert.ok(text.includes('未知'), text);
  assert.ok(text.includes('price-aware.prices'), '必须指向真实存在的配置键，而不是编一个命令');
});

test('unknown balance says so instead of printing a hole', () => {
  const text = renderMoneyContext(contextInput({ balanceMicros: null }));
  assert.ok(text.includes('余额 未知'), text);
});

test('the injected block bills itself, so it stays small', () => {
  const text = renderMoneyContext(contextInput());
  const tokens = tokensForText(text);
  assert.ok(tokens < 260, `${tokens} tokens: ${(tokens * flash.perMillion.uncachedInput) / 1_000_000} CNY per turn`);
});

test('staleness and unpriced calls are admitted in the same block', () => {
  assert.ok(renderMoneyContext(contextInput({ catalogStale: true })).includes('45 天'));
  const withUnpriced = contextInput();
  withUnpriced.totals.unpricedEvents = 3;
  assert.ok(renderMoneyContext(withUnpriced).includes('下限'));
});

test('tiers are printed cheapest first with their error bands', () => {
  const tiers = buildTiers({ kind: 'refactor', residentTokens: 20_000 }, pro, { at: bj(2026, 9, 16, 1) });
  const text = renderTiers(tiers);
  const rows = text.split('\n');
  assert.equal(rows.length, 4);
  assert.ok(rows[0]!.includes('¥'));
  assert.ok(rows[0]!.includes('±'));
  const costs = tiers.map((t) => t.cost.micros);
  assert.deepEqual([...costs].sort((a, b) => a - b), costs);
  assert.ok(text.includes('无历史校准'));
  const calibrated = renderTiers(tiers, { bias: 1.2, n: 12 });
  assert.ok(calibrated.includes('12 次'));
});
