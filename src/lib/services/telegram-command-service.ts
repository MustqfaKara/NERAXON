import type { ChainId } from "@/lib/domain/types";
import { translateText } from "@/lib/i18n";
import { store } from "@/lib/repositories/store";
import { getBotOrchestrator } from "@/lib/services/bot-orchestrator";
import { getDashboardSnapshotForApi } from "@/lib/services/dashboard-service";
import { monitorService } from "@/lib/services/service-health";
import { CHAIN_DEFINITIONS, INTEGRATION_IDS } from "@/lib/domain/defaults";
import { readCredentialSync } from "@/lib/security/credential-vault";

interface TelegramUpdate { update_id: number; message?: TelegramMessage; channel_post?: TelegramMessage }
interface TelegramMessage { text?: string; chat: { id: number } }
const globalState = globalThis as typeof globalThis & { neraxonTelegramCommands?: TelegramCommandService };

class TelegramCommandService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private offset = 0;
  start() { if (!this.timer) this.timer = setTimeout(() => void this.poll(), 1_000); }
  private schedule() { this.timer = setTimeout(() => void this.poll(), 10_000); }
  private async poll() {
    const token = readCredentialSync("telegram-bot-token");
    const chatId = readCredentialSync("telegram-chat-id");
    if (!token || !chatId) { this.schedule(); return; }
    try {
      const response = await monitorService("telegram", () => fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${this.offset}&limit=20`, { signal: AbortSignal.timeout(8_000) }));
      const payload = await response.json() as { ok: boolean; result?: TelegramUpdate[] };
      for (const update of payload.result ?? []) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        const message = update.message ?? update.channel_post;
        if (!message?.text || String(message.chat.id) !== String(chatId)) continue;
        await this.handle(message.text, token, chatId);
      }
    } catch { /* Sağlık metriği hatayı kaydeder; polling devam eder. */ }
    this.schedule();
  }
  private async handle(text: string, token: string, chatId: string) {
    const [command, argument] = text.trim().toLowerCase().split(/\s+/);
    if (!["/status", "/positions", "/pnl", "/pause", "/resume"].includes(command)) return;
    const snapshot = await getDashboardSnapshotForApi();
    let reply = "";
    if (command === "/status") reply = snapshot.chains.map((chain) => `${chain.name}: ${chain.status === "running" ? "çalışıyor" : "durdu"} · ${chain.latencyMs ?? "-"} ms`).join("\n");
    if (command === "/positions") {
      const evm = snapshot.positions.map((position) => `${position.tokenSymbol}: ${position.quantity.toFixed(6)} · ${position.unrealizedPnlUsd >= 0 ? "+" : ""}${position.unrealizedPnlUsd.toFixed(2)} USD`);
      const hypercore = snapshot.hypercorePositions.map((position) => `${position.coin} ${position.marketType}/${position.side}: ${position.quantity.toFixed(6)} · ${position.leverage}x · ${position.unrealizedPnlUsd >= 0 ? "+" : ""}${position.unrealizedPnlUsd.toFixed(2)} USD`);
      reply = [...evm, ...hypercore].join("\n") || "Açık pozisyon yok.";
    }
    if (command === "/pnl") reply = `Portföy: ${snapshot.equityUsd.toFixed(2)} USD\nGerçekleşen: ${snapshot.realizedPnlUsd.toFixed(2)} USD\nGerçekleşmemiş: ${snapshot.unrealizedPnlUsd.toFixed(2)} USD`;
    if (command === "/pause" || command === "/resume") {
      const chains: ChainId[] = argument === "all" ? INTEGRATION_IDS : INTEGRATION_IDS.includes(argument as ChainId) ? [argument as ChainId] : [];
      if (!chains.length) reply = "Kullanım: /pause ethereum|base|robinhood|solana|hyperliquid|all veya /resume ethereum|base|robinhood|solana|hyperliquid|all";
      else {
        await Promise.all(chains.map((chainId) => command === "/pause" ? getBotOrchestrator().stop(chainId) : getBotOrchestrator().start(chainId)));
        reply = `${chains.map((id) => CHAIN_DEFINITIONS[id].name).join(", ")} ${command === "/pause" ? "durduruldu" : "çalıştırıldı"}.`;
      }
    }
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: translateText(reply, store.getLanguage()) }) });
  }
}

export function startTelegramCommandService() {
  const service = (globalState.neraxonTelegramCommands ??= new TelegramCommandService());
  service.start();
}
