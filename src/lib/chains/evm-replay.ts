export function getEvmReplayBatchSize(chainId: "ethereum" | "base" | "robinhood") {
  if (chainId === "base") return 10;
  if (chainId === "robinhood") return 1_000;
  return 500;
}

export function splitEvmReplayRange(fromBlock: bigint, toBlock: bigint, batchSize: number) {
  const safeBatchSize = BigInt(Math.max(1, Math.trunc(batchSize)));
  const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  for (let cursor = fromBlock; cursor <= toBlock; cursor += safeBatchSize) {
    const end = cursor + safeBatchSize - 1n;
    ranges.push({ fromBlock: cursor, toBlock: end > toBlock ? toBlock : end });
  }
  return ranges;
}
