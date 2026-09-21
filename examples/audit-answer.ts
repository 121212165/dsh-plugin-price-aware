/**
 * Score a generated answer against the brief it was asked to fulfil.
 * Uses the shipped fence extractor, so it judges the same files the plugin would keep.
 *
 *   node examples/audit-answer.ts [path/to/answer.md]
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { classifyChunks, extractCodeChunks } from '../src/fences.ts';
import { file } from './live-lib.ts';

const target = process.argv[2] ?? file('report/immersive-plugin-src.md');
const source = readFileSync(target, 'utf8');
const { kept, rejected } = classifyChunks(extractCodeChunks(source));

let parseable = 0;
for (const chunk of kept) {
  let verdict: string;
  try {
    if (/\.json$/i.test(chunk.file)) {
      JSON.parse(chunk.body);
      verdict = 'valid JSON';
      parseable++;
    } else if (/\.css$/i.test(chunk.file)) {
      const open = (chunk.body.match(/{/g) ?? []).length;
      const balanced = open > 0 && open === (chunk.body.match(/}/g) ?? []).length;
      if (balanced) parseable++;
      verdict = balanced ? `valid CSS (${open} rules)` : 'brace mismatch';
    } else {
      new vm.Script(chunk.body, { filename: chunk.file });
      verdict = 'parses as JS';
      parseable++;
    }
  } catch (error) {
    verdict = `BROKEN: ${(error as Error).message.split('\n')[0]}`;
  }
  console.log(`${chunk.file.padEnd(22)} ${String(chunk.body.length).padStart(6)} chars${chunk.unterminated ? ' [未闭合围栏]' : ''} · ${verdict}`);
}
for (const skip of rejected) console.log(`${skip.file.padEnd(22)} ${'—'.repeat(6).padStart(6)}        · 丢弃：${skip.reason}`);

const checks: [string, RegExp][] = [
  ['F1 拦截逐 token 渲染', /(MutationObserver|buffer|queue|suppress|textContent)/i],
  ['F1 一次性呈现/淡入', /(opacity|@keyframes|fadeIn|transition)/i],
  ['F1 恢复原生流式开关', /(toggle|enableStreaming|native|原生)/],
  ['F1 快捷键', /(commands|keydown|shortcut|Alt\+|Ctrl\+)/i],
  ['F2 ≥3 个场景', /(forest|creek|rain|valley|window|森林|溪流|雨夜|晨雾)/i],
  ['F2 动态感', /(requestAnimationFrame|@keyframes)/],
  ['F2 标签页隐藏暂停', /(visibilitychange|document\.hidden|IntersectionObserver)/],
  ['F3 音频播放', /new Audio\(|\.play\(/],
  ['F3 首次交互后才播', /(once:\s*true|pointerdown|click|autoplay-policy|first)/i],
  ['F3 音量与静音', /(volume|muted)/],
  ['F4 图片上传入口', /(input type="file"|FileReader|\.files\[0\])/],
  ['F4 只存本地', /(indexedDB|localStorage|browser\.storage|chrome\.storage)/i],
  ['F4 三种填充模式', /(cover|contain|blur|铺满|裁剪|高斯)/],
  ['F4 亮度遮罩', /(brightness|overlay|filter)/i],
  ['无障碍降级', /prefers-reduced-motion/],
  ['出错静默回退', /catch\s*\(/],
];
const missing = checks.filter(([, pattern]) => !pattern.test(source)).map(([name]) => name);
console.log(
  `\n可解析文件 ${parseable}/${kept.length} · 需求命中 ${checks.length - missing.length}/${checks.length}` +
    (missing.length ? `\n未命中：${missing.join('、')}` : ''),
);
