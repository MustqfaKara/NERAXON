import { erc20Abi, type Address } from "viem";
import type { CertificationStep, ChainId, EvmChainId, ExecutionAttempt, ReconciliationRecord } from "@/lib/domain/types";
import { getPublicClient } from "@/lib/chains/public-client";
import { store } from "@/lib/repositories/store";
import { getStoredCredentialStatus } from "@/lib/security/keychain";
import { getAllHypercoreClearinghouseStates, hypercoreInfo } from "@/lib/services/hypercore-api";
import { publishEvent } from "@/lib/services/audit-service";
import { solanaRpc } from "@/lib/solana/helius-client";
import { getExecutionAccount } from "@/lib/services/execution-account-service";
import { SOLANA_TOKEN_2022_PROGRAM_ID, SOLANA_TOKEN_PROGRAM_ID } from "@/lib/solana/constants";
import { planExternalBalanceAdjustment } from "@/lib/engine/external-balance-reconciliation";

export const EVM_CERTIFICATION_STEPS = ["small_buy", "partial_sell", "full_sell"] as const;
export const HYPERCORE_CERTIFICATION_STEPS = ["spot_open", "spot_close", "perp_open", "perp_reduce", "perp_close"] as const;
export const SOLANA_CERTIFICATION_STEPS = ["small_buy", "partial_sell", "full_sell"] as const;

interface ClearinghouseState {
  assetPositions?: Array<{ position?: { coin?: string; szi?: string } }>;
}

interface SpotState {
  balances?: Array<{ coin?: string; total?: string; hold?: string }>;
}

export function requiredCertificationSteps(chainId: ChainId) {
  return chainId === "hyperliquid" ? [...HYPERCORE_CERTIFICATION_STEPS] : chainId === "solana" ? [...SOLANA_CERTIFICATION_STEPS] : [...EVM_CERTIFICATION_STEPS];
}

export function certificationStatus(chainId: ChainId) {
  const stored = new Map(store.listCertificationSteps().filter((step) => step.integrationId === chainId).map((step) => [step.stepId, step]));
  return requiredCertificationSteps(chainId).map((stepId): CertificationStep => stored.get(stepId) ?? {
    integrationId: chainId,
    stepId,
    status: "pending",
    reference: null,
    details: "Kontrollü canlı test henüz çalıştırılmadı.",
    checkedAt: null,
  });
}

export async function reconcileIntegration(chainId: ChainId): Promise<ReconciliationRecord> {
  try {
    const details = chainId === "hyperliquid" ? await reconcileHypercore() : chainId === "solana" ? await reconcileSolana() : await reconcileEvm(chainId);
    const record: ReconciliationRecord = { integrationId: chainId, status: "passed", details, checkedAt: new Date().toISOString() };
    store.setReconciliation(record);
    return record;
  } catch (error) {
    const record: ReconciliationRecord = { integrationId: chainId, status: "failed", details: error instanceof Error ? error.message : "Mutabakat tamamlanamadı.", checkedAt: new Date().toISOString() };
    store.setReconciliation(record);
    return record;
  }
}

async function reconcileSolana() {
  const credential = await getStoredCredentialStatus("solana");
  if (!credential.configured || !credential.address) throw new Error("Solana Keychain cüzdanı yapılandırılmadı.");
  const responses = await Promise.all([SOLANA_TOKEN_PROGRAM_ID, SOLANA_TOKEN_2022_PROGRAM_ID].map((programId) => (
    solanaRpc<{ value: Array<{ account?: { data?: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } } } }> }>("getTokenAccountsByOwner", [credential.address, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }])
  )));
  const byMint = new Map<string, bigint>();
  for (const item of responses.flatMap((response) => response.value)) {
    const info = item.account?.data?.parsed?.info;
    if (info?.mint) byMint.set(info.mint, (byMint.get(info.mint) ?? 0n) + BigInt(info.tokenAmount?.amount ?? "0"));
  }
  const lots = store.listExecutionLots("live", "solana").filter((lot) => lot.status === "open" && lot.marketType === "solana");
  const expected = new Map<string, bigint>();
  for (const lot of lots) expected.set(lot.assetKey, (expected.get(lot.assetKey) ?? 0n) + BigInt(lot.amount));
  for (const [mint, amount] of expected) if ((byMint.get(mint) ?? 0n) < amount) throw new Error(`${mint} bakiyesi yerel Solana lotlarından düşük.`);
  return `${expected.size} Solana token bakiyesi yerel live lotlarını karşılıyor.`;
}

