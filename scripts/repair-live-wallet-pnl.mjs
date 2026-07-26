import { copyFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const databasePath = path.join(process.cwd(), "data", "neraxon.db");
const backupPath = path.join(process.cwd(), "data", `neraxon-before-wallet-pnl-repair-${new Date().toISOString().replaceAll(":", "-")}.db`);
const database = new DatabaseSync(databasePath);

const explorers = {
  ethereum: "https://eth.blockscout.com/api/v2",
  base: "https://base.blockscout.com/api/v2",
  robinhood: "https://robinhoodchain.blockscout.com/api/v2",
};

const attempts = database.prepare(`
  SELECT * FROM execution_attempts
  WHERE mode = 'live'
    AND source = 'copy'
    AND status = 'confirmed'
    AND integration_id IN ('ethereum', 'base', 'robinhood')
    AND tx_hash IS NOT NULL
  ORDER BY created_at ASC
`).all();

const lots = database.prepare(`
  SELECT * FROM execution_lots
  WHERE mode = 'live'
    AND source = 'copy'
    AND integration_id IN ('ethereum', 'base', 'robinhood')
  ORDER BY opened_at ASC
`).all();

const marketSamples = buildNativePriceSamples(attempts, lots);
const repairs = [];

for (const attempt of attempts) {
  const explorer = explorers[attempt.integration_id];
  if (!explorer) continue;
  const transaction = await fetchJson(`${explorer}/transactions/${attempt.tx_hash}`);
  const swapFeeNative = weiToNative(transaction?.fee?.value);
  if (!(swapFeeNative > 0)) continue;

  const nativePriceUsd = nearestNativePrice(marketSamples, attempt.integration_id, attempt.created_at);
  if (!(nativePriceUsd > 0)) {
    throw new Error(`${attempt.request_id} için işlem anındaki native token fiyatı türetilemedi.`);
  }

  const relatedLots = lots.filter((lot) =>
    lot.integration_id === attempt.integration_id
    && lot.wallet_id === attempt.wallet_id
    && lot.asset_symbol.toLowerCase() === String(attempt.asset).toLowerCase(),
  );
  const approvalFeeNative = attempt.action === "sell"
    ? await findApprovalFeeNative(explorer, transaction, relatedLots, attempt.created_at)
    : 0;
  const actualNetworkFeeUsd = (swapFeeNative + approvalFeeNative) * nativePriceUsd;
  repairs.push({
    attempt,
    relatedLots,
    actualNetworkFeeUsd,
    swapFeeNative,
    approvalFeeNative,
    nativePriceUsd,
  });
}

if (!repairs.length) {
  console.log("Onarılacak EVM execution kaydı bulunamadı.");
  database.close();
  process.exit(0);
}

database.exec("PRAGMA wal_checkpoint(FULL)");
copyFileSync(databasePath, backupPath);
database.exec("BEGIN IMMEDIATE");
try {
  for (const repair of repairs) applyRepair(repair);
  database.exec("COMMIT");
} catch (error) {
  database.exec("ROLLBACK");
  throw error;
} finally {
  database.close();
}

console.log(JSON.stringify({
  backupPath,
  repairedAttempts: repairs.length,
  changes: repairs.map(({ attempt, actualNetworkFeeUsd, swapFeeNative, approvalFeeNative }) => ({
    requestId: attempt.request_id,
    previousNetworkFeeUsd: Number(attempt.network_fee_usd),
    actualNetworkFeeUsd,
    swapFeeNative,
    approvalFeeNative,
  })),
}, null, 2));

function applyRepair(repair) {
  const { attempt, relatedLots, actualNetworkFeeUsd, swapFeeNative, approvalFeeNative, nativePriceUsd } = repair;
  const previousFeeUsd = Number(attempt.network_fee_usd);
  const feeDeltaUsd = actualNetworkFeeUsd - previousFeeUsd;
  const metadata = safeJson(attempt.metadata);
  metadata.nativePriceUsd = nativePriceUsd;
  metadata.estimatedNetworkFeeUsd ??= previousFeeUsd;
  metadata.actualNetworkFeeUsd = actualNetworkFeeUsd;
  metadata.actualNetworkFeeNativeAmount = String(Math.round((swapFeeNative + approvalFeeNative) * 1e18));
  metadata.networkFeeReconciledAt = new Date().toISOString();

  database.prepare(`
    UPDATE execution_attempts
    SET network_fee_usd = ?, metadata = ?, updated_at = ?
    WHERE id = ?
  `).run(actualNetworkFeeUsd, JSON.stringify(metadata), new Date().toISOString(), attempt.id);

  if (attempt.action === "buy") {
    const lot = relatedLots.find((candidate) => candidate.entry_reference?.toLowerCase() === attempt.tx_hash.toLowerCase());
    if (!lot) throw new Error(`${attempt.request_id} alımı için execution lotu bulunamadı.`);
    const nextEntryCostUsd = Number(lot.entry_cost_usd) + feeDeltaUsd;
    const quantity = executionQuantity(lot.initial_amount, lot.amount_format, lot.asset_decimals);
    database.prepare(`
      UPDATE execution_lots
      SET entry_cost_usd = ?, entry_price_usd = ?, fees_usd = fees_usd + ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextEntryCostUsd,
      quantity > 0 ? nextEntryCostUsd / quantity : Number(lot.entry_price_usd),
      feeDeltaUsd,
      new Date().toISOString(),
      lot.id,
    );
    return;
  }

  if (attempt.action !== "sell") return;
  const consumedLots = relatedLots
    .map((lot) => ({
      lot,
      consumed: Math.max(0, executionQuantity(lot.initial_amount, lot.amount_format, lot.asset_decimals)
        - executionQuantity(lot.amount, lot.amount_format, lot.asset_decimals)),
    }))
    .filter((item) => item.consumed > 0);
  const totalConsumed = consumedLots.reduce((sum, item) => sum + item.consumed, 0);
  if (!(totalConsumed > 0)) throw new Error(`${attempt.request_id} satışı için tüketilmiş execution lotu bulunamadı.`);
  for (const item of consumedLots) {
    const allocation = item.consumed / totalConsumed;
    database.prepare(`
      UPDATE execution_lots
      SET realized_pnl_usd = realized_pnl_usd - ?,
          fees_usd = fees_usd + ?,
          updated_at = ?
      WHERE id = ?
    `).run(feeDeltaUsd * allocation, feeDeltaUsd * allocation, new Date().toISOString(), item.lot.id);
  }
}

function buildNativePriceSamples(allAttempts, allLots) {
  return allAttempts.flatMap((attempt) => {
    if (attempt.action !== "buy" || !attempt.amount_in) return [];
    const lot = allLots.find((candidate) => candidate.entry_reference?.toLowerCase() === attempt.tx_hash?.toLowerCase());
    const nativeAmount = weiToNative(attempt.amount_in);
    if (!lot || !(nativeAmount > 0)) return [];
    const tradeValueUsd = Number(lot.entry_cost_usd) - Number(attempt.network_fee_usd);
    const nativePriceUsd = tradeValueUsd / nativeAmount;
    return Number.isFinite(nativePriceUsd) && nativePriceUsd > 0
      ? [{ integrationId: attempt.integration_id, createdAt: attempt.created_at, nativePriceUsd }]
      : [];
  });
}

function nearestNativePrice(samples, integrationId, createdAt) {
  const timestamp = new Date(createdAt).getTime();
  return samples
    .filter((sample) => sample.integrationId === integrationId)
    .sort((left, right) =>
      Math.abs(new Date(left.createdAt).getTime() - timestamp)
      - Math.abs(new Date(right.createdAt).getTime() - timestamp),
    )[0]?.nativePriceUsd ?? 0;
}

async function findApprovalFeeNative(explorer, transaction, relatedLots, createdAt) {
  const owner = transaction?.from?.hash;
  const tokenAddresses = new Set(relatedLots.map((lot) => lot.asset_key.toLowerCase()));
  if (!owner || !tokenAddresses.size) return 0;
  const payload = await fetchJson(`${explorer}/addresses/${owner}/transactions`);
  const saleTime = new Date(createdAt).getTime();
  return (payload?.items ?? [])
    .filter((item) => item.method === "approve")
    .filter((item) => tokenAddresses.has(item.to?.hash?.toLowerCase()))
    .filter((item) => {
      const timestamp = new Date(item.timestamp).getTime();
      return timestamp <= saleTime + 60_000 && timestamp >= saleTime - 120_000;
    })
    .reduce((sum, item) => sum + weiToNative(item.fee?.value), 0);
}

function executionQuantity(value, format, decimals) {
  const numeric = Number(value);
  return format === "base_units" ? numeric / 10 ** Math.max(0, Number(decimals)) : numeric;
}

function weiToNative(value) {
  if (value === undefined || value === null || value === "") return 0;
  return Number(BigInt(value)) / 1e18;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${url} isteği başarısız (${response.status}).`);
  return response.json();
}

function safeJson(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}
