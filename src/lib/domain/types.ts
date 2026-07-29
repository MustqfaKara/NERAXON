export type EvmChainId = "ethereum" | "base" | "robinhood";
export type SolanaChainId = "solana";
export type VenueId = "hyperliquid";
export type ChainId = EvmChainId | SolanaChainId | VenueId;
export type IntegrationKind = "evm" | "solana" | "venue";
export type BotStatus =
  | "running"
  | "stopped"
  | "starting"
  | "stopping"
  | "error";
export type TradingMode = "paper" | "shadow" | "live";
export type AppLanguage = "tr" | "en";
export interface ExecutionAccountAddresses {
  evm: string | null;
  solana: string | null;
  hyperliquid: string | null;
}
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
  kind: IntegrationKind;
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
  qualityValidation?: {
    windowDays: number;
    swapCount: number;
    buyCount: number;
    sellCount: number;
    uniqueTokenCount: number;
    completedRoundTrips: number;
    winRatePercent: number;
    realizedPnlUsd: number;
    realizedPnlPercent: number;
    unrealizedPnlUsd?: number;
    totalPnlUsd?: number;
    investedUsd?: number;
    averageBuyUsd?: number;
    historyComplete?: boolean;
    dataSource?: "helius" | "helius-provisional" | "birdeye";
  };
}

export interface WalletDiscoveryScan {
  chainId: ChainId;
  candidates: WalletDiscoveryCandidate[];
  transferSampleSize: number;
  transactionSampleSize: number;
  topGainers: DiscoveryGainerToken[];
  pnlDataSource: "alchemy+dexscreener" | "dexscreener+rpc" | "dexscreener+public-rpc" | "dexscreener+geckoterminal+rpc" | "helius+dexscreener" | "birdeye+helius+dexscreener" | "hyperliquid-leaderboard";
  windowStartedAt: string;
  generatedAt: string;
  diagnostics?: {
    status?: "complete" | "partial";
    tokenUniverseSize: number;
    tokenTraderRows: number;
    seedWallets: number;
    tokenLinkedWallets: number;
    pnlValidatedWallets: number;
    attemptedWallets?: number;
    providerErrorCount?: number;
    completionPercent?: number;
    qualityScoreRange?: {
      minimum: number;
      maximum: number;
      average: number;
    };
    rejectionReasons: Record<string, number>;
  };
}

export type HypercoreMarketType = "spot" | "perp";
export type HypercorePositionSide = "long" | "short";

export interface HypercoreFillObservation {
  id: string;
  walletAddress: string;
  coin: string;
  marketType: HypercoreMarketType;
  side: "buy" | "sell";
  direction: string;
  priceUsd: number;
  quantity: number;
  notionalUsd: number;
  feeUsd: number;
  closedPnlUsd: number;
  crossed: boolean;
  sourcePositionBefore: number;
  timestamp: number;
}

export interface HypercorePaperPosition {
  id: string;
  walletId: string | null;
  walletLabel: string | null;
  coin: string;
  marketType: HypercoreMarketType;
  side: HypercorePositionSide;
  quantity: number;
  entryPriceUsd: number;
  currentPriceUsd: number;
  marginUsd: number;
  leverage: number;
  liquidationPriceUsd: number | null;
  unrealizedPnlUsd: number;
  fundingUsd: number;
  openedAt: string;
  updatedAt: string;
}