export async function reconcileAfterLiveExecution(chainId: ChainId, requestId?: string) {
  try {
    if (requestId) {
      const attempt = store.getExecutionAttempt(requestId);
      if (!attempt) throw new Error("Mutabakat için execution attempt bulunamadı.");
      await assertExternalExecutionConfirmed(attempt);
      if (attempt.accountingStatus !== "applied") throw new Error("Ağ işlemi onaylandı fakat yerel lot muhasebesi uygulanmadı.");
    }
    const reconciliation = await reconcileIntegration(chainId);
    if (reconciliation.status !== "passed") throw new Error(reconciliation.details);
    if (requestId) store.updateExecutionAttempt(requestId, {
      status: "confirmed",
      reconciliationStatus: "passed",
      reconciliationDetails: reconciliation.details,
      reconciledAt: new Date().toISOString(),
      errorMessage: null,
    });
    return reconciliation;
  } catch (error) {
    if (error instanceof PendingExternalExecutionError || error instanceof TerminalExternalRejectionError) throw error;
    const details = error instanceof Error ? error.message : "Canlı mutabakat tamamlanamadı.";
    if (requestId) {
      const attempt = store.getExecutionAttempt(requestId);
      if (attempt) store.updateExecutionAttempt(requestId, {
        status: attempt.status,
        reconciliationStatus: "failed",
        reconciliationDetails: details,
        reconciledAt: new Date().toISOString(),
        errorMessage: details,
      });
    }
    const current = store.getCircuitBreaker();
    store.setCircuitBreaker({ ...current, halted: true, reason: `${chainId} canlı mutabakatı başarısız: ${details}`, triggeredAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await publishEvent({ chainId, level: "critical", type: "system", title: "Canlı mutabakat devre kesiciyi durdurdu", message: details, txHash: null });
    throw new Error(details);
  }
}

export async function recoverPendingLiveExecutions() {
  const attempts = store.listPendingLiveExecutionAttempts();
  for (const attempt of attempts) {
    const ageMs = Date.now() - new Date(attempt.updatedAt).getTime();
    if (attempt.status === "submitting" && !attempt.txHash && !attempt.externalOrderId) {
      if (ageMs < 2 * 60_000) continue;
      const details = "Gönderim sırasında ağ referansı kaydedilemedi; aynı emrin otomatik tekrarı engellendi.";
      store.updateExecutionAttempt(attempt.requestId, { status: "stale", reconciliationStatus: "failed", reconciliationDetails: details, reconciledAt: new Date().toISOString(), errorMessage: details });
      await haltForRecoveryFailure(attempt.integrationId, details);
      continue;
    }
    try {
      await reconcileAfterLiveExecution(attempt.integrationId, attempt.requestId);
    } catch (error) {
      if (error instanceof TerminalExternalRejectionError) {
        store.updateExecutionAttempt(attempt.requestId, {
          status: "failed",
          reconciliationStatus: "passed",
          reconciliationDetails: "Borsa emri kesin olarak reddetti; fill oluşmadı.",
          reconciledAt: new Date().toISOString(),
          errorMessage: error.message,
        });
        continue;
      }
      if (error instanceof PendingExternalExecutionError) {
        if (ageMs < 3 * 60_000) continue;
        const details = `${error.message} Üç dakikalık mutabakat süresi aşıldı.`;
        store.updateExecutionAttempt(attempt.requestId, { status: attempt.status, reconciliationStatus: "failed", reconciliationDetails: details, reconciledAt: new Date().toISOString(), errorMessage: details });
        await haltForRecoveryFailure(attempt.integrationId, details);
      }
    }
  }
}

async function assertExternalExecutionConfirmed(attempt: ExecutionAttempt) {
  if (attempt.integrationId === "hyperliquid") return assertHypercoreExecutionConfirmed(attempt);
  if (attempt.integrationId === "solana") return assertSolanaExecutionConfirmed(attempt);
  if (!attempt.txHash?.startsWith("0x")) throw new Error("EVM transaction hash kaydedilmedi.");
  try {
    const receipt = await getPublicClient(attempt.integrationId).getTransactionReceipt({ hash: attempt.txHash as `0x${string}` });
    if (receipt.status !== "success") throw new Error("EVM işlemi zincirde başarısız oldu.");
  } catch (error) {
    if (/not found|could not be found/i.test(error instanceof Error ? error.message : "")) throw new PendingExternalExecutionError("EVM işlemi henüz zincirde bulunamadı.");
    throw error;
  }
}

async function assertSolanaExecutionConfirmed(attempt: ExecutionAttempt) {
  if (!attempt.txHash) throw new Error("Solana transaction signature kaydedilmedi.");
  const status = await solanaRpc<{ value: Array<{ confirmationStatus?: string; err?: unknown } | null> }>("getSignatureStatuses", [[attempt.txHash], { searchTransactionHistory: true }]);
  const item = status.value[0];
  if (!item) throw new PendingExternalExecutionError("Solana işlemi henüz RPC geçmişinde bulunamadı.");
  if (item.err) throw new Error(`Solana işlemi zincirde başarısız: ${JSON.stringify(item.err)}`);
  if (item.confirmationStatus !== "confirmed" && item.confirmationStatus !== "finalized") throw new PendingExternalExecutionError("Solana işlemi henüz confirmed olmadı.");
}

async function assertHypercoreExecutionConfirmed(attempt: ExecutionAttempt) {
  const account = getExecutionAccount("hyperliquid")?.toLowerCase();
  if (!account) throw new Error("Hyperliquid hesap adresi yapılandırılmadı.");
  const reference = attempt.externalOrderId;
  if (!reference) throw new Error("HyperCore order ID veya cloid kaydedilmedi.");
  const oid = reference.startsWith("0x") ? reference : Number(reference);
  const response = await hypercoreInfo<{
    status: "unknownOid" | "order";
    order?: { status?: string };
  }>({ type: "orderStatus", user: account, oid });
  if (response.status === "unknownOid") throw new PendingExternalExecutionError("HyperCore emri henüz Info API üzerinde bulunamadı.");
  const status = response.order?.status;
  if (status === "filled") return;
  if (status === "open" || status === "triggered") throw new PendingExternalExecutionError(`HyperCore emri henüz ${status} durumunda.`);
  throw new TerminalExternalRejectionError(`HyperCore emri ${status ?? "bilinmeyen"} durumunda; fill doğrulanamadı.`);
}

async function haltForRecoveryFailure(chainId: ChainId, details: string) {
  const current = store.getCircuitBreaker();
  store.setCircuitBreaker({ ...current, halted: true, reason: `${chainId} belirsiz canlı emir: ${details}`, triggeredAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await publishEvent({ chainId, level: "critical", type: "system", title: "Belirsiz canlı emir otomatik tekrarı durdurdu", message: details, txHash: null });
}

class PendingExternalExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingExternalExecutionError";
  }
}

class TerminalExternalRejectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalExternalRejectionError";
  }
}

