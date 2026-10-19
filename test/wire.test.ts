/** Wire-level assembly tests for price-aware: the real apply() against a mock
 * context, registering the plugin's commands, tools, prompt section and event
 * listeners, then driving synthetic usage events and tool-call hooks end-to-end
 * with an in-memory ledger and no HTTP.
 * @module test/wire.test */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeHarness, type Harness } from './harness.ts';

/** A row without peakMultiplier keeps every number in this file off-peak, so the
 * assertions do not depend on the wall clock the suite runs under. */
const ENTRY = {
  id: 'price-aware-test-model',
  currency: 'USD',
  perMillion: { uncachedInput: 300, output: 600, cacheRead: 30 },
  contextTokens: 1_000_000,
  maxOutputTokens: 64_000,
  aliases: [],
  note: 'wiring fixture',
};

/** input 2k uncached @300 + 5k cached @30 + 1k output @600 per million = $1.35 */
const USAGE = { inputTokens: 2_000, outputTokens: 1_000, cacheReadTokens: 5_000 };

async function mounted(config: Record<string, unknown> = {}): Promise<Harness> {
  const harness = makeHarness();
  await harness.apply({ prices: [ENTRY], ...config });
  return harness;
}

test('bad config fails loud naming price-aware; disabled mounts nothing', async () => {
  const bad = makeHarness();
  await assert.rejects(bad.apply({ taskAskMajor: -1 }), /price-aware 配置无效 -> taskAskMajor/);
  const off = makeHarness();
  await off.apply({ enabled: false });
  assert.equal(off.commands.length, 0);
  assert.equal(off.tools.length, 0);
  assert.equal(off.sections.length, 0);
  assert.equal(off.events.length, 0);
});

test('apply wires /money /budget /estimate, two tools, the money block and five listeners', async () => {
  const harness = await mounted();
  assert.deepEqual(
    harness.commands.map((command) => command.name).sort(),
    ['budget', 'estimate', 'money'],
  );
  assert.deepEqual(
    harness.tools.map((tool) => tool.name).sort(),
    ['price_status', 'quote_task'],
  );
  assert.deepEqual(
    [...harness.events].sort(),
    ['agent/request', 'session/disposed', 'session/event', 'tools/post-execute', 'tools/pre-execute'].sort(),
  );
  const section = harness.sections[0]!;
  assert.equal(section.name, 'price-aware.money');
  assert.ok(section.order! >= 40);
  assert.ok(harness.sectionText({ session: { id: 'wire' } }).startsWith('钱:'), 'the block is injected every turn');
});

test('injectIntoPrompt: false skips the prompt section but keeps events, commands and tools', async () => {
  const harness = await mounted({ injectIntoPrompt: false });
  assert.equal(harness.sections.length, 0);
  assert.equal(harness.commands.length, 3);
  assert.equal(harness.tools.length, 2);
  assert.equal(harness.events.length, 5);
});

test('no usage and no volume: /money and the section say the model is unknown, /budget states the tier', async () => {
  const harness = await mounted();
  const agent = { session: { id: 'wire' } };
  assert.match((await harness.command('money').handler({ agent })).text, /模型 unknown 不在价表内/);
  assert.match(harness.sectionText(agent), /不在价表内/);
  const budget = await harness.command('budget').handler({ agent });
  assert.match(budget.text, /normal 模式：会话 ¥10\.00，花到 75% 或单步 ≥¥1\.50/);
});

