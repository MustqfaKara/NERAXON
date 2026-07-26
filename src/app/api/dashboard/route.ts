import { NextResponse } from "next/server";
import { getDashboardSnapshotForApi, getDashboardSnapshotForView, refreshDashboardMarkets } from "@/lib/services/dashboard-service";
import { getBotOrchestrator } from "@/lib/services/bot-orchestrator";
import { apiError } from "@/lib/utils/api";
import { startTelegramCommandService } from "@/lib/services/telegram-command-service";
import { enforceWalletActivityLimits } from "@/lib/services/wallet-activity-service";
import { ensureRuntimeMonitor } from "@/lib/services/runtime-monitor";
import { ensureTelegramUserSignalService } from "@/lib/services/telegram-user-signal-service";
import { isDashboardViewId } from "@/lib/dashboard-pages";

export const dynamic = "force-dynamic";

let runtimePreparation: Promise<void> | null = null;

function prepareDashboardRuntime() {
  if (runtimePreparation) return runtimePreparation;
  runtimePreparation = (async () => {
    await ensureRuntimeMonitor();
    await ensureTelegramUserSignalService();
    await enforceWalletActivityLimits();
    await getBotOrchestrator().reconcile();
  })()
    .catch((error) => {
      console.error("Panel arka plan servisleri hazırlanamadı:", error);
    })
    .finally(() => {
      runtimePreparation = null;
    });
  return runtimePreparation;
}

export async function GET(request: Request) {
  try {
    startTelegramCommandService();
    void prepareDashboardRuntime();
    const searchParams = new URL(request.url).searchParams;
    const shouldRefreshMarkets = searchParams.get("refreshMarkets") === "true";
    const shouldRefreshPortfolio = searchParams.get("refreshPortfolio") === "true";
    const requestedView = searchParams.get("view");
    const view = requestedView && isDashboardViewId(requestedView) ? requestedView : null;
    const snapshot = shouldRefreshMarkets
      ? await refreshDashboardMarkets(view ?? undefined)
      : shouldRefreshPortfolio && view
        ? await getDashboardSnapshotForView(view, true)
      : view
        ? await getDashboardSnapshotForView(view)
        : await getDashboardSnapshotForApi();
    return NextResponse.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError(error, 500);
  }
}
