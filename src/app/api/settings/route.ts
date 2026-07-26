import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/repositories/store";
import { publishEvent } from "@/lib/services/audit-service";
import { apiError } from "@/lib/utils/api";
import { assertSameOrigin } from "@/lib/security/same-origin";
import { isAddress } from "viem";
import { PublicKey } from "@solana/web3.js";

const riskSchema = z.object({
  minPositionPercent: z.number().min(1).max(10),
  maxPositionPercent: z.number().min(5).max(20),
  dailyLossLimitPercent: z.number().min(1).max(30),
  maxOpenPositions: z.number().int().min(1).max(30),
  maxTokenExposurePercent: z.number().min(5).max(100),
  maxWalletExposurePercent: z.number().min(5).max(100),
  minimumLiquidityUsd: z.number().min(1_000),
  maxSlippagePercent: z.number().min(0.1).max(20),
  maxPriceImpactPercent: z.number().min(0.1).max(20),
  cashReservePercent: z.number().min(0).max(90),
  maxConsecutiveFailures: z.number().int().min(1).max(20),
  maxRpcLatencyMs: z.number().int().min(250).max(30_000),
  maxPriceChange24hPercent: z.number().min(5).max(500),
  maxWalletSwapsPerHour: z.number().int().min(1).max(500),
  maxWalletSwapsPer24Hours: z.number().int().min(1).max(5_000),
  maxHypercoreLeverage: z.number().int().min(1).max(20),
  maxLiveTradeUsd: z.number().min(1).max(100_000),
  maxLiveGasUsd: z.number().min(0.01).max(10_000),
  networkFeeLimits: z.object({
    ethereum: feeLimitSchema(),
    base: feeLimitSchema(),
    robinhood: feeLimitSchema(),
    solana: feeLimitSchema(),
    hyperliquid: feeLimitSchema(),
  }),
  networkExecutionLimits: z.object({
    ethereum: executionLimitSchema(),
    base: executionLimitSchema(),
    robinhood: executionLimitSchema(),
    solana: executionLimitSchema(),
    hyperliquid: executionLimitSchema(),
  }),
  assetPolicy: z.object({
    minimumSafetyScore: z.number().min(0).max(100),
    youngPoolAgeMinutes: z.number().int().min(1).max(1_440),
    youngPoolMinWallets: z.number().int().min(1).max(50),
    youngPoolAllocationMultiplier: z.number().min(0.05).max(1),
    requireVerifiedExitRoute: z.boolean(),
    hypercoreMinVolume24hUsd: z.number().min(0).max(1_000_000_000),
    hypercoreMinOpenInterestUsd: z.number().min(0).max(1_000_000_000),
    trustedAssets: assetListsSchema(),
    deniedAssets: assetListsSchema(),
  }),
}).refine((value) => value.minPositionPercent <= value.maxPositionPercent, {
  message: "Minimum pozisyon oranı maksimum orandan büyük olamaz.",
}).refine((value) => value.maxWalletSwapsPerHour <= value.maxWalletSwapsPer24Hours, {
  message: "Saatlik cüzdan swap sınırı 24 saatlik sınırdan büyük olamaz.",
});

function feeLimitSchema() {
  return z.object({
    maxFeeUsd: z.number().min(0.001).max(10_000),
    maxFeePercent: z.number().min(0.01).max(100),
  });
}

function assetListsSchema() {
  const evmAssets = z.array(z.string().trim().refine((value) => isAddress(value), "Geçerli bir EVM kontrat adresi gerekli.")).max(500);
  const solanaAssets = z.array(z.string().trim().refine((value) => { try { return new PublicKey(value).toBase58() === value; } catch { return false; } }, "Geçerli bir Solana mint adresi gerekli.")).max(500);
  const hypercoreAssets = z.array(z.string().trim().regex(/^(spot|perp):\S{1,80}$/i, "HyperCore varlığı spot:COIN veya perp:COIN biçiminde olmalı.")).max(500);
  return z.object({ ethereum: evmAssets, base: evmAssets, robinhood: evmAssets, solana: solanaAssets, hyperliquid: hypercoreAssets });
}

function executionLimitSchema() {
  return z.object({
    minPositionPercent: z.number().min(0.1).max(100),
    maxPositionPercent: z.number().min(0.1).max(100),
    minTradeUsd: z.number().min(0).max(100_000),
    maxTradeUsd: z.number().min(0.1).max(100_000),
    dailyLossLimitPercent: z.number().min(0.1).max(100),
    cashReservePercent: z.number().min(0).max(90),
    maxOpenPositions: z.number().int().min(1).max(100),
    maxSlippagePercent: z.number().min(0.1).max(20),
    maxLeverage: z.number().min(1).max(50),
    maxQuoteAgeMs: z.number().int().min(500).max(120_000),
    maxBuyPriceDeviationPercent: z.number().min(0.1).max(100),
    maxSellPriceDeviationPercent: z.number().min(0.1).max(100),
    maxEmergencyExitDeviationPercent: z.number().min(0.1).max(100),
  }).refine((value) => value.minPositionPercent <= value.maxPositionPercent, "Minimum pozisyon oranı maksimum orandan büyük olamaz.")
    .refine((value) => value.minTradeUsd <= value.maxTradeUsd, "Minimum işlem tutarı maksimum tutardan büyük olamaz.");
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const riskSettings = riskSchema.parse(await request.json());
    store.setRiskSettings(riskSettings);
    await publishEvent({
      chainId: null,
      level: "warning",
      type: "system",
      title: "Risk ayarları güncellendi",
      message: `Pozisyon aralığı %${riskSettings.minPositionPercent}–%${riskSettings.maxPositionPercent}, günlük zarar sınırı %${riskSettings.dailyLossLimitPercent} olarak ayarlandı.`,
      txHash: null,
    });
    return NextResponse.json({ riskSettings });
  } catch (error) {
    return apiError(error);
  }
}