async function reconcileEvm(chainId: EvmChainId) {
  const credential = await getStoredCredentialStatus("evm");
  if (!credential.configured || !credential.address) throw new Error("EVM Keychain cüzdanı yapılandırılmadı.");
  const address = credential.address as Address;
  const client = getPublicClient(chainId);
  await client.getBalance({ address });
  const lots = store.listExecutionLots("live", chainId).filter((lot) => lot.status === "open" && lot.marketType === "evm");
  const byToken = new Map<string, typeof lots>();
  for (const lot of lots) byToken.set(lot.assetKey, [...(byToken.get(lot.assetKey) ?? []), lot]);
  const entries = [...byToken.entries()];
  const contracts = entries.map(([tokenAddress]) => ({
    address: tokenAddress as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf" as const,
    args: [address] as const,
  }));
  const balances = await client.multicall({
    allowFailure: true,
    contracts,
  }).catch(async (error) => {
    if (!(error instanceof Error) || !error.message.includes("multicallAddress is required")) throw error;
    return Promise.all(contracts.map(async (contract) => {
      try {
        const result = await client.readContract(contract);
        return { status: "success" as const, result };
      } catch (readError) {
        return {
          status: "failure" as const,
          error: readError instanceof Error ? readError : new Error("Token bakiyesi okunamadı."),
        };
      }
    }));
  });
  let adjustedCount = 0;
  for (const [index, [tokenAddress, tokenLots]] of entries.entries()) {
    const balance = balances[index];
    if (balance.status === "failure") throw new Error(`${tokenAddress} zincir bakiyesi okunamadı: ${balance.error.message}`);
    const adjustment = planExternalBalanceAdjustment(tokenLots, BigInt(String(balance.result)));
    if (!adjustment) continue;
    const symbol = tokenLots[0]?.assetSymbol || tokenAddress;
    store.reduceExecutionLots(
      tokenLots,
      adjustment.reductionAmount.toString(),
      adjustment.hasMarketPrice
        ? { netProceedsUsd: adjustment.estimatedNetProceedsUsd, feesUsd: 0 }
        : undefined,
    );
    adjustedCount += 1;
    await publishEvent({
      chainId,
      level: "warning",
      type: "system",
      title: `${symbol} harici satışla eşitlendi`,
      message: adjustment.hasMarketPrice
        ? `Cüzdan bakiyesi yerel kayıttan düşük olduğu için ${symbol} lotu zincir bakiyesine indirildi. Harici satışın gerçek fill verisi uygulamada bulunmadığından yaklaşık ${adjustment.estimatedRealizedPnlUsd.toFixed(4)} USD sonuç son piyasa fiyatıyla kaydedildi. Yeni emir gönderilmedi.`
        : `Cüzdan bakiyesi yerel kayıttan düşük olduğu için ${symbol} lotu zincir bakiyesine indirildi. Güncel fiyat bulunamadığından harici satış PnL'si lota eklenmedi. Yeni emir gönderilmedi.`,
      txHash: null,
    });
  }
  return adjustedCount
    ? `${byToken.size} token kontrol edildi; ${adjustedCount} token harici cüzdan hareketlerine göre yerel lotlarla eşitlendi.`
    : `${byToken.size} token için zincir bakiyesi yerel live lotlarını karşılıyor.`;
}

