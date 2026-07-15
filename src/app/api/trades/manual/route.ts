import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { z } from "zod";
import { executePaperTrade } from "@/lib/engine/paper-trading";
import { dexFeePercentFor } from "@/lib/engine/paper-execution-model";
import { store } from "@/lib/repositories/store";
import { resolveTokenQuote } from "@/lib/services/token-quote-service";
import { apiError } from "@/lib/utils/api";

const schema = z.object({
  chainId: z.enum(["ethereum", "base"]),
  side: z.enum(["buy", "sell"]),
  tokenAddress: z.string().refine((value) => isAddress(value.toLowerCase()), "Geçerli bir token kontrat adresi girin."),
  allocationPercent: z.coerce.number().min(5).max(10).optional(),
  sellPercent: z.coerce.number().min(1).max(100).optional(),
  quantity: z.coerce.number().positive().optional(),
  slippagePercent: z.coerce.number().min(0).max(20).optional(),
});

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json());
    const position = input.side === "sell" ? store.getPosition(input.chainId, input.tokenAddress) : null;
    let quote: Awaited<ReturnType<typeof resolveTokenQuote>> | null = null;

    try {
      quote = await resolveTokenQuote(input.chainId, input.tokenAddress);
    } catch (error) {
      if (!position || position.currentPriceUsd <= 0) throw error;
    }

    if (input.side === "buy" && (!quote || !quote.safety.approved)) {
      throw new Error(quote?.safety.reason ?? "Token piyasa verileri doğrulanamadı.");
    }

    const trade = await executePaperTrade({
      ...input,
      tokenAddress: quote?.address ?? position!.tokenAddress,
      tokenSymbol: quote?.symbol ?? position!.tokenSymbol,
      pairAddress: quote?.market.pairAddress ?? position!.pairAddress ?? null,
      priceUsd: quote?.market.priceUsd ?? position!.currentPriceUsd,
      liquidityUsd: quote?.market.liquidityUsd,
      gasFeeUsd: quote?.gas.feeUsd,
      dexFeePercent: dexFeePercentFor(quote?.market.dexId),
      priceChange24hPercent: quote?.market.priceChange24hPercent,
    });
    return NextResponse.json({ trade }, { status: trade.status === "skipped" ? 422 : 201 });
  } catch (error) {
    return apiError(error);
  }
}
