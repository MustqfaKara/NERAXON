import { isAddress } from "viem";
import { PublicKey } from "@solana/web3.js";
import type { ExecutionAccountAddresses } from "@/lib/domain/types";
import { store } from "@/lib/repositories/store";

export type ExecutionAccountKind = keyof ExecutionAccountAddresses;

export function getExecutionAccount(kind: ExecutionAccountKind) {
  const stored = store.getExecutionAccounts()[kind]?.trim();
  if (stored) return stored;
  if (kind === "evm") return process.env.LIVE_EVM_WALLET_ADDRESS?.trim() || null;
  if (kind === "solana") return process.env.SOLANA_WALLET_ADDRESS?.trim() || null;
  return process.env.HYPERLIQUID_ACCOUNT_ADDRESS?.trim() || null;
}

export function setExecutionAccount(kind: ExecutionAccountKind, address: string) {
  const normalized = normalizeExecutionAccount(kind, address);
  store.setExecutionAccounts({ ...store.getExecutionAccounts(), [kind]: normalized });
  return normalized;
}

export function normalizeExecutionAccount(kind: ExecutionAccountKind, address: string) {
  const trimmed = address.trim();
  if (kind === "solana") {
    try { return new PublicKey(trimmed).toBase58(); } catch { throw new Error("Geçerli bir Solana cüzdan adresi gerekli."); }
  }
  if (!isAddress(trimmed)) throw new Error("Geçerli bir EVM cüzdan adresi gerekli.");
  return trimmed.toLowerCase();
}
