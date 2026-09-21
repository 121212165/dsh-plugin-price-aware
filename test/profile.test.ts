import assert from 'node:assert/strict';
import { test } from 'node:test';
import { profileModels, rankByUsableCost, recommendMaxTokens, type CallObservation } from '../src/profile.ts';
import { readFileSync } from 'node:fs';
import { catalogFromProviderModels } from '../src/provider.ts';
import { fromMajor } from '../src/money.ts';

/** shapes taken from the round-2 paid run against TokenRhythm */
const observations: CallObservation[] = [
  // qwen3.8-flash spent its whole cap on reasoning and returned nothing twice, once it wrote 431 chars
  { modelId: 'qwen3.8-flash', actualMicros: 900, promptTokens: 71, completionTokens: 300, requestedMaxTokens: 300, reasoningTokens: 300, visibleChars: 0 },
  { modelId: 'qwen3.8-flash', actualMicros: 3500, promptTokens: 675, completionTokens: 1080, requestedMaxTokens: 1800, reasoningTokens: 1080, visibleChars: 0 },
  { modelId: 'qwen3.8-flash', actualMicros: 3700, promptTokens: 3688, completionTokens: 285, requestedMaxTokens: 400, reasoningTokens: 57, visibleChars: 431 },
  // a non-thinking model that actually writes
  { modelId: 'deepseek-v4-flash-0731', actualMicros: 2200, promptTokens: 45, completionTokens: 226, requestedMaxTokens: 1500, reasoningTokens: 0, visibleChars: 451 },
  // round 3's real shape: the cap was the binding constraint, so the file came back cut off
  { modelId: 'deepseek-v4-flash-0731', actualMicros: 29_300, promptTokens: 622, completionTokens: 3044, requestedMaxTokens: 3044, reasoningTokens: 0, visibleChars: 6977 },
  // expensive and nearly silent
  { modelId: 'kimi-k3', actualMicros: 153_000, promptTokens: 126, completionTokens: 1500, requestedMaxTokens: 1500, reasoningTokens: 1500, visibleChars: 16 },
];

const profiles = profileModels(observations);
// the same gateway the paid test hit: its rows are provider-scoped, and profile keys
// are the bare model id, so this is the only catalog that can join the two
const { catalog } = catalogFromProviderModels(
  JSON.parse(readFileSync(new URL('./fixtures/models.tokenrhythm.json', import.meta.url), 'utf8')).data,
  { provider: 'jiyuan' },
);

test('a model that bills without producing text is flagged, not averaged away', () => {
  const qwen = profiles.get('qwen3.8-flash')!;
  assert.equal(qwen.calls, 3);
  assert.equal(qwen.starving, false, 'it did write once, so it is not hopeless — just unreliable at small caps');
  assert.ok(qwen.reasoningShare > 0.5 && qwen.reasoningShare < 1, `reasoningShare ${qwen.reasoningShare}`);
  assert.ok(qwen.microPerKiloChar! > 0);

  const kimi = profiles.get('kimi-k3')!;
  assert.equal(kimi.reasoningShare, 1);
  assert.equal(kimi.microPerKiloChar, 153_000 / 0.016);
});

test('fill rate is completion over the cap we asked for', () => {
  assert.equal(profiles.get('kimi-k3')!.fillRate, 1, 'it used every last requested token');
  const single = profileModels([observations[3]!]).get('deepseek-v4-flash-0731')!;
  assert.equal(single.fillRate, 226 / 1500, 'a small answer under a big cap shows the model stopped early');
  // round 3 added a call that ran to the ceiling, so the merged profile must reflect both
  assert.equal(profiles.get('deepseek-v4-flash-0731') === undefined, false);
});

test('ranking puts observed writers ahead of unknown models and hides the silent', () => {
  const ranking = rankByUsableCost(catalog.entries, profiles, {
    wantChars: 4_000,
    remainingMicros: fromMajor(5),
    promptTokens: 700,
  });
  assert.equal(ranking[0]!.modelId, 'deepseek-v4-flash-0731', 'cheapest per kilo of visible output');
  assert.equal(ranking.find((fit) => fit.modelId === 'kimi-k3')!.fits, false, 'a model that answers in reasoning only is not a candidate');
  const unknown = ranking.find((fit) => fit.modelId === 'deepseek-v4-pro-0813')!;
  assert.equal(unknown.profile, null);
  assert.ok(ranking.findIndex((f) => f.modelId === 'deepseek-v4-flash-0731') < ranking.findIndex((f) => f.modelId === 'deepseek-v4-pro-0813'));
});

test('budget that cannot buy the wanted text rules the model out honestly', () => {
  const broke = rankByUsableCost(catalog.entries, profiles, { wantChars: 200_000, remainingMicros: 1000 });
  assert.equal(broke.every((fit) => !fit.fits), true);
});

test('a call that spent exactly its cap is recorded as cut off', () => {
  const writer = profileModels(observations).get('deepseek-v4-flash-0731')!;
  assert.equal(writer.capHitRate, 0.5, 'two calls, one of them ran to the ceiling');
  assert.equal(profileModels(observations).get('kimi-k3')!.capHitRate, 1);
  assert.ok(recommendMaxTokens(writer, 4000) > Math.round((4000 / writer.charsPerCompletionToken) * 1.35), 'the cap penalty widens a request that was truncated before');
});

test('max_tokens is sized from what a model actually spends', () => {
  const silent = profiles.get('kimi-k3')!;
  const writer = profiles.get('deepseek-v4-flash-0731')!;
  assert.equal(silent.charsPerCompletionToken, Number((16 / 1500).toFixed(3)));
  assert.equal(writer.charsPerCompletionToken, Number(((451 + 6977) / (226 + 3044)).toFixed(3)), 'yield per token aggregates across calls');
  assert.equal(recommendMaxTokens(writer, 4000), Math.round((4000 / writer.charsPerCompletionToken) * 1.35 * 1.5));
  assert.equal(recommendMaxTokens(silent, 4000), 64_000, 'hits the ceiling: that model cannot buy 4000 chars sanely');
  assert.ok(recommendMaxTokens(null, 4000) > 1500, 'an unknown model is assumed to write, not to think silently');
  assert.equal(recommendMaxTokens(writer, 0), 200, 'never ask for a cap that cannot hold an answer');
});
