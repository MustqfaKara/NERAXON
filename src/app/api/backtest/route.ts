import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/repositories/store";
import { apiError } from "@/lib/utils/api";

const schema = z.object({ feeMultiplier: z.number().min(0).max(5).default(1), slippageMultiplier: z.number().min(0).max(5).default(1), startingBalanceUsd: z.number().min(10).max(1_000_000).default(100) });

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json());
    const history = [...store.listTrades()].reverse().filter((trade) => trade.status === "confirmed");
    let equity = input.startingBalanceUsd;
    let peak = equity;
    let maxDrawdownPercent = 0;
    let wins = 0;
    let losses = 0;
    let totalFeesUsd = 0;
    const points = [{ at: history[0]?.createdAt ?? new Date().toISOString(), valueUsd: equity }];
    for (const trade of history) {
      const baseFee = trade.fees.totalUsd - trade.fees.slippageUsd;
      const adjustedFee = baseFee * input.feeMultiplier + trade.fees.slippageUsd * input.slippageMultiplier;
      const feeDifference = adjustedFee - trade.fees.totalUsd;
      const pnl = trade.side === "sell" ? trade.realizedPnlUsd - feeDifference : -Math.max(0, feeDifference);
      equity += pnl;
      totalFeesUsd += adjustedFee;
      if (trade.side === "sell" && pnl > 0) wins += 1;
      if (trade.side === "sell" && pnl <= 0) losses += 1;
      peak = Math.max(peak, equity);
      maxDrawdownPercent = Math.max(maxDrawdownPercent, peak ? (peak - equity) / peak * 100 : 0);
      points.push({ at: trade.createdAt, valueUsd: Number(equity.toFixed(4)) });
    }
    return NextResponse.json({ tradeCount: history.length, endingBalanceUsd: Number(equity.toFixed(4)), netPnlUsd: Number((equity - input.startingBalanceUsd).toFixed(4)), totalFeesUsd: Number(totalFeesUsd.toFixed(4)), winRate: wins + losses ? Number((wins / (wins + losses) * 100).toFixed(2)) : 0, maxDrawdownPercent: Number(maxDrawdownPercent.toFixed(2)), points });
  } catch (error) { return apiError(error); }
}
