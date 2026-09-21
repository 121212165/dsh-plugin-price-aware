/**
 * Live test against a real paid endpoint (TokenRhythm / 基元律动, ¥18 of credits).
 *
 * Every step goes through the plugin's own code: read the provider rate card,
 * estimate before spending, pick a model that fits what is left, call, then price
 * what actually came back and compare. Run:  node examples/live-run.ts
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { catalogFromProviderModels, normalizeOpenAiUsage, pickModelByBudget, usageCostMicros, type OpenAiUsage } from '../src/provider.ts';
import { estimateTask, buildTiers, priceEstimate, reconCost, reconEstimate, shouldRecon, calibrate, type TaskShape } from '../src/estimate.ts';
import { resolveBudget, DEFAULT_CONFIG } from '../src/config.ts';
import { decide } from '../src/gate.ts';
import { formatMoney, fromMajor, type Micros } from '../src/money.ts';
import { emptyBuckets } from '../src/pricing/cost.ts';

interface Secrets {
  key: string;
  base: string;
}

function loadSecrets(): Secrets {
  const path = new URL('../.secrets.env', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  if (!existsSync(path)) throw new Error('.secrets.env 不存在，先写入 JIYUAN_API_KEY / JIYUAN_BASE');
  const parsed = Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()] as const),
  );
  if (!parsed.JIYUAN_API_KEY) throw new Error('JIYUAN_API_KEY 缺失');
  return { key: parsed.JIYUAN_API_KEY, base: (parsed.JIYUAN_BASE ?? 'https://tokenrhythm.studio/v1').replace(/\/$/, '') };
}

const BUDGET_MICROS = fromMajor(18);
const secrets = loadSecrets();
const provider = 'jiyuan';

interface Row {
  phase: string;
  model: string;
  predicted: Micros;
  actual: Micros;
  prompt: number;
  completion: number;
  cached: number;
  ms: number;
  status: string;
  note: string;
}

const rows: Row[] = [];
const samples: { predicted: Micros; actual: Micros }[] = [];
let spent = 0;

const out = new URL('../report/live-test.md', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
writeFileSync(out, '# price-aware 真实调用测试（基元律动 ¥18 额度）\n\n');
const log = (line: string) => {
  console.log(line);
  appendFileSync(out, line + '\n');
};

async function chat(model: string, messages: unknown[], maxTokens: number) {
  const body = JSON.stringify({ model, messages, max_completion_tokens: maxTokens, stream: false });
  let lastError = 'unknown';
  for (let attempt = 1; attempt <= 4; attempt++) {
    const started = Date.now();
    try {
      const response = await fetch(`${secrets.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secrets.key}` },
        body,
        signal: AbortSignal.timeout(180_000),
      });
      const json = (await response.json().catch(() => ({}))) as {
        usage?: OpenAiUsage;
        choices?: { message?: { content?: string } }[];
        error?: unknown;
        message?: string;
        code?: string;
      };
      if (!response.ok) {
        lastError = `HTTP ${response.status} ${String(json.message ?? json.code ?? response.statusText).slice(0, 90)}`;
        if (response.status === 402 || /balance|credit|quota/i.test(lastError)) {
          return { ok: false, fatal: true, error: `额度耗尽: ${lastError}`, usage: null, content: '', ms: Date.now() - started };
        }
      } else {
        return {
          ok: true,
          fatal: false,
          error: '',
          usage: (json.usage ?? null) as OpenAiUsage | null,
          content: json.choices?.[0]?.message?.content ?? '',
          ms: Date.now() - started,
        };
      }
    } catch (error) {
      lastError = error instanceof Error ? `${error.name} ${error.message}`.slice(0, 90) : 'fetch failed';
    }
    await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
  }
  return { ok: false, fatal: false, error: lastError, usage: null, content: '', ms: 0 };
}

/** The plugin's own pre-flight: estimate, then keep only what the remaining credits afford. */
function preflight(catalog: ReturnType<typeof catalogFromProviderModels>['catalog'], shape: TaskShape, need: { uncachedInput: number; output: number }) {
  const estimate = estimateTask(shape);
  const remaining = BUDGET_MICROS - spent;
  const ranking = pickModelByBudget(catalog, {
    need: { ...emptyBuckets(), ...need },
    remainingMicros: remaining,
    reserveFraction: 0,
  });
  const predictedForPick = ranking.pick ? priceEstimate(estimate, ranking.pick.entry, {}).micros : 0;
  return { estimate, remaining, ranking, predictedForPick };
}

