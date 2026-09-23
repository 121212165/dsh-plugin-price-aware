import { existsSync, readFileSync } from 'node:fs';

export interface Secrets {
  key: string;
  base: string;
}

export function loadSecrets(): Secrets {
  const path = file('.secrets.env');
  if (!existsSync(path)) throw new Error('.secrets.env 不存在');
  const parsed = Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()] as const),
  );
  if (!parsed.JIYUAN_API_KEY) throw new Error('JIYUAN_API_KEY 缺失');
  return { key: parsed.JIYUAN_API_KEY, base: (parsed.JIYUAN_BASE ?? 'https://tokenrhythm.studio/v1').replace(/\/$/, '') };
}

export function file(relative: string): string {
  return new URL(`../${relative}`, import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
}

export interface CallResult {
  ok: boolean;
  fatal: boolean;
  error: string;
  usage: Record<string, unknown> | null;
  content: string;
  ms: number;
  attempts: number;
}

/** The relay is flaky: 504s on long generations, so retry with backoff and a smaller ask. */
export async function chat(
  secrets: Secrets,
  model: string,
  messages: { role: string; content: string }[],
  maxTokens: number,
  options: { attempts?: number; timeoutMs?: number } = {},
): Promise<CallResult> {
  const attempts = options.attempts ?? 4;
  const timeoutMs = options.timeoutMs ?? 240_000;
  let lastError = 'unknown';
  let budget = maxTokens;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1 && /504|timeout|Gateway/i.test(lastError)) budget = Math.max(900, Math.round(budget * 0.6));
    const started = Date.now();
    try {
      const response = await fetch(`${secrets.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secrets.key}` },
        body: JSON.stringify({ model, messages, max_completion_tokens: budget, stream: false }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = (await response.json().catch(() => ({}))) as {
        usage?: Record<string, unknown>;
        choices?: { message?: { content?: string } }[];
        message?: string;
        code?: string;
      };
      if (!response.ok) {
        lastError = `HTTP ${response.status} ${String(json.message ?? response.statusText)}`.slice(0, 100);
        if (response.status === 402 || /balance|credit|quota|insufficient/i.test(lastError)) {
          return { ok: false, fatal: true, error: `额度耗尽 ${lastError}`, usage: null, content: '', ms: Date.now() - started, attempts: attempt };
        }
      } else {
        return {
          ok: true,
          fatal: false,
          error: '',
          usage: (json.usage ?? null) as Record<string, unknown> | null,
          content: json.choices?.[0]?.message?.content ?? '',
          ms: Date.now() - started,
          attempts: attempt,
        };
      }
    } catch (error) {
      lastError = (error instanceof Error ? `${error.name} ${error.message}` : 'fetch failed').slice(0, 100);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }
  return { ok: false, fatal: false, error: lastError, usage: null, content: '', ms: 0, attempts };
}

export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function usageNumbers(usage: Record<string, unknown> | null) {
  const details = (usage?.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completionDetails = (usage?.completion_tokens_details ?? {}) as Record<string, unknown>;
  return {
    prompt: num(usage?.prompt_tokens),
    completion: num(usage?.completion_tokens),
    cached: num(details.cached_tokens),
    reasoning: num(completionDetails.reasoning_tokens),
  };
}

export function money(micros: number): string {
  return `¥${(micros / 1e6).toFixed(micros < 100_000 ? 4 : micros < 1e6 ? 3 : 2)}`;
}

/**
 * The later rounds learn their caps from what earlier rounds observed, so they need
 * those files to exist. Say which script to run instead of throwing a bare ENOENT.
 */
export function readPriorJson<T>(relative: string, producedBy: string): T {
  const path = file(relative);
  if (!existsSync(path)) {
    throw new Error(`${relative} 不存在：先跑 node examples/${producedBy}.ts 生成它（这几轮是按观测串起来的，不能跳着跑）`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
