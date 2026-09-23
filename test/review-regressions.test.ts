/**
 * Regression suite for the 2026-09-21 code review.
 *
 * Each test here exists because a real defect was found and fixed; they are named
 * after the failure mode, not the function, so a future refactor cannot quietly
 * restore the bug while keeping the unit tests green.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEEPSEEK_CATALOG, mergeCatalog } from '../src/pricing/catalog.ts';
import { costOf, emptyBuckets } from '../src/pricing/cost.ts';
import { isPeakAt, nextRegimeChange } from '../src/pricing/window.ts';
import { resolveModel } from '../src/pricing/resolve.ts';
import { catalogFromProviderModels } from '../src/provider.ts';
import { decide, preset } from '../src/gate.ts';
import { DEFAULT_CONFIG, resolveBudget, validateConfig } from '../src/config.ts';
import { renderMoneyContext } from '../src/advice.ts';
import { classifyChunks, extractCodeChunks } from '../src/fences.ts';
import { profileModels } from '../src/profile.ts';

const bj = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi) - 8 * 3_600_000);
const peakWednesday = bj(2026, 9, 16, 10);
const pro = DEEPSEEK_CATALOG.entries[1]!;

test('a price edit does not silently switch peak billing off', () => {
  const need = { uncachedInput: 100_000, output: 20_000, cacheRead: 800_000 };
  const edited = mergeCatalog(DEEPSEEK_CATALOG, [
    { id: 'deepseek-v4-pro', currency: 'CNY', perMillion: { uncachedInput: 4.5, output: 13.5, cacheRead: 0.15 } } as never,
  ]).entries.find((entry) => entry.id === 'deepseek-v4-pro')!;
  assert.equal(edited.peakMultiplier, 2, 'the row edited a rate, it did not deny the peak rule exists');
  assert.equal(costOf(need, edited, { at: peakWednesday }).micros, costOf(need, pro, { at: peakWednesday }).micros);
  assert.equal(isPeakAt(peakWednesday), true);
});

test('a half-written price row is rejected at load instead of becoming free tokens', () => {
  const problems = validateConfig({
    ...DEFAULT_CONFIG,
    prices: [{ id: 'mystery', currency: 'CNY', perMillion: { uncachedInput: 1, output: NaN, cacheRead: 0 } }] as never,
  });
  assert.ok(problems.some((p) => p.field === 'prices' && /output/.test(p.message)), JSON.stringify(problems));

  const missingCache = validateConfig({
    ...DEFAULT_CONFIG,
    prices: [{ id: 'mystery', currency: 'CNY', perMillion: { uncachedInput: 1, output: 2 } }] as never,
  });
  assert.ok(missingCache.some((p) => /cacheRead/.test(p.message)), 'an absent cacheRead must be said out loud, not read as 0');
});

test('a broken ledger asks instead of waving the spend through', () => {
  // every numeric comparison in decide() is false for NaN, which used to mean
  // "within budget" — the gate must fail toward a question
  const decision = decide({
    spentMicros: Number.NaN,
    projectedMicros: 100_000,
    entry: pro,
    ratio: { ...emptyBuckets(), uncachedInput: 1000, output: 100 },
    policy: preset('normal'),
    now: peakWednesday,
  });
  assert.equal(decision.kind, 'ask');
  if (decision.kind === 'ask') assert.match(decision.headline, /算不出/);
});

test('max mode drops the budget nag but keeps the overdraw guard', () => {
  const max = resolveBudget({ ...DEFAULT_CONFIG, mode: 'max', taskAskMajor: 0.01, warnPercent: 1, balanceFloorMajor: 999 });
  assert.equal(Number.isFinite(max.taskSoftCapMicros), false, 'a sentinel must not be overwritten by a config default');
  assert.equal(max.warnFraction, 1, 'max means "never ask about the cap", whatever warnPercent says');

  const allowed = decide({
    spentMicros: 9_000_000,
    projectedMicros: 100_000,
    entry: pro,
    balanceMicros: null,
    ratio: { ...emptyBuckets(), uncachedInput: 1000, output: 100 },
    policy: max,
    now: peakWednesday,
  });
  assert.equal(allowed.kind, 'allow', 'no cap, unknown balance: nothing to say');

  // spending past what the account actually holds is not a budget preference,
  // so max mode keeps that one check
  const overdraw = decide({
    spentMicros: 9_000_000,
    projectedMicros: 100_000,
    entry: pro,
    balanceMicros: 500_000,
    ratio: { ...emptyBuckets(), uncachedInput: 1000, output: 100 },
    policy: max,
    now: peakWednesday,
  });
  assert.equal(overdraw.kind, 'block');
  if (overdraw.kind === 'block') assert.match(overdraw.headline, /余额/);
});

test('a rate card that omits the currency is refused, not assumed to be CNY', () => {
  const { priced, unpriced, catalog } = catalogFromProviderModels(
    [{ id: 'us-model', input_price_per_million: '1.50', output_price_per_million: '6.00', context_length: 1000, max_completion_tokens: 100 }],
    { provider: 'p' },
  );
  assert.equal(priced, 0);
  assert.deepEqual(unpriced, ['us-model']);
  assert.equal(catalog.entries.length, 0, 'booking $1.50 as ¥1.50 is a 7x error, not a rounding one');

  const told = catalogFromProviderModels(
    [{ id: 'us-model', input_price_per_million: '1.50', output_price_per_million: '6.00' }],
    { provider: 'p', defaultCurrency: 'USD' },
  );
  assert.equal(told.priced, 1);
  assert.equal(told.catalog.entries[0]!.currency, 'USD');
});

test('a guessed model match is disclosed to the model', () => {
  const guessed = resolveModel('deepseek-flash-lite', DEEPSEEK_CATALOG);
  assert.equal(guessed.kind === 'known' && guessed.confidence < 0.9, true, 'the match must carry its own doubt');
  const text = renderMoneyContext({
    resolution: guessed,
    now: peakWednesday,
    balanceMicros: null,
    spentMicros: 0,
    policy: preset('normal'),
    totals: {
      micros: 0,
      buckets: emptyBuckets(),
      tokens: 0,
      turns: 0,
      steps: 0,
      cacheHitRate: 0,
      costPerTurnMicros: 0,
      reasoningTokens: 0,
      ratio: { uncachedInput: 0, output: 0, cacheRead: 0 },
      unpricedEvents: 0,
    },
  });
  assert.match(text, /猜配/);
  assert.match(text, /把握 50%/);
});

test('the money block never points at a command that does not exist', () => {
  const unknown = renderMoneyContext({
    resolution: resolveModel('glm-9', DEEPSEEK_CATALOG),
    now: peakWednesday,
    balanceMicros: null,
    spentMicros: 0,
    policy: preset('normal'),
    totals: {
      micros: 0,
      buckets: emptyBuckets(),
      tokens: 0,
      turns: 0,
      steps: 0,
      cacheHitRate: 0,
      costPerTurnMicros: 0,
      reasoningTokens: 0,
      ratio: { uncachedInput: 0, output: 0, cacheRead: 0 },
      unpricedEvents: 0,
    },
  });
  assert.match(unknown, /price-aware\.prices/);
  assert.equal(/\/(price-add|price-refresh)/.test(unknown), false, 'advice told the model to run commands that were never registered');
});

test('a holiday blackout reports no next price change instead of inventing one', () => {
  const holidays = Array.from({ length: 45 }, (_, day) => new Date(Date.UTC(2026, 8, 16 + day)).toISOString().slice(0, 10));
  assert.equal(nextRegimeChange(peakWednesday, { holidays }), null);
});

test('tilde fences are code too, and do not close backtick blocks', () => {
  const tildes = ['~~~js t.js', 'export const t = 1;', '~~~'].join('\n');
  const [chunk] = extractCodeChunks(tildes);
  assert.equal(chunk?.file, 't.js');
  assert.ok(chunk?.body.includes('const t'));

  const mixed = ['```js a.js', "const s = '~';", '~~~', 'still inside the backtick block', '```'].join('\n');
  const [only] = extractCodeChunks(mixed);
  assert.equal(only?.file, 'a.js');
  assert.ok(only?.body.includes('still inside'), 'a tilde line must not terminate a backtick fence');
});

test('a truncated restatement cannot clobber a complete file', () => {
  const answer = [
    '```js good.js',
    'export function complete() {',
    '  return 1;',
    '}',
    '```',
    '```js good.js',
    'export function cutOff() {',
    '  return 2;',
  ].join('\n');
  const { kept } = classifyChunks(extractCodeChunks(answer));
  assert.equal(kept.length, 1);
  assert.match(kept[0]!.body, /complete\(\)/, 'the last complete definition wins');
  assert.equal(/cutOff/.test(kept[0]!.body), false);
});

test('a model that bills without writing is not made to look cheap', () => {
  const profiles = profileModels([
    { modelId: 'loud', actualMicros: 1_000_000, promptTokens: 100, completionTokens: 5000, requestedMaxTokens: 5000, reasoningTokens: 5000, visibleChars: 0 },
    { modelId: 'loud', actualMicros: 20_000, promptTokens: 100, completionTokens: 200, requestedMaxTokens: 5000, reasoningTokens: 0, visibleChars: 500 },
  ]).get('loud')!;
  // the wasted ¥1.00 must be in the price of the 500 characters it did deliver
  assert.equal(profiles.microPerKiloChar, Math.round(1_020_000 / 0.5));
});
