import type { ChainId, HypercoreMarketType, HypercorePositionSide } from "../domain/types.ts";
import { INTEGRATION_IDS } from "../domain/integrations.ts";

export type InfoCommand =
  | { kind: "help" | "status" | "balance" | "pnl" | "positions" | "recent" | "limits" }
  | { kind: "pause" | "resume"; chainIds: ChainId[] }
  | { kind: "quote"; chainId: Exclude<ChainId, "hyperliquid">; asset: string }
  | { kind: "hyperQuote"; marketType: HypercoreMarketType; coin: string }
  | { kind: "buy"; chainId: Exclude<ChainId, "hyperliquid">; asset: string; amountUsd: number }
  | { kind: "hyperBuy"; marketType: HypercoreMarketType; coin: string; side: HypercorePositionSide; amountUsd: number; leverage: number }
  | { kind: "sell"; chainId: Exclude<ChainId, "hyperliquid">; asset: string; percent: number }
  | { kind: "hyperSell"; marketType: HypercoreMarketType; coin: string; side: HypercorePositionSide; percent: number }
  | { kind: "sellAll"; chainId: ChainId };

const CHAIN_ALIASES: Record<string, ChainId> = {
  eth: "ethereum",
  ethereum: "ethereum",
  base: "base",
  rh: "robinhood",
  rhc: "robinhood",
  robinhood: "robinhood",
  sol: "solana",
  solana: "solana",
  hl: "hyperliquid",
  hyper: "hyperliquid",
  hyperliquid: "hyperliquid",
};

const INFO_COMMAND_NAMES = [
  "balance",
  "pnl",
  "positions",
  "status",
  "recent",
  "limits",
  "quote",
  "buy",
  "sell",
  "sellall",
  "pause",
  "resume",
  "help",
] as const;

export function parseInfoCommand(rawText: string): InfoCommand | null {
  const parts = rawText.trim().split(/\s+/);
  if (!parts.length || !parts[0].startsWith("/")) return null;
  const command = parts[0].split("@")[0].toLowerCase();
  if (["/help", "/start"].includes(command)) return { kind: "help" };
  if (["/status", "/balance", "/pnl", "/positions", "/recent", "/limits"].includes(command)) {
    return { kind: command.slice(1) as "status" | "balance" | "pnl" | "positions" | "recent" | "limits" };
  }
  if (command === "/pause" || command === "/resume") {
    const chainIds = parseChainList(parts[1]);
    return chainIds.length ? { kind: command.slice(1) as "pause" | "resume", chainIds } : null;
  }
  if (command === "/sellall") {
    const chainId = parseChain(parts[1]);
    return chainId ? { kind: "sellAll", chainId } : null;
  }

  const chainId = parseChain(parts[1]);
  if (!chainId) return null;
  if (chainId === "hyperliquid") return parseHypercoreCommand(command, parts);
  if (command === "/quote" && parts[2]) return { kind: "quote", chainId, asset: parts[2] };
  if (command === "/buy" && parts[2]) {
    const amountUsd = parsePositiveNumber(parts[3]);
    return amountUsd ? { kind: "buy", chainId, asset: parts[2], amountUsd } : null;
  }
  if (command === "/sell" && parts[2]) {
    const percent = parsePercent(parts[3]);
    return percent ? { kind: "sell", chainId, asset: parts[2], percent } : null;
  }
  return null;
}

export function suggestInfoCommand(rawText: string): string | null {
  const entered = rawText.trim().split(/\s+/)[0]?.split("@")[0]?.replace(/^\/+/, "").toLowerCase();
  if (!entered || INFO_COMMAND_NAMES.includes(entered as (typeof INFO_COMMAND_NAMES)[number])) return null;
  const ranked = INFO_COMMAND_NAMES
    .map((command) => ({ command, distance: editDistance(entered, command) }))
    .sort((left, right) => left.distance - right.distance || left.command.localeCompare(right.command));
  const best = ranked[0];
  const closePrefix = best.command.slice(0, Math.min(2, entered.length)) === entered.slice(0, 2);
  const maximumDistance = Math.max(2, Math.ceil(best.command.length * 0.4));
  return closePrefix && best.distance <= maximumDistance ? `/${best.command}` : null;
}

function parseHypercoreCommand(command: string, parts: string[]): InfoCommand | null {
  const marketType = parts[2]?.toLowerCase();
  if (marketType !== "spot" && marketType !== "perp") return null;
  const coin = parts[3]?.trim();
  if (!coin) return null;
  if (command === "/quote") return { kind: "hyperQuote", marketType, coin };

  if (command === "/buy") {
    if (marketType === "spot") {
      const amountUsd = parsePositiveNumber(parts[4]);
      return amountUsd ? { kind: "hyperBuy", marketType, coin, side: "long", amountUsd, leverage: 1 } : null;
    }
    const side = parseSide(parts[4]);
    const amountUsd = parsePositiveNumber(parts[5]);
    const leverage = parsePositiveNumber(parts[6]) ?? 1;
    return side && amountUsd ? { kind: "hyperBuy", marketType, coin, side, amountUsd, leverage } : null;
  }

  if (command === "/sell") {
    if (marketType === "spot") {
      const percent = parsePercent(parts[4]);
      return percent ? { kind: "hyperSell", marketType, coin, side: "long", percent } : null;
    }
    const side = parseSide(parts[4]);
    const percent = parsePercent(parts[5]);
    return side && percent ? { kind: "hyperSell", marketType, coin, side, percent } : null;
  }
  return null;
}

function parseChain(value?: string): ChainId | null {
  return value ? CHAIN_ALIASES[value.toLowerCase()] ?? null : null;
}

function parseChainList(value?: string) {
  if (!value) return [];
  if (value.toLowerCase() === "all") return [...INTEGRATION_IDS];
  const chainId = parseChain(value);
  return chainId ? [chainId] : [];
}

function parsePositiveNumber(value?: string) {
  if (!value) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parsePercent(value?: string) {
  const parsed = parsePositiveNumber(value);
  return parsed && parsed <= 100 ? parsed : null;
}

function parseSide(value?: string): HypercorePositionSide | null {
  if (value?.toLowerCase() === "long") return "long";
  if (value?.toLowerCase() === "short") return "short";
  return null;
}

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}
