import { SOLANA_NATIVE_MINT, SOLANA_STABLE_MINTS } from "./constants.ts";
import type { HeliusEnhancedTransaction } from "./helius-client.ts";

export function extractSolanaSwapMovement(transaction: HeliusEnhancedTransaction, tokenAddress: string, solPriceUsd: number) {
  const wallet = transaction.feePayer;
  if (!wallet) return null;
  const tokenTransfers = (transaction.tokenTransfers ?? []).filter((transfer) => transfer.mint === tokenAddress);
  const tokenReceived = sum(tokenTransfers.filter((transfer) => transfer.toUserAccount === wallet).map((transfer) => Number(transfer.tokenAmount ?? 0)));
  const tokenSent = sum(tokenTransfers.filter((transfer) => transfer.fromUserAccount === wallet).map((transfer) => Number(transfer.tokenAmount ?? 0)));
  const tokenDelta = tokenReceived - tokenSent;
  if (!Number.isFinite(tokenDelta) || Math.abs(tokenDelta) <= 0) return null;
  const direction = tokenDelta > 0 ? "buy" as const : "sell" as const;
  const quoteDirection = direction === "buy" ? "out" : "in";
  let tokenQuoteUsd = 0;
  for (const transfer of transaction.tokenTransfers ?? []) {
    const matchesDirection = quoteDirection === "out" ? transfer.fromUserAccount === wallet : transfer.toUserAccount === wallet;
    if (!matchesDirection || transfer.mint === tokenAddress) continue;
    if (transfer.mint === SOLANA_NATIVE_MINT) tokenQuoteUsd += Number(transfer.tokenAmount ?? 0) * solPriceUsd;
    if (transfer.mint && SOLANA_STABLE_MINTS.has(transfer.mint)) tokenQuoteUsd += Number(transfer.tokenAmount ?? 0);
  }
  let nativeQuoteUsd = 0;
  for (const transfer of transaction.nativeTransfers ?? []) {
    const matchesDirection = quoteDirection === "out" ? transfer.fromUserAccount === wallet : transfer.toUserAccount === wallet;
    if (matchesDirection) nativeQuoteUsd += Number(transfer.amount ?? 0) / 1_000_000_000 * solPriceUsd;
  }
  return { wallet, direction, tokenAmount: Math.abs(tokenDelta), notionalUsd: tokenQuoteUsd || nativeQuoteUsd };
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
