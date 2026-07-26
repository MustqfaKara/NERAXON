import { createHash } from "node:crypto";
import type { ChainId, TradingMode } from "@/lib/domain/types";

const MANUAL_DEDUPLICATION_WINDOW_MS = 30_000;

export function createManualExecutionKey(input: {
  mode: Exclude<TradingMode, "paper">;
  chainId: ChainId;
  action: string;
  asset: string;
  allocationPercent?: number;
  closePercent?: number;
  slippagePercent?: number;
  leverage?: number;
  positionSide?: string;
  now?: number;
}) {
  const bucket = Math.floor((input.now ?? Date.now()) / MANUAL_DEDUPLICATION_WINDOW_MS);
  return hashExecutionKey({ ...input, asset: normalizeAsset(input.chainId, input.asset), now: undefined, bucket, source: "manual" });
}

export function createCopyExecutionKey(mode: Exclude<TradingMode, "paper">, chainId: ChainId, sourceReference: string) {
  return hashExecutionKey({ source: "copy", mode, chainId, sourceReference: sourceReference.toLowerCase() });
}

export function createCertificationExecutionKey(chainId: ChainId, stepId: string) {
  return hashExecutionKey({ source: "certification", chainId, stepId });
}

export function hypercoreClientOrderId(idempotencyKey: string): `0x${string}` {
  return `0x${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
}

function normalizeAsset(chainId: ChainId, asset: string) {
  return chainId === "solana" ? asset.trim() : asset.trim().toLowerCase();
}

function hashExecutionKey(value: Record<string, unknown>) {
  const canonical = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)));
  return `exec:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}
