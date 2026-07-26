const globalState = globalThis as typeof globalThis & { neraxonRuntimeOwnerId?: string };

export const PRIMARY_RUNTIME_LEASE = "primary-runtime";
export const PRIMARY_RUNTIME_LEASE_TTL_MS = 120_000;

export function getRuntimeOwnerId() {
  return (globalState.neraxonRuntimeOwnerId ??= `${process.pid}:${crypto.randomUUID()}`);
}
