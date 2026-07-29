export function isRecoverableRpcMonitoringError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /429|rate.?limit|too many requests|monthly capacity|compute units|fetch failed|HTTP request failed|RPC|WebSocket|timeout|timed out|zaman aşımı|gecikmesi|deadline exceeded|temporar|unavailable|gateway|connection|socket|network|econn|block range/i.test(message);
}
