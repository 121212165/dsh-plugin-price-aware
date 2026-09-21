/**
 * dsh wiring for the price-aware plugin.
 *
 * Everything that decides a number lives in the pure modules (pricing/, ledger,
 * gate, estimate, balance, advice); this file only moves events and renders text.
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
// type-only: these packages augment cordis' Context with the services used below
import type {} from '@deepseek-ai/dsh-commands';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-session';

import { DEFAULT_CONFIG, describeBudget, resolveBudget, validateConfig, type PriceAwareConfig } from './config.ts';
import { BalanceTracker, spendableMicros } from './balance.ts';
import { decide, type GateDecision } from './gate.ts';
import { renderMoneyContext, renderTiers } from './advice.ts';
import { buildTiers, reconCost, reconEstimate, shouldRecon, type Estimate, type TaskShape } from './estimate.ts';
import { Ledger, type RawUsage } from './ledger.ts';
import { formatMoney, fromMajor, type Currency, type Micros } from './money.ts';
import { DEEPSEEK_CATALOG, isCatalogStale, mergeCatalog, type PriceCatalog, type PriceEntry } from './pricing/catalog.ts';
import { emptyBuckets } from './pricing/cost.ts';
import { resolveModel, type ResolveResult } from './pricing/resolve.ts';

export const name = 'price-aware';
export const inject = ['commands', 'llm', 'session', 'system-prompt', 'tools'];

const modes = Schema.union([Schema.const('economy'), Schema.const('normal'), Schema.const('max'), Schema.const('custom')]);

const taskKinds = ['answer', 'small-edit', 'refactor', 'test-fix-loop', 'greenfield', 'bulk-read'] as const;

export interface Config extends PriceAwareConfig {}

export const Config = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_CONFIG.enabled),
  mode: modes.default('normal'),
  sessionCapMajor: Schema.natural().default(10),
  warnPercent: Schema.number().min(1).max(100).default(75),
  taskAskMajor: Schema.number().default(1.5),
  balanceFloorMajor: Schema.number().default(3),
  currency: Schema.union([Schema.const('auto'), Schema.const('CNY'), Schema.const('USD')]).default('auto'),
  balanceCheck: Schema.boolean().default(true),
  balanceTtlSeconds: Schema.natural().default(60),
  apiKeyEnv: Schema.array(Schema.string()).default(DEFAULT_CONFIG.apiKeyEnv),
  baseUrl: Schema.string().default('https://api.deepseek.com'),
  prices: Schema.array(
    Schema.object({
      id: Schema.string(),
      currency: Schema.string().default('CNY'),
      perMillion: Schema.object({
        cacheRead: Schema.number().default(0),
        uncachedInput: Schema.number(),
        output: Schema.number(),
      }),
      peakMultiplier: Schema.number().default(1),
      contextTokens: Schema.natural().default(1_000_000),
      maxOutputTokens: Schema.natural().default(256_000),
      aliases: Schema.array(Schema.string()).default([]),
      note: Schema.string().default(''),
    }),
  ).default([]),
  holidays: Schema.array(Schema.string()).default([]),
  reconThresholdMajor: Schema.number().default(0.5),
  inputIncludesCache: Schema.boolean().default(false),
  injectIntoPrompt: Schema.boolean().default(true),
});

interface ModelRef {
  id: string;
  provider?: string;
}

interface SessionMoney {
  ledger: Ledger;
  model: ModelRef;
}

export function apply(ctx: Context, config: Config): void {
  const problems = validateConfig(config);
  if (problems.length) {
    throw new Error(`price-aware 配置无效 -> ${problems.map((p) => `${String(p.field)}: ${p.message}`).join('; ')}`);
  }
  const log = ctx.logger('price-aware');
  if (!config.enabled) return void log.info('disabled by config');

  const catalog: PriceCatalog = mergeCatalog(DEEPSEEK_CATALOG, config.prices as PriceEntry[]);
  const policy = resolveBudget(config);
  const rules = { holidays: config.holidays };
  const moneyBySession = new Map<string, SessionMoney>();
  const modelByAgent = new Map<string, ModelRef>();
  const balance = new BalanceTracker({
    apiKey: readKey(config.apiKeyEnv),
    baseUrl: config.baseUrl,
    ttlMs: config.balanceTtlSeconds * 1000,
  });

  const sessionMoney = (sessionId: string, model: ModelRef): SessionMoney => {
    let money = moneyBySession.get(sessionId);
    if (!money) {
      money = {
        model,
        ledger: new Ledger((event) => resolveModel(event.modelId ?? model.id, catalog, { provider: event.provider ?? model.provider }), {
          rules,
          inputIncludesCache: config.inputIncludesCache,
        }),
      };
      moneyBySession.set(sessionId, money);
    }
    if (model.id && model.id !== 'unknown') money.model = model;
    return money;
  };

  const currencyOf = (resolution: ResolveResult): Currency =>
    resolution.kind === 'known' ? resolution.entry.currency : config.currency === 'auto' ? 'CNY' : config.currency;

  const moneyBlock = (sessionId: string) => {
    const money = sessionMoney(sessionId, { id: 'unknown' });
    const resolution = resolveModel(money.model.id, catalog, { provider: money.model.provider });
    const totals = money.ledger.totals();
    return {
      resolution,
      totals,
      text: renderMoneyContext({
        resolution,
        now: new Date(),
        rules,
        balanceMicros: config.balanceCheck ? spendableMicros(balance.current, currencyOf(resolution)) : null,
        spentMicros: totals.micros,
        policy,
        totals,
        catalogStale: isCatalogStale(catalog),
      }),
    };
  };

  /** The outgoing call config is the only place the live provider+model pair is authoritative. */
  ctx.on('agent/request', (payload, next) =>
    next().then((callConfig) => {
      const shape = callConfig as unknown as { provider?: string; model?: string };
      if (shape.model) {
        const model: ModelRef = { id: shape.model, provider: shape.provider };
        modelByAgent.set(agentKey(payload.agent), model);
        sessionMoney(sessionIdOf(payload.agent), model);
      }
      return callConfig;
    }),
  );

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return;
    const usage = event.data.usage as RawUsage | undefined;
    if (!usage) return;
    const model = modelByAgent.get(agentKey(session)) ?? { id: 'unknown' };
    sessionMoney(String(session.id), model).ledger.record({
      turn: event.data.turn,
      step: event.data.step,
      usage,
      modelId: model.id,
      provider: model.provider,
    });
  });

  if (config.injectIntoPrompt) {
    ctx.systemPrompt.context({
      name: 'price-aware.money',
      order: 40,
      text: (assemble) => moneyBlock(sessionIdOf(assemble.agent)).text,
    });
  }

  const quote = (shape: TaskShape, entry: PriceEntry): string => {
    const tiers = buildTiers(shape, entry, { rules });
    const big = tiers[1] ?? tiers[0]!;
    const recon: Estimate = reconEstimate(shape);
    const lines = [renderTiers(tiers)];
    lines.push(
      shouldRecon(big.estimate, entry, fromMajor(config.reconThresholdMajor))
        ? `先花 ${formatMoney(reconCost(recon, entry), entry.currency)} 做一次只读侦察，可把误差从 ±${big.estimate.errorPct}% 压到 ±${recon.errorPct}%。`
        : `这单不够大，侦察不划算；直接用 ±${big.estimate.errorPct}% 的误差带。`,
    );
    return lines.join('\n');
  };

  const gate = (sessionId: string, projected: Micros) => {
    const block = moneyBlock(sessionId);
    if (block.resolution.kind !== 'known') {
      return { entry: undefined as PriceEntry | undefined, currency: currencyOf(block.resolution) };
    }
    const entry = block.resolution.entry;
    const ratio = block.totals.ratio.uncachedInput
      ? block.totals.ratio
      : { ...emptyBuckets(), uncachedInput: 1_000, output: 150, cacheRead: 7_000 };
    return {
      entry,
      currency: entry.currency,
      decision: decide({
        spentMicros: block.totals.micros,
        projectedMicros: projected,
        entry,
        downgradeTo: catalog.entries.find((candidate) => candidate.id.includes('flash')),
        balanceMicros: config.balanceCheck ? spendableMicros(balance.current, entry.currency) : null,
        ratio,
        policy,
        rules,
      }),
    };
  };

  /**
   * The gate only earns trust where dsh lets a plugin answer for money: a call
   * whose own payload is big enough to matter is priced before it dispatches.
   * It never refuses on its own — it hands the model the menu to relay.
   */
  ctx.on('tools/pre-execute', async (exec, next) => {
    const projected = estimateCallMicros(exec.name, exec.arguments);
    if (projected < policy.taskSoftCapMicros) return next();
    const gated = gate(sessionIdOf(exec.agent), projected);
    if (!gated.entry) return next();
    const decision: GateDecision | undefined = gated.decision;
    if (!decision || decision.kind === 'allow') return next();
    if (decision.kind === 'block') return { kind: 'ask', reason: renderDecision(decision, gated.currency) };
    return { kind: 'allow', contexts: [renderDecision(decision, gated.currency)] };
  });

  ctx.commands.register({
    name: 'money',
    description: '我现在用的模型多少钱、余额还剩多少、本次会话烧到哪了',
    handler: async ({ agent }) => {
      if (config.balanceCheck) await balance.refresh();
      const block = moneyBlock(sessionIdOf(agent));
      return { kind: 'success', text: `${block.text}\n预算: ${describeBudget(policy, currencyOf(block.resolution))}` };
    },
  });

  ctx.commands.register({
    name: 'budget',
    description: '看当前预算档位；改档位要落到配置里，插件不偷偷改你的上限',
    input: { hint: '[economy|normal|max|<金额>]' },
    handler: ({ agent, rawInput }) => {
      const argument = String(rawInput ?? '').trim();
      const block = moneyBlock(sessionIdOf(agent));
      const currency = currencyOf(block.resolution);
      if (!argument) return { kind: 'success', text: describeBudget(policy, currency) };
      const amount = Number.parseFloat(argument);
      if (!Number.isFinite(amount) || amount < 0) {
        return { kind: 'error', text: `看不懂这个预算: ${argument}（试试 economy|normal|max|5）` };
      }
      return {
        kind: 'success',
        text: `设为 ${formatMoney(fromMajor(amount), currency)} 需要落到配置里才生效：\nprice-aware:\n  mode: custom\n  sessionCapMajor: ${amount}\n当前已花 ${formatMoney(block.totals.micros, currency)}`,
      };
    },
  });

  ctx.commands.register({
    name: 'estimate',
    description: '开工前先要价：/estimate refactor 14 20（类型 轮数 常驻千 token）',
    input: { hint: '<kind> [turns] [residentK]' },
    handler: ({ agent, rawInput }) => {
      const [kind = 'refactor', turns, resident] = String(rawInput ?? '').trim().split(/\s+/);
      const block = moneyBlock(sessionIdOf(agent));
      if (block.resolution.kind !== 'known') return { kind: 'error', text: describeUnknown(block.resolution) };
      return {
        kind: 'success',
        text: quote(
          {
            kind: (taskKinds as readonly string[]).includes(kind) ? (kind as TaskShape['kind']) : 'refactor',
            turns: turns ? Number.parseInt(turns, 10) : undefined,
            residentTokens: resident ? Number.parseInt(resident, 10) * 1000 : undefined,
          },
          block.resolution.entry,
        ),
      };
    },
  });

  ctx.tools.register(
    defineTool({
      name: 'price_status',
      description: '读出当前模型单价、账户余额、本会话已花费与剩余预算。要花大钱之前先问我。',
      parameters: {},
      output: {
        schema: { type: 'string' } as const,
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(_args, exec) {
        if (config.balanceCheck) await balance.refresh();
        const block = moneyBlock(sessionIdOf(agentOf(exec)));
        return `${block.text}\n预算: ${describeBudget(policy, currencyOf(block.resolution))}`;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'quote_task',
      description: '给一个任务要三档价（A 最小可用 / B 达标 / C 彻底）与各自产出边界，供用户选档；不执行任何改动。',
      parameters: {
        kind: { type: 'string', required: true, description: '任务类型', enum: [...taskKinds] },
        turns: { type: 'number', description: '预计 agent 轮数' },
        residentTokens: { type: 'number', description: '每轮重复发送的上下文 token 数（系统提示+历史）' },
        charsWritten: { type: 'number', description: '预计写出的字符总量' },
      },
      output: {
        schema: { type: 'string' } as const,
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const block = moneyBlock(sessionIdOf(agentOf(exec)));
        if (block.resolution.kind !== 'known') return describeUnknown(block.resolution);
        return quote(
          {
            kind: args.kind as TaskShape['kind'],
            turns: args.turns,
            residentTokens: args.residentTokens,
            charsWritten: args.charsWritten,
          },
          block.resolution.entry,
        );
      },
    }),
  );

  log.info(`mounted · ${describeBudget(policy, config.currency === 'auto' ? 'CNY' : config.currency)}`);
}

function describeUnknown(resolution: ResolveResult): string {
  return resolution.kind === 'unknown'
    ? `模型 ${resolution.modelId} 不在价表内，花费未知。先补 price-aware.prices 一条价目再来问。`
    : '模型价目异常';
}

/** Rough cost of one call: the payload it injects plus the turn it usually triggers. */
function estimateCallMicros(toolName: string, args: unknown): Micros {
  const chars = toolName === 'str_replace_editor' || toolName === 'write' ? JSON.stringify(args ?? '').length : 400;
  return Math.round((chars * 0.3 + 1500) * 9);
}

function renderDecision(decision: Exclude<GateDecision, { kind: 'allow' }>, currency: Currency): string {
  const options = decision.options.map((option, index) => `${index + 1}. ${option.label} — ${option.detail}`);
  return `预算提示: ${decision.headline}\n${options.join('\n')}\n把这几个选项原样转给用户，让他选，别替他决定花多少钱。`;
}

function readKey(names: string[]): string | undefined {
  for (const key of names) {
    const value = process.env[key];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

interface ScopedLike {
  id?: string;
  session?: { id?: string };
  agent?: unknown;
}

function agentOf(value: unknown): unknown {
  return (value as ScopedLike | undefined)?.agent ?? value;
}

function agentKey(agent: unknown): string {
  const value = agent as ScopedLike | undefined;
  return String(value?.id ?? value?.session?.id ?? 'agent');
}

function sessionIdOf(agent: unknown): string {
  const value = agent as ScopedLike | undefined;
  return String(value?.session?.id ?? value?.id ?? 'session');
}
