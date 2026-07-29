import { monitorService } from "@/lib/services/service-health";
import { readCredentialSync } from "@/lib/security/credential-vault";

export interface JupiterRouteStep {
  swapInfo: {
    ammKey: string;
    label?: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
  };
  percent: number;
}

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: "ExactIn";
  slippageBps: number;
  priceImpactPct: string;
  routePlan: JupiterRouteStep[];
  contextSlot?: number;
  timeTaken?: number;
}

export interface JupiterSwapTransaction {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
}

export interface JupiterShieldWarning {
  type: string;
  message: string;
  severity: "info" | "warning" | "error" | string;
}

interface JupiterShieldResponse {
  warnings?: Record<string, JupiterShieldWarning[]>;
}

const apiBase = () => process.env.JUPITER_API_URL?.trim() || "https://api.jup.ag/swap/v1";
const SHIELD_CACHE_TTL_MS = 10 * 60_000;
const shieldCache = new Map<string, { warnings: JupiterShieldWarning[]; expiresAt: number }>();
const headers = () => ({
  accept: "application/json",
  "content-type": "application/json",
  ...(readCredentialSync("jupiter-api-key") ? { "x-api-key": readCredentialSync("jupiter-api-key")! } : {}),
});

function priorityFeeConfig() {
  const requestedLevel = process.env.SOLANA_PRIORITY_LEVEL?.trim();
  const priorityLevel = requestedLevel === "high" || requestedLevel === "veryHigh" ? requestedLevel : "medium";
  const requestedMax = Number(process.env.SOLANA_MAX_PRIORITY_FEE_LAMPORTS ?? 100_000);
  const maxLamports = Number.isFinite(requestedMax) ? Math.max(5_000, Math.min(1_000_000, Math.trunc(requestedMax))) : 100_000;
  return { priorityLevelWithMaxLamports: { maxLamports, priorityLevel } };
}

export async function getJupiterQuote(input: {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
}) {
  const query = new URLSearchParams({
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    amount: input.amount.toString(),
    slippageBps: String(input.slippageBps),
    restrictIntermediateTokens: "true",
    swapMode: "ExactIn",
  });
  const response = await monitorService("jupiter", () => fetch(`${apiBase()}/quote?${query}`, {
    headers: headers(),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  }));
  const payload = await response.json() as JupiterQuote & { error?: string; errorCode?: string };
  if (!response.ok || payload.error || !payload.outAmount) {
    throw new Error(payload.error ?? `Jupiter rota teklifi alınamadı (${response.status}).`);
  }
  return payload;
}

export async function buildJupiterSwap(quote: JupiterQuote, userPublicKey: string) {
  const response = await monitorService("jupiter", () => fetch(`${apiBase()}/swap`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: priorityFeeConfig(),
    }),
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  }));
  const payload = await response.json() as JupiterSwapTransaction & { error?: string };
  if (!response.ok || payload.error || !payload.swapTransaction) {
    throw new Error(payload.error ?? `Jupiter swap işlemi hazırlanamadı (${response.status}).`);
  }
  return payload;
}

export async function getJupiterShieldWarnings(mint: string) {
  const cached = shieldCache.get(mint);
  if (cached && cached.expiresAt > Date.now()) return cached.warnings;
  const apiKey = readCredentialSync("jupiter-api-key");
  if (!apiKey) throw new Error("Jupiter API anahtarı yapılandırılmadı.");
  const url = new URL("https://api.jup.ag/ultra/v1/shield");
  url.searchParams.set("mints", mint);
  const response = await monitorService("jupiter", () => fetch(url, {
    headers: { accept: "application/json", "x-api-key": apiKey },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  }));
  const payload = await response.json().catch(() => null) as JupiterShieldResponse | null;
  if (!response.ok || !payload?.warnings || !Array.isArray(payload.warnings[mint])) {
    throw new Error(`Jupiter Shield doğrulaması tamamlanamadı (${response.status}).`);
  }
  const warnings = payload.warnings[mint];
  shieldCache.set(mint, { warnings, expiresAt: Date.now() + SHIELD_CACHE_TTL_MS });
  return warnings;
}
