import { NextResponse } from "next/server";
import { z } from "zod";
import type { ChainId } from "@/lib/domain/types";
import { getBotOrchestrator } from "@/lib/services/bot-orchestrator";
import { apiError } from "@/lib/utils/api";

const schema = z.object({ action: z.enum(["start", "stop"]) });
const supportedChains = new Set<ChainId>(["ethereum", "base"]);

export async function POST(
  request: Request,
  context: { params: Promise<{ chainId: string }> },
) {
  try {
    const { chainId: rawChainId } = await context.params;
    if (!supportedChains.has(rawChainId as ChainId)) throw new Error("Desteklenmeyen ağ.");
    const chainId = rawChainId as ChainId;
    const { action } = schema.parse(await request.json());
    const orchestrator = getBotOrchestrator();
    const chain = action === "start" ? await orchestrator.start(chainId) : await orchestrator.stop(chainId);
    return NextResponse.json({ chain });
  } catch (error) {
    return apiError(error);
  }
}
