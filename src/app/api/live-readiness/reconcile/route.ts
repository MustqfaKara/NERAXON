import { NextResponse } from "next/server";
import { z } from "zod";
import { store } from "@/lib/repositories/store";
import { assertSameOrigin } from "@/lib/security/same-origin";
import { reconcileAfterLiveExecution, reconcileIntegration } from "@/lib/services/live-certification";
import { apiError } from "@/lib/utils/api";
import { publishEvent } from "@/lib/services/audit-service";
import { isLivePilotIntegration } from "@/lib/domain/integrations";

const schema = z.object({ chainId: z.enum(["ethereum", "base", "robinhood", "solana", "hyperliquid"]) });

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (store.listChains().some((chain) => chain.status !== "stopped")) throw new Error("Mutabakat öncesinde bütün ağ botları durdurulmalı.");
    const { chainId } = schema.parse(await request.json());
    if (!isLivePilotIntegration(chainId)) throw new Error("Bu ağ ilk canlı pilot kapsamına dahil değil.");
    const retryableAttempts = store.listExecutionAttempts().filter((attempt) => (
      attempt.integrationId === chainId
      && attempt.mode === "live"
      && attempt.accountingStatus === "applied"
      && (attempt.status === "submitted" || attempt.status === "confirmed")
      && attempt.reconciliationStatus !== "passed"
    ));
    for (const attempt of retryableAttempts) await reconcileAfterLiveExecution(chainId, attempt.requestId);
    const reconciliation = await reconcileIntegration(chainId);
    await publishEvent({ chainId, level: reconciliation.status === "passed" ? "info" : "critical", type: "system", title: reconciliation.status === "passed" ? "Canlı mutabakat geçti" : "Canlı mutabakat başarısız", message: reconciliation.details, txHash: null });
    return NextResponse.json({ reconciliation }, { status: reconciliation.status === "passed" ? 200 : 422 });
  } catch (error) {
    return apiError(error);
  }
}
