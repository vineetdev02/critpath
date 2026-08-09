/** `12m 04s`, `1h 07m`, `42s` — always two significant units, never more. */
export function duration(millis: number): string {
  if (!Number.isFinite(millis) || millis < 0) return "—";

  const totalSeconds = Math.round(millis / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** Signed variant for trends: `+2m 10s` / `-45s`. */
export function delta(millis: number): string {
  const sign = millis >= 0 ? "+" : "−";
  return `${sign}${duration(Math.abs(millis))}`;
}

export function usd(amount: number): string {
  if (amount >= 100) return `$${Math.round(amount).toLocaleString("en-US")}`;
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(3)}`;
}

export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
