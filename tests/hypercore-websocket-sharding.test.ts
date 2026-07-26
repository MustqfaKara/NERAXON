import assert from "node:assert/strict";
import test from "node:test";
import { HYPERCORE_USERS_PER_SOCKET, isUserTerminatedWebSocket, shardHypercoreAddresses } from "../src/lib/chains/hypercore-websocket-sharding.ts";

test("HyperCore cüzdanlarını bağlantı başına en fazla on kullanıcıya böler", () => {
  const addresses = Array.from({ length: 23 }, (_, index) => `0x${index.toString(16).padStart(40, "0")}`);
  const shards = shardHypercoreAddresses(addresses);

  assert.equal(shards.length, 3);
  assert.deepEqual(shards.map((shard) => shard.length), [10, 10, 3]);
  assert.ok(shards.every((shard) => shard.length <= HYPERCORE_USERS_PER_SOCKET));
});

test("HyperCore bağlantı havuzu aynı cüzdanı iki kez abone etmez", () => {
  const address = `0x${"1".padStart(40, "0")}`;
  const shards = shardHypercoreAddresses([address, address]);

  assert.deepEqual(shards, [[address]]);
});

test("kullanıcı kaynaklı WebSocket kapanışını bağlantı hatası saymaz", () => {
  assert.equal(isUserTerminatedWebSocket({ code: "TERMINATED_BY_USER" }), true);
  assert.equal(isUserTerminatedWebSocket({ code: "RECONNECTION_LIMIT" }), false);
  assert.equal(isUserTerminatedWebSocket(new Error("timeout")), false);
});