async function step(catalog: ReturnType<typeof catalogFromProviderModels>['catalog'], phase: string, shape: TaskShape, messages: unknown[], maxTokens: number, need: { uncachedInput: number; output: number }) {
  const { estimate, remaining, ranking } = preflight(catalog, shape, need);
  const fit = ranking.pick;
  if (!fit) {
    log(`| ${phase} | — | 额度不足以起任何模型（剩 ${formatMoney(remaining, 'CNY')}） |`);
    return { content: '', done: true };
  }
  const gate = decide({
    spentMicros: spent,
    projectedMicros: fit.costMicros,
    entry: fit.entry,
    balanceMicros: remaining,
    ratio: { ...emptyBuckets(), uncachedInput: 1, output: 0.3, cacheRead: 0 },
    policy: resolveBudget({ ...DEFAULT_CONFIG, mode: 'custom', sessionCapMajor: 18, taskAskMajor: 99, warnPercent: 90 }),
  });
  const model = fit.entry.id.replace(`${provider}/`, '');
  log(
    `\n### ${phase}\n模型 ${model} · 预估 ${formatMoney(fit.costMicros, 'CNY')}（形态估算 ${formatMoney(
      priceEstimate(estimate, fit.entry, {}).micros,
      'CNY',
    )}）· 剩余 ${formatMoney(remaining, 'CNY')} · 闸门 ${gate.kind}`,
  );
  const result = await chat(model, messages, maxTokens);
  if (!result.ok) {
    rows.push({ phase, model, predicted: fit.costMicros, actual: 0, prompt: 0, completion: 0, cached: 0, ms: result.ms, status: 'FAIL', note: result.error });
    log(`失败：${result.error}（0 花费，预估未计入）`);
    return { content: '', done: result.fatal };
  }
  const usage = result.usage ?? {};
  const buckets = normalizeOpenAiUsage(usage);
  const actual = usageCostMicros(usage, fit.entry);
  spent += actual;
  samples.push({ predicted: fit.costMicros, actual });
  rows.push({
    phase,
    model,
    predicted: fit.costMicros,
    actual,
    prompt: usage.prompt_tokens ?? 0,
    completion: usage.completion_tokens ?? 0,
    cached: usage.prompt_tokens_details?.cached_tokens ?? 0,
    ms: result.ms,
    status: 'OK',
    note: `${result.content.length} 字符`,
  });
  log(
    `实际 ${formatMoney(actual, 'CNY')} · in ${buckets.uncachedInput}+cache ${buckets.cacheRead} · out ${buckets.output} · ${result.ms}ms · 误差 ${(
      ((actual - fit.costMicros) /
        Math.max(1, actual)) *
      100
    ).toFixed(0)}%`,
  );
  return { content: result.content, done: false };
}

const BRIEF = readFileSync(new URL('./brief.md', import.meta.url), 'utf8');

