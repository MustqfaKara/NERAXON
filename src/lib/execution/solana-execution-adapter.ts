import { VersionedTransaction } from "@solana/web3.js";
import type { ExecutionAdapter, ExecutionSubmissionHooks, NormalizedExecutionResult } from "@/lib/execution/execution-adapter";
import type { TradeSide, TradingMode } from "@/lib/domain/types";
import { getStoredCredentialStatus, readSolanaKeypair } from "@/lib/security/keychain";
import { SOLANA_LAMPORTS_PER_SOL, SOLANA_NATIVE_MINT } from "@/lib/solana/constants";
import { solanaRpc } from "@/lib/solana/helius-client";
import { buildJupiterSwap, getJupiterQuote, type JupiterQuote, type JupiterSwapTransaction } from "@/lib/services/jupiter-api";
import { getExecutionAccount } from "@/lib/services/execution-account-service";
import { store } from "@/lib/repositories/store";
import { isExpectedShadowFundingError } from "@/lib/solana/shadow-simulation";
import { assertAssetNotDenied } from "@/lib/engine/asset-execution-policy";
import { calculateSolanaBuyTransactionCosts } from "@/lib/execution/solana-fee";
import { getNetworkExecutionLimit } from "@/lib/execution/network-execution-risk";
import { isJupiterSlippageError, nextJupiterSlippageBps } from "@/lib/execution/live-error-policy";

export interface SolanaExecutionIntent {
  side: TradeSide;
  tokenAddress: string;
  allocationPercent?: number;
  exactSellAmount?: bigint;
  slippagePercent: number;
  mode: Exclude<TradingMode, "paper">;
}

export interface SolanaExecutionPlan {
  side: TradeSide;
  tokenAddress: string;
  userPublicKey: string;
  quote: JupiterQuote;
  transaction: JupiterSwapTransaction;
  sellAmount: bigint;
  estimatedPriorityFeeLamports: number;
  quotedAt: string;
  shadowSimulation: { rpcValidated: boolean; fundingStateSkipped: boolean; detail: string | null } | null;
}

class SolanaExecutionAdapter implements ExecutionAdapter<SolanaExecutionIntent, SolanaExecutionPlan> {
  readonly integrationId = "solana" as const;

  async prepare(intent: SolanaExecutionIntent): Promise<SolanaExecutionPlan> {
    const accountAddress = intent.mode === "shadow"
      ? getExecutionAccount("solana")
      : (await getStoredCredentialStatus("solana")).address;
    if (!accountAddress) throw new Error("Solana işlem hesabı yapılandırılmadı.");
    const sellAmount = intent.side === "buy"
      ? await this.buyAmount(accountAddress, intent.allocationPercent, intent.mode)
      : intent.exactSellAmount;
    if (!sellAmount || sellAmount <= 0n) throw new Error("Solana swap miktarı sıfırdan büyük olmalı.");
    const quote = await getJupiterQuote({
      inputMint: intent.side === "buy" ? SOLANA_NATIVE_MINT : intent.tokenAddress,
      outputMint: intent.side === "buy" ? intent.tokenAddress : SOLANA_NATIVE_MINT,
      amount: sellAmount,
      slippageBps: Math.max(1, Math.round(intent.slippagePercent * 100)),
    });
    const quotedAt = new Date().toISOString();
    const transaction = await buildJupiterSwap(quote, accountAddress);
    return {
      side: intent.side,
      tokenAddress: intent.tokenAddress,
      userPublicKey: accountAddress,
      quote,
      transaction,
      sellAmount,
      estimatedPriorityFeeLamports: transaction.prioritizationFeeLamports ?? 0,
      quotedAt,
      shadowSimulation: null,
    };
  }

