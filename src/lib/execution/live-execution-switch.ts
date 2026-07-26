export function assertLiveExecutionEnabled() {
  if (process.env.LIVE_TRADING_ENABLED?.trim().toLowerCase() !== "true") {
    throw new Error("LIVE_TRADING_ENABLED etkin değil; canlı emir gönderimi kilitli.");
  }
}
