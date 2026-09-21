/**
 * Burn the whole ¥18 and turn it into a ranking that token price alone cannot give:
 * parseable files per yuan.
 *
 * Every model on the gateway's sheet gets the same brief, the same five-file ask.
 * Caps come from what we have already observed about that model; a call that runs
 * to its cap is retried once with a doubled cap, because a truncated file is worth
 * nothing no matter how cheap it was per character. Each returned file is judged by
 * the fence extractor plus vm.Script / JSON.parse / CSS brace balance.
 *
 *   node examples/burn-all.ts
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { chat, file, loadSecrets, money, usageNumbers } from './live-lib.ts';
import { catalogFromProviderModels, usageCostMicros } from '../src/provider.ts';
import { escalateCap, profileModels, recommendMaxTokens, type CallObservation, type ModelProfile } from '../src/profile.ts';
import { classifyChunks, extractCodeChunks } from '../src/fences.ts';
import { estimateCall, priceEstimate } from '../src/estimate.ts';
import { fromMajor } from '../src/money.ts';

const BUDGET = fromMajor(18);
const secrets = loadSecrets();
const provider = 'jiyuan';
const brief = readFileSync(file('examples/brief.md'), 'utf8');
const outDir = file('report/bundle');
mkdirSync(outDir, { recursive: true });

const reportPath = file('report/burn.md');
writeFileSync(reportPath, '# 烧完 ¥18：每个模型能交出几个能解析的文件\n\n');
const say = (line: string) => {
  console.log(line);
  appendFileSync(reportPath, line + '\n');
};

const observations: CallObservation[] = [];
let spent = 0;

const modelsJson = await (await fetch(`${secrets.base}/models`, { headers: { Authorization: `Bearer ${secrets.key}` } })).json() as { data: Parameters<typeof catalogFromProviderModels>[0] };
const { catalog } = catalogFromProviderModels(modelsJson.data, { provider });
const entryOf = (id: string) => catalog.entries.find((entry) => entry.id === `${provider}/${id}`)!;

const ASK = `一次输出下列 5 个文件的完整代码，每个文件用带文件名的代码围栏隔开（形如 \`\`\`js content.js），文件之间不要散文说明：
manifest.json、content.js、scene.css、audio.js、options.js。
要求同 brief。代码必须自洽可运行：JS 语法正确、JSON 可解析、CSS 括号平衡。`;

function capFor(modelId: string, profile: ModelProfile | null): number {
  const base = recommendMaxTokens(profile, 9000);
  return Math.min(base, 32_000);
}

function judge(file: string, body: string): boolean {
  if (/\.json$/i.test(file)) {
    try {
      JSON.parse(body);
      return true;
    } catch {
      return false;
    }
  }
  if (/\.css$/i.test(file)) {
    const open = (body.match(/{/g) ?? []).length;
    return open > 0 && open === (body.match(/}/g) ?? []).length;
  }
  try {
    new vm.Script(body.replace(/^```[a-z]*\s*/m, ''), { filename: file });
    return true;
  } catch {
    return false;
  }
}

async function attempt(modelId: string, messages: { role: string; content: string }[], cap: number, label: string) {
  const entry = entryOf(modelId);
  const projection = priceEstimate(estimateCall(messages, cap), entry, {}).micros;
  if (spent + projection > BUDGET) {
    say(`| ${label} | ${modelId} | 跳过：预计 ${money(projection)} 会超出剩余 ${money(BUDGET - spent)} |`);
    return null;
  }
  const result = await chat(secrets, modelId, messages, cap, { attempts: 2, timeoutMs: 300_000 });
  if (!result.ok) {
    if (/额度|402/.test(result.error)) {
      say(`\n额度耗尽：${result.error}`);
      spent = BUDGET;
    }
    return { error: result.error };
  }
  const usage = usageNumbers(result.usage);
  const actual = usageCostMicros(result.usage as never, entry);
  spent += actual;
  observations.push({
    modelId,
    actualMicros: actual,
    promptTokens: usage.prompt,
    completionTokens: usage.completion,
    requestedMaxTokens: cap,
    reasoningTokens: usage.reasoning,
    visibleChars: result.content.length,
  });
  return { usage, actual, content: result.content, truncated: usage.completion >= cap, ms: result.ms };
}

say('| 轮次 | 模型 | cap | out | 花费 | 交出 | 可用 | 每可用文件 |');
say('|---|---|---|---|---|---|---|---|');

const safeName = (value: string) => value.replace(/[^\w.+-]/g, '_');
let round = 0;
let calls = 0;

