export function notificationRetryDelayMs(attempt: number): number {
  const safeAttempt = Math.max(1, Math.trunc(attempt));
  return Math.min(30_000 * 2 ** Math.min(safeAttempt - 1, 5), 15 * 60_000);
}

export function shouldDeadLetterNotification(message: string, attempt: number) {
  if (attempt >= 10) return true;
  return /unauthorized|chat not found|bot was blocked|can't parse entities|user is deactivated/i.test(message);
}
