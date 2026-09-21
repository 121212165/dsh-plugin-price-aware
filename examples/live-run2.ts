/**
 * Live test round 2 — fixes what round 1 exposed and answers the question the
 * plugin exists to answer: what does this cost, and what is the cheaper way.
 *
 *   node examples/live-run2.ts
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { chat, file, loadSecrets, money, usageNumbers } from './live-lib.ts';
import { catalogFromProviderModels, normalizeOpenAiUsage, pickModelByBudget, usageCostMicros } from '../src/provider.ts';
import { calibrate, estimateCall, priceEstimate } from '../src/estimate.ts';
import { fromMajor } from '../src/money.ts';
import { emptyBuckets } from '../src/pricing/cost.ts';

const BUDGET = fromMajor(18);
const secrets = loadSecrets();
const provider = 'jiyuan';
let spent = 0;
const report = file('report/live-test-2.md');
writeFileSync(report, '# price-aware 真实测试 第二轮（基元律动 ¥18）\n\n');
const log = (line: string) => {
  console.log(line);
  appendFileSync(report, line + '\n');
};

const samples: { predicted: number; actual: number }[] = [];
const rows: Record<string, unknown>[] = [];

const models = await (await fetch(`${secrets.base}/models`, { headers: { Authorization: `Bearer ${secrets.key}` } })).json() as { data: Parameters<typeof catalogFromProviderModels>[0] };
const { catalog } = catalogFromProviderModels(models.data, { provider, baseUrl: `${secrets.base}/models` });
const entryOf = (id: string) => catalog.entries.find((entry) => entry.id === `${provider}/${id}`)!;

/** Predict from the text we are actually about to send, then bill what came back. */
async function priced(label: string, modelId: string, messages: { role: string; content: string }[], maxTokens: number) {
  const entry = entryOf(modelId);
  const estimate = estimateCall(messages, maxTokens);
  const predicted = priceEstimate(estimate, entry, {}).micros;
  const result = await chat(secrets, modelId, messages, maxTokens);
  if (!result.ok) {
    log(`| ${label} | ${modelId} | ${money(predicted)} | — | — | — | 失败 ${result.error} |`);
    rows.push({ label, model: modelId, predicted, error: result.error });
    return { content: '', actual: 0 };
  }
  const usage = usageNumbers(result.usage);
  const actual = usageCostMicros(result.usage as never, entry);
  spent += actual;
  samples.push({ predicted, actual });
  const invisible = usage.completion > 0 ? Math.round((usage.reasoning / usage.completion) * 100) : 0;
  log(
    `| ${label} | ${modelId} | ${money(predicted)} | ${money(actual)} | ${usage.prompt}/${usage.completion}（cache ${usage.cached}） | ${
      result.content.length
    } 字符 | ${money(actual / Math.max(1, result.content.length / 1000))}/千字符 · 推理占 ${invisible}% |`,
  );
  rows.push({ label, model: modelId, predicted, actual, usage, chars: result.content.length, ms: result.ms, invisibleShare: invisible });
  return { content: result.content, actual };
}

const BRIEF = file('examples/brief.md');
const brief = await import('node:fs').then((fs) => fs.readFileSync(BRIEF, 'utf8'));

log('| 步骤 | 模型 | 预估 | 实际 | in/out | 正文 | 单位成本 |');
log('|---|---|---|---|---|---|---|');

// 1) 预估精度：测量输入而非猜输入
await priced('1a 单轮小问', 'qwen3.8-flash', [{ role: 'user', content: '用三行说明 cordis 插件入口。' }], 300);
await priced('1b 大上下文单轮', 'qwen3.8-flash', [{ role: 'user', content: `${brief}\n\n只回答：这个任务最大 technical risk 是什么？150 字。` }], 400);

// 2) 提示词优化 A/B：同一个交付目标，两种写法
await priced('2A 原始 brief 直问', 'qwen3.8-flash', [{ role: 'user', content: `${brief}\n\n按交付物输出第 1、2 节。` }], 1800);
const OPTIMIZED = `任务：给 DeepSeek Harness（TypeScript CLI 编码 agent，插件系统 cordis）写「等待态沉浸」插件的架构方案。
硬约束：只输出 3 部分，总长 ≤600 字——
① 模块表（列：模块名 | 职责 | dsh 事件/服务 | 失败时降级行为），6 行内；
② 用 mermaid 画 token→UI 的事件流，标明在哪一步屏蔽流式；
③ 三条你查不到依据、必须由我确认的假设。
禁止：前言、道歉、代码块以外的解释。`;
await priced('2B 优化后提示词', 'qwen3.8-flash', [{ role: 'user', content: OPTIMIZED }], 1800);

