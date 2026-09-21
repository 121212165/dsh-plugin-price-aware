import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromMajor, formatMoney } from '../src/money.ts';
import {
  DEEPSEEK_CATALOG,
  blendedPricePerMillion,
  catalogAgeDays,
  costOf,
  isCatalogStale,
  isPeakAt,
  mergeCatalog,
  nextRegimeChange,
  deferralAdvice,
  regimeAt,
  resolveModel,
  tokensWithinBudget,
} from '../src/pricing/index.ts';

/** Beijing wall clock -> Date (China has no DST, so a fixed offset is exact). */
const bj = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi) - 8 * 3_600_000);

const flash = DEEPSEEK_CATALOG.entries[0]!;
const pro = DEEPSEEK_CATALOG.entries[1]!;

test('micros identity: 1000 in + 500 out on flash costs 0.003 CNY off-peak', () => {
  const cost = costOf({ uncachedInput: 1000, output: 500, cacheRead: 0 }, flash, { at: bj(2026, 9, 16, 1) });
  assert.equal(cost.micros, 3000);
  assert.equal(cost.regime, 'offpeak');
  assert.equal(formatMoney(cost.micros, 'CNY'), '¥0.0030');
});

test('peak hours double the bill', () => {
  const off = costOf({ uncachedInput: 1000, output: 500, cacheRead: 0 }, flash, { at: bj(2026, 9, 16, 1) });
  const peak = costOf({ uncachedInput: 1000, output: 500, cacheRead: 0 }, flash, { at: bj(2026, 9, 16, 10) });
  assert.equal(peak.micros, off.micros * 2);
  assert.equal(peak.regime, 'peak');
});

test('cache reads cost 1/50th of uncached input on flash', () => {
  const cost = costOf({ uncachedInput: 0, output: 0, cacheRead: 100_000 }, flash, { at: bj(2026, 9, 16, 1) });
  assert.equal(cost.micros, 2000); // 100k tokens x 0.02/M = 0.002 元
  assert.equal(formatMoney(cost.micros, 'CNY'), '¥0.0020');
  assert.equal(cost.cacheHitRate, 1);
});

test('a long agent turn is priced across all three buckets', () => {
  const cost = costOf(
    { uncachedInput: 20_000, output: 2_000, cacheRead: 100_000 },
    pro,
    { at: bj(2026, 9, 16, 10) },
  );
  // peak: uncached 9/M, output 27/M, cacheRead 0.30/M
  assert.equal(cost.micros, 20_000 * 9 + 2_000 * 27 + 100_000 * 0.3);
});

test('Beijing peak windows: 9-12 and 14-18 on workdays only', () => {
  const wed = bj(2026, 9, 16, 10);
  assert.equal(isPeakAt(wed), true);
  assert.equal(isPeakAt(bj(2026, 9, 16, 9)), true);
  assert.equal(isPeakAt(bj(2026, 9, 16, 12)), false, '12:00 is the exclusive end');
  assert.equal(isPeakAt(bj(2026, 9, 16, 13)), false, 'lunch break is off-peak');
  assert.equal(isPeakAt(bj(2026, 9, 16, 17, 59)), true);
  assert.equal(isPeakAt(bj(2026, 9, 19, 10)), false, 'Saturday');
  assert.equal(isPeakAt(bj(2026, 9, 20, 10)), false, 'Sunday');
});

test('declared holidays bill at off-peak', () => {
  assert.equal(isPeakAt(bj(2026, 9, 16, 10), { holidays: ['2026-09-16'] }), false);
});

test('nextRegimeChange finds the 12:00 boundary, then Monday', () => {
  const midPeak = nextRegimeChange(bj(2026, 9, 16, 10, 30));
  assert.deepEqual([midPeak.regime, midPeak.at.toISOString()], ['offpeak', '2026-09-16T04:00:00.000Z']);

  const lunchBreak = nextRegimeChange(bj(2026, 9, 16, 12, 30));
  assert.deepEqual([lunchBreak.regime, lunchBreak.at.toISOString()], ['peak', '2026-09-16T06:00:00.000Z']);

  const fridayEvening = nextRegimeChange(bj(2026, 9, 18, 19));
  assert.deepEqual([fridayEvening.regime, fridayEvening.at.toISOString()], ['peak', '2026-09-21T01:00:00.000Z'], 'jumps the weekend to Monday 09:00');
});

