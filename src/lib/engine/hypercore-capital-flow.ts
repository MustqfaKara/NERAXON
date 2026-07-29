export interface HypercoreLedgerUpdate {
  time: number;
  hash: string;
  delta: Record<string, unknown> & { type?: string };
}

export function hypercoreExternalCapitalFlowUsd(
  updates: HypercoreLedgerUpdate[],
  account: string,
  sinceMs: number,
) {
  const normalizedAccount = account.toLowerCase();
  return updates
    .filter((update) => update.time > sinceMs)
    .reduce((sum, update) => sum + signedCapitalFlow(update.delta, normalizedAccount), 0);
}

function signedCapitalFlow(delta: HypercoreLedgerUpdate["delta"], account: string) {
  if (delta.type === "deposit") return positiveNumber(delta.usdc);
  if (delta.type === "withdraw") return -positiveNumber(delta.usdc);
  if (delta.type !== "send" && delta.type !== "internalTransfer") return 0;

  const sender = stringValue(delta.user).toLowerCase();
  const destination = stringValue(delta.destination).toLowerCase();
  if (sender === account && destination === account) return 0;
  const valueUsd = positiveNumber(delta.usdcValue ?? delta.usdc);
  if (destination === account) return valueUsd;
  if (sender === account) return -valueUsd;
  return 0;
}

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}
