import assert from "node:assert/strict";
import test from "node:test";
import { getEvmReplayBatchSize, splitEvmReplayRange } from "../src/lib/chains/evm-replay.ts";

test("Her EVM ağı sağlayıcısının desteklediği güvenli replay aralığını kullanır", () => {
  assert.equal(getEvmReplayBatchSize("base"), 10);
  assert.equal(getEvmReplayBatchSize("robinhood"), 1_000);
  assert.equal(getEvmReplayBatchSize("ethereum"), 500);
});

test("Base replay aralıkları boşluk ve çakışma olmadan 10 bloğa bölünür", () => {
  assert.deepEqual(splitEvmReplayRange(100n, 125n, getEvmReplayBatchSize("base")), [
    { fromBlock: 100n, toBlock: 109n },
    { fromBlock: 110n, toBlock: 119n },
    { fromBlock: 120n, toBlock: 125n },
  ]);
});

test("Robinhood hızlı blok akışını daha az RPC çağrısıyla tarar", () => {
  assert.deepEqual(splitEvmReplayRange(1_000n, 3_250n, getEvmReplayBatchSize("robinhood")), [
    { fromBlock: 1_000n, toBlock: 1_999n },
    { fromBlock: 2_000n, toBlock: 2_999n },
    { fromBlock: 3_000n, toBlock: 3_250n },
  ]);
});
