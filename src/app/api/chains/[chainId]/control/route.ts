import { NextResponse } from "next/server";
import { z } from "zod";
import type { ChainId } from "@/lib/domain/types";
import { getBotOrchestrator } from "@/lib/services/bot-orchestrator";
import { apiError } from "@/lib/utils/api";
import { assertSameOrigin } from "@/lib/security/same-origin";
import { isLivePilotIntegration, isShadowTestIntegration } from "@/lib/domain/integrations";
import { store } from "@/lib/repositories/store";

const schema = z.object({ action: z.enum(["start", "stop"]) });
const supportedChains = new Set<ChainId>(["ethereum", "base", "robinhood", "solana", "hyperliquid"]);

export async function POST(
  request: Request,
  context: { params: Promise<{ chainId: string }> },
) {
  try {
    assertSameOrigin(request);
    const { chainId: rawChainId } = await context.params;
    if (!supportedChains.has(rawChainId as ChainId)) throw new Error("Desteklenmeyen ağ.");
    const chainId = rawChainId as ChainId;
    const { action } = schema.parse(await request.json());
    const mode = store.getMode();
    if (action === "start" && mode === "shadow" && !isShadowTestIntegration(chainId)) {
      throw new Error(`${chainId} ilk shadow test kapsamına dahil değil. Yalnızca Base, Solana ve Hyperliquid çalıştırılabilir.`);
    }
    if (action === "start" && mode === "live" && !isLivePilotIntegration(chainId)) {
      throw new Error(`${chainId} canlı işlem kapsamına dahil değil.`);
    }
    const orchestrator = getBotOrchestrator();
    const chain = action === "start" ? await orchestrator.start(chainId) : await orchestrator.stop(chainId);
    return NextResponse.json({ chain });
  } catch (error) {
    return apiError(error);
  }
}
