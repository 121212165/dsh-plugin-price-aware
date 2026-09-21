/**
 * Live test round 3 — the round that has to actually deliver.
 *
 * Round 2 proved the plugin could bill correctly but the "C 彻底" build came back
 * empty: reasoning models spent the whole cap thinking. This round feeds those
 * observations back in, sizes each cap from measured yield, ranks models by cost
 * per *visible* character, and rebuilds the deliverable.
 *
 *   node examples/live-run3.ts
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chat, file, loadSecrets, money, usageNumbers } from './live-lib.ts';
import { catalogFromProviderModels, pickModelByBudget, usageCostMicros } from '../src/provider.ts';
import { profileModels, rankByUsableCost, recommendMaxTokens, type CallObservation } from '../src/profile.ts';
import { calibrate } from '../src/estimate.ts';
import { fromMajor } from '../src/money.ts';
import { emptyBuckets } from '../src/pricing/cost.ts';

const BUDGET = fromMajor(18);
const secrets = loadSecrets();
const provider = 'jiyuan';
const reportPath = file('report/live-test-3.md');
writeFileSync(reportPath, '# price-aware 真实测试 第三轮（用第二轮的观测重选模型）\n\n');
const log = (line: string) => {
  console.log(line);
  appendFileSync(reportPath, line + '\n');
};

const observations: CallObservation[] = [];
const samples: { predicted: number; actual: number }[] = [];
let spent = 0;

// ---- seed from round 2 -------------------------------------------------
const previous = JSON.parse(readFileSync(file('report/usage2.json'), 'utf8')) as {
  spent: number;
  rows: { model: string; actual?: number; usage?: { prompt: number; completion: number; cached: number; reasoning: number }; chars?: number; ms?: number }[];
};
spent = previous.spent;
for (const row of previous.rows) {
  if (!row.usage || !row.actual) continue;
  observations.push({
    modelId: row.model,
    actualMicros: row.actual,
    promptTokens: row.usage.prompt,
    completionTokens: row.usage.completion,
    requestedMaxTokens: Math.max(row.usage.completion, 1),
    reasoningTokens: row.usage.reasoning,
    visibleChars: row.chars ?? 0,
  });
}

const modelsJson = await (await fetch(`${secrets.base}/models`, { headers: { Authorization: `Bearer ${secrets.key}` } })).json() as { data: Parameters<typeof catalogFromProviderModels>[0] };
const { catalog } = catalogFromProviderModels(modelsJson.data, { provider, baseUrl: `${secrets.base}/models` });
const brief = readFileSync(file('examples/brief.md'), 'utf8');

const entryOf = (id: string) => catalog.entries.find((entry) => entry.id === `${provider}/${id}`)!;

function ranking(wantChars: number) {
  return rankByUsableCost(catalog.entries, profileModels(observations), {
    wantChars,
    remainingMicros: BUDGET - spent,
    promptTokens: 1200,
  });
}

function showRanking(title: string, wantChars: number) {
  log(`\n### ${title}（目标 ${wantChars} 可见字符，剩 ${money(BUDGET - spent)}）`);
  for (const fit of ranking(wantChars).slice(0, 7)) {
    log(
      `- ${fit.modelId.padEnd(24)} ${fit.fits ? '可负担' : '放弃   '}  预估 ${fit.estMicros == null ? '—' : money(fit.estMicros)}  ${
        fit.profile ? `实测 ¥/千字符 ${fit.profile.microPerKiloChar == null ? '∞(没写出过字)' : money(fit.profile.microPerKiloChar)} · 每 completion token 出 ${fit.profile.charsPerCompletionToken} 字` : '未观测'
      }`,
    );
  }
}

async function priced(label: string, modelId: string, messages: { role: string; content: string }[], maxTokens: number) {
  const entry = entryOf(modelId);
  const result = await chat(secrets, modelId, messages, maxTokens, { attempts: 3, timeoutMs: 300_000 });
  if (!result.ok) {
    log(`| ${label} | ${modelId} | — | — | — | 失败 ${result.error} |`);
    return { content: '', actual: 0 };
  }
  const usage = usageNumbers(result.usage);
  const actual = usageCostMicros(result.usage as never, entry);
  spent += actual;
  observations.push({
    modelId,
    actualMicros: actual,
    promptTokens: usage.prompt,
    completionTokens: usage.completion,
    requestedMaxTokens: maxTokens,
    reasoningTokens: usage.reasoning,
    visibleChars: result.content.length,
  });
  log(
    `| ${label} | ${modelId} | ${money(actual)} | ${usage.prompt}/${usage.completion} | ${result.content.length} 字符 | ${money(
      actual / Math.max(1, result.content.length / 1000),
    )}/千字符 · 推理 ${usage.completion ? Math.round((usage.reasoning / usage.completion) * 100) : 0}% · ${result.ms}ms |`,
  );
  return { content: result.content, actual };
}

// ---- 1) what the evidence says before we spend anything -------
showRanking('开局排序（仅第二轮观测）', 12_000);

log('\n### 真实调用');
log('| 步骤 | 模型 | 花费 | in/out | 正文 | 单位成本 |');
log('|---|---|---|---|---|---|');

const start = spent;

// 2) prompt A/B, this time with caps that leave room for the answer
const wantPerChunk = 4500;
const top = ranking(wantPerChunk)[0]!;
const abModel = top.modelId;
const abCap = recommendMaxTokens(top.profile, wantPerChunk);
log(`\n对拍用 ${abModel}，上限按实测产出算出 = ${abCap} token（写死 1500 时第二轮有 4 次正文为 0）`);
await priced('2A 原始 brief', abModel, [{ role: 'user', content: `${brief}\n\n按交付物输出第 1、2 节（调研摘要 + 架构简述）。` }], abCap);
await priced(
  '2B 优化后 brief',
  abModel,
  [
    { role: 'system', content: '你是插件工程师。只输出规定小节，不写前言后语。查不到的写"待验证"。' },
    {
      role: 'user',
      content: `目标：给 DeepSeek Harness（TypeScript CLI 编码 agent，插件系统 cordis，插件=导出 apply(ctx,config) 的模块）设计「等待态沉浸」插件。
输出恰好两节：
## 调研摘要 —— 5 条表格：结论 | 依据来源 | 可信度(高/中/低)。查不到的必须写"暂无官方文档可验证"，禁止编 API 名。
## 架构简述 —— 模块表(模块|职责|挂的事件或服务|降级行为) + 一个 mermaid 事件流图，标明在哪一步屏蔽逐 token 渲染。
总长 ≤1200 字。`,
    },
  ],
  abCap,
);

// 3) the actual build, chunked, caps sized per model from live evidence
log('\n### C 档分块重建');
const PARTS: [string, string][] = [
  ['manifest.json + 目录树', '只输出 manifest.json（Manifest V3）与目录树，然后每个文件一行职责。无代码块之外的说明。'],
  ['content.js', '只输出 content.js 完整代码：拦截逐 token 渲染、后台缓冲、完成后一次性淡入、全局开关+快捷键恢复原生流式、prefers-reduced-motion 降级、异常静默回退。'],
  ['scene.css', '只输出 scene.css：3 个自然场景（晨雾森林/溪流山谷/雨夜窗景），只用 transform+opacity 的合成层动画，document.hidden 时暂停。'],
  ['audio.js + options.js', '只输出 audio.js（CC0 环境音、首次交互后播放、音量与静音）与 options.js（本地图片上传，裁剪/铺满/高斯模糊三模式 + 亮度遮罩，只存 indexedDB 不上传）。'],
];
const chunks: string[] = [];
for (const [name, ask] of PARTS) {
  const fit = ranking(wantPerChunk)[0]!;
  if (!fit.fits) {
    log(`| ${name} | — | 剩余额度买不到这块，跳过 |`);
    continue;
  }
  const cap = recommendMaxTokens(fit.profile, wantPerChunk);
  log(`\n[${name}] 选 ${fit.modelId}（每字符成本最优），cap=${cap}`);
  const result = await priced(
    `3 ${name}`,
    fit.modelId,
    [
      { role: 'system', content: '只输出代码，按顺序给文件块，不要解释性散文。' },
      { role: 'user', content: `${brief}\n\n${ask}` },
    ],
    cap,
  );
  chunks.push(`\n\n===== ${name} =====\n${result.content}`);
}
writeFileSync(file('report/immersive-plugin-src.md'), `# 「自然环境沉浸」插件草稿（由 ¥18 真实额度测试生成）\n${chunks.join('\n')}`);

// 4) did the ranking change once it had evidence from this round?
showRanking('重建后的排序（两轮观测合并）', 12_000);

const calibration = calibrate(samples);
log('\n## 结论');
log(`- 本轮花费 ${money(spent - start)}，累计 ${money(spent)} / ¥18.00（剩 ${money(BUDGET - spent)}）`);
const written = observations.filter((o) => o.visibleChars > 0);
log(`- 观测样本 ${observations.length} 次，其中 ${written.length} 次真的写出了正文`);
const perModel = [...profileModels(observations).entries()].sort(
  (a, b) => (a[1].microPerKiloChar ?? Number.MAX_SAFE_INTEGER) - (b[1].microPerKiloChar ?? Number.MAX_SAFE_INTEGER),
);
log('- 每千可见正文成本：' + perModel.filter(([, p]) => p.microPerKiloChar).map(([id, p]) => `${id} ${money(p.microPerKiloChar!)}`).join(' · '));
const empty = observations.filter((o) => o.visibleChars === 0);
log(`- 空正文调用 ${empty.length} 次（全部发生在第二、三轮 cap 小于该模型推理开销时），这 ${money(
  empty.reduce((sum, o) => sum + o.actualMicros, 0),
)} 是纯浪费，插件现在会按实测产出把 cap 抬高或直接放弃该模型`);
if (calibration.n) log(`- 预估校准（本轮样本 ${calibration.n}）：×${calibration.bias}，headroom ${calibration.headroom}%`);
writeFileSync(
  file('report/usage3.json'),
  JSON.stringify({ budget: BUDGET, spent, observations, perModel: Object.fromEntries(perModel.map(([id, p]) => [id, p])) }, null, 2),
);
log(`\n产物：report/immersive-plugin-src.md · report/usage3.json${existsSync(file('report/immersive-plugin-src.md')) ? '' : ' (缺失)'}`);