  async simulate(plan: SolanaExecutionPlan) {
    if (plan.side === "buy") assertAssetNotDenied("solana", plan.tokenAddress, store.getRiskSettings());
    VersionedTransaction.deserialize(Buffer.from(plan.transaction.swapTransaction, "base64"));
    const simulation = await solanaRpc<{ value?: { err?: unknown; logs?: string[]; unitsConsumed?: number } }>("simulateTransaction", [
      plan.transaction.swapTransaction,
      { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" },
    ]);
    if (simulation.value?.err) {
      if (!isExpectedShadowFundingError(simulation.value.err, simulation.value.logs)) {
        throw new Error(`Jupiter shadow simülasyonu başarısız: ${JSON.stringify(simulation.value.err)}`);
      }
      plan.shadowSimulation = {
        rpcValidated: false,
        fundingStateSkipped: true,
        detail: "Zincir hesabı shadow varlıklarını tutmadığı için bakiye aşaması beklenen şekilde reddedildi.",
      };
      return normalize(plan, "shadow", null);
    }
    plan.shadowSimulation = { rpcValidated: true, fundingStateSkipped: false, detail: null };
    return normalize(plan, "shadow", null);
  }

  async execute(plan: SolanaExecutionPlan, hooks?: ExecutionSubmissionHooks) {
    if (plan.side === "buy") assertAssetNotDenied("solana", plan.tokenAddress, store.getRiskSettings());
    if (process.env.LIVE_TRADING_ENABLED?.trim().toLowerCase() !== "true") throw new Error("LIVE_TRADING_ENABLED etkin değil.");
    const keypair = await readSolanaKeypair();
    if (keypair.publicKey.toBase58() !== plan.userPublicKey) throw new Error("Hazırlanan işlem ile Keychain imzalayıcısı eşleşmiyor.");
    const tokenBalanceBefore = await readTokenBalance(plan.userPublicKey, plan.tokenAddress);
    let signature: string;
    try {
      signature = await signAndSendSolanaTransaction(plan, keypair);
    } catch (error) {
      if (!isJupiterSlippageError(error)) throw error;
      const maximumBps = Math.round(
        getNetworkExecutionLimit("solana", store.getRiskSettings()).maxSlippagePercent * 100,
      );
      const retryBps = nextJupiterSlippageBps(plan.quote.slippageBps, maximumBps);
      if (retryBps <= plan.quote.slippageBps) throw error;
      const refreshedQuote = await getJupiterQuote({
        inputMint: plan.quote.inputMint,
        outputMint: plan.quote.outputMint,
        amount: plan.sellAmount,
        slippageBps: retryBps,
      });
      plan.quote = refreshedQuote;
      plan.transaction = await buildJupiterSwap(refreshedQuote, plan.userPublicKey);
      plan.estimatedPriorityFeeLamports = plan.transaction.prioritizationFeeLamports ?? 0;
      plan.quotedAt = new Date().toISOString();
      signature = await signAndSendSolanaTransaction(plan, keypair);
    }
    await hooks?.onSubmitted({ txHash: signature });
    await waitForConfirmation(signature, plan.transaction.lastValidBlockHeight);
    const tokenBalanceAfter = await waitForTokenBalanceChange(plan.userPublicKey, plan.tokenAddress, tokenBalanceBefore, plan.side);
    const tokenDelta = plan.side === "buy" ? tokenBalanceAfter - tokenBalanceBefore : tokenBalanceBefore - tokenBalanceAfter;
    if (tokenDelta <= 0n) throw new Error("Solana swap onaylandı ancak token bakiye değişimi doğrulanamadı; otomatik muhasebe durduruldu.");
    const transactionCosts = await readConfirmedTransactionCosts(signature, plan);
    return normalize(
      plan,
      "live",
      signature,
      plan.side === "sell" ? tokenDelta.toString() : plan.quote.inAmount,
      plan.side === "buy" ? tokenDelta.toString() : plan.quote.outAmount,
      transactionCosts,
    );
  }

  private async buyAmount(address: string, allocationPercent = 7.5, mode: Exclude<TradingMode, "paper">) {
    if (mode === "shadow") {
      const account = store.getShadowAccount("solana");
      if (!account || account.fundingTokenAmount <= 0) throw new Error("Shadow SOL bakiyesi hazır değil.");
      const balanceLamports = BigInt(Math.floor(account.fundingTokenAmount * SOLANA_LAMPORTS_PER_SOL));
      return balanceLamports * BigInt(Math.max(1, Math.round(allocationPercent * 100))) / 10_000n;
    }
    const balance = await solanaRpc<{ value: number }>("getBalance", [address, { commitment: "confirmed" }]);
    const reserve = BigInt(Math.ceil(Number(process.env.SOLANA_MIN_RESERVE_SOL ?? 0.05) * SOLANA_LAMPORTS_PER_SOL));
    const spendable = BigInt(balance.value) - reserve;
    if (spendable <= 0n) throw new Error("SOL bakiyesi işlem ve fee rezervi için yetersiz.");
    return spendable * BigInt(Math.max(1, Math.round(allocationPercent * 100))) / 10_000n;
  }
}

async function signAndSendSolanaTransaction(
  plan: SolanaExecutionPlan,
  keypair: Awaited<ReturnType<typeof readSolanaKeypair>>,
) {
  const transaction = VersionedTransaction.deserialize(Buffer.from(plan.transaction.swapTransaction, "base64"));
  transaction.sign([keypair]);
  return solanaRpc<string>("sendTransaction", [
    Buffer.from(transaction.serialize()).toString("base64"),
    { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 },
  ]);
}

async function waitForConfirmation(signature: string, lastValidBlockHeight: number) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await solanaRpc<{ value: Array<{ confirmationStatus?: string; err?: unknown } | null> }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    const item = status.value[0];
    if (item?.err) throw new Error(`Solana işlemi zincirde başarısız: ${JSON.stringify(item.err)}`);
    if (item?.confirmationStatus === "confirmed" || item?.confirmationStatus === "finalized") return;
    const blockHeight = await solanaRpc<number>("getBlockHeight", [{ commitment: "confirmed" }]);
    if (blockHeight > lastValidBlockHeight) throw new Error("Solana işleminin blockhash süresi doldu.");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Solana işlem onayı zaman aşımına uğradı.");
}

