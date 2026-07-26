import { NextResponse } from "next/server";
import { z } from "zod";
import {
  credentialBackend,
  credentialStatus,
  deleteCredential,
  storeCredential,
  type CredentialId,
} from "@/lib/security/credential-vault";
import { clearGroqApiKeyCache } from "@/lib/security/api-keychain";
import { assertSameOrigin } from "@/lib/security/same-origin";
import { apiError } from "@/lib/utils/api";

const credentialIds = [
  "groq-api-key",
  "telegram-api-id",
  "telegram-api-hash",
  "telegram-bot-token",
  "telegram-chat-id",
  "helius-api-key",
  "jupiter-api-key",
  "birdeye-api-key",
  "zerox-api-key",
  "etherscan-api-key",
  "lifi-api-key",
  "ethereum-rpc-url",
  "ethereum-rpc-fallback-urls",
  "base-rpc-url",
  "base-rpc-fallback-urls",
  "robinhood-rpc-url",
  "robinhood-rpc-fallback-urls",
  "solana-rpc-url",
  "solana-ws-url",
  "hyperliquid-info-url",
  "hyperliquid-ws-url",
  "hyperliquid-exchange-url",
] as const satisfies readonly CredentialId[];

const credentialSchema = z.enum(credentialIds);
const inputSchema = z.object({
  id: credentialSchema,
  value: z.string().trim().min(1).max(262_144),
});

const labels: Record<(typeof credentialIds)[number], { group: string; label: string; secret: boolean; placeholder: string }> = {
  "groq-api-key": { group: "AI", label: "Groq API key", secret: true, placeholder: "gsk_..." },
  "telegram-api-id": { group: "Telegram", label: "User API ID", secret: true, placeholder: "12345678" },
  "telegram-api-hash": { group: "Telegram", label: "User API hash", secret: true, placeholder: "32-character hash" },
  "telegram-bot-token": { group: "Telegram", label: "Bot token", secret: true, placeholder: "123456:token" },
  "telegram-chat-id": { group: "Telegram", label: "Notification chat ID", secret: true, placeholder: "-100..." },
  "helius-api-key": { group: "Market data", label: "Helius API key", secret: true, placeholder: "Helius key" },
  "jupiter-api-key": { group: "Execution", label: "Jupiter API key", secret: true, placeholder: "jup_..." },
  "birdeye-api-key": { group: "Market data", label: "Birdeye API key", secret: true, placeholder: "Birdeye key" },
  "zerox-api-key": { group: "Execution", label: "0x API key", secret: true, placeholder: "0x key" },
  "etherscan-api-key": { group: "Market data", label: "Etherscan API key", secret: true, placeholder: "Etherscan key" },
  "lifi-api-key": { group: "Execution", label: "LI.FI API key", secret: true, placeholder: "Optional LI.FI key" },
  "ethereum-rpc-url": { group: "RPC", label: "Ethereum primary RPC", secret: true, placeholder: "https://..." },
  "ethereum-rpc-fallback-urls": { group: "RPC", label: "Ethereum fallback RPCs", secret: true, placeholder: "Comma-separated URLs" },
  "base-rpc-url": { group: "RPC", label: "Base primary RPC", secret: true, placeholder: "https://..." },
  "base-rpc-fallback-urls": { group: "RPC", label: "Base fallback RPCs", secret: true, placeholder: "Comma-separated URLs" },
  "robinhood-rpc-url": { group: "RPC", label: "Robinhood primary RPC", secret: true, placeholder: "https://..." },
  "robinhood-rpc-fallback-urls": { group: "RPC", label: "Robinhood fallback RPCs", secret: true, placeholder: "Comma-separated URLs" },
  "solana-rpc-url": { group: "RPC", label: "Solana RPC", secret: true, placeholder: "https://..." },
  "solana-ws-url": { group: "RPC", label: "Solana WebSocket", secret: true, placeholder: "wss://..." },
  "hyperliquid-info-url": { group: "Hyperliquid", label: "Info API URL", secret: false, placeholder: "https://api.hyperliquid.xyz/info" },
  "hyperliquid-ws-url": { group: "Hyperliquid", label: "WebSocket URL", secret: false, placeholder: "wss://api.hyperliquid.xyz/ws" },
  "hyperliquid-exchange-url": { group: "Hyperliquid", label: "Exchange API URL", secret: false, placeholder: "https://api.hyperliquid.xyz/exchange" },
};

function responseBody() {
  return {
    backend: credentialBackend(),
    telegramUserSessionConfigured: credentialStatus("telegram-session").configured,
    credentials: credentialIds.map((id) => ({ id, ...labels[id], ...credentialStatus(id) })),
  };
}

export async function GET() {
  return NextResponse.json(responseBody(), { headers: { "cache-control": "no-store" } });
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const input = inputSchema.parse(await request.json());
    await storeCredential(input.id, input.value);
    if (input.id === "groq-api-key") clearGroqApiKeyCache();
    return NextResponse.json(responseBody(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const id = credentialSchema.parse(new URL(request.url).searchParams.get("id"));
    await deleteCredential(id);
    if (id === "groq-api-key") clearGroqApiKeyCache();
    return NextResponse.json(responseBody(), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
