/**
 * Live test round 4 — one claim, one call: does sizing the cap from observed yield
 * (plus the cap-hit penalty) turn a truncated file into a parseable one?
 *
 *   node examples/live-run4.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { chat, file, loadSecrets, money, readPriorJson, usageNumbers } from './live-lib.ts';
import { catalogFromProviderModels, usageCostMicros } from '../src/provider.ts';
import { profileModels, recommendMaxTokens, rankByUsableCost } from '../src/profile.ts';
import { fromMajor } from '../src/money.ts';

const BUDGET = fromMajor(18);
const secrets = loadSecrets();
const provider = 'jiyuan';

const usage3 = readPriorJson<{
  spent: number;
  observations: Parameters<typeof profileModels>[0];
}>('report/usage3.json', 'live-run3');
const profiles = profileModels(usage3.observations);
const modelsJson = await (await fetch(`${secrets.base}/models`, { headers: { Authorization: `Bearer ${secrets.key}` } })).json() as { data: Parameters<typeof catalogFromProviderModels>[0] };
const { catalog } = catalogFromProviderModels(modelsJson.data, { provider });
const brief = readFileSync(file('examples/brief.md'), 'utf8');

const modelId = 'deepseek-v4-flash-0731';
const profile = profiles.get(modelId)!;
const entry = catalog.entries.find((candidate) => candidate.id === `${provider}/${modelId}`)!;
const wantChars = 8000;
const naiveCap = recommendMaxTokens(null, wantChars);
const sizedCap = recommendMaxTokens(profile, wantChars);

console.log(`${modelId}: 观测 ${profile.calls} 次 · 每 token 出 ${profile.charsPerCompletionToken} 字 · capHitRate ${(profile.capHitRate * 100).toFixed(0)}%`);
console.log(`没观测时的 cap = ${naiveCap}，按观测放大后 = ${sizedCap}`);

const fit = rankByUsableCost(catalog.entries, profiles, { wantChars, remainingMicros: BUDGET - usage3.spent, promptTokens: 900 })[0]!;
console.log(`成本最优仍是 ${fit.modelId}（预估 ${fit.estMicros == null ? '—' : money(fit.estMicros)}）`);

const messages = [
  { role: 'system' as const, content: '只输出一个完整可运行的 JS 文件，从第一行注释到最后一个括号，不要 markdown 围栏，不要解释。' },
  { role: 'user' as const, content: `${brief}\n\n只输出 content.js 完整代码（F1 全部要求）。` },
];

const result = await chat(secrets, modelId, messages, sizedCap, { attempts: 3, timeoutMs: 300_000 });
if (!result.ok) {
  console.log('调用失败：', result.error);
  process.exitCode = 1;
} else {
  const usage = usageNumbers(result.usage);
  const actual = usageCostMicros(result.usage as never, entry);
  const body = result.content.replace(/^```[a-z]*\n?/, '').replace(/```$/, '');
  let verdict: string;
  try {
    new vm.Script(body, { filename: 'content.js' });
    verdict = 'PARSE OK';
  } catch (error) {
    verdict = `PARSE FAIL: ${(error as Error).message.split('\n')[0]}`;
  }
  writeFileSync(file('report/content.js'), body);
  console.log(
    `\n实际 ${money(actual)}（累计 ${money(usage3.spent + actual)} / ¥18）· in ${usage.prompt} out ${usage.completion}/${sizedCap} · 正文 ${body.length} 字符 · ${money(
      actual / (body.length / 1000),
    )}/千字符`,
  );
  console.log(`撞 cap？${usage.completion >= sizedCap ? '是，还是被截断了' : '否，模型自己说完了'}`);
  console.log(verdict);
}