export interface HypercorePaperTrade {
  id: string;
  walletId: string | null;
  source: "copy" | "manual";
  coin: string;
  marketType: HypercoreMarketType;
  side: "buy" | "sell";
  positionSide: HypercorePositionSide;
  action: "open" | "increase" | "reduce" | "close" | "spot_buy" | "spot_sell" | "skipped";
  quantity: number;
  priceUsd: number;
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
  feeUsd: number;
  fundingUsd: number;
  realizedPnlUsd: number;
  status: TradeStatus;
  reason: string;
  sourceFillId: string | null;
  createdAt: string;
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
  isFavorite: boolean;
  trackedChainIds: ChainId[];
  state: WalletState;
  score: number;
  scoreBreakdown: WalletScoreBreakdown;
  totalTrades: number;
  observationSwapCount: number;
  copiedTradeCount: number;
  winRate: number;
  realizedPnlUsd: number;
  copyPnlPercent: number;
  copyInvestedUsd: number;
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
  tokenDecimals?: number;
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
  sourceWalletLabels?: string[];
  openedAt?: string | null;
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

export interface NetworkFeeLimit {
  maxFeeUsd: number;
  maxFeePercent: number;
}

export interface NetworkExecutionLimit {
  minPositionPercent: number;
  maxPositionPercent: number;
  minTradeUsd: number;
  maxTradeUsd: number;
  dailyLossLimitPercent: number;
  cashReservePercent: number;
  maxOpenPositions: number;
  maxSlippagePercent: number;
  maxLeverage: number;
  maxQuoteAgeMs: number;
  maxBuyPriceDeviationPercent: number;
  maxSellPriceDeviationPercent: number;
  maxEmergencyExitDeviationPercent: number;
}

export interface AssetPolicySettings {
  minimumSafetyScore: number;
  youngPoolAgeMinutes: number;
  youngPoolMinWallets: number;
  youngPoolAllocationMultiplier: number;
  requireVerifiedExitRoute: boolean;
  hypercoreMinVolume24hUsd: number;
  hypercoreMinOpenInterestUsd: number;
  trustedAssets: Record<ChainId, string[]>;
  deniedAssets: Record<ChainId, string[]>;
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
  hypercoreMaxWalletFillsPerHour?: number;
  hypercoreMaxWalletFillsPer24Hours?: number;
  maxHypercoreLeverage?: number;
  maxLiveTradeUsd?: number;
  maxLiveGasUsd?: number;
  networkFeeLimits?: Record<ChainId, NetworkFeeLimit>;
  networkExecutionLimits?: Record<ChainId, NetworkExecutionLimit>;
  assetPolicy?: AssetPolicySettings;
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

export interface AiTradeAdvisory {
  id: string;
  chainId: ChainId;
  mode: TradingMode;
  side: TradeSide;
  asset: string;
  walletId: string | null;
  walletLabel: string | null;
  sourceReference: string;
  recommendation: "proceed" | "review" | "avoid";
  confidence: number;
  riskLevel: "low" | "medium" | "high";
  summaryTr: string;
  summaryEn: string;
  projectPurposeTr: string;
  projectPurposeEn: string;
  socialAssessmentTr: string;
  socialAssessmentEn: string;
  researchSources: string[];
  riskFlagsTr: string[];
  riskFlagsEn: string[];
  provider: "groq";
  model: string;
  latencyMs: number;
  createdAt: string;
}

export interface TelegramUserChat {
  id: string;
  title: string;
  kind: "group" | "channel";
  selected: boolean;
}

export interface SocialTokenSignal {
  id: string;
  chatId: string;
  chatTitle: string;
  messageId: string;
  chainId: ChainId | null;
  dexScreenerChainId: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  ticker: string | null;
  referenceType: "address" | "dexscreener_pair" | "pumpfun" | "ticker";
  status: "detected" | "analyzed" | "market_unavailable" | "failed";
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  priceChange24hPercent: number;
  marketCapUsd: number | null;
  pairAddress: string | null;
  errorMessage: string | null;
  resolverVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramSocialSettings {
  enabled: boolean;
  selectedChatIds: string[];
  dailyAiLimit: number;
}

export interface TelegramSocialStatus {
  connected: boolean;
  accountLabel: string | null;
  lastConnectedAt: string | null;
  lastSignalAt: string | null;
  lastError: string | null;
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
  consecutiveErrors: number;
  rateLimitedUntil: string | null;
  reconnectCount: number;
}

export interface LiveReadinessCheck {
  id: string;
  label: string;
  ready: boolean;
  detail: string;
}

export interface IntegrationLiveReadiness {
  chainId: ChainId;
  ready: boolean;
  checks: LiveReadinessCheck[];
}

export interface LiveReadiness {
  ready: boolean;
  integrations: IntegrationLiveReadiness[];
}

export interface ExecutionLot {
  id: string;
  integrationId: ChainId;
  mode: Exclude<TradingMode, "paper">;
  assetKey: string;
  walletId: string | null;
  source: "copy" | "manual" | "certification";
  marketType: "evm" | "solana" | HypercoreMarketType;
  positionSide: HypercorePositionSide | null;
  amount: string;
  initialAmount: string;
  amountFormat: "base_units" | "decimal";
  assetSymbol: string;
  pairAddress?: string | null;
  assetDecimals: number;
  entryPriceUsd: number;
  currentPriceUsd: number;
  entryCostUsd: number;
  realizedPnlUsd: number;
  feesUsd: number;
  leverage: number;
  entryReference: string | null;
  status: "open" | "closed";
  openedAt: string;
  updatedAt: string;
}

export interface ExecutionAttempt {
  id: string;
  requestId: string;
  idempotencyKey: string;
  integrationId: ChainId;
  walletId: string | null;
  mode: Exclude<TradingMode, "paper">;
  source: "copy" | "manual" | "certification";
  action: string;
  asset: string;
  status: "preparing" | "filtered" | "submitting" | "submitted" | "simulated" | "confirmed" | "failed" | "stale";
  amountIn: string | null;
  amountOut: string | null;
  expectedAmountOut: string | null;
  minimumAmountOut: string | null;
  quotedPriceUsd: number;
  slippagePercent: number;
  priceImpactPercent: number;
  networkFeeUsd: number;
  dexFeeUsd: number;
  availableBalanceUsd: number;
  simulationLatencyMs: number;
  txHash: string | null;
  externalOrderId: string | null;
  accountingStatus: "pending" | "applied";
  reconciliationStatus: "pending" | "passed" | "failed";
  reconciliationDetails: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  accountedAt: string | null;
  reconciledAt: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionQuality {
  rawSignals: number;
  filteredBeforeExecution: number;
  executableAttempts: number;
  successfulExecutions: number;
  failedExecutions: number;
  successRate: number;
}

export interface ShadowAccount {
  integrationId: ChainId;
  startingEquityUsd: number;
  cashBalanceUsd: number;
  fundingTokenSymbol: string;
  fundingTokenAmount: number;
  fundingTokenPriceUsd: number;
  realizedPnlUsd: number;
  totalCostsUsd: number;
  dailyStartEquityUsd: number;
  dailyStartDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShadowPortfolioSummary extends ShadowAccount {
  positionValueUsd: number;
  equityUsd: number;
  reservedBalanceUsd: number;
  networkCostsUsd: number;
  dexCostsUsd: number;
  unrealizedPnlUsd: number;
  positionUnrealizedPnlUsd: number;
  fundingTokenPnlUsd: number;
  executionRealizedPnlUsd?: number;
  copyPnlUsd?: number;
  nonCopyExecutionPnlUsd?: number;
  accountResidualPnlUsd?: number;
  openPositionCount: number;
}

export interface ReconciliationRecord {
  integrationId: ChainId;
  status: "pending" | "passed" | "failed";
  details: string;
  checkedAt: string | null;
}

export interface CertificationStep {
  integrationId: ChainId;
  stepId: string;
  status: "pending" | "passed" | "failed";
  reference: string | null;
  details: string;
  checkedAt: string | null;
}

export interface DashboardSnapshot {
  language: AppLanguage;
  mode: TradingMode;
  liveReadiness: LiveReadiness;
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
  aiAdvisories: AiTradeAdvisory[];
  serviceHealth: ServiceHealthMetric[];
  rpcEndpoints: RpcEndpointInfo[];
  hypercorePositions: HypercorePaperPosition[];
  hypercoreTrades: HypercorePaperTrade[];
  executionLots: ExecutionLot[];
  executionAttempts: ExecutionAttempt[];
  executionQuality: ExecutionQuality;
  shadowPortfolio: ShadowPortfolioSummary[];
  livePortfolio: ShadowPortfolioSummary[];
  livePortfolioComplete?: boolean;
  executionAccounts: ExecutionAccountAddresses;
  reconciliation: ReconciliationRecord[];
  certificationSteps: CertificationStep[];
}

export interface RpcEndpointInfo {
  chainId: ChainId;
  url: string;
  source: "configured" | "public";
  priority: number;
  status: "active" | "cooldown";
  cooldownUntil: string | null;
  failureCount: number;
  pollingIntervalMs: number | null;
}

export interface ManualTradeInput {
  chainId: ChainId;
  side: TradeSide;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals?: number;
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
