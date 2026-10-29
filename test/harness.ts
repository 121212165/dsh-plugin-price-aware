/** Assembly-layer harness for price-aware: a scripted mock dsh context mounting the
 * real apply(), with the agent/request middleware, the session/event listener and
 * the tool pre/post hooks captured so tests can drive usage events end-to-end
 * without any HTTP. price-aware keeps its ledger in memory (no dataPath), so the
 * temp dir is the only filesystem surface the harness needs. The mock itself
 * lives in @dsh-family/kit; this file only adds price-aware's config defaults
 * and event shapes.
 * @module test/harness */

import { applyOnce, createMockCtx, tempDir } from '@dsh-family/kit/kit/test-harness';

import { type PriceAwareConfig } from '../src/config.ts';

export interface ScopedLike {
  id?: string;
  session?: { id?: string };
  agent?: unknown;
}

export interface CapturedCommand {
  name: string;
  handler(args: { agent?: ScopedLike; rawInput?: string }): Promise<{ kind: string; text: string }> | { kind: string; text: string };
}

export interface CapturedTool {
  name: string;
  execute(args: Record<string, unknown>, exec?: ScopedLike): Promise<string>;
}

export interface CapturedSection {
  name: string;
  order?: number;
  text(assemble: { agent: ScopedLike }): string;
}

export interface Harness {
  commands: CapturedCommand[];
  tools: CapturedTool[];
  sections: CapturedSection[];
  events: string[];
  scratchDir: string;
  apply(config?: Partial<PriceAwareConfig>): Promise<void>;
  command(name: string): CapturedCommand;
  tool(name: string): CapturedTool;
  sectionText(agent?: ScopedLike): string;
  emitRequest(payload: ScopedLike, callConfig: { model?: string; provider?: string }): Promise<unknown>;
  emitSessionEvent(session: ScopedLike, event: Record<string, unknown>): void;
  emitUsage(sessionId: string, model: string, usage: Record<string, number>): Promise<void>;
  emitPre<T>(exec: Record<string, unknown>, next: () => Promise<T>): Promise<unknown>;
  emitPost(exec: Record<string, unknown>, result: unknown, next: () => unknown): Promise<unknown>;
  dispose(session: ScopedLike): void;
}

export function makeHarness(options: { reflect?: Map<string, unknown> } = {}): Harness {
  // cost-ledger's cross-plugin sheet, read through ctx.reflect.get in plugin.ts
  const mock = createMockCtx<CapturedCommand, CapturedTool, CapturedSection>(
    options.reflect ? { reflect: options.reflect } : {},
  );
  const { listeners } = mock;

  const scratchDir = tempDir('price-aware-wire-');
  let usageCalls = 0;

  const call = (event: string, ...args: unknown[]): unknown => {
    const callback = mock.listener(event).callback as unknown as (...input: unknown[]) => unknown;
    return callback(...args);
  };

  // Schema defaults only apply through the host — restate them for direct apply(),
  // with balanceCheck false so a harness never leaves the machine.
  const defaults = {
    enabled: true,
    mode: 'normal',
    sessionCapMajor: 10,
    warnPercent: 75,
    taskAskMajor: 1.5,
    balanceFloorMajor: 3,
    currency: 'auto',
    balanceCheck: false,
    balanceTtlSeconds: 60,
    apiKeyEnv: [],
    prices: [],
    holidays: [],
    reconThresholdMajor: 0.5,
    injectIntoPrompt: true,
  } satisfies Partial<PriceAwareConfig>;

  // The first apply() call decides the mount config; later calls reuse it.
  let pending: Partial<PriceAwareConfig> | undefined;
  let mounted = false;
  const mount = applyOnce(() =>
    import('../src/plugin.ts').then(({ apply }) =>
      apply(mock.ctx as never, { ...defaults, ...pending } as never),
    ),
  );

  const harness: Harness = {
    commands: mock.commands,
    tools: mock.tools,
    sections: mock.sections,
    get events() {
      return listeners.map((listener) => listener.event);
    },
    scratchDir,
    apply(config?: Partial<PriceAwareConfig>) {
      if (!mounted) {
        mounted = true;
        pending = config;
      }
      return mount();
    },
    command: mock.command,
    tool: mock.tool,
    sectionText(agent?: ScopedLike): string {
      return mock.section('price-aware.money').text({ agent: agent ?? { session: { id: 'session' } } });
    },
    emitRequest(payload: ScopedLike, callConfig: { model?: string; provider?: string }): Promise<unknown> {
      return call('agent/request', payload, async () => callConfig) as Promise<unknown>;
    },
    emitSessionEvent(session: ScopedLike, event: Record<string, unknown>): void {
      call('session/event', session, event);
    },
    async emitUsage(sessionId: string, model: string, usage: Record<string, number>): Promise<void> {
      usageCalls++;
      await harness.emitRequest({ agent: { session: { id: sessionId } } }, { model, provider: 'deepseek' });
      harness.emitSessionEvent(
        { id: sessionId },
        { type: 'assistant/message', data: { turn: usageCalls, step: usageCalls, usage } },
      );
    },
    emitPre<T>(exec: Record<string, unknown>, next: () => Promise<T>): Promise<unknown> {
      return call('tools/pre-execute', exec, next, undefined) as Promise<unknown>;
    },
    emitPost(exec: Record<string, unknown>, result: unknown, next: () => unknown): Promise<unknown> {
      return call('tools/post-execute', exec, result, next) as Promise<unknown>;
    },
    dispose(session: ScopedLike): void {
      call('session/disposed', session, undefined);
    },
  };

  return harness;
}
