import { NextResponse } from "next/server";
import { z } from "zod";
import { haltTrading, resetCircuitBreaker } from "@/lib/services/circuit-breaker-service";
import { getBotOrchestrator } from "@/lib/services/bot-orchestrator";
import { store } from "@/lib/repositories/store";
import { publishEvent } from "@/lib/services/audit-service";
import { apiError } from "@/lib/utils/api";

const schema = z.object({ action: z.enum(["halt", "reset"]) });

export async function POST(request: Request) {
  try {
    const { action } = schema.parse(await request.json());
    const state = action === "halt" ? haltTrading("Web panelinden acil durdurma etkinleştirildi.") : resetCircuitBreaker();
    if (action === "halt") {
      await Promise.allSettled(store.listChains().map((chain) => getBotOrchestrator().stop(chain.id)));
    }
    await publishEvent({ chainId: null, level: action === "halt" ? "critical" : "warning", type: "system", title: action === "halt" ? "Acil durdurma etkin" : "Devre kesici sıfırlandı", message: action === "halt" ? "Yeni paper işlemleri ve ağ izleyicileri durduruldu." : "İşlem engeli ve ardışık hata sayacı temizlendi.", txHash: null });
    return NextResponse.json({ state });
  } catch (error) { return apiError(error); }
}
