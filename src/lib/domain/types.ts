export type ChainId = "ethereum" | "base";
export type BotStatus =
  | "running"
  | "stopped"
  | "starting"
  | "stopping"
  | "error";
export type TradingMode = "paper" | "live";
export type AppLanguage = "tr" | "en";
export type WalletState = "observing" | "active" | "paused";
export type TradeSide = "buy" | "sell";
export type TradeStatus =
  | "detected"
  | "evaluating"
  | "approved"
  | "confirmed"
  | "failed"
  | "skipped";
export type ActivityType =
  | "swap"
  | "liquidity_add"
  | "liquidity_remove"
  | "transfer"
  | "approval"
  | "bridge"
  | "contract"
  | "unknown"
  | "system";

export interface ChainRuntime {
  id: ChainId;
  name: string;
  nativeSymbol: string;
  status: BotStatus;
  rpcConfigured: boolean;
  lastBlock: number | null;
  latencyMs: number | null;
  errorMessage: string | null;
  updatedAt: string;
}

export interface WalletScoreBreakdown {
  profitability: number;
  consistency: number;
  riskControl: number;
  copyability: number;
  safety: number;
}

export interface DiscoveryScoreBreakdown {
  profitability: number;
  activity: number;
  diversity: number;
  balance: number;
  freshness: number;
}

export interface DiscoveryGainerToken {
  address: string;
  symbol: string;
  priceUsd: number;
  priceChange24hPercent: number;
  liquidityUsd: number;
  volume24hUsd: number;
  marketCapUsd: number | null;
  pairAddress: string;
  dexId: string;
}

export interface DiscoveryTokenPerformance extends DiscoveryGainerToken {
  boughtUsd: number;
  soldUsd: number;
  currentValueUsd: number;
  estimatedPnlUsd: number;
  gasCostUsd: number;
  swapCount: number;
  buyCount: number;
  sellCount: number;
}

export interface WalletDiscoveryCandidate {
  address: string;
  chainId: ChainId;
  score: number;
  scoreBreakdown: DiscoveryScoreBreakdown;
  swapCount: number;
  buyCount: number;
  sellCount: number;
  uniqueTokenCount: number;
  boughtUsd: number;
  soldUsd: number;
  currentValueUsd: number;
  estimatedPnlUsd: number;
  estimatedPnlPercent: number;
  gasCostUsd: number;
  gainerTokens: DiscoveryTokenPerformance[];
  lastActiveAt: string;
  sampleTxHashes: string[];
}

export interface WalletDiscoveryScan {
  chainId: ChainId;
  candidates: WalletDiscoveryCandidate[];
  transferSampleSize: number;
  transactionSampleSize: number;
  topGainers: DiscoveryGainerToken[];
  pnlDataSource: "alchemy+dexscreener";
  windowStartedAt: string;
  generatedAt: string;
}

export interface WalletAdditionTokenSnapshot {
  address: string;
  symbol: string;
  pairAddress: string | null;
  boughtUsd: number;
  soldUsd: number;
  currentValueUsd: number;
  estimatedPnlUsd: number;
  swapCount: number;
  buyCount: number;
  sellCount: number;
}

export interface WalletAdditionContext {
  source: "manual" | "discovery";
  reason: string;
  capturedAt: string;
  chainId: ChainId | null;
  boughtUsd: number;
  soldUsd: number;
  currentValueUsd: number;
  estimatedPnlUsd: number;
  estimatedPnlPercent: number;
  swapCount: number;
  buyCount: number;
  sellCount: number;
  uniqueTokenCount: number;
  tokens: WalletAdditionTokenSnapshot[];
}

