import assert from "node:assert/strict";
import test from "node:test";
import { evmPollingIntervalMs, fetchEvmRpcJson, getEvmRpcUrls, listEvmRpcEndpoints } from "../src/lib/chains/evm-rpc-pool.ts";

test("RPC havuzu ana endpoint ve fallback endpointlerini sıralı ve tekrarsız tutar", () => {
  const originalPrimary = process.env.BASE_RPC_URL;
  const originalFallbacks = process.env.BASE_RPC_FALLBACK_URLS;
  process.env.BASE_RPC_URL = "https://primary.example";
  process.env.BASE_RPC_FALLBACK_URLS = "https://backup-a.example, https://backup-b.example,https://primary.example";
  try {
    assert.deepEqual(getEvmRpcUrls("base").slice(0, 3), [
      "https://primary.example",
      "https://backup-a.example",
      "https://backup-b.example",
    ]);
  } finally {
    if (originalPrimary === undefined) delete process.env.BASE_RPC_URL;
    else process.env.BASE_RPC_URL = originalPrimary;
    if (originalFallbacks === undefined) delete process.env.BASE_RPC_FALLBACK_URLS;
    else process.env.BASE_RPC_FALLBACK_URLS = originalFallbacks;
  }
});

test("EVM polling aralıkları ağ hızına göre sınırlandırılır", () => {
  assert.equal(evmPollingIntervalMs("ethereum"), 15_000);
  assert.equal(evmPollingIntervalMs("base"), 10_000);
  assert.equal(evmPollingIntervalMs("robinhood"), 15_000);
});

test("RPC ayarları API anahtarlarını maskeler", () => {
  const originalPrimary = process.env.BASE_RPC_URL;
  const originalFallbacks = process.env.BASE_RPC_FALLBACK_URLS;
  process.env.BASE_RPC_URL = "https://base-mainnet.g.alchemy.com/v2/short-secret-value";
  process.env.BASE_RPC_FALLBACK_URLS = "https://rpc.ankr.com/base/another-private-secret-value";
  try {
    const endpoints = listEvmRpcEndpoints("base");
    assert.equal(endpoints.some((endpoint) => endpoint.url.includes("secret-value")), false);
    assert.equal(endpoints.filter((endpoint) => endpoint.source === "configured").every((endpoint) => endpoint.url.includes("[gizli]")), true);
  } finally {
    if (originalPrimary === undefined) delete process.env.BASE_RPC_URL;
    else process.env.BASE_RPC_URL = originalPrimary;
    if (originalFallbacks === undefined) delete process.env.BASE_RPC_FALLBACK_URLS;
    else process.env.BASE_RPC_FALLBACK_URLS = originalFallbacks;
  }
});

test("rate limit alan RPC beklemeden sıradaki endpoint ile devam eder", async () => {
  const originalPrimary = process.env.ETHEREUM_RPC_URL;
  const originalFallbacks = process.env.ETHEREUM_RPC_FALLBACK_URLS;
  const originalFetch = globalThis.fetch;
  process.env.ETHEREUM_RPC_URL = "https://limited.example";
  process.env.ETHEREUM_RPC_FALLBACK_URLS = "https://healthy.example";
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === "https://limited.example") {
      return new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2a" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const payload = await fetchEvmRpcJson<{ result: string }>("ethereum", {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_blockNumber",
      params: [],
    });
    assert.equal(payload.result, "0x2a");
    assert.deepEqual(requestedUrls.slice(0, 2), ["https://limited.example", "https://healthy.example"]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPrimary === undefined) delete process.env.ETHEREUM_RPC_URL;
    else process.env.ETHEREUM_RPC_URL = originalPrimary;
    if (originalFallbacks === undefined) delete process.env.ETHEREUM_RPC_FALLBACK_URLS;
    else process.env.ETHEREUM_RPC_FALLBACK_URLS = originalFallbacks;
  }
});

