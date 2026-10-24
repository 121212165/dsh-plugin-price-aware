import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { DEFAULT_CONFIG, describeBudget, resolveBudget, validateConfig } from './config.js';
import { BalanceTracker, spendableMicros } from './balance.js';
import { decide } from './gate.js';
import { renderMoneyContext, renderTiers } from './advice.js';
import { buildTiers, reconCost, reconEstimate, shouldRecon } from './estimate.js';
import { Ledger } from './ledger.js';
import { formatMoney, fromMajor } from './money.js';
import { DEEPSEEK_CATALOG, isCatalogStale, mergeCatalog } from './pricing/catalog.js';
import { costOf, emptyBuckets } from './pricing/cost.js';
import { resolveModel } from './pricing/resolve.js';
export const name = 'price-aware';
/**
 * Service names are the strings each service passes to cordis' `Service`
 * constructor — `systemPrompt` and `sessions`, not the package names
 * `system-prompt` / `session`. A name that resolves to no implementation makes
 * cordis mark the plugin inactive, so apply() is never called and nothing errors.
 */
export const inject = ['commands', 'llm', 'sessions', 'systemPrompt', 'tools'];
const modes = Schema.union([Schema.const('economy'), Schema.const('normal'), Schema.const('max'), Schema.const('custom')]);
const taskKinds = ['answer', 'small-edit', 'refactor', 'test-fix-loop', 'greenfield', 'bulk-read'];
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
    prices: Schema.array(Schema.object({
        id: Schema.string(),
        // a free-form currency string would silently mis-scale every displayed number
        currency: Schema.union([Schema.const('CNY'), Schema.const('USD'), Schema.const('EUR')]).default('CNY'),
        perMillion: Schema.object({
            // deliberately no defaults here: an absent cacheRead must inherit the row it
            // overrides, and defaulting it to 0 would make cached tokens free
            cacheRead: Schema.number(),
            uncachedInput: Schema.number(),
            output: Schema.number(),
        }),
        peakMultiplier: Schema.number(),
        contextTokens: Schema.natural().default(1_000_000),
        maxOutputTokens: Schema.natural().default(256_000),
        aliases: Schema.array(Schema.string()).default([]),
        note: Schema.string().default(''),
    })).default([]),
    holidays: Schema.array(Schema.string()).default([]),
    reconThresholdMajor: Schema.number().default(0.5),
    injectIntoPrompt: Schema.boolean().default(true),
});
export function apply(ctx, config) {
    const problems = validateConfig(config);
    if (problems.length) {
        throw new Error(`price-aware 配置无效 -> ${problems.map((p) => `${String(p.field)}: ${p.message}`).join('; ')}`);
    }
    const log = ctx.logger('price-aware');
    if (!config.enabled)
        return void log.info('disabled by config');
    const catalog = mergeCatalog(DEEPSEEK_CATALOG, config.prices);
    /**
     * Cross-plugin pricing source (plan 2.3): when cost-ledger is mounted in the
     * same profile it provides its merged sheet as the cordis service
     * `pricing-catalog`. Read it through `ctx.reflect.get`: the context proxy
     * throws on any property this plugin has not injected, and adding the name to
     * `inject` would deactivate the whole plugin in profiles without cost-ledger.
     */
    const resolvePrice = (modelId, provider) => {
        const options = provider === undefined ? undefined : { provider };
        const own = resolveModel(modelId, catalog, options);
        if (own.kind !== 'unknown')
            return own;
        const shared = ctx.reflect.get('pricing-catalog');
        return shared ? resolveModel(modelId, shared, options) : own;
    };
    const policy = resolveBudget(config);
    const rules = { holidays: config.holidays };
    const moneyBySession = new Map();
    const modelByAgent = new Map();
    const balance = new BalanceTracker({
        apiKey: readKey(config.apiKeyEnv),
        baseUrl: config.baseUrl,
        ttlMs: config.balanceTtlSeconds * 1000,
    });
    const sessionMoney = (sessionId, model) => {
        let money = moneyBySession.get(sessionId);
        if (!money) {
            money = {
                model,
                ledger: new Ledger((event) => resolvePrice(event.modelId ?? model.id, event.provider ?? model.provider), {
                    rules,
                }),
            };
            moneyBySession.set(sessionId, money);
        }
        if (model.id && model.id !== 'unknown')
            money.model = model;
        return money;
    };
    const currencyOf = (resolution) => resolution.kind === 'known' ? resolution.entry.currency : config.currency === 'auto' ? 'CNY' : config.currency;
    const moneyBlock = (sessionId) => {
        const money = sessionMoney(sessionId, { id: 'unknown' });
        const resolution = resolvePrice(money.model.id, money.model.provider);
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
    ctx.on('agent/request', (payload, next) => next().then((callConfig) => {
        const shape = callConfig;
        if (shape.model) {
            const model = { id: shape.model, provider: shape.provider };
            modelByAgent.set(agentKey(payload.agent), model);
            sessionMoney(sessionIdOf(payload.agent), model);
        }
        return callConfig;
    }));
    ctx.on('session/event', (session, event) => {
        if (event.type !== 'assistant/message')
            return;
        const usage = event.data.usage;
        if (!usage)
            return;
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
    const quote = (shape, entry) => {
        const tiers = buildTiers(shape, entry, { rules });
        const big = tiers[1] ?? tiers[0];
        const recon = reconEstimate(shape);
        const lines = [renderTiers(tiers)];
        lines.push(shouldRecon(big.estimate, entry, fromMajor(config.reconThresholdMajor))
            ? `先花 ${formatMoney(reconCost(recon, entry), entry.currency)} 做一次只读侦察，可把误差从 ±${big.estimate.errorPct}% 压到 ±${recon.errorPct}%。`
            : `这单不够大，侦察不划算；直接用 ±${big.estimate.errorPct}% 的误差带。`);
        return lines.join('\n');
    };
    const gate = (sessionId, projected) => {
        const block = moneyBlock(sessionId);
        if (block.resolution.kind !== 'known') {
            return { entry: undefined, currency: currencyOf(block.resolution) };
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
     * dsh gives a plugin exactly two money voices: `tools/pre-execute` may allow /
     * deny / ask, and only `tools/post-execute` may hand the model new context.
     * `{kind:'allow', contexts:[...]}` is not a thing — it compiles and is silently
     * dropped, so the advice has to ride the post-execute leg instead.
     */
    const pendingAdvice = new Map();
    ctx.on('tools/pre-execute', async (exec, next) => {
        const sessionId = sessionIdOf(exec.agent);
        const block = moneyBlock(sessionId);
        const entry = block.resolution.kind === 'known' ? block.resolution.entry : null;
        const projected = estimateCallMicros(exec, entry);
        if (!entry || projected < policy.taskSoftCapMicros)
            return next();
        const gated = gate(sessionId, projected);
        if (!gated.entry)
            return next();
        const decision = gated.decision;
        if (!decision || decision.kind === 'allow')
            return next();
        const callKey = String(exec.rootCallId ?? exec.callId ?? '');
        if (decision.kind === 'block') {
            pendingAdvice.set(callKey, renderDecision(decision));
            return { kind: 'ask', reason: renderDecision(decision) };
        }
        if (callKey && pendingAdvice.size < 200)
            pendingAdvice.set(callKey, renderDecision(decision));
        return next();
    });
    ctx.on('tools/post-execute', async (exec, _result, next) => {
        const callKey = String(exec.rootCallId ?? exec.callId ?? '');
        const text = pendingAdvice.get(callKey);
        if (!text)
            return next();
        pendingAdvice.delete(callKey);
        const downstream = await next();
        return {
            ...downstream,
            additionalContexts: [
                createUserMessage({
                    // Session format v4 retired the {kind:'plugin', plugin:<name>} wrapper and
                    // throws on it, which aborts the session as soon as this notice is
                    // persisted. Third-party producers own their kind as `plugin:<name>`, the
                    // shape the official v3->v4 producerKind() migrates to; dsh-llm's source
                    // union predates that and is narrower than its own runtime.
                    content: [{ type: 'text', text }],
                    source: { kind: `plugin:${name}`, form: 'notice', summary: '预算提示' },
                }),
                ...('additionalContexts' in downstream ? (downstream.additionalContexts ?? []) : []),
            ],
        };
    });
    // sessions come and go; a long-lived host must not accumulate ledgers forever
    ctx.on('session/disposed', (session) => {
        const key = String(session.id ?? '');
        moneyBySession.delete(key);
        modelByAgent.delete(key);
        log.debug(`released money state for ${key}`);
    });
    ctx.commands.register({
        name: 'money',
        description: '我现在用的模型多少钱、余额还剩多少、本次会话烧到哪了',
        handler: async ({ agent }) => {
            if (config.balanceCheck)
                await balance.refresh();
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
            if (!argument)
                return { kind: 'success', text: describeBudget(policy, currency) };
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
            if (block.resolution.kind !== 'known')
                return { kind: 'error', text: describeUnknown(block.resolution) };
            return {
                kind: 'success',
                text: quote({
                    kind: taskKinds.includes(kind) ? kind : 'refactor',
                    turns: turns ? Number.parseInt(turns, 10) : undefined,
                    residentTokens: resident ? Number.parseInt(resident, 10) * 1000 : undefined,
                }, block.resolution.entry),
            };
        },
    });
    ctx.tools.register(defineTool({
        name: 'price_status',
        description: '读出当前模型单价、账户余额、本会话已花费与剩余预算。要花大钱之前先问我。',
        parameters: {},
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(_args, exec) {
            if (config.balanceCheck)
                await balance.refresh();
            const block = moneyBlock(sessionIdOf(agentOf(exec)));
            return `${block.text}\n预算: ${describeBudget(policy, currencyOf(block.resolution))}`;
        },
    }));
    ctx.tools.register(defineTool({
        name: 'quote_task',
        description: '给一个任务要三档价（A 最小可用 / B 达标 / C 彻底）与各自产出边界，供用户选档；不执行任何改动。',
        parameters: {
            kind: { type: 'string', required: true, description: '任务类型', enum: [...taskKinds] },
            turns: { type: 'number', description: '预计 agent 轮数' },
            residentTokens: { type: 'number', description: '每轮重复发送的上下文 token 数（系统提示+历史）' },
            charsWritten: { type: 'number', description: '预计写出的字符总量' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(args, exec) {
            const block = moneyBlock(sessionIdOf(agentOf(exec)));
            if (block.resolution.kind !== 'known')
                return describeUnknown(block.resolution);
            return quote({
                kind: args.kind,
                turns: args.turns,
                residentTokens: args.residentTokens,
                charsWritten: args.charsWritten,
            }, block.resolution.entry);
        },
    }));
    log.info(`mounted · ${describeBudget(policy, config.currency === 'auto' ? 'CNY' : config.currency)}`);
}
function describeUnknown(resolution) {
    return resolution.kind === 'unknown'
        ? `模型 ${resolution.modelId} 不在价表内，花费未知。先补 price-aware.prices 一条价目再来问。`
        : '模型价目异常';
}
/**
 * Price a pending tool call against the model that would serve it. The guess is
 * coarse on purpose — tokens-per-character for a JSON payload and one turn of
 * overhead — but the *unit price* must come from the catalog, because a hardcoded
 * rate silently mis-gates every model that is not priced like deepseek pro peak.
 */
function estimateCallMicros(exec, entry) {
    if (!entry)
        return 0;
    const chars = JSON.stringify(exec.arguments ?? {}).length || 400;
    const tokens = Math.round(chars * 0.3 + 1500);
    return costOf({ uncachedInput: tokens, output: Math.round(tokens * 0.2), cacheRead: 0 }, entry, {}).micros;
}
function renderDecision(decision) {
    const options = decision.options.map((option, index) => `${index + 1}. ${option.label} — ${option.detail}`);
    return `预算提示: ${decision.headline}\n${options.join('\n')}\n把这几个选项原样转给用户，让他选，别替他决定花多少钱。`;
}
function readKey(names) {
    for (const key of names) {
        const value = process.env[key];
        if (value?.trim())
            return value.trim();
    }
    return undefined;
}
function agentOf(value) {
    return value?.agent ?? value;
}
function agentKey(agent) {
    const value = agent;
    return String(value?.id ?? value?.session?.id ?? 'agent');
}
function sessionIdOf(agent) {
    const value = agent;
    return String(value?.session?.id ?? value?.id ?? 'session');
}
//# sourceMappingURL=plugin.js.map