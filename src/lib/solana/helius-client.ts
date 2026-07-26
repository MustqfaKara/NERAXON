import { CHAIN_DEFINITIONS } from "@/lib/domain/defaults";
import { monitorService } from "@/lib/services/service-health";
import { readCredentialSync } from "@/lib/security/credential-vault";

interface RpcEnvelope<T> {
  result?: T;
  error?: { code?: number; message?: string };
}

export interface HeliusEnhancedTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  mint?: string;
  tokenAmount?: number;
}

export interface HeliusEnhancedNativeTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount?: number;
}

export interface HeliusEnhancedSwapEvent {
  nativeInput?: { account?: string; amount?: string };
  nativeOutput?: { account?: string; amount?: string };
  tokenInputs?: Array<{ userAccount?: string; mint?: string; rawTokenAmount?: { tokenAmount?: string; decimals?: number } }>;
  tokenOutputs?: Array<{ userAccount?: string; mint?: string; rawTokenAmount?: { tokenAmount?: string; decimals?: number } }>;
}

export interface HeliusEnhancedTransaction {
  signature: string;
  timestamp?: number;
  feePayer?: string;
  fee?: number;
  type?: string;
  source?: string;
  tokenTransfers?: HeliusEnhancedTokenTransfer[];
  nativeTransfers?: HeliusEnhancedNativeTransfer[];
  events?: { swap?: HeliusEnhancedSwapEvent };
}

export function heliusRpcUrl() {
  return readCredentialSync("solana-rpc-url") || CHAIN_DEFINITIONS.solana.rpcUrl;
}

export function heliusWebSocketUrl() {
  const configured = readCredentialSync("solana-ws-url");
  if (configured) return configured;
  const apiKey = readCredentialSync("helius-api-key");
  return apiKey ? `wss://mainnet.helius-rpc.com/?api-key=${apiKey}` : "wss://api.mainnet-beta.solana.com";
}

export async function solanaRpc<T>(method: string, params: unknown = []): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await monitorService("helius", () => fetch(heliusRpcUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      }));
      const payload = await response.json() as RpcEnvelope<T>;
      if (response.ok && !payload.error && payload.result !== undefined) return payload.result;
      lastError = new Error(payload.error?.message ?? `Solana RPC isteği başarısız (${response.status}).`);
      if (response.status !== 429 && response.status < 500) throw lastError;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Solana RPC isteği başarısız.");
    }
    if (attempt < 3) await delay(500 * 2 ** attempt);
  }
  throw lastError ?? new Error("Solana RPC tekrar denemelerden sonra yanıt vermedi.");
}

export async function getEnhancedTransactions(
  address: string,
  options: { before?: string; limit?: number; type?: "SWAP" } = {},
) {
  const apiKey = readCredentialSync("helius-api-key");
  if (!apiKey) throw new Error("HELIUS_API_KEY yapılandırılmadı.");
  const search = new URLSearchParams({ "api-key": apiKey, limit: String(options.limit ?? 100) });
  if (options.before) search.set("before", options.before);
  if (options.type) search.set("type", options.type);
  const url = `https://api-mainnet.helius-rpc.com/v0/addresses/${encodeURIComponent(address)}/transactions?${search}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await monitorService("helius", () => fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "application/json" },
      cache: "no-store",
    }));
    if (response.ok) return response.json() as Promise<HeliusEnhancedTransaction[]>;
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      await delay(Math.max(retryAfter * 1_000, 500 * 2 ** attempt));
      continue;
    }
    const detail = await response.text();
    throw new Error(`Helius işlem geçmişi alınamadı (${response.status}): ${detail.slice(0, 180)}`);
  }
  throw new Error("Helius işlem geçmişi tekrar denemelerden sonra alınamadı.");
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
