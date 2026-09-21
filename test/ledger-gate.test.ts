import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger, toBuckets } from '../src/ledger.ts';
import { DEEPSEEK_CATALOG } from '../src/pricing/catalog.ts';
import { resolveModel } from '../src/pricing/resolve.ts';
import { preset, decide, type GateInput } from '../src/gate.ts';

const flash = DEEPSEEK_CATALOG.entries[0]!;
const pro = DEEPSEEK_CATALOG.entries[1]!;
const known = (id: string) => resolveModel(id, DEEPSEEK_CATALOG);
const bj = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi) - 8 * 3_600_000);
const wedPeak = bj(2026, 9, 16, 10);

function ledgerFor(model: string) {
  return new Ledger(() => known(model), { now: () => wedPeak });
}

test('dsh usage counts are already disjoint, so nothing gets billed twice', () => {
  const buckets = toBuckets({ inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 90_000 });
  assert.deepEqual(buckets, { uncachedInput: 10_000, cacheRead: 90_000, output: 1_000, cacheWrite: 0 });
});

test('a raw OpenAI-shaped prompt_tokens can be told apart from its cached prefix', () => {
  const buckets = toBuckets({ inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 90_000 }, true);
  assert.equal(buckets.uncachedInput, 10_000);
});

test('reasoning tokens never become a separate line item', () => {
  const withReasoning = ledgerFor('deepseek-v4-pro');
  withReasoning.record({ turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 500, reasoningTokens: 400 } });
  const plain = ledgerFor('deepseek-v4-pro');
  plain.record({ turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 500 } });
  assert.equal(withReasoning.spentMicros(), plain.spentMicros());
  // peak pro: 1000 x 9 + 500 x 27 = 22_500
  assert.equal(plain.spentMicros(), 22_500);
});

test('the ledger tracks turns, ratios and an unpriced tail', () => {
  const ledger = new Ledger((e) => known(e.modelId ?? 'deepseek-v4-pro'), { now: () => wedPeak });
  ledger.record({ turn: 1, step: 1, usage: { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 5_000 } });
  ledger.record({ turn: 1, step: 2, usage: { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 9_000 } });
  ledger.record({ turn: 2, step: 1, usage: { inputTokens: 2_000, outputTokens: 200 } });
  const dropped = ledger.record({ turn: 2, step: 2, usage: { inputTokens: 100, outputTokens: 10 }, modelId: 'gpt-99' });
  assert.equal(dropped, null);

  const totals = ledger.totals();
  assert.equal(totals.turns, 2);
  assert.equal(totals.steps, 3);
  assert.equal(totals.unpricedEvents, 1);
  assert.equal(totals.buckets.cacheRead, 14_000);
  assert.equal(ledger.spentInTurn(1) + ledger.spentInTurn(2), totals.micros);
  assert.ok(ledger.spentInTurn(1) > ledger.spentInTurn(2));
  assert.equal(totals.cacheHitRate, 14_000 / (14_000 + totals.buckets.uncachedInput));
  assert.equal(Math.round(totals.costPerTurnMicros * 2), totals.micros);
});

test('each event is priced against the model that served it', () => {
  const ledger = new Ledger((e) => known(e.modelId ?? 'deepseek-v4-pro'), { now: () => wedPeak });
  const usage = { inputTokens: 100_000, outputTokens: 10_000 };
  ledger.record({ turn: 1, step: 1, usage, modelId: 'deepseek-v4-pro' });
  const before = ledger.spentMicros();
  ledger.record({ turn: 1, step: 2, usage, modelId: 'deepseek-flash' });
  const after = ledger.spentMicros();
  assert.ok(after - before < before / 4, `flash should be a fraction of pro: ${before} then ${after}`);
});

function gateInput(over: Partial<GateInput> = {}): GateInput {
  return {
    spentMicros: 100_000,
    projectedMicros: 200_000,
    entry: pro,
    ratio: { uncachedInput: 80_000, output: 12_000, cacheRead: 500_000, cacheWrite: 0 },
    policy: preset('normal'),
    now: wedPeak,
    ...over,
  } as GateInput;
}

test('quiet when there is nothing to say', () => {
  assert.equal(decide(gateInput({ spentMicros: 1_000, projectedMicros: 0 })).kind, 'allow');
  assert.equal(decide(gateInput({ policy: preset('max') })).kind, 'allow');
});

test('a big next step earns a pre-flight question with real numbers', () => {
  const decision = decide(gateInput({ projectedMicros: 2_000_000, downgradeTo: flash }));
  assert.equal(decision.kind, 'ask');
  if (decision.kind !== 'ask') return;
  const ids = decision.options.map((o) => o.id);
  assert.deepEqual(ids.filter((i) => i !== 'raise'), ['continue', 'downgrade', 'narrow', 'defer', 'stop']);
  const downgrade = decision.options.find((o) => o.id === 'downgrade')!;
  assert.ok(downgrade.savingMicros! > 0 && downgrade.costMicros! < 2_000_000);
  const defer = decision.options.find((o) => o.id === 'defer')!;
  assert.equal(defer.savingMicros, 1_000_000, 'peak x2 means deferral saves half');
  assert.equal(decision.options.find((o) => o.id === 'continue')!.costMicros, 2_000_000);
});

test('downgrade is offered by price ratio, not by guesswork', () => {
  const sameRatio = decide(gateInput({ projectedMicros: 2_000_000, entry: flash, downgradeTo: pro }));
  if (sameRatio.kind === 'allow') return assert.fail('expected a question');
  const downgrade = sameRatio.options.find((o) => o.id === 'downgrade');
  assert.equal(downgrade, undefined, 'flash is already the cheap one');
});

test('hitting the session cap blocks and offers to raise it', () => {
  const decision = decide(gateInput({ spentMicros: 9_900_000, projectedMicros: 200_000 }));
  assert.equal(decision.kind, 'block');
  if (decision.kind !== 'block') return;
  assert.ok(decision.options.some((o) => o.id === 'raise'));
  assert.equal(decision.options.find((o) => o.id === 'continue'), undefined, 'no silent continue past the cap');
});

test('a thin account blocks even when the session budget is wide', () => {
  const decision = decide(gateInput({ balanceMicros: 3_500_000, spentMicros: 3_000_000, projectedMicros: 200_000 }));
  assert.equal(decision.kind, 'block');
  if (decision.kind === 'block') assert.ok(decision.headline.includes('余额'));
});

test('off-peak work gets no deferral option', () => {
  const decision = decide(gateInput({ projectedMicros: 2_000_000, now: bj(2026, 9, 16, 1) }));
  if (decision.kind === 'allow') return assert.fail('expected ask');
  assert.ok(!decision.options.some((o) => o.id === 'defer'));
});