test('deferral advice names the wait and the saving', () => {
  const at = bj(2026, 9, 16, 11, 30);
  const cost = costOf({ uncachedInput: 100_000, output: 10_000, cacheRead: 0 }, pro, { at });
  const advice = deferralAdvice(cost.micros, pro, {}, at)!;
  assert.equal(advice.waitMinutes, 30);
  assert.equal(advice.savingMicros, Math.round(cost.micros / 2));
  assert.equal(deferralAdvice(cost.micros, pro, {}, bj(2026, 9, 16, 1)), null, 'nothing to dodge off-peak');
});

test('relay model ids resolve to a sheet price with a confidence flag', () => {
  const dated = resolveModel('DeepSeek_V4_Flash_0731', DEEPSEEK_CATALOG);
  assert.equal(dated.kind, 'known');
  if (dated.kind === 'known') {
    assert.equal(dated.entry.id, 'deepseek-flash');
    assert.ok(dated.confidence >= 0.85);
  }
  const legacy = resolveModel('deepseek-chat', DEEPSEEK_CATALOG);
  assert.equal(legacy.kind === 'known' && legacy.via, 'alias');
  const unknown = resolveModel('gpt-99-turbo', DEEPSEEK_CATALOG);
  assert.equal(unknown.kind, 'unknown');
});

test('a provider-scoped override wins over the generic row', () => {
  const catalog = mergeCatalog(DEEPSEEK_CATALOG, [
    {
      id: 'jiyuan/deepseek-v4-flash',
      currency: 'CNY',
      perMillion: { cacheRead: 0.5, uncachedInput: 3, output: 12 },
      contextTokens: 128_000,
      maxOutputTokens: 8_000,
    },
  ]);
  const hit = resolveModel('deepseek-v4-flash-0731', catalog, { provider: 'jiyuan' });
  assert.equal(hit.kind === 'known' && hit.entry.perMillion.output, 12);
  assert.equal(hit.kind === 'known' && hit.via, 'provider-scoped');
  const generic = resolveModel('deepseek-v4-flash-0731', catalog, { provider: 'other' });
  assert.equal(generic.kind === 'known' && generic.entry.id, 'deepseek-flash');
});

test('budget converts back into sayable tokens', () => {
  const within = tokensWithinBudget(fromMajor(1), pro, { uncachedInput: 80, output: 15, cacheRead: 5 }, {
    at: bj(2026, 9, 16, 1),
  });
  const back = costOf({ ...within }, pro, { at: bj(2026, 9, 16, 1) });
  assert.ok(Math.abs(back.micros - 1_000_000) < 100, `round trip off by ${back.micros - 1_000_000}`);
});

test('blended price tracks the cache hit rate', () => {
  const cold = blendedPricePerMillion(flash, { input: 100, output: 10, cacheRead: 0 }, 'offpeak');
  const warm = blendedPricePerMillion(flash, { input: 100, output: 10, cacheRead: 500 }, 'offpeak');
  assert.ok(warm < cold, `${warm} should be cheaper than ${cold}`);
});

test('regime is reported as offpeak for flat-priced models', () => {
  const flat = mergeCatalog(DEEPSEEK_CATALOG, [
    {
      id: 'test-flat',
      currency: 'USD',
      perMillion: { cacheRead: 0.1, uncachedInput: 1, output: 3 },
      contextTokens: 200_000,
      maxOutputTokens: 64_000,
    },
  ]).entries.find((e) => e.id === 'test-flat')!;
  assert.equal(regimeAt(bj(2026, 9, 16, 10)), 'peak');
  assert.equal(costOf({ uncachedInput: 1000, output: 0, cacheRead: 0 }, flat, { at: bj(2026, 9, 16, 10) }).regime, 'offpeak');
});

test('the snapshot self-reports staleness', () => {
  const days = catalogAgeDays(DEEPSEEK_CATALOG.asOf, new Date('2026-10-01T00:00:00Z'));
  assert.equal(days, 10);
  assert.equal(isCatalogStale(DEEPSEEK_CATALOG, bj(2026, 12, 31, 1)), true);
  assert.equal(isCatalogStale(DEEPSEEK_CATALOG, bj(2026, 9, 22, 1)), false);
});
