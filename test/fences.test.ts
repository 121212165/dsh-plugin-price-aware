import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyChunks, extractCodeChunks, looksLikeCode } from '../src/fences.ts';

test('an unterminated fence stops instead of eating the next file', () => {
  // the exact shape that broke the live report: model opened a fence and never closed it
  const answer = ['```js', '// content.js', 'const a = 1;', 'function f() { return a; }'].join('\n');
  const [chunk] = extractCodeChunks(answer);
  assert.equal(chunk?.file, 'content.js');
  assert.equal(chunk?.unterminated, true);
  assert.equal(chunk?.body.includes('===== scene.css'), false);
  assert.match(chunk!.body, /return a/);
});

test('a separator inside a glued answer becomes its own block, not code', () => {
  const answer = ['```js', 'const x = 1;', '```', '', '===== scene.css =====', '', '```css', '.a { color: red; }', '```'].join('\n');
  const chunks = extractCodeChunks(answer);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1]!.language, 'css');
  assert.ok(looksLikeCode(chunks[1]!.body, 'css'));
});

test('file names come from the fence, the first line, or the heading above', () => {
  assert.equal(extractCodeChunks(['```json manifest.json', '{ "a": 1 }', '```'].join('\n'))[0]!.file, 'manifest.json');
  assert.equal(extractCodeChunks(['```js', '// audio.js', 'const b = 2;', '```'].join('\n'))[0]!.file, 'audio.js');
  assert.equal(
    extractCodeChunks(['### options.js', '', '```js', 'const c = 3;', '```'].join('\n'))[0]!.file,
    'options.js',
  );
  assert.equal(extractCodeChunks(['```', 'no hints here', '```'].join('\n'))[0]!.file, 'chunk-1');
});

test('a restated file keeps the longer body', () => {
  const answer = ['```js x.js', 'short', '```', '```js x.js', 'longer body', 'with lines', '```'].join('\n');
  const chunks = extractCodeChunks(answer);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0]!.body, /longer body/);
});

test('directory trees and prose are rejected, real code is kept', () => {
  const chunks = extractCodeChunks(
    [
      '```',
      'deepseek-harness/',
      '├── manifest.json',
      '└── content.js',
      '```',
      '```json',
      '{ "manifest_version": 3 }',
      '```',
      '```js',
      'export function main() { return 1; }',
      '```',
    ].join('\n'),
  );
  const { kept, rejected } = classifyChunks(chunks);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!.reason, /不是代码/);
  // the rejected tree still consumed chunk-1, so the survivors are numbered after it
  assert.deepEqual(
    kept.map((chunk) => chunk.file),
    ['chunk-2', 'chunk-3'],
  );
  assert.equal(kept[0]!.language, 'json');
});

test('json is validated by parsing, css by brace balance', () => {
  assert.equal(looksLikeCode('{ "a": [1,2] }', 'json'), true);
  assert.equal(looksLikeCode('{ "a": ', 'json'), false);
  assert.equal(looksLikeCode('.a { color: red }', 'css'), true);
  assert.equal(looksLikeCode('.a { color: red', 'css'), false);
});

test('multiple fences in one answer are all recovered', () => {
  const answer = ['```js a.js', 'const a=1', '```', 'prose', '```js b.js', 'const b=2', '```'].join('\n');
  assert.deepEqual(
    extractCodeChunks(answer).map((chunk) => chunk.file),
    ['a.js', 'b.js'],
  );
});
