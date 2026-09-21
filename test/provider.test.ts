import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  catalogFromProviderModels,
  normalizeOpenAiUsage,
  pickModelByBudget,
  selectModelsByBudget,
  usageCostMicros,
} from '../src/provider.ts';
import { resolveModel } from '../src/pricing/resolve.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/models.tokenrhythm.json', import.meta.url), 'utf8'));
const { catalog, priced, unpriced } = catalogFromProviderModels(fixture.data, {
  provider: 'jiyuan',
  baseUrl: 'https://tokenrhythm.studio/v1/models',
  asOf: '2026-09-21',
});
const entryFor = (id: string) => {
  const hit = resolveModel(id, catalog, { provider: 'jiyuan' });
  assert.equal(hit.kind, 'known', `no price row for ${id}`);
  return hit.kind === 'known' ? hit.entry : null;
};

test('a provider that publishes its rate card becomes a real catalog', () => {
  assert.equal(priced, 5);
  assert.deepEqual(unpriced, []);
  assert.equal(catalog.source, 'https://tokenrhythm.studio/v1/models');
  assert.equal(catalog.entries.every((entry) => entry.id.startsWith('jiyuan/')), true);
});

test('the relay charges 3x DeepSeek official for the dated flash build', () => {
  const relay = entryFor('deepseek-v4-flash-0731')!;
  assert.deepEqual(relay.perMillion, { uncachedInput: 3, output: 9, cacheRead: 0.1 });
  // the official sheet prices flash at 1/4 (off-peak); guessing from the name would
  // have understated this bill by 3x, which is exactly the bug this test pins
  assert.ok(relay.perMillion.uncachedInput > 1.9, 'relay price must not be replaced by the official one');
  assert.equal(relay.currency, 'CNY');
  assert.equal(relay.contextTokens, 1_000_000);
});

test('a missing cache price falls back to the input price, not to free', () => {
  const minimax = entryFor('minimax-m2.7')!;
  assert.equal(minimax.perMillion.cacheRead, minimax.perMillion.uncachedInput);
});

test('prompt_tokens contains cached_tokens on this gateway', () => {
  const observed = normalizeOpenAiUsage({
    prompt_tokens: 687,
    completion_tokens: 120,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 120 },
  });
  assert.deepEqual(observed, { uncachedInput: 687, cacheRead: 0, output: 120, cacheWrite: 0 });

  const warm = normalizeOpenAiUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } });
  assert.deepEqual(warm, { uncachedInput: 200, cacheRead: 800, output: 50, cacheWrite: 0 });

  const nonsense = normalizeOpenAiUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 900 } });
  assert.deepEqual({ ...nonsense, cacheRead: nonsense.cacheRead }, { uncachedInput: 0, cacheRead: 100, output: 5, cacheWrite: 0 });
});

test('a probe call bills to the micro-yuan we actually paid', () => {
  const usage = { prompt_tokens: 687, completion_tokens: 120 };
  // 687 x 0.8 + 120 x 2.7 = 549.6 + 324 = 873.6 micros
  assert.equal(usageCostMicros(usage, entryFor('qwen3.8-flash')!), 874);
});

test('credits decide the menu: an expensive model drops out first', () => {
  const need = { uncachedInput: 20_000, output: 6_000, cacheRead: 0 };
  const poor = pickModelByBudget(catalog, { need, remainingMicros: 60_000 });
  assert.ok(poor.pick, 'something must still be affordable');
  assert.equal(poor.pick!.entry.id, 'jiyuan/qwen3.8-flash');
  assert.equal(poor.ranking.filter((f) => f.fits).length, 1, 'only the cheap one fits ¥0.06');

  const rich = pickModelByBudget(catalog, { need, remainingMicros: 15_000_000 });
  assert.equal(rich.ranking.filter((f) => f.fits).length, 5);
  assert.equal(rich.ranking.every((f, i, all) => i === 0 || all[i - 1]!.costMicros <= f.costMicros), true, 'cheapest first');
});

test('a reserve keeps enough for the steps after this one', () => {
  const need = { uncachedInput: 20_000, output: 6_000, cacheRead: 0 };
  const qwenCost = selectModelsByBudget(catalog, { need, remainingMicros: 10_000_000 })[0]!.costMicros;
  const tight = pickModelByBudget(catalog, { need, remainingMicros: qwenCost * 2, reserveFraction: 0.6 });
  assert.equal(tight.pick, undefined, 'reserving 60% of two calls\' worth leaves nothing spendable');
  const loose = pickModelByBudget(catalog, { need, remainingMicros: qwenCost * 10, reserveFraction: 0.6 });
  assert.ok(loose.pick, 'ten calls\' worth still spends 40%');
});

test('a flaky model can be taken off the menu', () => {
  const excluded = selectModelsByBudget(catalog, {
    need: { uncachedInput: 1000, output: 100, cacheRead: 0 },
    remainingMicros: 15_000_000,
    exclude: ['qwen3.8-flash'],
  });
  assert.equal(excluded.some((f) => f.entry.id === 'jiyuan/qwen3.8-flash'), false);
  assert.equal(excluded[0]!.entry.id, 'jiyuan/minimax-m2.7');
});