while (round < 8 && spent < BUDGET * 0.995) {
  round++;
  const profiles = profileModels(observations);
  let roundStart = spent;
  for (const modelId of ['qwen3.8-flash','glm-5.3-flash','deepseek-v4-flash-0731','minimax-m2.7','mimo-v2.5-pro','seed-2.1-turbo','qwen3.8-27b','longcat-2.0','deepseek-v4-pro-0813','kimi-k2.6','glm-5.1','seed-2.1-pro','glm-5.2','qwen3.7-flash','glm-5.3-flashx','kimi-k2.7-code','deepseek-flash','qwen3.7-max','kimi-k3','qwen3.8-max','glm-5.3']) {
    if (spent >= BUDGET * 0.995) break;
    const entry = entryOf(modelId);
    const profile = profiles.get(modelId) ?? null;
    let cap = capFor(modelId, profile);
    // one call should never eat more than a fifth of what is left
    if (priceEstimate(estimateCall([{ role: 'user', content: `${brief}\n${ASK}` }], cap), entry, {}).micros > (BUDGET - spent) * 0.2) {
      cap = Math.max(1500, Math.floor((cap * (BUDGET - spent) * 0.2) / Math.max(1, priceEstimate(estimateCall([{ role: 'user', content: brief }], cap), entry, {}).micros)));
    }
    const messages = [
      { role: 'system' as const, content: '只输出代码文件，按顺序给 5 个带文件名的代码块，不要任何解释文字。' },
      { role: 'user' as const, content: `${brief}\n\n${ASK}` },
    ];
    calls++;
    let outcome = await attempt(modelId, messages, cap, `r${round}`);
    if (outcome && outcome.truncated) {
      const next = escalateCap(cap, 40_000);
      if (next) {
        calls++;
        outcome = await attempt(modelId, messages, next, `r${round}+`) ?? outcome;
        cap = next;
      }
    }
    if (!outcome || 'error' in outcome) {
      say(`| r${round} | ${modelId} | ${cap} | — | — | — | — | ${outcome ? '失败 ' + outcome.error : '跳过（预算不足）'} |`);
      continue;
    }
    const chunks = classifyChunks(extractCodeChunks(outcome.content ?? '')).kept;
    const usable = chunks.filter((chunk) => judge(chunk.file, chunk.body));
    for (const chunk of usable) {
      writeFileSync(`${outDir}/${safeName(modelId)}__r${round}__${safeName(chunk.file)}`, chunk.body);
    }
    say(
      `| r${round} | ${modelId} | ${cap} | ${outcome.usage.completion} | ${money(outcome.actual)} | ${chunks.length} | ${usable.length}/5 | ${money(
        outcome.actual / Math.max(1, usable.length),
      )} |`,
    );
  }
  if (spent - roundStart === 0) {
    say(`\n第 ${round} 轮零支出，预算被单步成本下限卡住，停止。`);
    break;
  }
}

const profiles = profileModels(observations);
const leaderboard = [...profiles.entries()]
  .map(([modelId, profile]) => {
    const delivered = usableCount(modelId);
    return {
      modelId,
      calls: profile.calls,
      spentMicros: profile.microPerKiloChar === null && delivered === 0 ? profile.medianActualMicros * profile.calls : 0,
      delivered,
      microPerUsableFile: delivered ? Math.round(billedFor(modelId) / delivered) : null,
    };
  })
  .sort((a, b) => (a.microPerUsableFile ?? Number.MAX_SAFE_INTEGER) - (b.microPerUsableFile ?? Number.MAX_SAFE_INTEGER));

function billedFor(modelId: string): number {
  return observations.filter((o) => o.modelId === modelId).reduce((sum, o) => sum + o.actualMicros, 0);
}

function usableCount(modelId: string): number {
  const seen = new Set<string>();
  for (const name of readdirBundle()) {
    if (!name.startsWith(`${safeName(modelId)}__`)) continue;
    const filePart = name.split('__').slice(2).join('__');
    seen.add(filePart.replace(/^r\d+__/, ''));
  }
  return seen.size;
}
function readdirBundle(): string[] {
  return readdirSync(outDir);
}

say('\n## 排行榜（每元能交出几个**能解析**的文件，越少越划算）');
say('| 模型 | 调用 | 交出可用文件 | 每可用文件成本 |');
say('|---|---|---|---|');
for (const row of leaderboard) {
  say(`| ${row.modelId} | ${row.calls} | ${row.delivered} | ${row.microPerUsableFile == null ? '—（一个都没交付出）' : money(row.microPerUsableFile)} |`);
}
say(`\n- 总计 ${calls} 次调用，花掉 ${money(spent)} / ¥18.00`);
say(`- 落盘产物：report/bundle/ 下 ${readdirBundle().length} 个文件`);
writeFileSync(file('report/burn.json'), JSON.stringify({ budget: BUDGET, spent, observations, leaderboard }, null, 2));

