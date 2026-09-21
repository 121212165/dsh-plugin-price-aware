import { resolveModel, DEEPSEEK_CATALOG, costOf } from '../lib/pricing/index.js';
import { renderMoneyContext, renderTiers } from '../lib/advice.js';
import { buildTiers, reconEstimate, reconCost, shouldRecon } from '../lib/estimate.js';
import { decide } from '../lib/gate.js';
import { resolveBudget, DEFAULT_CONFIG } from '../lib/config.js';
import { emptyBuckets } from '../lib/pricing/cost.js';
import { formatMoney, fromMajor } from '../lib/money.js';

const catalog = { ...DEEPSEEK_CATALOG };
const policy = resolveBudget(DEFAULT_CONFIG);
const at = new Date('2026-09-21T03:30:00Z'); // 北京 11:30 周一 = 高峰
const resolution = resolveModel('deepseek-v4-pro', catalog);
const entry = resolution.entry;
const totals = { micros: 3_840_000, buckets: emptyBuckets(), tokens: 0, turns: 34, steps: 61, cacheHitRate: .71, costPerTurnMicros: 113000, ratio: { uncachedInput: 250_000, output: 40_000, cacheRead: 600_000 }, unpricedEvents: 0 };

console.log('=== 1) 模型每轮读到的上下文 ===');
console.log(renderMoneyContext({ resolution, now: at, balanceMicros: 41_200_000, spentMicros: 3_840_000, policy, totals }));

console.log('\n=== 2) 一次 refactor 的三档报价 ===');
const tiers = buildTiers({ kind: 'refactor', residentTokens: 20_000 }, entry, { at });
console.log(renderTiers(tiers));
const recon = reconEstimate({ kind: 'refactor', residentTokens: 20_000 });
console.log(`侦察费 ${formatMoney(reconCost(recon, entry), entry.currency)} / 是否值得: ${shouldRecon(tiers[1].estimate, entry, fromMajor(0.5), at)}`);

console.log('\n=== 3) 超预算时那一句问话 ===');
const d = decide({ spentMicros: 3_840_000, projectedMicros: 2_000_000, entry, downgradeTo: resolveModel('deepseek-flash', catalog).entry, balanceMicros: 41_200_000, ratio: totals.ratio, policy, now: at });
console.log(`[${d.kind}] ${d.headline}`);
for (const o of d.options) console.log(`   ${o.label} — ${o.detail}`);

console.log('\n=== 4) 实际一次调用的账单 ===');
const bill = costOf({ uncachedInput: 12_400, cacheRead: 88_000, output: 2_100 }, entry, { at });
console.log(bill.lines.map(l => `   ${l.kind.padEnd(14)} ${l.tokens.toLocaleString().padStart(9)} × ${l.pricePerMillion}/M = ${formatMoney(l.micros, 'CNY')}`).join('\n'));
console.log(`   合计 ${formatMoney(bill.micros, bill.currency)}（${bill.regime}）`);
