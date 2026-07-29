import { custom } from "viem";
import type { EvmChainId, RpcEndpointInfo } from "@/lib/domain/types";
import { readCredentialSync, type CredentialId } from "../security/credential-vault.ts";

const DEFAULT_RPC_URLS: Record<EvmChainId, string[]> = {
  ethereum: [
    "https://eth.blockscout.com/api/eth-rpc",
    "https://eth.drpc.org",
    "https://ethereum-rpc.publicnode.com",
  ],
  base: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
  robinhood: ["https://rpc.mainnet.chain.robinhood.com"],
};

const RPC_ENV_PREFIX: Record<EvmChainId, string> = {
  ethereum: "ETHEREUM",
  base: "BASE",
  robinhood: "ROBINHOOD",
};

const RPC_CREDENTIALS: Record<EvmChainId, { primary: CredentialId; fallbacks: CredentialId }> = {
  ethereum: { primary: "ethereum-rpc-url", fallbacks: "ethereum-rpc-fallback-urls" },
  base: { primary: "base-rpc-url", fallbacks: "base-rpc-fallback-urls" },
  robinhood: { primary: "robinhood-rpc-url", fallbacks: "robinhood-rpc-fallback-urls" },
};

const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;
const MONTHLY_CAPACITY_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
const FAILURE_COOLDOWN_MS = 60_000;

interface RpcEndpointState {
  cooldownUntil: number;
  failures: number;
}

const globalRpcState = globalThis as typeof globalThis & {
  neraxonEvmRpcEndpointState?: Map<string, RpcEndpointState>;
  neraxonEvmUnsupportedMethods?: Set<string>;
};
const endpointState = globalRpcState.neraxonEvmRpcEndpointState ?? new Map<string, RpcEndpointState>();
const unsupportedMethods = globalRpcState.neraxonEvmUnsupportedMethods ?? new Set<string>();
globalRpcState.neraxonEvmRpcEndpointState = endpointState;
globalRpcState.neraxonEvmUnsupportedMethods = unsupportedMethods;
class NonFailoverRpcError extends Error {}

export function getEvmRpcUrls(chainId: EvmChainId): string[] {
  const prefix = RPC_ENV_PREFIX[chainId];
  const credentials = RPC_CREDENTIALS[chainId];
  const configured = [
    readCredentialSync(credentials.primary),
    ...splitRpcUrls(process.env[`${prefix}_RPC_URLS`]),
    ...splitRpcUrls(readCredentialSync(credentials.fallbacks)),
  ];
  return uniqueRpcUrls([...configured, ...DEFAULT_RPC_URLS[chainId]]);
}

export function listEvmRpcEndpoints(chainId: EvmChainId): RpcEndpointInfo[] {
  const prefix = RPC_ENV_PREFIX[chainId];
  const credentials = RPC_CREDENTIALS[chainId];
  const configured = uniqueRpcUrls([
    readCredentialSync(credentials.primary),
    ...splitRpcUrls(process.env[`${prefix}_RPC_URLS`]),
    ...splitRpcUrls(readCredentialSync(credentials.fallbacks)),
  ]);
  const configuredSet = new Set(configured);
  return getEvmRpcUrls(chainId).map((url, index) => {
    const state = endpointState.get(url);
    const cooldownUntil = state?.cooldownUntil ?? 0;
    return {
      chainId,
      url: maskRpcUrl(url),
      source: configuredSet.has(url) ? "configured" : "public",
      priority: index + 1,
      status: cooldownUntil > Date.now() ? "cooldown" : "active",
      cooldownUntil: cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null,
      failureCount: state?.failures ?? 0,
      pollingIntervalMs: evmPollingIntervalMs(chainId),
    };
  });
}

export function isEvmRpcUrlAvailable(url: string) {
  return (endpointState.get(url)?.cooldownUntil ?? 0) <= Date.now();
}

export function recordEvmRpcProviderFailure(url: string, method: string, message: string, httpRateLimited = false) {
  markRpcFailure(url, method, message, httpRateLimited);
}

export function createEvmFallbackTransport(chainId: EvmChainId, timeout = 10_000) {
  return custom({
    async request({ method, params }) {
      const payload = await fetchEvmRpcJson<{ result?: unknown }>(
        chainId,
        { jsonrpc: "2.0", id: 1, method, params: params ?? [] },
        timeout,
      );
      if (!("result" in payload)) throw new Error("RPC sonuç alanı bulunamadı.");
      return payload.result;
    },
  }, { retryCount: 0 });
}