export interface TrackedWallet {
  id: string;
  address: string;
  label: string;
  state: WalletState;
  score: number;
  scoreBreakdown: WalletScoreBreakdown;
  totalTrades: number;
  observationSwapCount: number;
  copiedTradeCount: number;
  winRate: number;
  realizedPnlUsd: number;
  maxDrawdownPercent: number;
  averageHoldMinutes: number;
  pauseReason: string | null;
  additionContext: WalletAdditionContext | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeeBreakdown {
  dexFeeUsd: number;
  gasFeeUsd: number;
  slippageUsd: number;
  priceImpactUsd: number;
  tokenTaxUsd: number;
  totalUsd: number;
}

export interface Trade {
  id: string;
  chainId: ChainId;
  walletId: string | null;
  source: "copy" | "manual";
  side: TradeSide;
  tokenAddress: string;
  tokenSymbol: string;
  quantity: number;
  priceUsd: number;
  grossUsd: number;
  netUsd: number;
  realizedPnlUsd: number;
  executionDelayMs: number;
  status: TradeStatus;
  fees: FeeBreakdown;
  reason: string;
  txHash: string | null;
  createdAt: string;
}

export interface Position {
  id: string;
  chainId: ChainId;
  tokenAddress: string;
  tokenSymbol: string;
  pairAddress?: string | null;
  sourceWalletId: string | null;
  sourceWalletLabel: string | null;
  quantity: number;
  averageEntryUsd: number;
  currentPriceUsd: number;
  investedUsd: number;
  unrealizedPnlUsd: number;
  updatedAt: string;
}

export interface PositionLot {
  id: string;
  chainId: ChainId;
  tokenAddress: string;
  tokenSymbol: string;
  pairAddress: string | null;
  walletId: string | null;
  walletLabel: string | null;
  source: "copy" | "manual";
  openedTradeId: string | null;
  initialQuantity: number;
  remainingQuantity: number;
  entryPriceUsd: number;
  entryCostUsd: number;
  realizedPnlUsd: number;
  openedAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  chainId: ChainId | null;
  level: "info" | "warning" | "critical";
  type: ActivityType;
  title: string;
  message: string;
  txHash: string | null;
  createdAt: string;
}

export interface RiskSettings {
  minPositionPercent: number;
  maxPositionPercent: number;
  dailyLossLimitPercent: number;
  maxOpenPositions: number;
  maxTokenExposurePercent: number;
  maxWalletExposurePercent: number;
  minimumLiquidityUsd: number;
  maxSlippagePercent: number;
  maxPriceImpactPercent: number;
  cashReservePercent: number;
  maxConsecutiveFailures?: number;
  maxRpcLatencyMs?: number;
  maxPriceChange24hPercent?: number;
  maxWalletSwapsPerHour?: number;
  maxWalletSwapsPer24Hours?: number;
}

export interface CircuitBreakerState {
  halted: boolean;
  reason: string | null;
  consecutiveFailures: number;
  triggeredAt: string | null;
  updatedAt: string;
}

export interface PerformanceSlice {
  key: string;
  label: string;
  tradeCount: number;
  winCount: number;
  winRate: number;
  realizedPnlUsd: number;
  feesUsd: number;
  averageExecutionDelayMs: number;
}

export interface EquityPoint { at: string; valueUsd: number }

export interface PerformanceAnalytics {
  confirmedTrades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  averageExecutionDelayMs: number;
  byChain: PerformanceSlice[];
  byWallet: PerformanceSlice[];
  byToken: PerformanceSlice[];
  equityCurve: EquityPoint[];
}

export interface ConsensusEntry {
  chainId: ChainId;
  tokenAddress: string;
  tokenSymbol: string;
  pairAddress: string | null;
  walletCount: number;
  walletLabels: string[];
  copiedStages: number;
  nextThreshold: number | null;
  updatedAt: string;
}

export interface ServiceHealthMetric {
  id: string;
  label: string;
  status: "healthy" | "degraded" | "down" | "idle";
  requestCount: number;
  errorCount: number;
  cacheHitCount: number;
  averageLatencyMs: number;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

export interface DashboardSnapshot {
  language: AppLanguage;
  mode: TradingMode;
  startingBalanceUsd: number;
  cashBalanceUsd: number;
  equityUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalFeesUsd: number;
  dailyPnlUsd: number;
  chains: ChainRuntime[];
  wallets: TrackedWallet[];
  positions: Position[];
  positionLots: PositionLot[];
  trades: Trade[];
  events: AuditEvent[];
  riskSettings: RiskSettings;
  circuitBreaker: CircuitBreakerState;
  analytics: PerformanceAnalytics;
  consensus: ConsensusEntry[];
  serviceHealth: ServiceHealthMetric[];
}

export interface ManualTradeInput {
  chainId: ChainId;
  side: TradeSide;
  tokenAddress: string;
  tokenSymbol: string;
  pairAddress?: string | null;
  priceUsd: number;
  allocationPercent?: number;
  sellPercent?: number;
  quantity?: number;
  slippagePercent?: number;
  liquidityUsd?: number;
  gasFeeUsd?: number;
  dexFeePercent?: number;
  buyTaxPercent?: number;
  sellTaxPercent?: number;
  priceChange24hPercent?: number;
  executionDelayMs?: number;
}