async function reconcileHypercore() {
  const account = getExecutionAccount("hyperliquid")?.toLowerCase();
  if (!account) throw new Error("Hyperliquid hesap adresi yapılandırılmadı.");
  const [perpStates, spotState] = await Promise.all([
    getAllHypercoreClearinghouseStates<ClearinghouseState>(account),
    hypercoreInfo<SpotState>({ type: "spotClearinghouseState", user: account }),
  ]);
  const lots = store.listExecutionLots("live", "hyperliquid").filter((lot) => lot.status === "open");
  for (const lot of lots) {
    const coin = lot.assetKey.split(":").slice(1).join(":").toUpperCase();
    const expected = Number(lot.amount);
    if (lot.marketType === "spot") {
      const balance = spotState.balances?.find((item) => item.coin?.toUpperCase() === coin);
      const actual = Math.max(0, Number(balance?.total ?? 0) - Number(balance?.hold ?? 0));
      if (actual + 1e-9 < expected) throw new Error(`${coin} spot bakiyesi yerel lottan düşük.`);
    } else {
      const position = perpStates
        .flatMap((state) => state.assetPositions ?? [])
        .find((item) => item.position?.coin?.toUpperCase() === coin)
        ?.position;
      const signed = Number(position?.szi ?? 0);
      const actual = lot.positionSide === "short" ? Math.max(0, -signed) : Math.max(0, signed);
      if (actual + 1e-9 < expected) throw new Error(`${coin} ${lot.positionSide} pozisyonu yerel lottan düşük.`);
    }
  }
  return `${lots.length} HyperCore lotu Info API pozisyonlarıyla uyumlu.`;
}
