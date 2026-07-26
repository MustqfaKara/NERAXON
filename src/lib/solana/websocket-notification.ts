export interface SolanaLogsNotification {
  context?: { slot?: number };
  value?: { signature?: string; err?: unknown };
}

export function parseSolanaLogsNotification(notification: SolanaLogsNotification) {
  const signature = notification.value?.signature;
  if (!signature || notification.value?.err) return null;
  return { signature, slot: notification.context?.slot ?? 0 };
}
