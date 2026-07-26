export function parseErc20TransferAmount(data: string | undefined): bigint {
  const normalized = data?.trim().toLowerCase();
  if (!normalized || normalized === "0x") return 0n;
  return BigInt(normalized);
}
