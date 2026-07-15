import { NextResponse } from "next/server";
import { z } from "zod";
import { addTrackedWallet } from "@/lib/services/wallet-service";
import { apiError } from "@/lib/utils/api";

const schema = z.object({
  address: z.string().trim(),
  label: z.string().trim().max(40).default(""),
  discoveryScore: z.object({
    score: z.number().int().min(0).max(100),
    breakdown: z.object({
      profitability: z.number().int().min(0).max(100),
      activity: z.number().int().min(0).max(100),
      diversity: z.number().int().min(0).max(100),
      balance: z.number().int().min(0).max(100),
      freshness: z.number().int().min(0).max(100),
    }),
  }).optional(),
  observedSwapCount24h: z.number().int().nonnegative().optional(),
  discoverySnapshot: z.object({
    chainId: z.enum(["ethereum", "base"]),
    boughtUsd: z.number().nonnegative(),
    soldUsd: z.number().nonnegative(),
    currentValueUsd: z.number().nonnegative(),
    estimatedPnlUsd: z.number(),
    estimatedPnlPercent: z.number(),
    swapCount: z.number().int().nonnegative(),
    buyCount: z.number().int().nonnegative(),
    sellCount: z.number().int().nonnegative(),
    uniqueTokenCount: z.number().int().nonnegative(),
    tokens: z.array(z.object({
      address: z.string(),
      symbol: z.string().max(32),
      pairAddress: z.string().nullable(),
      boughtUsd: z.number().nonnegative(),
      soldUsd: z.number().nonnegative(),
      currentValueUsd: z.number().nonnegative(),
      estimatedPnlUsd: z.number(),
      swapCount: z.number().int().nonnegative(),
      buyCount: z.number().int().nonnegative(),
      sellCount: z.number().int().nonnegative(),
    })).max(20),
  }).optional(),
});

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json());
    const wallet = await addTrackedWallet(input.address, input.label, input.discoveryScore, input.observedSwapCount24h, input.discoverySnapshot);
    return NextResponse.json({ wallet }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
