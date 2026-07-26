import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { AiProjectResearch } from "../ai/groq-trade-advisor.ts";
import { monitorService } from "./service-health.ts";

interface DexScreenerProjectInfo {
  websites?: Array<{ url?: string; label?: string }>;
  socials?: Array<{ url?: string; type?: string }>;
}

interface DexScreenerProjectPair {
  pairAddress?: string;
  info?: DexScreenerProjectInfo;
}

interface PageInspection {
  reachable: boolean;
  title: string | null;
  description: string | null;
}

interface PageInspectionOptions {
  fetchImpl?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<string[]>;
}

const RESEARCH_CACHE_TTL_MS = 6 * 60 * 60_000;
const researchCache = new Map<string, { expiresAt: number; value: AiProjectResearch }>();

export async function collectSocialProjectResearch(input: {
  dexScreenerChainId: string;
  pairAddress: string;
}, options: PageInspectionOptions = {}): Promise<AiProjectResearch> {
  const cacheKey = `${input.dexScreenerChainId}:${input.pairAddress}`.toLowerCase();
  const cached = researchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await monitorService("dexscreener", () => fetchImpl(
    `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(input.dexScreenerChainId)}/${encodeURIComponent(input.pairAddress)}`,
    { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" }, cache: "no-store" },
  ));
  if (!response.ok) throw new Error(`DexScreener proje bilgisi alınamadı (${response.status}).`);
  const payload = await response.json() as { pairs?: DexScreenerProjectPair[] };
  const pair = (payload.pairs ?? []).find((candidate) =>
    candidate.pairAddress?.toLowerCase() === input.pairAddress.toLowerCase()
  ) ?? payload.pairs?.[0];
  const websiteUrl = firstHttpsUrl(pair?.info?.websites?.map((website) => website.url));
  const xUrls = [...new Set((pair?.info?.socials ?? [])
    .filter((social) => social.type?.toLowerCase() === "twitter" || isXUrl(social.url))
    .map((social) => normalizeHttpsUrl(social.url))
    .filter((url): url is string => Boolean(url)))]
    .slice(0, 2);

  const [websiteInspection, xInspections] = await Promise.all([
    websiteUrl
      ? inspectPublicPage(websiteUrl, options).catch(() => unavailablePage())
      : Promise.resolve(unavailablePage()),
    Promise.all(xUrls.map(async (url) => ({
      url,
      handle: xHandle(url),
      ...await inspectPublicPage(url, options).catch(() => unavailablePage()),
    }))),
  ]);
  const limitations: string[] = [];
  if (!websiteUrl) limitations.push("DexScreener üzerinde resmî web sitesi bağlantısı yok.");
  else if (!websiteInspection.reachable) limitations.push("Proje web sitesinin herkese açık metadata bilgisi alınamadı.");
  if (!xUrls.length) limitations.push("DexScreener üzerinde X hesabı bağlantısı yok.");
  else if (xInspections.every((profile) => !profile.reachable)) {
    limitations.push("X profili herkese açık metadata üzerinden doğrulanamadı; paylaşım ve takipçi verisi değerlendirilmedi.");
  }

  const value: AiProjectResearch = {
    website: {
      url: websiteUrl,
      reachable: websiteInspection.reachable,
      title: websiteInspection.title,
      description: websiteInspection.description,
    },
    xProfiles: xInspections.map((profile) => ({
      url: profile.url,
      handle: profile.handle,
      reachable: profile.reachable,
      profileSummary: profile.description ?? profile.title,
    })),
    evidenceLimitations: limitations,
  };
  researchCache.set(cacheKey, { expiresAt: Date.now() + RESEARCH_CACHE_TTL_MS, value });
  return value;
}

export async function inspectPublicPage(url: string, options: PageInspectionOptions = {}): Promise<PageInspection> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveHost = options.resolveHost ?? resolvePublicHost;
  let currentUrl = validatePublicUrl(url);
  for (let redirect = 0; redirect <= 2; redirect += 1) {
    const parsed = new URL(currentUrl);
    const addresses = await resolveHost(parsed.hostname);
    if (!addresses.length || addresses.some((address) => isPrivateOrReservedIp(address))) {
      throw new Error("Güvenli olmayan proje bağlantısı engellendi.");
    }
    const response = await fetchImpl(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(6_000),
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "NERAXON-Research/1.0",
      },
      cache: "no-store",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === 2) return unavailablePage();
      currentUrl = validatePublicUrl(new URL(location, currentUrl).toString());
      continue;
    }
    if (!response.ok) return unavailablePage();
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      return unavailablePage();
    }
    return { reachable: true, ...extractPageMetadata(await readLimitedText(response, 200_000)) };
  }
  return unavailablePage();
}

export function extractPageMetadata(html: string) {
  const title = cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? "");
  const descriptions: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/giu) ?? []) {
    const attributes = Object.fromEntries(
      [...tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu)]
        .map((match) => [match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? ""]),
    );
    const key = (attributes.name ?? attributes.property ?? "").toLowerCase();
    if (key === "description" || key === "og:description" || key === "twitter:description") {
      const content = cleanText(attributes.content ?? "");
      if (content) descriptions.push(content);
    }
  }
  return {
    title: title ? title.slice(0, 240) : null,
    description: descriptions[0]?.slice(0, 700) ?? null,
  };
}

async function resolvePublicHost(hostname: string) {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function validatePublicUrl(value: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
    throw new Error("Yalnızca herkese açık HTTPS proje bağlantıları incelenebilir.");
  }
  return parsed.toString();
}

function isPrivateOrReservedIp(address: string) {
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isPrivateOrReservedIp(normalized.slice(7));
    return normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || /^fe[89ab]/u.test(normalized);
  }
  if (isIP(address) !== 4) return true;
  const [a, b] = address.split(".").map(Number);
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0)
    || a >= 224;
}

async function readLimitedText(response: Response, maxBytes: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = Math.min(value.byteLength, maxBytes - total);
    output += decoder.decode(value.subarray(0, remaining), { stream: true });
    total += remaining;
    if (remaining < value.byteLength) {
      await reader.cancel();
      break;
    }
  }
  return output + decoder.decode();
}

function firstHttpsUrl(values: Array<string | undefined> | undefined) {
  for (const value of values ?? []) {
    const normalized = normalizeHttpsUrl(value);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeHttpsUrl(value?: string) {
  try {
    const parsed = new URL(value ?? "");
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function isXUrl(value?: string) {
  try {
    const hostname = new URL(value ?? "").hostname.toLowerCase();
    return hostname === "x.com" || hostname.endsWith(".x.com")
      || hostname === "twitter.com" || hostname.endsWith(".twitter.com");
  } catch {
    return false;
  }
}

function xHandle(value: string) {
  try {
    return new URL(value).pathname.split("/").filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

function cleanText(value: string) {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/\s+/gu, " ")
    .trim();
}

function unavailablePage(): PageInspection {
  return { reachable: false, title: null, description: null };
}
