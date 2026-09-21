import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildTiers,
  calibrate,
  estimateTask,
  priceEstimate,
  reconCost,
  reconEstimate,
  shouldRecon,
  tokensForText,
} from '../src/estimate.ts';
import { DEEPSEEK_CATALOG } from '../src/pricing/catalog.ts';

const flash = DEEPSEEK_CATALOG.entries[0]!;
const pro = DEEPSEEK_CATALOG.entries[1]!;
const offPeak = new Date(Date.UTC(2026, 8, 16, 1) - 8 * 3_600_000);

test('chinese text costs about a token per glyph, code about a quarter', () => {
  assert.equal(tokensForText('重构计费内核'), Math.round(6 * 0.7));
  assert.equal(tokensForText('const x = 1'), Math.round(11 * 0.25));
  assert.equal(tokensForText(''), 0);
});

test('an agent turn pays for the whole history riding along', () => {
  const est = estimateTask({ kind: 'refactor', residentTokens: 20_000, growthTokensPerTurn: 2_000 });
  // 14 turns: 14 x 20k + 2k x 14 x 13 / 2 = 280k + 182k = 462k prompt tokens
  assert.equal(est.buckets.cacheRead + est.buckets.uncachedInput, 462_000);
  assert.ok(est.drivers[0]!.includes('缓存'), est.drivers[0] ?? '');
});

test('tier A is cheaper than B is cheaper than C, by more than a hair', () => {
  const tiers = buildTiers({ kind: 'refactor', residentTokens: 20_000 }, pro, { at: offPeak });
  const [a, b, c] = tiers.map((t) => t.cost.micros);
  assert.ok(a! < b! && b! < c!, `${a} ${b} ${c}`);
  assert.ok(b! / a! > 2, 'minimal should be a real discount, not a rounding difference');
  assert.ok(c! / b! > 1.5, 'thorough should be a real premium');
  assert.equal(tiers[0]!.id, 'minimal');
  assert.ok(tiers[2]!.estimate.turns > tiers[1]!.estimate.turns);
});

test('calibration moves the estimate without touching its shape', () => {
  const plain = estimateTask({ kind: 'refactor', residentTokens: 20_000, growthTokensPerTurn: 2_000 });
  const biased = estimateTask(
    { kind: 'refactor', residentTokens: 20_000, growthTokensPerTurn: 2_000 },
    { calibration: 1.5 },
  );
  assert.equal(biased.buckets.uncachedInput, Math.round(plain.buckets.uncachedInput * 1.5));
  assert.equal(biased.buckets.cacheRead, plain.buckets.cacheRead);
  assert.ok(biased.drivers.some((d) => d.includes('校准')));
});

test('recon only pays for itself on bills worth getting wrong', () => {
  const tiny = estimateTask({ kind: 'answer', residentTokens: 8_000 });
  const huge = estimateTask({ kind: 'refactor', residentTokens: 40_000, growthTokensPerTurn: 6_000 });
  assert.equal(shouldRecon(tiny, pro, 500_000, offPeak), false);
  assert.equal(shouldRecon(huge, pro, 500_000, offPeak), true);

  const recon = reconEstimate({ kind: 'refactor', residentTokens: 40_000, growthTokensPerTurn: 6_000 });
  assert.ok(reconCost(recon, pro, offPeak) < priceEstimate(huge, pro, { at: offPeak }).micros / 4, 'recon must stay cheap');
  assert.equal(recon.errorPct, 12);
});

test('estimates follow the clock', () => {
  const est = estimateTask({ kind: 'refactor', residentTokens: 20_000 });
  const cheap = priceEstimate(est, pro, { at: offPeak }).micros;
  const peaky = priceEstimate(est, pro, { at: new Date(offPeak.getTime() + 9 * 3_600_000) });
  assert.equal(peaky.regime, 'peak');
  assert.equal(peaky.micros, cheap * 2);
});

test('calibration learns the median miss, not the average', () => {
  assert.deepEqual(calibrate([]), { bias: 1, mape: 0, headroom: 0, worstOver: 1, n: 0 });
  const oneSidedBadGuess = calibrate([
    { predicted: 1_000_000, actual: 1_000_000 },
    { predicted: 1_000_000, actual: 1_100_000 },
    { predicted: 1_000_000, actual: 5_000_000 },
  ]);
  assert.equal(oneSidedBadGuess.bias, 1.1, 'the wild outlier must not drag the correction');
  assert.equal(oneSidedBadGuess.n, 3);
  assert.equal(oneSidedBadGuess.mape, 137, 'mean error measured against the quote, not the bill');
  assert.equal(oneSidedBadGuess.headroom, -137, 'negative headroom = the quote under-called reality');
  assert.equal(oneSidedBadGuess.worstOver, 1);

  const consistentlyLow = calibrate(
    Array.from({ length: 5 }, () => ({ predicted: 1_000_000, actual: 1_600_000 })),
  );
  assert.equal(consistentlyLow.bias, 1.6);
  assert.equal(consistentlyLow.headroom, -60);

  // round 2's real shape: the quote is a ceiling, most calls land under it
  const upperBound = calibrate([
    { predicted: 42_000, actual: 36_000 },
    { predicted: 136_000, actual: 22_000 },
    { predicted: 40_800, actual: 5_800 },
  ]);
  assert.ok(upperBound.headroom > 50, `headroom ${upperBound.headroom}`);
  assert.equal(upperBound.worstOver, 7, 'the worst quote billed 7x less than predicted');
});
