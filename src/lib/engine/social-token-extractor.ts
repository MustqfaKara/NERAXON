import { PublicKey } from "@solana/web3.js";
import type { ChainId, SocialTokenSignal } from "../domain/types.ts";

export interface SocialTokenReference {
  chainHint: ChainId | null;
  dexScreenerChainHint?: string;
  value: string;
  referenceType: SocialTokenSignal["referenceType"];
  pairAddress?: string;
}

const EVM_ADDRESS_PATTERN = /\b0x[a-fA-F0-9]{40}\b/g;
const SOLANA_ADDRESS_PATTERN = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const TICKER_PATTERN = /(?:^|[\s(])\$([A-Za-z][A-Za-z0-9]{1,11})\b/g;
const DEXSCREENER_PATTERN = /https?:\/\/(?:www\.)?dexscreener\.com\/([a-z0-9-]+)\/([a-zA-Z0-9]+)/gi;
const PUMPFUN_PATTERN = /https?:\/\/(?:www\.)?pump\.fun\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/gi;
const SUPPORTED_DEXSCREENER_CHAINS: Partial<Record<string, ChainId>> = {
  ethereum: "ethereum",
  base: "base",
  robinhood: "robinhood",
  solana: "solana",
};

export function extractSocialTokenReferences(text: string): SocialTokenReference[] {
  const references: SocialTokenReference[] = [];
  const seen = new Set<string>();
  const add = (reference: SocialTokenReference) => {
    const key = `${reference.referenceType}:${reference.chainHint ?? "unknown"}:${reference.value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push(reference);
  };

  for (const match of text.matchAll(DEXSCREENER_PATTERN)) {
    const dexScreenerChainHint = match[1].toLowerCase();
    add({
      chainHint: SUPPORTED_DEXSCREENER_CHAINS[dexScreenerChainHint] ?? null,
      dexScreenerChainHint,
      value: match[2],
      pairAddress: match[2],
      referenceType: "dexscreener_pair",
    });
  }

  for (const match of text.matchAll(PUMPFUN_PATTERN)) {
    if (!isSolanaAddress(match[1])) continue;
    add({ chainHint: "solana", value: match[1], referenceType: "pumpfun" });
  }

  const chainHint = inferChainHint(text);
  const textWithoutUrls = text.replace(/https?:\/\/\S+/gi, " ");
  for (const address of textWithoutUrls.match(EVM_ADDRESS_PATTERN) ?? []) {
    add({ chainHint, value: address.toLowerCase(), referenceType: "address" });
  }

  for (const address of textWithoutUrls.match(SOLANA_ADDRESS_PATTERN) ?? []) {
    if (!isSolanaAddress(address)) continue;
    add({ chainHint: "solana", value: address, referenceType: "address" });
  }

  for (const match of textWithoutUrls.matchAll(TICKER_PATTERN)) {
    add({ chainHint, value: match[1].toUpperCase(), referenceType: "ticker" });
  }
  return references.slice(0, 12);
}

function inferChainHint(text: string): ChainId | null {
  const normalized = text.toLowerCase();
  if (/dexscreener\.com\/solana|pump\.fun|solscan|solana/.test(normalized)) return "solana";
  if (/dexscreener\.com\/robinhood|robinhoodchain|robinhood chain/.test(normalized)) return "robinhood";
  if (/dexscreener\.com\/base|basescan|\bbase\b/.test(normalized)) return "base";
  if (/dexscreener\.com\/ethereum|etherscan|\beth(?:ereum)?\b/.test(normalized)) return "ethereum";
  return null;
}

function isSolanaAddress(value: string) {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}
