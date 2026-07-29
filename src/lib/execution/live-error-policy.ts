export function isJupiterSlippageError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /0x1771|custom(?: program)? error[: ]+6001|Custom["': ]+6001|slippage tolerance exceeded/i.test(message);
}

export function nextJupiterSlippageBps(currentBps: number, maximumBps: number) {
  const increased = Math.max(100, currentBps + 50, Math.ceil(currentBps * 1.5));
  return Math.max(currentBps, Math.min(maximumBps, increased));
}

export function isHypercoreCrossMarginUnsupported(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /cross margin is not allowed|only isolated|isolated margin only/i.test(message);
}
