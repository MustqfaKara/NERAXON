# Architecture

NERAXON is organized into three primary layers:

1. `src/lib/chains`: EVM and Solana connectivity, HyperCore streams, block and fill monitoring, transaction classification, and receipt parsing.
2. `src/lib/engine`: Wallet scoring, token safety, consensus, risk decisions, and execution math.
3. `src/lib/services`: Orchestration, market data, Telegram, auditing, wallet discovery, and copy execution.

The web interface communicates only with API routes. It never accesses RPC providers or SQLite directly.

Integrations are declared in `src/lib/domain/integrations.ts`. Ethereum, Base, and Robinhood use EVM semantics; Solana uses its own chain adapter; Hyperliquid is modeled as a venue. This keeps HyperCore order and position behavior separate from token-based chain logic.

## Copy Flow

```text
New block, Solana transaction, or HyperCore fill
  -> Match a monitored wallet on its configured network
  -> Classify the swap or fill
  -> Resolve confirmed token movements
  -> Fetch market price and liquidity
  -> Apply stablecoin and token safety filters
  -> Evaluate wallet score, consensus, and portfolio risk
  -> Prepare, validate, and execute a live order
  -> Persist to SQLite and publish Telegram and web audit events
```

Liquidity changes, approvals, unrelated transfers, and unknown contract calls are not copied. They remain visible in the audit trail and can affect wallet quality metrics.

## Wallet Discovery

EVM and Solana discovery combine market context with on-chain ownership:

```text
DexScreener and Birdeye gaining markets
  -> Liquid market and pool selection
  -> Alchemy or Helius transaction sampling
  -> Pool-linked buyer and seller reconstruction
  -> Realized and unrealized PnL validation
  -> Capital, swap count, ROI, and behavior filters
  -> Network-specific wallet scoring
  -> Global and token-specific rankings
```

DexScreener provides token, pool, and market context, but not wallet ownership. Candidate addresses therefore come from confirmed on-chain movements. Stablecoin swaps and non-swap activity are excluded from copy signals and swap-count limits.

HyperCore uses a separate pipeline:

```text
Hyperliquid daily leaderboard
  -> Positive daily PnL and ROI filter
  -> Recent userFills history
  -> Spot and perpetual behavior analysis
  -> PnL, volume, consistency, and copyability score
  -> Network-scoped watchlist
```

The HyperCore monitor subscribes to new `userFills` events. Snapshot fills are not copied; only fills received after the subscription starts are processed.

## Live Execution

NERAXON is live-only. A new database starts in live mode and the trading-mode API cannot switch to simulated modes. Historical paper and shadow tables remain readable for migration compatibility but are not part of the active runtime path.

Public account addresses are stored in SQLite for balance and reconciliation requests. Private keys are never written to the database or returned by an API. The supported local macOS runtime stores credentials in Keychain.

Execution attempts are idempotent. Quotes preserve expected output, minimum output, slippage, price impact, network cost, DEX cost, simulation latency, submission state, and the final network reference.

## Accounting And Ownership

Ethereum and Base use 0x, Robinhood uses Uniswap v4, and Solana uses Jupiter. They share a `prepare / simulate / execute` lifecycle through integration-specific adapters. HyperCore follows the same lifecycle through a dedicated adapter for spot and perpetual orders.

Live positions are stored in `execution_lots`. Every copied lot owns the `wallet_id` that triggered it. Automated sells can only reduce lots owned by the same source wallet, and legacy simulation history cannot trigger a live entry.

Open value, remaining cost basis, realized PnL, unrealized PnL, fees, funding, and cash are maintained independently for each execution account. FIFO reductions prevent another wallet or position from consuming unrelated cost basis.

## Risk And Safety

New entries pass portfolio-level controls for trade size, open-position count, token exposure, source-wallet exposure, cash reserve, daily loss, gas or priority fee, slippage, provider-aware execution contract validation, and the circuit breaker. Sells remain available when an entry-only limit is reached so risk can still be reduced.

The application binds to `127.0.0.1` and mutating API routes reject non-local origins. Optional administrator authentication uses a signed, HTTP-only session cookie. Public internet deployment is intentionally outside the supported operating model. Live adapters check `LIVE_TRADING_ENABLED` immediately before submission, so a higher-level routing mistake cannot bypass the final kill switch.

## Live Certification

Each EVM network must complete a small buy, partial sell, and full sell followed by on-chain reconciliation. Solana must complete equivalent Jupiter spot tests. HyperCore must complete spot open/close and perpetual open/reduce/close tests against actual fills and the Info API.

Certification and signer changes require every bot to be stopped and explicit operator confirmation. A failed reconciliation activates the circuit breaker. A network is operational only when its signer, provider contract policy, limits, certification, and reconciliation are current.

## Persistence And Recovery

SQLite runs an integrity check and WAL checkpoint during startup. A daily local backup is written to `data/backups/` and old backups are retained for a bounded period. The complete `data/` directory is excluded from Git to keep wallet and trading history local.

Service health records consecutive failures, rate-limit windows, reconnect counts, and recovery timestamps for RPC, WebSocket, quote, market-data, and exchange providers.

## Adding Integrations

New EVM networks are added through the integration catalog and `ChainAdapter`. A non-EVM chain or venue receives its own adapter, address validation, discovery provider, execution plan, and position semantics while reusing the shared risk, audit, and interface contracts.