test('session/event usage events land in the ledger and /money, the section and price_status read them back', async () => {
  const harness = await mounted();
  const agent = { session: { id: 'wire' } };
  await harness.emitUsage('wire', 'price-aware-test-model', USAGE);

  const block = harness.sectionText(agent);
  assert.ok(block.includes('price-aware-test-model 单价(每百万 token, USD) 输入 300 · 缓存命中 30 · 输出 600'), block);
  assert.ok(block.includes('本会话已花 $1.35/$10.00（模式 normal） · 1 轮 · 缓存命中 71%'), block);
  assert.match((await harness.command('money').handler({ agent })).text, /本会话已花 \$1\.35/);

  // a second turn accumulates: +1k uncached input = +$0.30
  await harness.emitUsage('wire', 'price-aware-test-model', { inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0 });
  assert.match((await harness.command('money').handler({ agent })).text, /本会话已花 \$1\.65\/\$10\.00（模式 normal） · 2 轮/);

  const tool = await harness.tool('price_status').execute({}, agent);
  assert.ok(tool.includes('$1.65'), tool);
  assert.ok(tool.includes('normal 模式'), tool);
});

test('an unpriced model records unpriced events and every surface says the spend is unknown', async () => {
  const harness = await mounted();
  const agent = { session: { id: 'stranger' } };
  await harness.emitUsage('stranger', 'mystery/llm-7', USAGE);

  const block = harness.sectionText(agent);
  assert.ok(block.includes('模型 mystery/llm-7 不在价表内'), block);
  assert.ok(!block.includes('$'), 'no invented money for an unknown model');
  const unknown = await harness.command('estimate').handler({ agent, rawInput: 'refactor' });
  assert.equal(unknown.kind, 'error');
  assert.match(unknown.text, /mystery\/llm-7 不在价表内，花费未知。先补 price-aware\.prices/);
});

test('session/disposed drops the ledger so a long-lived host does not bill two sessions as one', async () => {
  const harness = await mounted();
  const agent = { session: { id: 'short' } };
  await harness.emitUsage('short', 'price-aware-test-model', USAGE);
  const before = await harness.command('money').handler({ agent });
  assert.match(before.text, /本会话已花 \$1\.35/);

  harness.dispose({ id: 'short' });
  const after = harness.sectionText(agent);
  assert.ok(!after.includes('本会话已花'), after);
  assert.ok(after.includes('不在价表内'), 'the released session starts with a fresh unknown ledger');
});

test('/budget quotes a raise without touching config; /estimate prices a three-tier plan', async () => {
  const harness = await mounted();
  const agent = { session: { id: 'wire' } };
  await harness.emitUsage('wire', 'price-aware-test-model', USAGE);

  const raise = await harness.command('budget').handler({ agent, rawInput: '7' });
  assert.ok(raise.text.includes('设为 $7.00 需要落到配置里才生效'), raise.text);
  assert.ok(raise.text.includes('sessionCapMajor: 7'), raise.text);
  assert.ok(raise.text.includes('当前已花 $1.35'), raise.text);
  const nonsense = await harness.command('budget').handler({ agent, rawInput: '-x' });
  assert.equal(nonsense.kind, 'error');

  const estimate = await harness.command('estimate').handler({ agent, rawInput: 'refactor 10 20' });
  assert.ok(estimate.text.includes('A 最小可用'), estimate.text);
  assert.ok(estimate.text.includes('$81.84（±40% · 10 轮）'), estimate.text, 'the B tier carries the standard estimate');
  assert.ok(estimate.text.includes('C 彻底'), estimate.text);
  assert.ok(estimate.text.includes('只读侦察'), estimate.text, 'a big plan earns the recon branch');

  const quoted = await harness.tool('quote_task').execute({ kind: 'refactor', turns: 10, residentTokens: 20_000 }, agent);
  assert.ok(quoted.includes('$81.84'), quoted);
});

test('a priced cross-plugin sheet arrives through ctx.reflect.get when the own catalog cannot match', async () => {
  const harness = makeHarness({
    reflect: new Map([['pricing-catalog', { asOf: '2026-10-01', source: 'cost-ledger', entries: [ENTRY] }]]),
  });
  await harness.apply();
  const agent = { session: { id: 'wire' } };
  await harness.emitUsage('wire', 'price-aware-test-model', USAGE);
  const block = harness.sectionText(agent);
  assert.ok(block.includes('本会话已花 $1.35'), block, 'the shared sheet priced the event even with prices: []');
  assert.ok(!block.includes('不在价表内'), block);
});

