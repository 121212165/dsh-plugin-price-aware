/**
 * Fence-aware extraction of code from model answers.
 *
 * Born from a real bug: a live run asked for five files in five calls, and the
 * report glued the chunks together with plain-text separators. One answer had an
 * unterminated ``` fence, so the next separator landed *inside* the open block and
 * the assembled "content.js" failed to parse — the code was fine, the assembler was
 * not. Never trust a model to close its own fences.
 */

export interface CodeChunk {
  file: string;
  language: string;
  body: string;
  /** true when the answer never closed the fence this chunk came from */
  unterminated: boolean;
}


const FILE_HINTS: RegExp[] = [
  // ```js src/content.js  /  ```json manifest.json
  /^([a-zA-Z0-9_+./-]+\.(?:js|mjs|cjs|ts|json|css|html|md|py|yml|yaml|tsx|jsx))\b/,
  // file: content.js / **content.js** / ### content.js / // content.js
  /^(?:file[:：]\s*)?([a-zA-Z0-9_.-]+\.(?:js|mjs|cjs|ts|json|css|html|md|py|yml|yaml|tsx|jsx))/i,
];

function nameFromInfoString(info: string): string | null {
  for (const pattern of FILE_HINTS) {
    const hit = pattern.exec(info.trim());
    if (hit?.[1]) return hit[1];
  }
  return null;
}

/** `// x.js`, `### x.js`, `**x.js**`, `` `x.js` `` all name the file that follows */
function stripDecoration(line: string): string {
  return line
    .trim()
    .replace(/^(?:\/\/+|\/\*+|\*+|#+|-+|>+)\s*/, '')
    .replace(/^[`*_~]+/, '')
    .replace(/[`*_~]+$/, '')
    .trim();
}

function nameFromContext(lines: string[]): string | null {
  // walk backwards from the fence to the nearest heading-ish line that names a file
  for (let index = lines.length - 1; index >= 0 && index >= lines.length - 6; index--) {
    const line = stripDecoration(lines[index] ?? '');
    if (!line) continue;
    for (const pattern of FILE_HINTS) {
      const hit = pattern.exec(line);
      if (hit?.[1]) return hit[1];
    }
    return null;
  }
  return null;
}

/** `// content.js` as the first line inside the block names the block. Forward order. */
function nameFromLeadingLines(lines: string[]): string | null {
  for (const raw of lines.slice(0, 3)) {
    const line = stripDecoration(raw);
    if (!line) continue;
    for (const pattern of FILE_HINTS) {
      const hit = pattern.exec(line);
      if (hit?.[1]) return hit[1];
    }
  }
  return null;
}

const LANG_BY_EXTENSION: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  json: 'json',
  css: 'css',
  html: 'html',
  md: 'markdown',
  py: 'python',
  yml: 'yaml',
  yaml: 'yaml',
};

function guessLanguage(file: string): string {
  const extension = file.split('.').pop()?.toLowerCase() ?? '';
  return LANG_BY_EXTENSION[extension] ?? 'text';
}

/** A directory tree or a prose paragraph is not a source file. */
export function looksLikeCode(body: string, language: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  if (language === 'json') {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }
  if (language === 'css') {
    return (trimmed.match(/{/g) ?? []).length > 0 && (trimmed.match(/{/g) ?? []).length === (trimmed.match(/}/g) ?? []).length;
  }
  if (/[├└─]/.test(trimmed)) return false;
  if (!/[{}();=]/.test(trimmed)) return false;
  // one line of code is still code, provided it terminates like code
  return trimmed.split('\n').length > 1 || /[;{}]\s*$/.test(trimmed);
}

export function extractCodeChunks(answer: string): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  const lines = answer.split('\n');
  let index = 0;
  let unnamed = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const fenceMatch = /^(`{3,})([a-zA-Z0-9_+.-]*)[ \t]*([^\n]*)$/.exec(line.trim());
    if (!fenceMatch) {
      index++;
      continue;
    }
    const marker = fenceMatch[1]!;
    const declaredLang = (fenceMatch[2] ?? '').toLowerCase();
    const infoRest = fenceMatch[3] ?? '';
    const infoName = nameFromInfoString(infoRest) ?? nameFromInfoString(declaredLang);
    const bodyLines: string[] = [];
    let cursor = index + 1;
    let closed = false;
    const closer = new RegExp('^' + marker[1]!.repeat(marker.length) + '\\s*$');
    while (cursor < lines.length) {
      if (closer.test(lines[cursor]!.trim())) {
        closed = true;
        break;
      }
      bodyLines.push(lines[cursor]!);
      cursor++;
    }
    const body = bodyLines.join('\n').replace(/\s+$/, '');
    const contextName = bodyLines.length ? nameFromLeadingLines(bodyLines) : null;
    const headingName = nameFromContext(lines.slice(0, index));
    const file = infoName ?? contextName ?? headingName ?? `chunk-${++unnamed}`;
    const language = declaredLang && !infoName ? declaredLang : guessLanguage(file);
    chunks.push({ file, language, body, unterminated: !closed });
    // an unterminated fence swallowed the rest of the answer: stop scanning
    index = closed ? cursor + 1 : lines.length;
  }

  return dedupeByName(chunks);
}

/** Later definitions of the same file win — a model often restates a file after fixing it. */
export function dedupeByName(chunks: CodeChunk[]): CodeChunk[] {
  const byName = new Map<string, CodeChunk>();
  for (const chunk of chunks) {
    const existing = byName.get(chunk.file);
    if (!existing || chunk.body.length >= existing.body.length) byName.set(chunk.file, chunk);
  }
  return [...byName.values()];
}

export interface BundleReport {
  kept: CodeChunk[];
  rejected: { file: string; reason: string }[];
}

export function classifyChunks(chunks: CodeChunk[]): BundleReport {
  const kept: CodeChunk[] = [];
  const rejected: BundleReport['rejected'] = [];
  for (const chunk of chunks) {
    if (!chunk.body.trim()) rejected.push({ file: chunk.file, reason: '空块' });
    else if (!looksLikeCode(chunk.body, chunk.language)) rejected.push({ file: chunk.file, reason: '不是代码（目录树或说明文字）' });
    else kept.push(chunk);
  }
  return { kept, rejected };
}
