import { NextResponse } from "next/server";
import { getDashboardSnapshot, refreshDashboardMarkets } from "@/lib/services/dashboard-service";
import { getBotOrchestrator } from "@/lib/services/bot-orchestrator";
import { apiError } from "@/lib/utils/api";
import { startTelegramCommandService } from "@/lib/services/telegram-command-service";
import { enforceWalletActivityLimits } from "@/lib/services/wallet-activity-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    startTelegramCommandService();
    await enforceWalletActivityLimits();
    await getBotOrchestrator().reconcile();
    const shouldRefreshMarkets = new URL(request.url).searchParams.get("refreshMarkets") === "true";
    const snapshot = shouldRefreshMarkets
      ? await refreshDashboardMarkets()
      : getDashboardSnapshot();
    return NextResponse.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError(error, 500);
  }
}