// 3) 跨模型对拍：同一 prompt，三个价位
const CROSS = [{ role: 'user', content: '用 200 字给出"在只支持 content script 的插件里屏蔽 LLM 流式输出并一次性呈现"的 3 个技术点和 1 个失败模式。' }];
for (const modelId of ['glm-5.3-flash', 'deepseek-v4-flash-0731', 'deepseek-v4-pro-0813', 'kimi-k3']) {
  if (spent > BUDGET * 0.9) break;
  await priced(`3 跨模型 ${modelId}`, modelId, CROSS, 1500);
}

// 4) 缓存是否真的省钱：同一长前缀连问三次
const PREFIX = `${brief}\n`.repeat(6);
for (let round = 1; round <= 3; round++) {
  await priced(`4-${round} 缓存探测`, 'qwen3.8-flash', [{ role: 'user', content: `第${round}次：把下面材料压成 ${3 + round} 条要点。\n${PREFIX}` }], 400);
}

// 5) C 档分块构建：绕开 504，同时把交付物真的做出来
const PARTS: [string, string][] = [
  ['manifest + 目录结构', '只输出 manifest.json（MV3）与目录结构树，加 5 行说明每个文件职责。不要别的章节。'],
  ['content.js', '只输出 content.js：屏蔽逐 token 渲染、后台缓存、完成后淡入一次性呈现、「恢复原生流式」开关与快捷键、prefers-reduced-motion 与出错静默回退。带注释。'],
  ['scene.css + audio.js + options.js', '只输出这三个文件：3 个有动态感的自然场景（合成层动画，标签页隐藏时暂停）、CC0 环境音（首次交互后播放、音量与静音）、本地图片上传（三种填充模式+亮度遮罩，绝不上传）。'],
];
const chunks: string[] = [];
for (const [name, ask] of PARTS) {
  const remaining = BUDGET - spent;
  const fit = pickModelByBudget(catalog, {
    need: { ...emptyBuckets(), uncachedInput: 3000, output: 6000 },
    remainingMicros: remaining,
  });
  const modelId = fit.pick?.entry.id.replace(`${provider}/`, '') ?? 'qwen3.8-flash';
  log(`\n[C 分块·${name}] 剩 ${money(remaining)} → 选中 ${modelId}（这一步最多 ${money(fit.pick?.costMicros ?? 0)}）`);
  const result = await priced(`5 ${name}`, modelId, [{ role: 'system', content: '只输出代码，不解释。' }, { role: 'user', content: `${brief}\n\n${ask}` }], 5000);
  chunks.push(`\n\n/* ==== ${name} ==== */\n${result.content}`);
}
writeFileSync(file('report/immersive-plugin-src.md'), `# 由 ¥18 额度测试生成的实现草稿\n\n${brief}\n${chunks.join('\n')}`);

const calibration = calibrate(samples);
log('\n## 结论');
log(`- 总花费 ${money(spent)} / ¥18.00（本地记账，网关无余额接口）`);
log(`- 成功 ${rows.filter((r) => !r.error).length} 次 · 失败 ${rows.filter((r) => r.error).length} 次`);
log(`- 测量式预估：中位偏差 ×${calibration.bias}，MAPE ${calibration.mape}%（n=${calibration.n}）— 第一轮猜输入时是 ×0.637 / 57%`);
const okRows = rows.filter((r) => !r.error && (r.actual as number) > 0) as unknown as { model: string; actual: number; chars: number; invisibleShare: number; usage: { cached: number } }[];
const best = [...okRows].sort((a, b) => a.actual / Math.max(1, a.chars) - b.actual / Math.max(1, b.chars))[0];
if (best) log(`- 单位正文最便宜：${best.model}（${money(best.actual / (best.chars / 1000))}/千字符）`);
const cacheSeen = okRows.some((row) => (row.usage?.cached ?? 0) > 0);
log(`- 缓存命中：${cacheSeen ? '有，见明细' : '整轮全部 cached_tokens=0，说明该网关这条路不吃前缀缓存，插件里 cacheableShare 应按 0 估'}`);
const invisible = okRows.map((row) => row.invisibleShare).filter((v) => v > 0);
if (invisible.length) log(`- 推理 token 占输出比例：中位 ${invisible.sort((a, b) => a - b)[Math.floor(invisible.length / 2)]}%（这部分按输出价收费、用户看不见）`);
writeFileSync(file('report/usage2.json'), JSON.stringify({ budget: BUDGET, spent, rows, calibration }, null, 2));
log('\n机器可读：report/usage2.json · 产物：report/immersive-plugin-src.md');
