import { UsageError } from "../args.js";

const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

/**
 * `10m`, `90s`, `1h30m`, `250ms` — and a bare number, which reads as minutes
 * because that is the unit every CI budget conversation already uses.
 */
export function parseDuration(text: string): number {
  // Whitespace is stripped so a quoted "12m 30s" reads the same as 12m30s.
  const value = text.toLowerCase().replace(/\s+/g, "");
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * UNIT_MS.m;

  let total = 0;
  let consumed = 0;
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    total += Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
    consumed += (match[0] as string).length;
  }

  // Anything left over means the input was only partly understood, and a
  // budget that was silently misread is worse than one that was rejected.
  if (consumed !== value.length || total <= 0) {
    throw new UsageError(`Option "--budget" expects a duration like 10m, 90s or 1h30m, got "${text}".`);
  }
  return total;
}

export interface BudgetVerdict {
  budgetMs: number;
  /** What was measured against the budget: p50 wall time across the sample. */
  actualMs: number;
  over: boolean;
}

/**
 * The gate reads p50 wall time, not the newest run. One unlucky run should not
 * turn a pipeline red, and "CI takes 22 minutes" was always a claim about the
 * middle of the distribution rather than about any single build.
 */
export function evaluateBudget(budgetMs: number, wallP50Ms: number): BudgetVerdict {
  return { budgetMs, actualMs: wallP50Ms, over: wallP50Ms > budgetMs };
}
