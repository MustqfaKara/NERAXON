import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/repositories/store";
import { publishEvent } from "@/lib/services/audit-service";
import { apiError } from "@/lib/utils/api";

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
}).refine((value) => value.minPositionPercent <= value.maxPositionPercent, {
  message: "Minimum pozisyon oranı maksimum orandan büyük olamaz.",
}).refine((value) => value.maxWalletSwapsPerHour <= value.maxWalletSwapsPer24Hours, {
  message: "Saatlik cüzdan swap sınırı 24 saatlik sınırdan büyük olamaz.",
});

export async function PUT(request: Request) {
  try {
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
