import type { EvmChainId } from "@/lib/domain/types";

const MAX_CURSOR_AGE_MS = 2 * 60_000;
const WATCHER_RECOVERY_GRACE_MS = 3 * 60_000;
const MAX_CURSOR_LAG: Record<EvmChainId, number> = {
  ethereum: 12,
  base: 120,
  robinhood: 1_000,
};

export function isEvmCursorStalled(input: {
  chainId: EvmChainId;
  lastBlock: number | null;
  cursor: number | null;
  cursorUpdatedAt: string | null;
  watcherStartedAt?: number | null;
  now?: number;
}) {
  if (input.lastBlock === null || input.cursor === null || !input.cursorUpdatedAt) return false;
  const now = input.now ?? Date.now();
  if (input.watcherStartedAt && now - input.watcherStartedAt < WATCHER_RECOVERY_GRACE_MS) return false;
  const updatedAt = Date.parse(input.cursorUpdatedAt);
  if (!Number.isFinite(updatedAt)) return false;
  const lag = input.lastBlock - input.cursor;
  return lag > MAX_CURSOR_LAG[input.chainId]
    && now - updatedAt > MAX_CURSOR_AGE_MS;
}
