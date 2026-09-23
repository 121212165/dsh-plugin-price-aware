/**
 * Live test round 5 — the escalation experiment round 4 forced.
 *
 * Round 4 showed a doubled cap gets filled again, so a quote for whole-file output
 * is a floor. This loop raises the cap until the model stops on its own, prices every
 * attempt (failed ones cost real money), and only then asks whether the file parses.
 *
 *   node examples/live-run5.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { chat, file, loadSecrets, money, readPriorJson, usageNumbers } from './live-lib.ts';
import { catalogFromProviderModels, usageCostMicros } from '../src/provider.ts';
import { escalateCap, profileModels, quoteTrust, recommendMaxTokens } from '../src/profile.ts';
import { fromMajor } from '../src/money.ts';

const BUDGET = fromMajor(18);
const secrets = loadSecrets();
const provider = 'jiyuan';
const log: string[] = ['# price-aware 真实测试 第五轮：cap 递增到模型自己收尾\n\n'];
const say = (line: string) => {
  console.log(line);
  log.push(line + '\n');
};

const usage3 = readPriorJson<{ spent: number; observations: Parameters<typeof profileModels>[0] }>(
  'report/usage3.json',
  'live-run3',
);
const usage4spent = fromMajor(0.0583);
let spent = usage3.spent + usage4spent;
const profiles = profileModels(usage3.observations);
const modelsJson = await (await fetch(`${secrets.base}/models`, { headers: { Authorization: `Bearer ${secrets.key}` } })).json() as { data: Parameters<typeof catalogFromProviderModels>[0] };
const { catalog } = catalogFromProviderModels(modelsJson.data, { provider });
const brief = readFileSync(file('examples/brief.md'), 'utf8');

const modelId = 'deepseek-v4-flash-0731';
const profile = profiles.get(modelId)!;
const entry = catalog.entries.find((candidate) => candidate.id === `${provider}/${modelId}`)!;

say(`模型 ${modelId} · 已有观测 ${profile.calls} 次 · ${quoteTrust(profile).label}`);
say(`预算 ¥18.00，前四轮已花 ${money(spent)}，可用 ${money(BUDGET - spent)}\n`);
say('| 尝试 | cap | 实际 out | 撞 cap？ | 花费 | 正文 | 判定 |');
say('|---|---|---|---|---|---|---|');

const messages = [
  { role: 'system' as const, content: '只输出一个完整可运行的 JS 文件。第一行是注释，最后一行是闭合括号。禁止 markdown 围栏，禁止解释文字。' },
  { role: 'user' as const, content: `${brief}\n\n只输出 content.js（实现 F1：拦截逐 token 渲染、缓冲、一次性淡入、开关与快捷键、prefers-reduced-motion 与异常回退）。` },
];

let cap = recommendMaxTokens(profile, 8000);
let finalBody = '';
let attempts = 0;
let totalAttemptCost = 0;
for (let round = 1; round <= 4; round++) {
  const remaining = BUDGET - spent;
  if (remaining < cap * entry.perMillion.output * 1.2) {
    say(`\n停止：剩余 ${money(remaining)} 不够再买一次 ${cap} token 的输出`);
    break;
  }
  attempts++;
  const result = await chat(secrets, modelId, messages, cap, { attempts: 2, timeoutMs: 300_000 });
  if (!result.ok) {
    say(`| ${round} | ${cap} | — | — | ¥0.0000 | — | 调用失败 ${result.error} |`);
    continue;
  }
  const usage = usageNumbers(result.usage);
  const actual = usageCostMicros(result.usage as never, entry);
  spent += actual;
  totalAttemptCost += actual;
  const body = result.content.replace(/^```[a-z]*\s*/, '').replace(/```\s*$/, '');
  const truncated = usage.completion >= cap;
  let verdict: string;
  try {
    new vm.Script(body, { filename: 'content.js' });
    verdict = 'PARSE OK';
  } catch (error) {
    verdict = truncated ? '截断，语法不完整' : `自己收尾但语法不通：${(error as Error).message.split('\n')[0]}`;
  }
  say(`| ${round} | ${cap} | ${usage.completion} | ${truncated ? '是' : '否'} | ${money(actual)} | ${body.length} 字符 | ${verdict} |`);
  finalBody = body;
  if (!truncated) break;
  const next = escalateCap(cap, 40_000);
  if (next === null) {
    say('\n已到 ceiling，无法再放大');
    break;
  }
  cap = next;
}

if (finalBody) writeFileSync(file('report/content.js'), finalBody);
let parses = false;
try {
  new vm.Script(finalBody, { filename: 'content.js' });
  parses = true;
} catch {
  parses = false;
}
say(
  `\n## 结论\n- 拿到一个能解析的 content.js 共花 ${money(totalAttemptCost)}（${attempts} 次尝试），累计 ${money(spent)} / ¥18.00`,
);
say(`- 最终文件 ${finalBody.length} 字符 · ${parses ? 'vm.Script 解析通过' : '仍然解析失败'}`);
say(
  `- 单位成本：按字符算是 ${money(totalAttemptCost / Math.max(1, finalBody.length / 1000))}/千字符，按"能跑的代码"算是 ${money(
    totalAttemptCost / Math.max(1, finalBody.length / 1000),
  )}/千字符 —— 差别在于前四版的字符是废掉的`,
);
say(`- 教训：整文件生成没有可信上限，${quoteTrust(profile).boundIsReal ? '该模型会自己收尾，报价可当上限' : '报价只能当下限'}；cap 递增是实验不是估算`);
writeFileSync(file('report/live-test-5.md'), log.join(''));
