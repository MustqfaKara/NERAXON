import { getAddress, isAddress } from "viem";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getEvmExecutionAdapter } from "@/lib/execution/evm-execution-adapter";
import { hypercoreExecutionAdapter } from "@/lib/execution/hypercore-execution-adapter";
import { solanaExecutionAdapter } from "@/lib/execution/solana-execution-adapter";
import { isLivePilotIntegration } from "@/lib/domain/integrations";
import { assertSameOrigin } from "@/lib/security/same-origin";
import { apiError } from "@/lib/utils/api";

const schema = z.object({
  chainId: z.enum(["base", "robinhood", "solana", "hyperliquid"]),
  tokenAddress: z.string().optional(),
  coin: z.string().min(1).max(40).optional(),
  marketType: z.enum(["spot", "perp"]).default("spot"),
  allocationPercent: z.number().min(5).max(20).default(20),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = schema.parse(await request.json());
    if (!isLivePilotIntegration(input.chainId)) throw new Error("Bu ağ ilk canlı pilot kapsamına dahil değil.");

    if (input.chainId === "hyperliquid") {
      if (!input.coin) throw new Error("HyperCore preflight için piyasa sembolü gerekli.");
      const plan = await hypercoreExecutionAdapter.prepare({ coin: input.coin, marketType: input.marketType, positionSide: "long", action: "open", allocationPercent: input.allocationPercent, leverage: input.marketType === "perp" ? 1 : undefined, slippagePercent: 0.25, mode: "live" });
      return NextResponse.json({ chainId: input.chainId, asset: `${plan.marketType}:${plan.coin}`, side: plan.side, size: plan.size, notionalUsd: plan.notionalUsd, limitPrice: plan.limitPrice, availableCollateralUsd: plan.availableCollateralUsd, quotedAt: plan.quotedAt });
    }

    if (!input.tokenAddress) throw new Error("Token adresi gerekli.");
    if (input.chainId === "solana") {
      const plan = await solanaExecutionAdapter.prepare({ side: "buy", tokenAddress: input.tokenAddress, allocationPercent: input.allocationPercent, slippagePercent: 0.5, mode: "live" });
      return NextResponse.json({ chainId: input.chainId, asset: input.tokenAddress, side: plan.side, sellAmount: plan.quote.inAmount, expectedAmountOut: plan.quote.outAmount, minimumAmountOut: plan.quote.otherAmountThreshold, priceImpactPercent: Number(plan.quote.priceImpactPct) * 100, quotedAt: plan.quotedAt });
    }

    if (!isAddress(input.tokenAddress)) throw new Error("Geçerli EVM token kontratı gerekli.");
    const plan = await getEvmExecutionAdapter(input.chainId).prepare({ chainId: input.chainId, side: "buy", tokenAddress: getAddress(input.tokenAddress), allocationPercent: input.allocationPercent, slippagePercent: 0.5, mode: "live" });
    return NextResponse.json({ chainId: input.chainId, asset: input.tokenAddress, side: plan.side, sellAmount: plan.sellAmount.toString(), expectedAmountOut: plan.buyAmount.toString(), minimumAmountOut: plan.minBuyAmount.toString(), quotedAt: plan.quotedAt });
  } catch (error) {
    return apiError(error);
  }
}
