/** Wire-level unit coverage for the cross-plugin pricing fallback (plan 2.3):
 * with cost-ledger mounted in the same profile, price-aware resolves its
 * unknown models against the cordis `pricing-catalog` service instead of
 * dropping to the "unknown" guardrail text — and keeps the old behavior when
 * the service is absent.
 * @module test/catalog-fallback.test */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEEPSEEK_CATALOG, mergeCatalog } from '../src/pricing/catalog.ts';
import { apply } from '../src/plugin.ts';

interface PromptDef {
  name: string;
  text: (assemble: unknown) => string;
}

interface Captured {
  event: string;
  callback: (payload: unknown, next: (value?: unknown) => Promise<unknown>) => Promise<unknown>;
}

type MockCtx = Record<string, unknown> & { on(event: string, callback: Captured['callback']): void };

const PROBE = { id: 'probe-nemotron-x', currency: 'CNY' as const, perMillion: { cacheRead: 0.5, uncachedInput: 2, output: 4 } };

const config = {
  enabled: true,
  mode: 'normal',
  sessionCapMajor: 10,
  warnPercent: 75,
  taskAskMajor: 1.5,
  balanceFloorMajor: 3,
  currency: 'auto',
  balanceCheck: false,
  balanceTtlSeconds: 60,
  apiKeyEnv: ['AIRTEST_NOPE'],
  baseUrl: 'https://api.deepseek.com',
  prices: [],
  holidays: [],
  reconThresholdMajor: 0.5,
  injectIntoPrompt: true,
};

function mockCtx(shared?: object): { ctx: MockCtx; prompt: PromptDef[]; middlewares: Captured[] } {
  const prompt: PromptDef[] = [];
  const middlewares: Captured[] = [];
  const ctx: MockCtx = {
    logger: () => ({ info() {}, warn() {}, debug() {} }),
    on(event: string, callback: Captured['callback']) {
      middlewares.push({ event, callback });
    },
    commands: { register() {} },
    tools: { register() {} },
    systemPrompt: {
      context(definition: PromptDef) {
        prompt.push(definition);
      },
    },
    ...(shared ? { 'pricing-catalog': shared } : {}),
  };
  return { ctx, prompt, middlewares };
}

/** Drive the agent/request middleware so the session's model becomes the probe. */
async function setModel(middlewares: Captured[], model: string): Promise<void> {
  const agent = middlewares.find((m) => m.event === 'agent/request');
  assert.ok(agent, 'agent/request middleware was never registered');
  await agent.callback({ agent: { id: 'a1', session: { id: 's1' } } }, () => Promise.resolve({ model, provider: 'probe' }));
}

test('unknown model falls back to the cost-ledger pricing-catalog service', async () => {
  const shared = mergeCatalog(DEEPSEEK_CATALOG, [PROBE as never]);
  const { ctx, prompt, middlewares } = mockCtx(shared);
  apply(ctx as never, { ...config } as never);

  await setModel(middlewares, 'probe-nemotron-x');
  const def = prompt.find((candidate) => candidate.name === 'price-aware.money');
  assert.ok(def, 'money context was never injected');
  const text = def.text({ agent: { session: { id: 's1' } } });
  assert.ok(!text.includes('不在价表内'), text);
  assert.match(text, /[¥$€]/, text);
});

test('with no sibling service the unknown guardrail text is unchanged', async () => {
  const { ctx, prompt, middlewares } = mockCtx();
  apply(ctx as never, { ...config } as never);

  await setModel(middlewares, 'probe-nemotron-x');
  const def = prompt.find((candidate) => candidate.name === 'price-aware.money');
  assert.ok(def);
  const text = def.text({ agent: { session: { id: 's1' } } });
  assert.ok(text.includes('不在价表内'), text);
});
