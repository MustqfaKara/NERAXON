export function hypercoreRetryDelayMs(retryAfter: string | null, attempt: number, now = Date.now()) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.max(250, Math.min(60_000, seconds * 1_000));
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt) && retryAt > now) return Math.max(250, Math.min(60_000, retryAt - now));
  }
  return Math.min(8_000, 1_000 * 2 ** Math.max(0, attempt));
}