test('a call whose single-step estimate heads over the ask threshold continues, and the advice rides post-execute', async () => {
  const harness = await mounted({ taskAskMajor: 0.05 });
  const agent = { session: { id: 'wire' } };
  await harness.emitUsage('wire', 'price-aware-test-model', USAGE);

  const exec = { name: 'read_file', rootCallId: 'call-1', agent };
  let preCalls = 0;
  const passed = await harness.emitPre(exec, async () => {
    preCalls++;
    return 'PASSED';
  });
  assert.equal(passed, 'PASSED');
  assert.equal(preCalls, 1, 'an ask decision continues the call, the note is deferred to post-execute');

  const downstream = { kind: 'success', text: 'tool-result' };
  let postCalls = 0;
  const posted = (await harness.emitPost(exec, downstream, () => {
    postCalls++;
    return downstream;
  })) as { additionalContexts?: Array<{ content: Array<{ text: string }> }> };

  assert.equal(postCalls, 1, 'next() runs exactly once');
  const note = posted.additionalContexts?.[0];
  assert.ok(note, 'the advice did not ride pre-execute, which may only allow/deny');
  assert.equal((note as { source?: { kind?: string } }).source?.kind, 'plugin:price-aware');
  const text = JSON.stringify(note);
  assert.ok(text.includes('预算提示'), text);
  assert.ok(text.includes('缩小范围'), text);
  assert.ok(text.includes('把这几个选项原样转给用户'), text);

  // the advice is consumed: a second post for the same call is a plain pass-through
  const again = (await harness.emitPost(exec, downstream, () => downstream)) as unknown;
  assert.deepEqual(again, downstream);
});

test('a call whose spend would keep the session over its cap is denied at pre-execute with options', async () => {
  const harness = await mounted({ mode: 'custom', taskAskMajor: 0.05, sessionCapMajor: 0.0002, prices: [ENTRY] });
  const agent = { session: { id: 'capped' } };
  await harness.emitUsage('capped', 'price-aware-test-model', USAGE);

  let nextCalls = 0;
  const blocked = (await harness.emitPre(
    { name: 'read_file', rootCallId: 'call-blocked', agent },
    async () => {
      nextCalls++;
      return 'SHOULD NOT RUN';
    },
  )) as { kind: string; reason: string };

  assert.equal(nextCalls, 0, 'a block decision must not even call the tool once');
  assert.equal(blocked.kind, 'ask', 'dsh pre-execute cannot hard-refuse, it asks the user');
  assert.ok(blocked.reason.includes('预算提示'), blocked.reason);
  assert.ok(blocked.reason.includes('超出会话预算'), blocked.reason);

  // the host may proceed anyway; the note then rides post-execute
  const posted = (await harness.emitPost(
    { name: 'read_file', rootCallId: 'call-blocked', agent },
    { kind: 'success', text: 'tool-result' },
    () => ({ kind: 'success', text: 'tool-result' }),
  )) as { additionalContexts?: Array<{ content: Array<{ text: string }> }> };
  assert.ok(JSON.stringify(posted.additionalContexts?.[0]).includes('预算提示'));
});

test('pre-execute passes a call whose estimate is under the ask threshold straight through', async () => {
  const harness = await mounted();
  const passed = await harness.emitPre(
    { name: 'read_file', rootCallId: 'call-cheap', agent: { session: { id: 'wire' } } },
    async () => 'PASSED',
  );
  assert.equal(passed, 'PASSED', 'the $0.63 estimate is under the default $1.50 ask threshold');
});

test('post-execute passes untouched results through when no advice is pending', async () => {
  const harness = await mounted();
  const downstream = { kind: 'success', text: 'clean' };
  const passed = (await harness.emitPost(
    { name: 'read_file', rootCallId: 'call-clean', agent: { session: { id: 'wire' } } },
    downstream,
    () => downstream,
  )) as unknown;
  assert.deepEqual(passed, downstream);
});