async function readTokenBalance(owner: string, mint: string) {
  const response = await solanaRpc<{ value: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }> }>("getTokenAccountsByOwner", [
    owner,
    { mint },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  return response.value.reduce((sum, item) => sum + BigInt(item.account?.data?.parsed?.info?.tokenAmount?.amount ?? "0"), 0n);
}

async function waitForTokenBalanceChange(owner: string, mint: string, previous: bigint, side: TradeSide) {
  let current = await readTokenBalance(owner, mint);
  for (let attempt = 0; attempt < 12 && (side === "buy" ? current <= previous : current >= previous); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    current = await readTokenBalance(owner, mint);
  }
  return current;
}

interface SolanaTransactionMeta {
  fee?: number;
  preBalances?: number[];
  postBalances?: number[];
}

async function readConfirmedTransactionCosts(signature: string, plan: SolanaExecutionPlan) {
  let meta: SolanaTransactionMeta | null = null;
  for (let attempt = 0; attempt < 8 && !meta; attempt += 1) {
    const transaction = await solanaRpc<{ meta?: SolanaTransactionMeta | null } | null>("getTransaction", [
      signature,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ]);
    meta = transaction?.meta ?? null;
    if (!meta) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!meta) return null;
  const networkFeeLamports = BigInt(meta.fee ?? plan.estimatedPriorityFeeLamports);
  if (plan.side !== "buy" || meta.preBalances?.[0] === undefined || meta.postBalances?.[0] === undefined) {
    return { networkFeeLamports, refundableRentLamports: 0n };
  }
  return calculateSolanaBuyTransactionCosts({
    preBalanceLamports: BigInt(meta.preBalances[0]),
    postBalanceLamports: BigInt(meta.postBalances[0]),
    swapInputLamports: BigInt(plan.quote.inAmount),
    networkFeeLamports,
  });
}

function normalize(
  plan: SolanaExecutionPlan,
  mode: "shadow" | "live",
  txHash: string | null,
  executedAmount = plan.quote.inAmount,
  receivedAmount = plan.quote.outAmount,
  transactionCosts: { networkFeeLamports: bigint; refundableRentLamports: bigint } | null = null,
): NormalizedExecutionResult {
  return {
    integrationId: "solana",
    mode,
    status: mode === "shadow" ? "simulated" : "confirmed",
    asset: plan.tokenAddress,
    side: plan.side,
    requestedAmount: plan.quote.inAmount,
    executedAmount,
    receivedAmount,
    txHash,
    externalOrderId: null,
    networkFeeNativeAmount: transactionCosts?.networkFeeLamports.toString(),
    refundableRentNativeAmount: transactionCosts?.refundableRentLamports.toString(),
  };
}

export const solanaExecutionAdapter = new SolanaExecutionAdapter();