export async function fetchEvmRpcJson<T>(
  chainId: EvmChainId,
  body: Record<string, unknown> | Array<Record<string, unknown>>,
  timeout = 20_000,
): Promise<T> {
  const method = rpcMethod(body);
  const urls = availableRpcUrls(chainId, method);
  let lastError = new Error(`${chainId} RPC isteği tamamlanamadı.`);

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
        cache: "no-store",
      });
      const responseText = await response.text();
      const payload = parseRpcPayload(responseText);
      const providerError = (!response.ok && payload === null && responseText.trim()
        ? responseText.trim().slice(0, 500)
        : rpcProviderError(payload))
        ?? (!response.ok && responseText.trim() ? responseText.trim().slice(0, 500) : null);
      if (!response.ok || providerError) {
        const message = providerError ?? `RPC isteği başarısız (${response.status}).`;
        const error = new Error(message);
        if (providerError && !isFailoverError(message)) throw new NonFailoverRpcError(message);
        markRpcFailure(url, method, message, response.status === 429);
        lastError = error;
        continue;
      }
      markRpcSuccess(url);
      return payload as T;
    } catch (error) {
      if (error instanceof NonFailoverRpcError) throw error;
      lastError = error instanceof Error ? error : lastError;
      markRpcFailure(url, method, lastError.message);
    }
  }
  throw lastError;
}

export function evmPollingIntervalMs(chainId: EvmChainId) {
  if (chainId === "ethereum") return 15_000;
  if (chainId === "base") return 10_000;
  return 15_000;
}

function splitRpcUrls(value: string | null | undefined) {
  return value?.split(",").map((url) => url.trim()).filter(Boolean) ?? [];
}

function uniqueRpcUrls(urls: Array<string | null | undefined>) {
  return [...new Set(urls.map((url) => url?.trim()).filter((url): url is string => Boolean(url)))];
}

function availableRpcUrls(chainId: EvmChainId, method: string) {
  const now = Date.now();
  const urls = getEvmRpcUrls(chainId).filter((url) => !unsupportedMethods.has(`${url}:${method}`));
  if (!urls.length) throw new Error(`${chainId} için ${method} metodunu destekleyen RPC endpoint'i kalmadı.`);
  const available = urls.filter((url) => (endpointState.get(url)?.cooldownUntil ?? 0) <= now);
  if (available.length) return available;
  return [...urls].sort(
    (left, right) => (endpointState.get(left)?.cooldownUntil ?? 0) - (endpointState.get(right)?.cooldownUntil ?? 0),
  );
}

function markRpcFailure(url: string, method: string, message: string, httpRateLimited = false) {
  if (isMethodIncompatible(message)) {
    unsupportedMethods.add(`${url}:${method}`);
    return;
  }
  const current = endpointState.get(url) ?? { cooldownUntil: 0, failures: 0 };
  const failures = current.failures + 1;
  const cooldownMs = isMonthlyCapacityError(message)
    ? MONTHLY_CAPACITY_COOLDOWN_MS
    : httpRateLimited || isRateLimitError(message)
      ? RATE_LIMIT_COOLDOWN_MS
      : FAILURE_COOLDOWN_MS;
  endpointState.set(url, {
    failures,
    cooldownUntil: Date.now() + cooldownMs,
  });
}

function markRpcSuccess(url: string) {
  endpointState.set(url, { cooldownUntil: 0, failures: 0 });
}

function rpcProviderError(payload: unknown): string | null {
  if (Array.isArray(payload)) {
    const failed = payload.find((item) => item && typeof item === "object" && "error" in item) as { error?: { message?: string } } | undefined;
    return failed?.error?.message ?? null;
  }
  if (payload && typeof payload === "object" && "error" in payload) {
    return (payload as { error?: { message?: string } }).error?.message ?? "RPC hata yanıtı döndürdü.";
  }
  return payload === null ? "RPC geçersiz JSON yanıtı döndürdü." : null;
}

function parseRpcPayload(value: string): unknown {
  if (!value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRateLimitError(message: string) {
  return /429|rate limit|too many|compute units|capacity/i.test(message);
}

function isMonthlyCapacityError(message: string) {
  return /monthly capacity limit exceeded/i.test(message);
}

function isFailoverError(message: string) {
  return /429|rate limit|too many|compute units|capacity|timeout|timed out|temporar|unavailable|internal error|gateway|invalid json|block range|limit exceeded|query returned more|response size|method not found|does not support|please specify an address|dedicated full node|archive.*requests?.*(?:require|not available|unavailable|current plan)|historical (?:state|data).*(?:unavailable|unsupported)/i.test(message);
}

function isMethodIncompatible(message: string) {
  return /method not found|does not support.*(?:method|eth_getlogs)|please specify an address|dedicated full node/i.test(message);
}

function rpcMethod(body: Record<string, unknown> | Array<Record<string, unknown>>) {
  const requests = Array.isArray(body) ? body : [body];
  return requests.map((request) => String(request.method ?? "unknown")).sort().join(",");
}

function maskRpcUrl(value: string) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of ["api-key", "apikey", "key", "token"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "[gizli]");
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const credentialIndex = segments.findIndex((segment, index) => (
      (segments[index - 1] === "v2" && segment.length > 6)
      || (segment.length >= 24 && /chainstack|ankr|alchemy/i.test(url.hostname))
    ));
    if (credentialIndex >= 0) {
      segments[credentialIndex] = "[gizli]";
      url.pathname = `/${segments.join("/")}`;
    }
    return decodeURIComponent(url.toString()).replace(/\/$/, "");
  } catch {
    return "Geçersiz RPC URL";
  }
}