test("aylık kotası tükenen RPC süreç boyunca tekrar denenmez", async () => {
  const originalPrimary = process.env.ROBINHOOD_RPC_URL;
  const originalFallbacks = process.env.ROBINHOOD_RPC_FALLBACK_URLS;
  const originalFetch = globalThis.fetch;
  process.env.ROBINHOOD_RPC_URL = "https://monthly-exhausted.example";
  process.env.ROBINHOOD_RPC_FALLBACK_URLS = "https://monthly-fallback.example";
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === "https://monthly-exhausted.example") {
      return new Response(JSON.stringify({ error: { message: "Monthly capacity limit exceeded." } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2a" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const request = { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] };
    await fetchEvmRpcJson("robinhood", request);
    await fetchEvmRpcJson("robinhood", request);
    assert.equal(requestedUrls.filter((url) => url === "https://monthly-exhausted.example").length, 1);
    assert.equal(requestedUrls.filter((url) => url === "https://monthly-fallback.example").length, 2);
    const exhausted = listEvmRpcEndpoints("robinhood").find((endpoint) => endpoint.url === "https://monthly-exhausted.example");
    assert.equal(exhausted?.status, "cooldown");
    assert.ok(new Date(exhausted?.cooldownUntil ?? 0).getTime() - Date.now() > 6 * 24 * 60 * 60_000);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPrimary === undefined) delete process.env.ROBINHOOD_RPC_URL;
    else process.env.ROBINHOOD_RPC_URL = originalPrimary;
    if (originalFallbacks === undefined) delete process.env.ROBINHOOD_RPC_FALLBACK_URLS;
    else process.env.ROBINHOOD_RPC_FALLBACK_URLS = originalFallbacks;
  }
});

test("metot uyumsuz RPC aynı metot için tekrar kullanılmaz", async () => {
  const originalPrimary = process.env.BASE_RPC_URL;
  const originalFallbacks = process.env.BASE_RPC_FALLBACK_URLS;
  const originalFetch = globalThis.fetch;
  process.env.BASE_RPC_URL = "https://method-limited.example";
  process.env.BASE_RPC_FALLBACK_URLS = "https://method-healthy.example";
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === "https://method-limited.example") {
      return new Response(JSON.stringify({ error: { message: "Please specify an address in your request or order a dedicated full node" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x2a" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const request = { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] };
    await fetchEvmRpcJson("base", request);
    await fetchEvmRpcJson("base", request);
    assert.equal(requestedUrls.filter((url) => url === "https://method-limited.example").length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPrimary === undefined) delete process.env.BASE_RPC_URL;
    else process.env.BASE_RPC_URL = originalPrimary;
    if (originalFallbacks === undefined) delete process.env.BASE_RPC_FALLBACK_URLS;
    else process.env.BASE_RPC_FALLBACK_URLS = originalFallbacks;
  }
});

test("archive planı olmayan RPC geçmiş log isteğinde fallback endpointine geçer", async () => {
  const originalPrimary = process.env.ETHEREUM_RPC_URL;
  const originalFallbacks = process.env.ETHEREUM_RPC_FALLBACK_URLS;
  const originalFetch = globalThis.fetch;
  process.env.ETHEREUM_RPC_URL = "https://archive-limited.example";
  process.env.ETHEREUM_RPC_FALLBACK_URLS = "https://archive-healthy.example";
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === "https://archive-limited.example") {
      return new Response(JSON.stringify({
        error: { message: "Archive, Debug and Trace requests are not available on your current plan." },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify([{ jsonrpc: "2.0", id: 1, result: [] }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const payload = await fetchEvmRpcJson<Array<{ result: unknown[] }>>("ethereum", [{
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [],
    }]);
    assert.deepEqual(payload, [{ jsonrpc: "2.0", id: 1, result: [] }]);
    assert.deepEqual(requestedUrls.slice(0, 2), [
      "https://archive-limited.example",
      "https://archive-healthy.example",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPrimary === undefined) delete process.env.ETHEREUM_RPC_URL;
    else process.env.ETHEREUM_RPC_URL = originalPrimary;
    if (originalFallbacks === undefined) delete process.env.ETHEREUM_RPC_FALLBACK_URLS;
    else process.env.ETHEREUM_RPC_FALLBACK_URLS = originalFallbacks;
  }
});

test("yalnızca eth_getLogs desteklemeyen RPC diğer metotlar için kullanılmaya devam eder", async () => {
  const originalPrimary = process.env.ETHEREUM_RPC_URL;
  const originalFallbacks = process.env.ETHEREUM_RPC_FALLBACK_URLS;
  const originalFetch = globalThis.fetch;
  process.env.ETHEREUM_RPC_URL = "https://logs-limited.example";
  process.env.ETHEREUM_RPC_FALLBACK_URLS = "https://logs-healthy.example";
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const request = JSON.parse(String(init?.body)) as Record<string, unknown> | Array<Record<string, unknown>>;
    requestedUrls.push(`${url}:${Array.isArray(request) ? "logs" : String(request.method)}`);
    if (url === "https://logs-limited.example" && Array.isArray(request)) {
      return new Response("Your current plan does not support the eth_getLogs method.", {
        status: 403,
        headers: { "content-type": "text/plain" },
      });
    }
    const payload = Array.isArray(request)
      ? [{ jsonrpc: "2.0", id: 1, result: [] }]
      : { jsonrpc: "2.0", id: 1, result: "0x10" };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await fetchEvmRpcJson("ethereum", [{
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getLogs",
      params: [],
    }]);
    const blockPayload = await fetchEvmRpcJson<{ result: string }>("ethereum", {
      jsonrpc: "2.0",
      id: 2,
      method: "eth_blockNumber",
      params: [],
    });
    assert.equal(blockPayload.result, "0x10");
    assert.deepEqual(requestedUrls.slice(0, 3), [
      "https://logs-limited.example:logs",
      "https://logs-healthy.example:logs",
      "https://logs-limited.example:eth_blockNumber",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPrimary === undefined) delete process.env.ETHEREUM_RPC_URL;
    else process.env.ETHEREUM_RPC_URL = originalPrimary;
    if (originalFallbacks === undefined) delete process.env.ETHEREUM_RPC_FALLBACK_URLS;
    else process.env.ETHEREUM_RPC_FALLBACK_URLS = originalFallbacks;
  }
});
