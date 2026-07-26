import assert from "node:assert/strict";
import test from "node:test";
import { createCopyExecutionKey, createManualExecutionKey, hypercoreClientOrderId } from "../src/lib/engine/execution-idempotency.ts";

test("aynı manuel emir otuz saniyelik pencerede tek idempotency anahtarı üretir", () => {
  const input = { mode: "live" as const, chainId: "base" as const, action: "buy", asset: "0x0000000000000000000000000000000000000001", allocationPercent: 10 };
  const first = createManualExecutionKey({ ...input, now: 60_001 });
  const duplicate = createManualExecutionKey({ ...input, now: 89_999 });
  const later = createManualExecutionKey({ ...input, now: 90_000 });
  assert.equal(first, duplicate);
  assert.notEqual(first, later);
});

test("EVM adresi büyük küçük harften bağımsız, Solana mint adresi duyarlıdır", () => {
  const common = { mode: "shadow" as const, action: "buy", now: 60_000 };
  assert.equal(
    createManualExecutionKey({ ...common, chainId: "ethereum", asset: "0xAbCd" }),
    createManualExecutionKey({ ...common, chainId: "ethereum", asset: "0xabcd" }),
  );
  assert.notEqual(
    createManualExecutionKey({ ...common, chainId: "solana", asset: "MintABC" }),
    createManualExecutionKey({ ...common, chainId: "solana", asset: "mintabc" }),
  );
});

test("copy trade anahtarı kaynak referansına, moda ve ağa bağlıdır", () => {
  const first = createCopyExecutionKey("live", "base", "0xABC");
  assert.equal(first, createCopyExecutionKey("live", "base", "0xabc"));
  assert.notEqual(first, createCopyExecutionKey("shadow", "base", "0xabc"));
  assert.notEqual(first, createCopyExecutionKey("live", "ethereum", "0xabc"));
});

test("HyperCore cloid aynı anahtardan kararlı 128 bit kimlik üretir", () => {
  const cloid = hypercoreClientOrderId("exec:test");
  assert.match(cloid, /^0x[0-9a-f]{32}$/);
  assert.equal(cloid, hypercoreClientOrderId("exec:test"));
});
