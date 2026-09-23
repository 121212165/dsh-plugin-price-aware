import type { PriceEntry } from './catalog.ts';

export type Regime = 'peak' | 'offpeak';

export interface RegimeRules {
  /** Beijing calendar dates (YYYY-MM-DD) treated as public holidays -> always off-peak */
  holidays?: string[];
  /** minutes-of-day boundaries [startInclusive, endExclusive), Asia/Shanghai wall clock */
  peakMinutes?: ReadonlyArray<readonly [number, number]>;
}

const BEIJING_OFFSET_MS = 8 * 3_600_000;
const DEFAULT_PEAK_MINUTES: ReadonlyArray<readonly [number, number]> = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
];

function shifted(at: Date | number): Date {
  const ms = typeof at === 'number' ? at : at.getTime();
  return new Date(ms + BEIJING_OFFSET_MS);
}

function beijingDateKey(at: Date | number): string {
  return shifted(at).toISOString().slice(0, 10);
}

/** Minutes since Beijing midnight, ignoring seconds (a second of slop costs <1e-5 CNY). */
function beijingMinutes(at: Date | number): number {
  const b = shifted(at);
  return b.getUTCHours() * 60 + b.getUTCMinutes();
}

function beijingWeekday(at: Date | number): number {
  return shifted(at).getUTCDay();
}

/** `dayStartUtcMs` is already shifted, so only the minutes-of-day remain. */
function msOfBeijingDayAt(dayStartUtcMs: number, minutes: number): number {
  return dayStartUtcMs + minutes * 60_000;
}

function beijingDayStartUtc(at: Date | number): number {
  const b = shifted(at);
  return Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()) - BEIJING_OFFSET_MS;
}

export function isHoliday(at: Date | number, rules: RegimeRules): boolean {
  return (rules.holidays ?? []).includes(beijingDateKey(at));
}

export function isPeakAt(at: Date | number, rules: RegimeRules = {}): boolean {
  const ms = typeof at === 'number' ? at : at.getTime();
  // an invalid date must not throw out of costOf/decide and kill a turn
  if (!Number.isFinite(ms)) return false;
  const weekday = beijingWeekday(ms);
  if (weekday === 0 || weekday === 6) return false;
  if (isHoliday(ms, rules)) return false;
  const minutes = beijingMinutes(ms);
  const windows = rules.peakMinutes ?? DEFAULT_PEAK_MINUTES;
  return windows.some(([from, to]) => minutes >= from && minutes < to);
}

export function regimeAt(at: Date = new Date(), rules: RegimeRules = {}): Regime {
  return isPeakAt(at, rules) ? 'peak' : 'offpeak';
}

/** Next instant at which the billing regime flips, so the agent can say "等 40 分钟省一半". */
export function nextRegimeChange(
  at: Date = new Date(),
  rules: RegimeRules = {},
): { at: Date; regime: Regime } | null {
  const current = isPeakAt(at, rules);
  const base = beijingDayStartUtc(at);
  const boundaries = [...new Set((rules.peakMinutes ?? DEFAULT_PEAK_MINUTES).flatMap(([f, t]) => [f, t]))].sort(
    (a, b) => a - b,
  );
  for (let day = 0; day < 40; day++) {
    for (const minutes of boundaries) {
      const ms = msOfBeijingDayAt(base, minutes + day * 1440);
      if (ms <= at.getTime()) continue;
      if (isPeakAt(ms, rules) !== current) {
        return { at: new Date(ms), regime: isPeakAt(ms, rules) ? 'peak' : 'offpeak' };
      }
    }
  }
  // a long enough holiday run really does hide the next flip; say so rather than
  // inventing a 24h guess the money block would print as fact
  return null;
}

export function minutesUntil(at: Date, now: Date = new Date()): number {
  return Math.max(0, Math.round((at.getTime() - now.getTime()) / 60_000));
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/** What a model actually costs right now, as a multiplier of its sheet price. */
export function priceMultiplier(entry: PriceEntry, at: Date = new Date(), rules: RegimeRules = {}): number {
  if (entry.peakMultiplier === undefined) return 1;
  return isPeakAt(at, rules) ? entry.peakMultiplier : 1;
}

/**
 * Would deferring this spend to the next cheap window save anything?
 * Returns null when there is no peak premium to dodge (flat-priced model).
 */
export function deferralAdvice(
  micros: number,
  entry: PriceEntry,
  rules: RegimeRules = {},
  now: Date = new Date(),
): { waitMinutes: number; savingMicros: number } | null {
  if (entry.peakMultiplier === undefined || entry.peakMultiplier <= 1) return null;
  if (!isPeakAt(now, rules)) return null;
  const next = nextRegimeChange(now, rules);
  if (!next || next.regime !== 'offpeak') return null;
  const wait = minutesUntil(next.at, now);
  if (wait <= 0) return null;
  const saving = Math.round(micros * (1 - 1 / entry.peakMultiplier));
  return { waitMinutes: wait, savingMicros: saving };
}
