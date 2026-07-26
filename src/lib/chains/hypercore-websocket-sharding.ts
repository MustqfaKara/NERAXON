export const HYPERCORE_USERS_PER_SOCKET = 10;

export function shardHypercoreAddresses(addresses: Iterable<string>): string[][] {
  const uniqueAddresses = [...new Set(addresses)].sort();
  const shards: string[][] = [];
  for (let index = 0; index < uniqueAddresses.length; index += HYPERCORE_USERS_PER_SOCKET) {
    shards.push(uniqueAddresses.slice(index, index + HYPERCORE_USERS_PER_SOCKET));
  }
  return shards;
}

export function isUserTerminatedWebSocket(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "TERMINATED_BY_USER";
}