async function main() {
  log('## 0) 价目来源');
  const modelsResponse = await fetch(`${secrets.base}/models`, { headers: { Authorization: `Bearer ${secrets.key}` } });
  const modelsJson = (await modelsResponse.json()) as { data: never[] };
  const { catalog, priced, unpriced } = catalogFromProviderModels(modelsJson.data, { provider, baseUrl: `${secrets.base}/models` });
  log(`\n/v1/models 返回 ${modelsJson.data.length} 个模型，${priced} 个带价目，${unpriced.length} 个无价：${unpriced.join(', ') || '无'}`);
  log(`预算 ¥18.00（本地记账；该网关没有余额接口，14 个候选路径全 404）`);

  writeFileSync(
    new URL('../report/catalog.json', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
    JSON.stringify(catalog, null, 2),
  );

  log('\n| 阶段 | 模型 | 预估 | 实际 | in | cache | out | 延迟 | 备注 |');
  log('|---|---|---|---|---|---|---|---|---|');

  // 1) A 档：只做到"能验证链路"
  await step(
    catalog,
    'A 最小可用： cordis 插件入口 3 行说明',
    { kind: 'answer', turns: 1, residentTokens: 900, charsWritten: 600 },
    [{ role: 'user', content: 'DeepSeek Harness 的 cordis 插件入口是什么？三行内说完，只给结论。' }],
    400,
    { uncachedInput: 900, output: 400 },
  );

  // 2) 三档报价 vs 真实花费：同一个 brief 做三个深度
  const tiers = buildTiers({ kind: 'greenfield', residentTokens: 3_200, charsWritten: 12_000 }, catalog.entries[0]!, {});
  log(`\n### 三档报价（用 ${tiers[0]!.cost.currency} 最低单价模型打底）\n${tiers.map((t) => `${t.label} ${formatMoney(t.cost.micros, t.cost.currency)}`).join(' · ')}`);
  const recon = reconEstimate({ kind: 'greenfield', residentTokens: 3_200, charsWritten: 12_000 });
  log(`侦察一次 ${formatMoney(reconCost(recon, catalog.entries[0]!), 'CNY')}，值得吗：${shouldRecon(tiers[1]!.estimate, catalog.entries[0]!, fromMajor(0.5))}`);

  // 3) B 档：调研 + 架构（真实交付物第一节）
  const research = await step(
    catalog,
    'B 达标：第一步调研结论',
    { kind: 'answer', turns: 2, residentTokens: 2_600, charsWritten: 3_500 },
    [
      { role: 'system', content: '你是插件工程师。只说你查得到依据的内容，查不到就直说。' },
      { role: 'user', content: `${BRIEF}\n\n只做第一步：给出 DeepSeek Harness 插件机制的调研结论（注册方式、流式拦截点、UI 注入点、配置持久化、安装分发），每条标注可信度；查不到的部分明确写"暂无官方文档可验证"。控制在 900 字内。` },
    ],
    1_600,
    { uncachedInput: 2_800, output: 1_400 },
  );

  // 4) 缓存验证：同一长前缀再问一次，看 cached_tokens 是否出现
  await step(
    catalog,
    '缓存复用验证：同一前缀第二次问',
    { kind: 'answer', turns: 1, residentTokens: 2_600, charsWritten: 800 },
    [
      { role: 'system', content: '你是插件工程师。只说你查得到依据的内容，查不到就直说。' },
      { role: 'user', content: `${BRIEF}\n\n把上一条调研结论压缩成 5 条要点，每条不超 30 字。` },
    ],
    600,
    { uncachedInput: 2_800, output: 500 },
  );
  void research;

  // 5) C 档：完整源码交付（最贵的一步，按剩余额度决定模型）
  const build = await step(
    catalog,
    'C 彻底：自然环境沉浸插件完整源码',
    { kind: 'greenfield', turns: 3, residentTokens: 3_200, charsWritten: 16_000 },
    [
      { role: 'system', content: '你是资深插件工程师。输出可运行代码，不要道歉式前言。查不到的 API 要标注待验证。' },
      {
        role: 'user',
        content: `${BRIEF}\n\n直接产出：Manifest V3 目录结构 + manifest.json + content.js（流式屏蔽与一次性呈现）+ scene.css（3 个带动态感的自然场景，CSS 合成层实现，prefers-reduced-motion 降级）+ audio.js（CC0 音源、首次交互后播放、音量与静音）+ options.js（本地图片上传、三种填充模式、亮度遮罩，明确不上传服务器）。代码要能直接用，注释里标出所有待验证点。`,
      },
    ],
    6_000,
    { uncachedInput: 3_400, output: 5_000 },
  );
  if (build.content) writeFileSync(new URL('../report/immersive-plugin-answer.md', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), build.content);

  // 6) 横向对比：同一任务在 3 个价位模型上的真实成本
  log('\n### 同一任务、三个价位模型（真实对拍）');
  const probeMessages = [
    { role: 'system', content: '你是插件工程师。' },
    { role: 'user', content: '用 250 字说明：如何在只支持 content script 的插件里屏蔽 LLM 流式输出并改为一次性呈现，包含至少 3 个具体技术点和 1 个失败模式。' },
  ];
  for (const model of ['qwen3.8-flash', 'deepseek-v4-flash-0731', 'deepseek-v4-pro-0813']) {
    const entry = catalog.entries.find((candidate) => candidate.id === `${provider}/${model}`);
    if (!entry) continue;
    if (spent >= BUDGET_MICROS) {
      log(`| ${model} | 跳过 | 预算已用尽 |`);
      continue;
    }
    const result = await chat(model, probeMessages, 700);
    if (!result.ok) {
      rows.push({ phase: `对拍 ${model}`, model, predicted: 0, actual: 0, prompt: 0, completion: 0, cached: 0, ms: result.ms, status: 'FAIL', note: result.error });
      log(`| ${model} | — | — | — | — | — | — | — | 失败 ${result.error} |`);
      continue;
    }
    const usage = result.usage ?? {};
    const actual = usageCostMicros(usage, entry);
    spent += actual;
    rows.push({
      phase: `对拍 ${model}`,
      model,
      predicted: 0,
      actual,
      prompt: usage.prompt_tokens ?? 0,
      completion: usage.completion_tokens ?? 0,
      cached: usage.prompt_tokens_details?.cached_tokens ?? 0,
      ms: result.ms,
      status: 'OK',
      note: `${result.content.length} 字符`,
    });
    log(
      `| ${model} | ${formatMoney(actual, 'CNY')} | in ${usage.prompt_tokens} | out ${usage.completion_tokens} | cache ${
        usage.prompt_tokens_details?.cached_tokens ?? 0
      } | ${result.ms}ms | ${result.content.length} 字符 |`,
    );
  }

  const calibration = calibrate(samples);
  log('\n## 结论');
  log(`\n- 总花费 ${formatMoney(spent, 'CNY')} / ¥18.00（剩 ${formatMoney(BUDGET_MICROS - spent, 'CNY')}）`);
  log(`- 成功 ${rows.filter((r) => r.status === 'OK').length} 次，失败 ${rows.filter((r) => r.status === 'FAIL').length} 次`);
  log(
    `- 预估校准：中位偏差 ×${calibration.bias}，平均绝对百分比误差 ${calibration.mape}%（n=${calibration.n}）`,
  );
  log(`- 最贵一步：${[...rows].sort((a, b) => b.actual - a.actual)[0]?.phase ?? '无'}`);
  writeFileSync(
    new URL('../report/usage.json', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
    JSON.stringify({ budgetMicros: BUDGET_MICROS, spentMicros: spent, rows, calibration }, null, 2),
  );
  log(`\n机器可读结果：report/usage.json`);
}

main().catch((error) => {
  console.error('运行失败', error);
  process.exitCode = 1;
});
