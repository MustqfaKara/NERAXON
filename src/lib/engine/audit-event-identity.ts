import { createHash } from "node:crypto";

export function auditEventId(input: { chainId: string | null; txHash: string | null; type: string; title: string }) {
  if (!input.txHash) return crypto.randomUUID();
  const identity = [input.chainId ?? "system", input.txHash.toLowerCase(), input.type, input.title].join("|");
  return `tx_${createHash("sha256").update(identity).digest("hex")}`;
}
