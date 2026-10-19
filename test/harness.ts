/** Assembly-layer harness for price-aware: a scripted mock dsh context mounting the
 * real apply(), with the agent/request middleware, the session/event listener and
 * the tool pre/post hooks captured so tests can drive usage events end-to-end
 * without any HTTP. price-aware keeps its ledger in memory (no dataPath), so the
 * temp dir is the only filesystem surface the harness needs. Template ported from
 * dsh-plugin-quota (methodology: dsh-auto-review).
 * @module test/harness */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

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

interface CapturedListener {
  event: string;
  callback: (first: never, second: never, third?: never) => unknown;
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
  const commands: CapturedCommand[] = [];
  const tools: CapturedTool[] = [];
  const sections: CapturedSection[] = [];
  const listeners: CapturedListener[] = [];
  const sharedCatalogs = options.reflect ?? new Map<string, unknown>();
  let usageCalls = 0;

  const ctx: Record<string, unknown> = {
    logger(_name: string) {
      return { info() {}, warn() {}, debug() {} };
    },
    on(event: string, callback: CapturedListener['callback']) {
      listeners.push({ event, callback });
    },
    // cost-ledger's cross-plugin sheet, read through ctx.reflect.get in plugin.ts
    reflect: {
      get(name: string) {
        return sharedCatalogs.get(name);
      },
    },
    commands: {
      register(definition: CapturedCommand) {
        commands.push(definition);
      },
    },
    tools: {
      register(definition: CapturedTool) {
        tools.push(definition);
      },
    },
    systemPrompt: {
      context(section: CapturedSection) {
        sections.push(section);
      },
    },
  };

  const scratchDir = mkdtempSync(join(tmpdir(), 'price-aware-wire-'));
  after(() => rmSync(scratchDir, { recursive: true, force: true }));

  let applied: Promise<void> | null = null;

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

  const harness: Harness = {
    commands,
    tools,
    sections,
    get events() {
      return listeners.map((listener) => listener.event);
    },
    scratchDir,
    apply(config?: Partial<PriceAwareConfig>) {
      applied ??= import('../src/plugin.ts').then(({ apply }) => apply(ctx as never, { ...defaults, ...config } as never));
      return applied;
    },
    command(name: string): CapturedCommand {
      const found = commands.find((candidate) => candidate.name === name);
      if (!found) throw new Error(`command ${name} was never registered`);
      return found;
    },
    tool(name: string): CapturedTool {
      const found = tools.find((candidate) => candidate.name === name);
      if (!found) throw new Error(`tool ${name} was never registered`);
      return found;
    },
    sectionText(agent?: ScopedLike): string {
      const found = sections.find((candidate) => candidate.name === 'price-aware.money');
      if (!found) throw new Error('price-aware.money section was never registered');
      return found.text({ agent: agent ?? { session: { id: 'session' } } });
    },
    emitRequest(payload: ScopedLike, callConfig: { model?: string; provider?: string }): Promise<unknown> {
      const listener = listeners.find((candidate) => candidate.event === 'agent/request');
      if (!listener) throw new Error('agent/request listener was never registered');
      return listener.callback(payload as never, (async () => callConfig) as never) as Promise<unknown>;
    },
    emitSessionEvent(session: ScopedLike, event: Record<string, unknown>): void {
      const listener = listeners.find((candidate) => candidate.event === 'session/event');
      if (!listener) throw new Error('session/event listener was never registered');
      listener.callback(session as never, event as never);
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
      const listener = listeners.find((candidate) => candidate.event === 'tools/pre-execute');
      if (!listener) throw new Error('tools/pre-execute listener was never registered');
      return listener.callback(exec as never, next as never, undefined as never) as Promise<unknown>;
    },
    emitPost(exec: Record<string, unknown>, result: unknown, next: () => unknown): Promise<unknown> {
      const listener = listeners.find((candidate) => candidate.event === 'tools/post-execute');
      if (!listener) throw new Error('tools/post-execute listener was never registered');
      return listener.callback(exec as never, result as never, next as never) as Promise<unknown>;
    },
    dispose(session: ScopedLike): void {
      const listener = listeners.find((candidate) => candidate.event === 'session/disposed');
      if (!listener) throw new Error('session/disposed listener was never registered');
      listener.callback(session as never, undefined as never);
    },
  };
  return harness;
}
