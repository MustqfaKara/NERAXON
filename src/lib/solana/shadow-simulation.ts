export function isExpectedShadowFundingError(error: unknown, logs: string[] = []) {
  const detail = `${stringify(error)} ${logs.join(" ")}`.toLowerCase();
  return [
    "insufficientfundsforfee",
    "insufficient funds",
    "accountnotfound",
    "invalidaccountforfee",
    "account not initialized",
    "accountnotinitialized",
    "no record of a prior credit",
  ].some((marker) => detail.includes(marker));
}

function stringify(value: unknown) {
  try { return JSON.stringify(value); } catch { return String(value); }
}
