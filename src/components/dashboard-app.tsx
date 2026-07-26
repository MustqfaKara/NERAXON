"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowDownLeft,
  ArrowUp,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  ExternalLink,
  Eye,
  Gauge,
  LayoutDashboard,
  Menu,
  Pause,
  PauseCircle,
  Play,
  PlayCircle,
  Plus,
  RefreshCw,
  Radar,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  TrendingDown,
  TrendingUp,
  Trash2,
  UserPlus,
  WalletCards,
  X,
  BarChart3,
  Layers3,
  History,
  ServerCog,
  OctagonX,
  MessageSquareText,
  Network,
  PlugZap,
  KeyRound,
  LogOut,
} from "lucide-react";
import type {
  AppLanguage,
  BotStatus,
  ChainId,
  ChainRuntime,
  DashboardSnapshot,
  DiscoveryTokenPerformance,
  Position,
  RiskSettings,
  Trade,
  TrackedWallet,
  WalletDiscoveryCandidate,
  WalletDiscoveryScan,
  HypercorePaperPosition,
  TradingMode,
  SocialTokenSignal,
  TelegramSocialSettings,
  TelegramSocialStatus,
  TelegramUserChat,
  AiTradeAdvisory,
} from "@/lib/domain/types";
import { MAX_DISCOVERY_BOUGHT_USD, MIN_DISCOVERY_BOUGHT_USD, MIN_DISCOVERY_PNL_USD, MIN_SOLANA_DISCOVERY_PNL_USD } from "@/lib/engine/discovery-pnl";
import { executionLotNetPnl } from "@/lib/engine/execution-wallet-performance";
import { useDocumentTranslation } from "@/lib/client-translation";
import { localeFor } from "@/lib/i18n";
import { INTEGRATION_CATALOG, INTEGRATION_IDS, LIVE_PILOT_INTEGRATION_IDS, SHADOW_TEST_INTEGRATION_IDS, integrationExplorerUrl, integrationMarketUrl, integrationName, isLivePilotIntegration, isShadowTestIntegration } from "@/lib/domain/integrations";
import { dashboardPathForView, type DashboardViewId } from "@/lib/dashboard-pages";

type DiscoverySort = "score" | "pnl" | "bought" | "sold" | "swaps";

interface TokenQuotePreview {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  market: {
    priceUsd: number;
    liquidityUsd: number;
    volume24hUsd: number;
    priceChange24hPercent: number;
    marketCapUsd: number | null;
    fdvUsd: number | null;
    dexId: string;
    pairAddress: string;
  };
  gas: {
    gasPriceGwei: number;
    gasUnits: number;
    feeUsd: number;
  };
  safety: {
    approved: boolean;
    warnings: string[];
    reason: string;
    score: number;
    checks: Array<{ label: string; status: "passed" | "warning" | "failed"; detail: string }>;
  };
}

type View = DashboardViewId;

const navigation: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Genel Bakış", icon: LayoutDashboard },
  { id: "my-wallets", label: "My Wallets", icon: CircleDollarSign },
  { id: "wallets", label: "Cüzdanlar", icon: WalletCards },
  { id: "discovery", label: "Cüzdan Keşfi", icon: Radar },
  { id: "social", label: "Sosyal Sinyaller", icon: MessageSquareText },
  { id: "trades", label: "İşlemler", icon: Activity },
  { id: "analytics", label: "Performans", icon: BarChart3 },
  { id: "consensus", label: "Konsensüs", icon: Layers3 },
  { id: "backtest", label: "Replay", icon: History },
  { id: "system", label: "Sistem Sağlığı", icon: ServerCog },
  { id: "risk", label: "Risk Ayarları", icon: SlidersHorizontal },
  { id: "rpc", label: "RPC Ayarları", icon: Network },
  { id: "integrations", label: "Entegrasyonlar", icon: PlugZap },
];

const DASHBOARD_POLL_INTERVAL_MS = 60_000;
const scrollPageToTop = () => window.scrollTo({ top: 0, left: 0, behavior: "auto" });

export function DashboardApp({ initialView, initialLanguage }: { initialView: View; initialLanguage: AppLanguage }) {
  const router = useRouter();
  const [data, setData] = useState<DashboardSnapshot | null>(null);
  const [language, setLanguage] = useState<AppLanguage>(initialLanguage);
  const [view, setView] = useState<View>(initialView);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [secondsUntilRefresh, setSecondsUntilRefresh] = useState(DASHBOARD_POLL_INTERVAL_MS / 1_000);
  const nextRefreshAt = useRef<number | null>(null);
  const activeViewRef = useRef<View>(initialView);
  const requestSequence = useRef(0);

  const resetRefreshCountdown = useCallback(() => {
    nextRefreshAt.current = Date.now() + DASHBOARD_POLL_INTERVAL_MS;
    setSecondsUntilRefresh(DASHBOARD_POLL_INTERVAL_MS / 1_000);
  }, []);

  const refresh = useCallback(async ({
    silent = false,
    refreshMarkets = false,
    refreshPortfolio = false,
    showSuccess = true,
    targetView = activeViewRef.current,
  }: {
    silent?: boolean;
    refreshMarkets?: boolean;
    refreshPortfolio?: boolean;
    showSuccess?: boolean;
    targetView?: View;
  } = {}) => {
    const requestId = ++requestSequence.current;
    if (!silent) setLoading(true);
    try {
      const query = new URLSearchParams({ view: targetView });
      if (refreshMarkets) query.set("refreshMarkets", "true");
      if (refreshPortfolio) query.set("refreshPortfolio", "true");
      const endpoint = `/api/dashboard?${query.toString()}`;
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error("Panel verileri alınamadı.");
      const snapshot = await response.json() as DashboardSnapshot;
      if (requestId !== requestSequence.current || targetView !== activeViewRef.current) return;
      document.documentElement.lang = snapshot.language;
      setLanguage(snapshot.language);
      setData(snapshot);
      if (refreshMarkets && showSuccess) {
        setNotice({ type: "success", message: "Portföy bakiyeleri güncel piyasa fiyatlarıyla yenilendi." });
      }
    } catch (error) {
      if (requestId !== requestSequence.current) return;
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Bağlantı hatası." });
    } finally {
      if (requestId === requestSequence.current) {
        if (!silent) setLoading(false);
        resetRefreshCountdown();
      }
    }
  }, [resetRefreshCountdown]);

  useDocumentTranslation(language);

  useEffect(() => {
    activeViewRef.current = initialView;
    scrollPageToTop();
    let marketTimer: number | null = null;
    const initialTimer = window.setTimeout(async () => {
      await refresh({
        targetView: initialView,
        refreshMarkets: initialView === "wallets",
        showSuccess: false,
      });
      if (initialView === "overview" || initialView === "my-wallets") {
        marketTimer = window.setTimeout(
          () => void refresh({ silent: true, refreshPortfolio: true, showSuccess: false, targetView: initialView }),
          350,
        );
      }
    }, 0);
    return () => {
      window.clearTimeout(initialTimer);
      if (marketTimer !== null) window.clearTimeout(marketTimer);
    };
  }, [initialView, refresh]);

  const hasRunningChain = data?.chains.some((chain) => chain.status === "running") ?? false;
  useEffect(() => {
    const shouldPoll = hasRunningChain || view === "overview" || view === "my-wallets" || view === "wallets";
    if (!shouldPoll) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      if (nextRefreshAt.current === null) {
        resetRefreshCountdown();
        return;
      }
      const remainingSeconds = Math.max(0, Math.ceil((nextRefreshAt.current - Date.now()) / 1_000));
      setSecondsUntilRefresh(remainingSeconds);
      if (remainingSeconds > 0) return;
      resetRefreshCountdown();
      void refresh({ silent: true, refreshMarkets: view === "overview" || view === "my-wallets" || view === "wallets", showSuccess: false });
    };
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [hasRunningChain, refresh, resetRefreshCountdown, view]);

  const navigate = useCallback((nextView: View) => {
    if (nextView === activeViewRef.current) {
      scrollPageToTop();
      return;
    }
    activeViewRef.current = nextView;
    setView(nextView);
    setData(null);
    setLoading(true);
    setMobileMenu(false);
    scrollPageToTop();
    router.push(dashboardPathForView(nextView));
  }, [router]);

  useEffect(() => {
    scrollPageToTop();
  }, [view]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const changeLanguage = async (nextLanguage: AppLanguage) => {
    if (nextLanguage === language) return;
    const previousLanguage = language;
    document.documentElement.lang = nextLanguage;
    setLanguage(nextLanguage);
    setData((current) => current ? { ...current, language: nextLanguage } : current);
    try {
      const response = await fetch("/api/language", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: nextLanguage }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Dil tercihi kaydedilemedi.");
    } catch (error) {
      document.documentElement.lang = previousLanguage;
      setLanguage(previousLanguage);
      setData((current) => current ? { ...current, language: previousLanguage } : current);
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Dil tercihi kaydedilemedi." });
    }
  };

  const controlChain = async (chainId: ChainId, action: "start" | "stop") => {
    setBusyKey(chainId);
    try {
      const response = await fetch(`/api/chains/${chainId}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Ağ durumu değiştirilemedi.");
      setNotice({ type: "success", message: `${integrationName(chainId)} botu ${action === "start" ? "çalıştırıldı" : "durduruldu"}.` });
      await refresh({ silent: true });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "İşlem başarısız." });
    } finally {
      setBusyKey(null);
    }
  };

  const controlAll = async () => {
    if (!data) return;
    const controllableChains = data.mode === "shadow"
      ? data.chains.filter((chain) => isShadowTestIntegration(chain.id))
      : data.mode === "live" ? data.chains.filter((chain) => isLivePilotIntegration(chain.id)) : data.chains;
    const shouldStart = controllableChains.every((chain) => chain.status !== "running");
    const targetChains = shouldStart ? controllableChains : data.chains.filter((chain) => chain.status === "running");
    setBusyKey("all");
    try {
      await Promise.all(targetChains.map(async (chain) => {
        const response = await fetch(`/api/chains/${chain.id}/control`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: shouldStart ? "start" : "stop" }),
        });
        if (!response.ok) {
          const result = await response.json();
          throw new Error(result.error ?? `${chain.name} kontrol edilemedi.`);
        }
      }));
      setNotice({ type: "success", message: shouldStart && data.mode === "live" ? "Base, Robinhood, Solana ve Hyperliquid botları çalıştırıldı." : shouldStart && data.mode === "shadow" ? "Base, Solana ve Hyperliquid botları çalıştırıldı." : shouldStart ? "Tüm ağ botları çalıştırıldı." : "Tüm ağ botları durduruldu." });
      await refresh({ silent: true });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Toplu işlem başarısız." });
    } finally {
      setBusyKey(null);
    }
  };

  const activeLabel = navigation.find((item) => item.id === view)?.label ?? "Genel Bakış";
  const controllableChains = data?.mode === "shadow"
    ? data.chains.filter((chain) => isShadowTestIntegration(chain.id))
    : data?.mode === "live" ? data.chains.filter((chain) => isLivePilotIntegration(chain.id)) : data?.chains ?? [];
  const allRunning = controllableChains.length > 0 && controllableChains.every((chain) => chain.status === "running");

  return (
    <div
      className="app-shell"
      data-ui-language={language}
      data-translation-ready={language === "tr" ? "true" : "false"}
    >
      <aside className={`sidebar ${mobileMenu ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><Image src="/neraxon-symbol-v2.png" alt="" width={34} height={34} priority /></div>
          <div><strong>NERAXON</strong><span>Çoklu piyasa çalışma alanı</span></div>
          <button className="icon-button mobile-close" onClick={() => setMobileMenu(false)} title="Menüyü kapat"><X size={18} /></button>
        </div>
        <nav className="nav-list" aria-label="Ana menü">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={`nav-item ${view === item.id ? "active" : ""}`} onClick={() => navigate(item.id)}>
                <Icon size={18} /><span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="language-switch" role="group" aria-label="Dil seçimi">
            <button type="button" className={language === "tr" ? "active" : ""} aria-pressed={language === "tr"} onClick={() => void changeLanguage("tr")}>TR</button>
            <button type="button" className={language === "en" ? "active" : ""} aria-pressed={language === "en"} onClick={() => void changeLanguage("en")}>ENG</button>
          </div>
          <button className="mode-panel mode-live" type="button" onClick={() => navigate("integrations")}>
            <div className="mode-row"><span className="pulse-dot" /><strong>Canlı mod</strong><Settings2 size={14} /></div>
            <p>Gerçek fonlarla işlem yapılıyor</p>
          </button>
          <div className="local-state"><ShieldCheck size={15} /><span>Şifreli kasa koruması</span></div>
        </div>
      </aside>

      {mobileMenu && <button className="backdrop" onClick={() => setMobileMenu(false)} aria-label="Menüyü kapat" />}

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-title">
            <button className="icon-button menu-button" onClick={() => setMobileMenu(true)} title="Menüyü aç"><Menu size={20} /></button>
            <div><span>Çalışma alanı</span><h1 key={view}>{activeLabel}</h1></div>
          </div>
          <div className="topbar-actions">
            {view === "overview" && <span className="refresh-countdown" title="Otomatik yenilemeye kalan süre">{secondsUntilRefresh}s</span>}
            <button className="icon-button refresh-button" disabled={loading} onClick={() => void refresh({ refreshMarkets: view === "overview" || view === "my-wallets" || view === "wallets" || view === "trades" })} title="Bu sayfanın verilerini yenile"><RefreshCw size={17} className={loading ? "spin" : ""} /></button>
            <button key={allRunning ? "all-running" : "all-stopped"} className={`primary-control ${allRunning ? "stop" : ""}`} disabled={!data || busyKey !== null} onClick={() => void controlAll()}>
              {busyKey === "all" ? <RefreshCw size={16} className="spin" /> : allRunning ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
              {allRunning ? "Tümünü durdur" : "Tümünü çalıştır"}
            </button>
          </div>
        </header>

        <div className={`content-area ${loading ? "is-loading" : "is-ready"}`} key={view}>
          {!data && loading ? <DashboardSkeleton /> : data && (
            <>
              {view === "overview" && <Overview data={data} busyKey={busyKey} onControl={controlChain} onNavigate={navigate} />}
              {view === "my-wallets" && <MyWalletsView data={data} />}
              {view === "wallets" && <WalletsView data={data} onChanged={() => refresh({ silent: true })} onNotice={setNotice} />}
              {view === "discovery" && <DiscoveryView wallets={data.wallets} onChanged={() => refresh({ silent: true })} onNotice={setNotice} />}
              {view === "social" && <SocialSignalsView language={data.language} onNotice={setNotice} />}
              {view === "trades" && <TradesView data={data} onChanged={() => refresh({ silent: true })} onNotice={setNotice} />}
              {view === "analytics" && <AnalyticsView data={data} />}
              {view === "consensus" && <ConsensusView data={data} />}
              {view === "backtest" && <BacktestView />}
              {view === "system" && <SystemView data={data} onChanged={() => refresh({ silent: true })} onNotice={setNotice} />}
              {view === "risk" && <RiskView data={data} onChanged={() => refresh({ silent: true })} onNotice={setNotice} />}
              {view === "rpc" && <RpcSettingsView data={data} />}
              {view === "integrations" && <IntegrationSettingsView chainsRunning={hasRunningChain} onNotice={setNotice} />}
            </>
          )}
        </div>
      </main>

      {notice && <div className={`toast ${notice.type}`}><span>{notice.message}</span><button onClick={() => setNotice(null)} title="Bildirimi kapat"><X size={15} /></button></div>}
    </div>
  );
}

function Overview({ data, busyKey, onControl, onNavigate }: {
  data: DashboardSnapshot;
  busyKey: string | null;
  onControl: (chainId: ChainId, action: "start" | "stop") => Promise<void>;
  onNavigate: (view: View) => void;
}) {
  const netPnlUsd = data.equityUsd - data.startingBalanceUsd;
  const scopedChains = data.mode === "shadow"
    ? data.chains.filter((chain) => isShadowTestIntegration(chain.id))
    : data.mode === "live" ? data.chains.filter((chain) => isLivePilotIntegration(chain.id)) : data.chains;
  const runningCount = scopedChains.filter((chain) => chain.status === "running").length;
  const overviewPositions = data.mode === "paper" ? data.positions : executionEvmPositions(data);
  const overviewHypercorePositions = data.mode === "paper" ? data.hypercorePositions : executionHypercorePositions(data);
  const overviewLots = data.mode === "paper" ? data.positionLots : [];
  const openPositionCount = overviewPositions.length + overviewHypercorePositions.length;
  const networkOrder: readonly ChainId[] = data.mode === "live" ? LIVE_PILOT_INTEGRATION_IDS : SHADOW_TEST_INTEGRATION_IDS;
  const networkMetrics = (data.mode === "live" ? data.livePortfolio : data.mode === "shadow" ? data.shadowPortfolio : [])
    .filter((account) => data.mode === "live" ? isLivePilotIntegration(account.integrationId) : isShadowTestIntegration(account.integrationId))
    .sort((left, right) => networkOrder.indexOf(left.integrationId) - networkOrder.indexOf(right.integrationId));
  const portfolioPending = data.mode === "live" && !data.livePortfolioComplete;
  return (
    <div className="view-stack">
      {portfolioPending ? <PortfolioMetricSkeleton /> : <section className="metric-grid" aria-label="Portföy özeti">
        <Metric
          label="Toplam portföy"
          value={overviewUsd(data.equityUsd)}
          meta={`${signedOverviewUsd(netPnlUsd)} toplam · ${signedOverviewUsd(data.dailyPnlUsd)} bugün`}
          icon={CircleDollarSign}
          tone={netPnlUsd >= 0 ? "positive" : "negative"}
          networks={networkMetrics.map((account) => ({
            chainId: account.integrationId,
            value: overviewUsd(account.equityUsd),
            change: signedOverviewUsd(account.equityUsd - account.startingEquityUsd),
          }))}
        />
        <Metric
          label="Likit bakiye"
          value={overviewUsd(data.cashBalanceUsd)}
          meta={`%${percentOf(data.cashBalanceUsd, data.equityUsd)} portföy`}
          icon={WalletCards}
          networks={networkMetrics.map((account) => ({
            chainId: account.integrationId,
            value: overviewUsd(account.cashBalanceUsd),
          }))}
        />
        <Metric
          label="Net PnL"
          value={signedOverviewUsd(netPnlUsd)}
          meta={`${signedOverviewUsd(data.realizedPnlUsd)} gerçekleşmiş · ${signedOverviewUsd(data.unrealizedPnlUsd)} gerçekleşmemiş`}
          icon={CircleDollarSign}
          tone={netPnlUsd >= 0 ? "positive" : "negative"}
          networks={networkMetrics.map((account) => ({
            chainId: account.integrationId,
            value: signedOverviewUsd(account.equityUsd - account.startingEquityUsd),
          }))}
        />
        <Metric
          label="Gerçekleşmemiş PnL"
          value={signedOverviewUsd(data.unrealizedPnlUsd)}
          meta={`${openPositionCount} açık pozisyon · giriş maliyetleri sonrası`}
          icon={data.unrealizedPnlUsd >= 0 ? TrendingUp : TrendingDown}
          tone={data.unrealizedPnlUsd >= 0 ? "positive" : "negative"}
          networks={networkMetrics.map((account) => ({
            chainId: account.integrationId,
            value: signedOverviewUsd(account.unrealizedPnlUsd),
          }))}
        />
        <Metric
          label="Toplam maliyet"
          value={preciseUsd(data.totalFeesUsd)}
          meta="Doğrulanmış ücretler · PnL içinde, tekrar düşülmez"
          icon={Gauge}
          tone="warning"
          networks={networkMetrics.map((account) => ({
            chainId: account.integrationId,
            value: preciseUsd(account.totalCostsUsd),
            change: `${preciseUsd(account.networkCostsUsd)} ağ · ${preciseUsd(account.dexCostsUsd)} DEX`,
          }))}
        />
      </section>}

      <section className="section-block">
        <div className="section-heading"><div><span className="eyebrow">Canlı altyapı</span><h2>Ağ botları</h2></div><span className="section-meta">{runningCount}/{scopedChains.length} çalışıyor</span></div>
        <div className="chain-grid">
          {data.chains.map((chain) => <ChainCard key={chain.id} chain={chain} busy={busyKey === chain.id} onControl={onControl} testDisabled={(data.mode === "shadow" && !isShadowTestIntegration(chain.id)) || (data.mode === "live" && !isLivePilotIntegration(chain.id))} />)}
        </div>
      </section>

      <div className="overview-grid">
        <section className="section-block positions-preview">
          <div className="section-heading"><div><span className="eyebrow">Portföy</span><h2>Açık pozisyonlar</h2></div><button className="text-button" onClick={() => onNavigate("trades")}>Tümünü gör <ChevronRight size={15} /></button></div>
          {openPositionCount ? <><PositionList positions={overviewPositions.slice(0, 4)} lots={overviewLots} usdFormatter={overviewUsd} /><HypercorePositionList positions={overviewHypercorePositions.slice(0, Math.max(0, 4 - overviewPositions.length))} usdFormatter={overviewUsd} /></> : <EmptyState icon={CircleDollarSign} title="Henüz açık pozisyon yok" body={`${data.mode} modunda ilk işlem açıldığında burada görünecek.`} />}
        </section>
        <section className="section-block activity-preview">
          <div className="section-heading"><div><span className="eyebrow">Audit akışı</span><h2>Son hareketler</h2></div><span className="live-label"><span /> Gerçek zamanlı</span></div>
          <EventList events={data.events.slice(0, 6)} />
        </section>
      </div>
    </div>
  );
}

function MyWalletsView({ data }: { data: DashboardSnapshot }) {
  if (data.mode === "live" && !data.livePortfolioComplete) {
    return <div className="view-stack"><PageIntroSkeleton /><PortfolioMetricSkeleton count={4} /><DashboardPanelSkeleton /></div>;
  }
  const portfolio = data.mode === "live" ? data.livePortfolio : data.shadowPortfolio;
  const totalEquityUsd = portfolio.reduce((sum, account) => sum + account.equityUsd, 0);
  const totalCashUsd = portfolio.reduce((sum, account) => sum + account.cashBalanceUsd, 0);
  const totalPositionUsd = portfolio.reduce((sum, account) => sum + account.positionValueUsd, 0);
  const totalReservedUsd = portfolio.reduce((sum, account) => sum + account.reservedBalanceUsd, 0);
  return <div className="view-stack">
    <section className="page-intro"><div><span className="eyebrow">Zincir üstü hesaplar</span><h2>My Wallets</h2><p>Gerçek ağ bakiyeleri, açık pozisyonlar, iade edilebilir rezervler ve işlem maliyetleri ayrı gösterilir.</p></div></section>
    <section className="metric-grid wallet-summary-grid" aria-label="Cüzdan özeti">
      <Metric label="Toplam değer" value={overviewUsd(totalEquityUsd)} meta="Likit + pozisyon + rezerv" icon={CircleDollarSign} />
      <Metric label="Likit bakiye" value={overviewUsd(totalCashUsd)} meta="Ağ harcama tokenleri" icon={WalletCards} />
      <Metric label="Açık pozisyonlar" value={overviewUsd(totalPositionUsd)} meta={`${portfolio.reduce((sum, account) => sum + account.openPositionCount, 0)} açık pozisyon`} icon={TrendingUp} />
      <Metric label="İade edilebilir rezerv" value={overviewUsd(totalReservedUsd)} meta="Token hesabı kapatıldığında geri alınabilir" icon={ShieldCheck} />
    </section>
    <MyWallets data={data} />
  </div>;
}

function MyWallets({ data }: { data: DashboardSnapshot }) {
  const portfolio = data.mode === "live" ? data.livePortfolio : data.shadowPortfolio;
  const integrationIds = data.mode === "live" ? LIVE_PILOT_INTEGRATION_IDS : SHADOW_TEST_INTEGRATION_IDS;
  const accounts = integrationIds.map((chainId) => {
    const account = portfolio.find((item) => item.integrationId === chainId);
    const address = chainId === "solana" ? data.executionAccounts.solana : chainId === "hyperliquid" ? data.executionAccounts.hyperliquid : data.executionAccounts.evm;
    const lots = data.executionLots.filter((lot) => lot.mode === data.mode && lot.integrationId === chainId && lot.status === "open");
    const assetGroups = new Map<string, typeof lots>();
    for (const lot of lots) {
      const key = `${lot.assetKey}:${lot.positionSide ?? ""}`;
      assetGroups.set(key, [...(assetGroups.get(key) ?? []), lot]);
    }
    const assets = [...assetGroups.values()].map((group) => {
      const quantity = group.reduce((sum, lot) => sum + executionDisplayQuantity(lot), 0);
      const costUsd = group.reduce((sum, lot) => sum + executionRemainingCost(lot), 0);
      const valueUsd = group.reduce((sum, lot) => sum + executionLotCurrentValue(lot), 0);
      return {
        key: `${chainId}:${group[0].assetKey}:${group[0].positionSide ?? ""}`,
        symbol: group[0].assetSymbol || group[0].assetKey.split(":").at(-1) || "Token",
        market: group[0].marketType,
        side: group[0].positionSide,
        quantity,
        valueUsd,
        pnlUsd: valueUsd - costUsd,
      };
    });
    const accountedAssetValueUsd = assets.reduce((sum, asset) => sum + asset.valueUsd, 0);
    const otherPositionValueUsd = Math.max(0, (account?.positionValueUsd ?? 0) - accountedAssetValueUsd);
    return { chainId, account, address, assets, otherPositionValueUsd };
  });
  const totalEquity = accounts.reduce((sum, item) => sum + (item.account?.equityUsd ?? 0), 0);

  return <section className="section-block my-wallets-section">
    <div className="section-heading"><div><span className="eyebrow">{data.mode === "live" ? "Canlı hesaplar" : "Shadow hesapları"}</span><h2>My Wallets</h2></div><span className="section-meta">{overviewUsd(totalEquity)} toplam</span></div>
    <div className="my-wallet-grid">
      {accounts.map(({ chainId, account, address, assets, otherPositionValueUsd }) => <article className="my-wallet-card" key={chainId}>
        <header>
          <span className={`chain-logo ${chainId}`}>{INTEGRATION_CATALOG[chainId].shortName}</span>
          <div><strong>{integrationName(chainId)}</strong><code title={address ?? "Sanal shadow cüzdanı"}>{address ? `${address.slice(0, 8)}…${address.slice(-6)}` : "Sanal shadow cüzdanı"}</code></div>
          <i>{data.mode === "live" ? "LIVE" : "TEST"}</i>
        </header>
        <div className="my-wallet-balance">
          <div><span>Toplam değer</span><strong>{overviewUsd(account?.equityUsd ?? 0)}</strong></div>
          <div><span>Likit bakiye</span><strong>{overviewUsd(account?.cashBalanceUsd ?? 0)}</strong></div>
          <div><span>Pozisyon değeri</span><strong>{overviewUsd(account?.positionValueUsd ?? 0)}</strong></div>
          <div><span>İade edilebilir rezerv</span><strong>{overviewUsd(account?.reservedBalanceUsd ?? 0)}</strong></div>
          <div><span>Net PnL</span><strong className={(account?.equityUsd ?? 0) - (account?.startingEquityUsd ?? 0) >= 0 ? "positive" : "negative"}>{signedOverviewUsd((account?.equityUsd ?? 0) - (account?.startingEquityUsd ?? 0))}</strong></div>
          <div><span>İşlem PnL</span><strong className={(account?.executionRealizedPnlUsd ?? 0) >= 0 ? "positive" : "negative"}>{signedOverviewUsd(account?.executionRealizedPnlUsd ?? 0)}</strong></div>
          <div><span>Gerçekleşmemiş PnL</span><strong className={(account?.unrealizedPnlUsd ?? 0) >= 0 ? "positive" : "negative"}>{signedOverviewUsd(account?.unrealizedPnlUsd ?? 0)}</strong></div>
          <div><span>Bakiye/funding farkı</span><strong className={(account?.fundingTokenPnlUsd ?? 0) >= 0 ? "positive" : "negative"}>{signedOverviewUsd(account?.fundingTokenPnlUsd ?? 0)}</strong></div>
          <div><span>Bugünkü değişim</span><strong className={(account?.equityUsd ?? 0) >= (account?.dailyStartEquityUsd ?? 0) ? "positive" : "negative"}>{signedOverviewUsd((account?.equityUsd ?? 0) - (account?.dailyStartEquityUsd ?? 0))}</strong></div>
        </div>
        {account && <div className="my-wallet-costs"><span>Ağ ücreti <strong>{preciseUsd(account.networkCostsUsd)}</strong></span><span>DEX ücreti <strong>{preciseUsd(account.dexCostsUsd)}</strong></span><span>Toplam maliyet <strong>{preciseUsd(account.totalCostsUsd)}</strong></span></div>}
        <div className="my-wallet-assets">
          <div className="my-wallet-assets-heading"><span>Varlıklar</span><small>{assets.length + (account ? 1 : 0) + (account?.reservedBalanceUsd ? 1 : 0) + (otherPositionValueUsd > 0.005 ? 1 : 0)} token/pozisyon</small></div>
          {account ? <div className="my-wallet-asset funding-token">
            <div><strong>{account.fundingTokenSymbol}</strong><small>Ağ harcama tokeni</small></div>
            <span><small>Miktar</small>{formatTokenQuantity(account.fundingTokenAmount)}</span>
            <span><small>Değer</small>{overviewUsd(account.cashBalanceUsd)}</span>
            <span className={account.fundingTokenPnlUsd >= 0 ? "positive" : "negative"}><small>PnL</small>{signedOverviewUsd(account.fundingTokenPnlUsd)}</span>
          </div> : null}
          {account && account.reservedBalanceUsd > 0 ? <div className="my-wallet-asset reserved-token">
            <div><strong>{account.fundingTokenSymbol} rezervi</strong><small>İade edilebilir hesap kirası</small></div>
            <span><small>Miktar</small>{formatTokenQuantity(account.reservedBalanceUsd / account.fundingTokenPriceUsd)}</span>
            <span><small>Değer</small>{overviewUsd(account.reservedBalanceUsd)}</span>
            <span><small>Durum</small>Fee değildir</span>
          </div> : null}
          {assets.map((asset) => <div className="my-wallet-asset" key={asset.key}>
            <div><strong>{asset.symbol}</strong><small>{asset.market.toUpperCase()}{asset.side ? ` · ${asset.side.toUpperCase()}` : ""}</small></div>
            <span><small>Miktar</small>{formatTokenQuantity(asset.quantity)}</span>
            <span><small>Değer</small>{overviewUsd(asset.valueUsd)}</span>
            <span className={asset.pnlUsd >= 0 ? "positive" : "negative"}><small>PnL</small>{signedOverviewUsd(asset.pnlUsd)}</span>
          </div>)}
          {otherPositionValueUsd > 0.005 ? <div className="my-wallet-asset">
            <div><strong>Diğer varlıklar</strong><small>Zincir veya borsada bağlı değer</small></div>
            <span><small>Miktar</small>—</span>
            <span><small>Değer</small>{overviewUsd(otherPositionValueUsd)}</span>
            <span><small>Kaynak</small>Zincir üstü</span>
          </div> : null}
          {!account && !assets.length ? <p>Henüz token veya açık pozisyon yok.</p> : null}
        </div>
      </article>)}
    </div>
  </section>;
}

function ChainCard({ chain, busy, onControl, testDisabled = false }: { chain: ChainRuntime; busy: boolean; onControl: (id: ChainId, action: "start" | "stop") => Promise<void>; testDisabled?: boolean }) {
  const running = chain.status === "running";
  return (
    <article className="chain-card">
      <div className="chain-top">
        <div className={`chain-logo ${chain.id}`}>{INTEGRATION_CATALOG[chain.id].shortName}</div>
        <div className="chain-name"><h3>{chain.name}</h3>{testDisabled ? <span className="test-scope-label">Pilot dışı</span> : <StatusBadge status={chain.status} />}</div>
        <button className={`chain-control ${running ? "pause" : "play"}`} disabled={busy || chain.status === "starting" || chain.status === "stopping" || testDisabled} onClick={() => void onControl(chain.id, running ? "stop" : "start")} title={testDisabled ? `${chain.name} mevcut işlem kapsamına dahil değil` : running ? `${chain.name} botunu durdur` : `${chain.name} botunu çalıştır`}>
          {busy ? <RefreshCw size={17} className="spin" /> : running ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
        </button>
      </div>
      <div className="chain-stats">
        <div><span>{chain.kind === "venue" ? "Akış" : chain.kind === "solana" ? "Son slot" : "Son blok"}</span><strong>{chain.kind === "venue" ? "REST + WS" : chain.lastBlock ? chain.lastBlock.toLocaleString(uiLocale()) : "—"}</strong></div>
        <div><span>{chain.kind === "venue" ? "API gecikmesi" : "RPC gecikmesi"}</span><strong>{chain.latencyMs !== null ? `${chain.latencyMs} ms` : "—"}</strong></div>
        <div><span>İzleme</span><strong>{running ? "Aktif" : "Kapalı"}</strong></div>
      </div>
      {chain.errorMessage && <p className="chain-error">{chain.errorMessage}</p>}
    </article>
  );
}

interface WalletNetworkPnl {
  pnlUsd: number;
  investedUsd: number;
}

function WalletsView({ data, onChanged, onNotice }: { data: DashboardSnapshot; onChanged: () => void; onNotice: (value: { type: "success" | "error"; message: string }) => void }) {
  const wallets = data.wallets;
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [chainId, setChainId] = useState<ChainId>("base");
  const [activeChainId, setActiveChainId] = useState<ChainId>("base");
  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [query, setQuery] = useState("");
  const networkWallets = wallets.filter((wallet) => wallet.trackedChainIds.includes(activeChainId));
  const filtered = networkWallets.filter((wallet) => `${wallet.label} ${wallet.address} ${wallet.trackedChainIds.map(integrationName).join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  const walletById = new Map(wallets.map((wallet) => [wallet.id, wallet]));
  const networkCopyLots = data.executionLots.filter((lot) =>
    lot.mode === data.mode
    && lot.integrationId === activeChainId
    && lot.source === "copy"
    && lot.walletId,
  );
  const networkPnlByWallet = new Map<string, WalletNetworkPnl>();
  for (const lot of networkCopyLots) {
    if (!lot.walletId) continue;
    const current = networkPnlByWallet.get(lot.walletId) ?? { pnlUsd: 0, investedUsd: 0 };
    current.pnlUsd += executionLotNetPnl(lot);
    current.investedUsd += lot.entryCostUsd;
    networkPnlByWallet.set(lot.walletId, current);
  }
  const copyPnlUsd = networkCopyLots.reduce((sum, lot) => sum + executionLotNetPnl(lot), 0);
  const activeCopyPnlUsd = networkCopyLots.reduce((sum, lot) => {
    const wallet = lot.walletId ? walletById.get(lot.walletId) : null;
    return wallet?.state === "paused" ? sum : sum + executionLotNetPnl(lot);
  }, 0);
  const pausedCopyPnlUsd = copyPnlUsd - activeCopyPnlUsd;
  const portfolio = data.mode === "live" ? data.livePortfolio : data.mode === "shadow" ? data.shadowPortfolio : [];
  const networkAccount = portfolio.find((account) => account.integrationId === activeChainId);
  const accountDifferenceUsd = networkAccount ? networkAccount.realizedPnlUsd - copyPnlUsd : null;
  const pnlText = (value: number) => Math.abs(value) < 0.0005 ? overviewUsd(0) : signedOverviewUsd(value);
  const pnlTone = (value: number) => Math.abs(value) < 0.0005 ? "" : value > 0 ? "positive-text" : "negative-text";

  const openForm = () => {
    setChainId(activeChainId);
    setFormOpen(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const response = await fetch("/api/wallets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, label, chainId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Cüzdan eklenemedi.");
      setAddress(""); setLabel(""); setActiveChainId(chainId); setFormOpen(false); onChanged();
      onNotice({ type: "success", message: "Cüzdan gözlem listesine eklendi." });
    } catch (error) { onNotice({ type: "error", message: error instanceof Error ? error.message : "Cüzdan eklenemedi." }); }
    finally { setSubmitting(false); }
  };

  return <>
    <div className="view-stack">
      <section className="page-intro"><div><span className="eyebrow">Takip merkezi</span><h2>Cüzdanlar</h2><p>Her cüzdan yalnızca seçtiğin ağlardaki işlemleri için izlenir; skor gözlenen davranışlarla güncellenir.</p></div><button type="button" className="wallet-add-button" onClick={openForm}><UserPlus size={16} /> Yeni cüzdan</button></section>
      <section className="wallet-network-filter">
        <div className="discovery-chain-tabs wallet-chain-tabs" role="tablist" aria-label="Cüzdan ağı">
          {INTEGRATION_IDS.map((id) => {
            const count = wallets.filter((wallet) => wallet.trackedChainIds.includes(id)).length;
            return <button type="button" role="tab" aria-selected={activeChainId === id} className={activeChainId === id ? "selected" : ""} key={id} onClick={() => setActiveChainId(id)}><span className={`chain-logo ${id}`}>{INTEGRATION_CATALOG[id].shortName}</span><span><strong>{integrationName(id)}</strong><small>{count} cüzdan</small></span></button>;
          })}
        </div>
      </section>
      {data.mode !== "paper" && <section className="wallet-pnl-panel" aria-label={`${integrationName(activeChainId)} PnL özeti`}>
        <header>
          <div className="wallet-pnl-title">
            <span className={`chain-logo ${activeChainId}`}>{INTEGRATION_CATALOG[activeChainId].shortName}</span>
            <div><strong>PnL mutabakatı</strong><small>{integrationName(activeChainId)} copy işlemleri ve gerçek hesap sonucu</small></div>
          </div>
          <div className="wallet-pnl-difference">
            <span>Hesap düzeyi fark</span>
            <strong className={accountDifferenceUsd === null ? "" : pnlTone(accountDifferenceUsd)}>{accountDifferenceUsd === null ? "—" : pnlText(accountDifferenceUsd)}</strong>
            <small>Sertifikasyon, manuel işlem ve artık varlıklar</small>
          </div>
        </header>
        <div className="wallet-pnl-metrics">
          <div><span>Aktif cüzdanlar</span><strong className={pnlTone(activeCopyPnlUsd)}>{pnlText(activeCopyPnlUsd)}</strong><small>Takibi açık cüzdanların copy sonucu</small></div>
          <div><span>Duraklatılmış cüzdanlar</span><strong className={pnlTone(pausedCopyPnlUsd)}>{pnlText(pausedCopyPnlUsd)}</strong><small>Geçmiş copy işlemleri korunur</small></div>
          <div><span>Toplam copy PnL</span><strong className={pnlTone(copyPnlUsd)}>{pnlText(copyPnlUsd)}</strong><small>Tüm kaynak cüzdanların net sonucu</small></div>
          <div><span>Gerçek hesap PnL</span><strong className={networkAccount ? pnlTone(networkAccount.realizedPnlUsd) : ""}>{networkAccount ? pnlText(networkAccount.realizedPnlUsd) : "—"}</strong><small>İlk canlı özsermayeye göre</small></div>
        </div>
      </section>}
      <section className="wallet-layout">
        <div className="table-panel wallet-table-panel">
          <div className="table-toolbar"><div key={activeChainId}><h3>{integrationName(activeChainId)} cüzdanları</h3><span>{networkWallets.length} cüzdan</span></div><label className="search-box"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ara" /></label></div>
          {filtered.length ? <WalletTable wallets={filtered} pnlByWallet={networkPnlByWallet} onChanged={onChanged} onNotice={onNotice} /> : <EmptyState icon={WalletCards} title={networkWallets.length ? "Sonuç bulunamadı" : `${integrationName(activeChainId)} takip listesi boş`} body={networkWallets.length ? "Arama ifadesini değiştirerek tekrar dene." : "Bu ağ için yeni bir cüzdan ekleyebilir veya keşif listesinden seçim yapabilirsin."} />}
        </div>
      </section>
    </div>
    {formOpen && <Modal title="Yeni cüzdan" subtitle={`${integrationName(chainId)} ağında izlemeye ekle`} onClose={() => { if (!submitting) setFormOpen(false); }}>
      <form className="form-panel wallet-create-form" onSubmit={submit}>
        <label><span>Etiket</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Örn. Base swing 01" maxLength={40} autoFocus /></label>
        <label><span>Cüzdan adresi</span><input value={address} onChange={(event) => setAddress(event.target.value)} placeholder={chainId === "solana" ? "Solana public key" : "0x…"} className="mono" required /></label>
        <label><span>Takip ağı</span><select value={chainId} onChange={(event) => setChainId(event.target.value as ChainId)}>{INTEGRATION_IDS.map((id) => <option value={id} key={id}>{integrationName(id)}</option>)}</select></label>
        <button className="submit-button" disabled={submitting}>{submitting ? <RefreshCw size={16} className="spin" /> : <Plus size={16} />} Gözleme ekle</button>
        <p className="form-note"><ShieldCheck size={14} /> Yeni cüzdanlar 50 başlangıç skoruyla gözlem moduna alınır.</p>
      </form>
    </Modal>}
  </>;
}

function DiscoveryView({ wallets, onChanged, onNotice }: { wallets: TrackedWallet[]; onChanged: () => void; onNotice: (value: { type: "success" | "error"; message: string }) => void }) {
  const [chainId, setChainId] = useState<ChainId | null>(null);
  const [scans, setScans] = useState<Partial<Record<ChainId, WalletDiscoveryScan>>>({});
  const [scanning, setScanning] = useState<ChainId | null>(null);
  const [addingAddress, setAddingAddress] = useState<string | null>(null);
  const [selectedTokens, setSelectedTokens] = useState<Partial<Record<ChainId, string | null>>>({});
  const [sortBy, setSortBy] = useState<DiscoverySort>("score");
  const chainName = chainId ? integrationName(chainId) : null;
  const scan = chainId ? scans[chainId] : undefined;
  const visibleScan = scan && Array.isArray(scan.topGainers) ? scan : undefined;
  const selectedTokenAddress = chainId ? selectedTokens[chainId] ?? null : null;
  const selectedToken = visibleScan?.topGainers.find((token) => token.address === selectedTokenAddress);
  const rankedCandidates: Array<{ candidate: WalletDiscoveryCandidate; performance: DiscoveryTokenPerformance | null }> = (visibleScan?.candidates ?? [])
    .map((candidate) => ({
      candidate,
      performance: selectedTokenAddress
        ? candidate.gainerTokens.find((token) => token.address === selectedTokenAddress) ?? null
        : null,
    }))
    .filter(({ candidate, performance }) => !selectedTokenAddress || Boolean(performance && (chainId === "hyperliquid"
      ? Math.max(performance.boughtUsd, performance.soldUsd) >= MIN_DISCOVERY_BOUGHT_USD && candidate.estimatedPnlUsd >= MIN_DISCOVERY_PNL_USD
      : performance.boughtUsd >= MIN_DISCOVERY_BOUGHT_USD && performance.estimatedPnlUsd >= MIN_DISCOVERY_PNL_USD)))
    .sort((left, right) => {
      const leftPnl = left.performance?.estimatedPnlUsd ?? left.candidate.estimatedPnlUsd;
      const rightPnl = right.performance?.estimatedPnlUsd ?? right.candidate.estimatedPnlUsd;
      if (sortBy === "score") return right.candidate.score - left.candidate.score || rightPnl - leftPnl;
      if (sortBy === "swaps") {
        const swapDifference = (right.performance?.swapCount ?? right.candidate.swapCount) - (left.performance?.swapCount ?? left.candidate.swapCount);
        return swapDifference || right.candidate.score - left.candidate.score || rightPnl - leftPnl;
      }
      if (sortBy === "bought") return (right.performance?.boughtUsd ?? right.candidate.boughtUsd) - (left.performance?.boughtUsd ?? left.candidate.boughtUsd);
      if (sortBy === "sold") return (right.performance?.soldUsd ?? right.candidate.soldUsd) - (left.performance?.soldUsd ?? left.candidate.soldUsd);
      return rightPnl - leftPnl;
    });
  const trackedAddresses = new Set(chainId
    ? wallets.filter((wallet) => wallet.trackedChainIds.includes(chainId)).map((wallet) => normalizeAddress(chainId, wallet.address))
    : []);

  const runScan = async () => {
    if (!chainId) return;
    const scanChainId = chainId;
    setScanning(scanChainId);
    try {
      const response = await fetch("/api/discovery/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chainId: scanChainId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Cüzdan keşfi tamamlanamadı.");
      const nextScan = result.scan as WalletDiscoveryScan;
      setScans((current) => ({ ...current, [scanChainId]: nextScan }));
      setSelectedTokens((current) => ({ ...current, [scanChainId]: null }));
      onNotice({ type: "success", message: `${integrationName(scanChainId)} cüzdan keşfi tamamlandı.` });
    } catch (error) {
      onNotice({ type: "error", message: error instanceof Error ? error.message : "Cüzdan keşfi tamamlanamadı." });
    } finally {
      setScanning(null);
    }
  };

  const addCandidate = async (candidate: WalletDiscoveryCandidate) => {
    setAddingAddress(candidate.address);
    try {
      const response = await fetch("/api/wallets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address: candidate.address,
          discoveryScore: {
            score: candidate.score,
            breakdown: candidate.scoreBreakdown,
          },
          observedSwapCount24h: candidate.swapCount,
          discoverySnapshot: {
            chainId: candidate.chainId,
            boughtUsd: candidate.boughtUsd,
            soldUsd: candidate.soldUsd,
            currentValueUsd: candidate.currentValueUsd,
            estimatedPnlUsd: candidate.estimatedPnlUsd,
            estimatedPnlPercent: candidate.estimatedPnlPercent,
            swapCount: candidate.swapCount,
            buyCount: candidate.buyCount,
            sellCount: candidate.sellCount,
            uniqueTokenCount: candidate.uniqueTokenCount,
            tokens: candidate.gainerTokens.map((token) => ({
              address: token.address,
              symbol: token.symbol,
              pairAddress: token.pairAddress,
              boughtUsd: token.boughtUsd,
              soldUsd: token.soldUsd,
              currentValueUsd: token.currentValueUsd,
              estimatedPnlUsd: token.estimatedPnlUsd,
              swapCount: token.swapCount,
              buyCount: token.buyCount,
              sellCount: token.sellCount,
            })),
          },
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Cüzdan takip listesine eklenemedi.");
      await onChanged();
      onNotice({ type: "success", message: "Keşfedilen cüzdan aktif izleme ve copy trade havuzuna eklendi." });
    } catch (error) {
      onNotice({ type: "error", message: error instanceof Error ? error.message : "Cüzdan takip listesine eklenemedi." });
    } finally {
      setAddingAddress(null);
    }
  };

  return (
    <div className="view-stack">
      <section className="page-intro"><div><span className="eyebrow">Akıllı cüzdan havuzu</span><h2>Cüzdan Keşfi</h2><p>EVM ve Solana on-chain akışlarını, HyperCore günlük sıralamasını aynı sermaye ve davranış filtresiyle analiz eder.</p></div></section>
      <section className="discovery-controls">
        <div className="discovery-chain-tabs" role="tablist" aria-label="Keşif ağı">
          {INTEGRATION_IDS.map((id) => <button type="button" role="tab" aria-selected={chainId === id} className={chainId === id ? "selected" : ""} key={id} onClick={() => { setChainId(id); setSelectedTokens((current) => ({ ...current, [id]: null })); }} title={`${integrationName(id)} ağındaki tüm token cüzdanlarını göster`}><span className={`chain-logo ${id}`}>{INTEGRATION_CATALOG[id].shortName}</span><span><strong>{integrationName(id)}</strong><small>{scans[id] ? `${scans[id]?.candidates.length} aday` : "Taranmadı"}</small></span></button>)}
        </div>
        <button key={chainId ?? "unselected"} className="discovery-run" type="button" disabled={!chainId || scanning !== null} onClick={() => void runScan()}>{chainId && scanning === chainId ? <RefreshCw size={17} className="spin" /> : <Radar size={17} />} {!chainName ? "Bir ağ seç" : scanning === chainId ? "24 saat taranıyor" : `${chainName} taramasını çalıştır`}</button>
      </section>
      {chainId ? <div className="discovery-network-content" key={chainId}>{visibleScan ? <>
        <div className="scan-summary"><span><strong>{rankedCandidates.length}</strong> uygun cüzdan</span><span><strong>{usd(MIN_DISCOVERY_BOUGHT_USD)}–{usd(MAX_DISCOVERY_BOUGHT_USD)}</strong> sermaye filtresi</span><span><strong>{usd(chainId === "solana" ? MIN_SOLANA_DISCOVERY_PNL_USD : MIN_DISCOVERY_PNL_USD)}+</strong> net kâr filtresi</span><span><strong>2–50</strong> swap filtresi</span><span><strong>{visibleScan.topGainers.length}</strong> yükselen piyasa</span><span><strong>{visibleScan.transferSampleSize}</strong> {chainId === "hyperliquid" ? "fill" : chainId === "solana" && visibleScan.pnlDataSource === "birdeye+helius+dexscreener" ? "top trader örneği" : "token transferi"}</span>{visibleScan.diagnostics && <span><strong>{visibleScan.diagnostics.pnlValidatedWallets}</strong> PnL doğrulaması</span>}<span>Kaynak: <strong>{visibleScan.pnlDataSource === "hyperliquid-leaderboard" ? "Hyperliquid Leaderboard + Info API" : visibleScan.pnlDataSource === "birdeye+helius+dexscreener" ? "Birdeye + Helius + DexScreener" : visibleScan.pnlDataSource === "helius+dexscreener" ? "Helius + DexScreener" : visibleScan.pnlDataSource === "dexscreener+geckoterminal+rpc" ? "DexScreener + GeckoTerminal + RPC" : visibleScan.pnlDataSource === "dexscreener+public-rpc" ? "DexScreener + Public RPC" : visibleScan.pnlDataSource === "dexscreener+rpc" ? "DexScreener + Robinhood RPC" : "DexScreener + Alchemy"}</strong></span><span>Güncellendi: <strong>{relativeTime(visibleScan.generatedAt)}</strong></span></div>
        {visibleScan.diagnostics?.status === "partial" && <div className="scan-partial-warning" role="status">Tarama kısmi tamamlandı: {visibleScan.diagnostics.pnlValidatedWallets}/{visibleScan.diagnostics.attemptedWallets ?? 0} cüzdanın PnL verisi doğrulandı. Eksik sonuç önbelleğe alınmadı; sonraki tarama yalnızca süresi dolan veya başarısız verileri yeniden isteyecek.</div>}
        <div className="gainer-strip" role="group" aria-label="24 saatlik örneklemde yükselen piyasalar">{visibleScan.topGainers.map((token, index) => <div className={`gainer-card ${token.address === selectedTokenAddress ? "selected" : ""}`} key={token.address}><button type="button" className="gainer-filter" aria-pressed={token.address === selectedTokenAddress} onClick={() => setSelectedTokens((current) => ({ ...current, [chainId]: current[chainId] === token.address ? null : token.address }))}><span>#{index + 1}</span><strong>{token.symbol}</strong><b>+%{token.priceChange24hPercent.toFixed(1)}</b><small>{wholeUsd(token.volume24hUsd)} hacim · {wholeUsd(token.liquidityUsd)} {chainId === "hyperliquid" ? "açık pozisyon" : "likidite"}</small></button><a className="gainer-dex-link" href={integrationMarketUrl(chainId, token.pairAddress)} target="_blank" rel="noreferrer" title={`${token.symbol} piyasa sayfasını aç`} aria-label={`${token.symbol} piyasa sayfasını aç`}><ExternalLink size={13} /></a></div>)}</div>
        <section className="discovery-results">
          <div className="section-heading"><div><span className="eyebrow">Günlük sıralama</span><h2>{selectedToken ? `${selectedToken.symbol} tokenındaki aday cüzdanlar` : "Yükselen piyasalardaki aday cüzdanlar"}</h2></div><div className="discovery-heading-actions">{selectedToken && <button type="button" className="text-button" onClick={() => setSelectedTokens((current) => ({ ...current, [chainId]: null }))}>Tüm cüzdanları göster</button>}<label className="sort-control"><span>Sırala</span><select value={sortBy} onChange={(event) => setSortBy(event.target.value as DiscoverySort)}><option value="score">Skor: yüksekten düşüğe</option><option value="swaps">24s swap: yüksekten düşüğe</option><option value="pnl">Net PnL: yüksekten düşüğe</option><option value="bought">Alım: yüksekten düşüğe</option><option value="sold">Satış: yüksekten düşüğe</option></select></label></div></div>
          {rankedCandidates.length ? <div className="candidate-list">{rankedCandidates.map(({ candidate, performance }, index) => {
            const tracked = trackedAddresses.has(normalizeAddress(chainId, candidate.address));
            const boughtUsd = performance?.boughtUsd ?? candidate.boughtUsd;
            const soldUsd = performance?.soldUsd ?? candidate.soldUsd;
            const currentValueUsd = performance?.currentValueUsd ?? candidate.currentValueUsd;
            const estimatedPnlUsd = performance?.estimatedPnlUsd ?? candidate.estimatedPnlUsd;
            const gasCostUsd = performance?.gasCostUsd ?? candidate.gasCostUsd;
            const pnlPercent = chainId === "hyperliquid" ? candidate.estimatedPnlPercent : boughtUsd > 0 ? estimatedPnlUsd / boughtUsd * 100 : 0;
            const tokenLabel = performance?.symbol ?? candidate.gainerTokens.map((token) => token.symbol).join(", ");
            return <article className="candidate-row" key={candidate.address}>
              <div className="candidate-rank">{index + 1}</div>
              <div className="candidate-wallet"><strong>{shortAddress(candidate.address)}</strong><code>{candidate.address}</code><span>{tokenLabel} · {performance?.swapCount ?? candidate.swapCount} swap · {relativeTime(candidate.lastActiveAt)} aktif</span>{candidate.qualityValidation && <span>{candidate.qualityValidation.dataSource === "birdeye" ? "Birdeye 7g" : candidate.qualityValidation.dataSource === "helius-provisional" ? "Güncel sinyal · gözlem gerekli" : "Helius 7g doğrulama"} · {candidate.qualityValidation.uniqueTokenCount} token · {candidate.qualityValidation.completedRoundTrips} kapanış · %{candidate.qualityValidation.winRatePercent.toFixed(0)} kazanma{candidate.qualityValidation.unrealizedPnlUsd !== undefined ? ` · realized ${signedUsd(candidate.qualityValidation.realizedPnlUsd)} · unrealized ${signedUsd(candidate.qualityValidation.unrealizedPnlUsd)} · toplam ${signedUsd(candidate.qualityValidation.totalPnlUsd ?? candidate.estimatedPnlUsd)} · ort. alım ${usd(candidate.qualityValidation.averageBuyUsd ?? 0)}` : ""}</span>}</div>
              <div className="candidate-score"><strong>{candidate.score}</strong><span>Keşif skoru</span></div>
              <div className="candidate-metrics financial"><div><strong>{usd(boughtUsd)}</strong><span>Toplam alım</span></div><div><strong>{usd(soldUsd)}</strong><span>Toplam satış</span></div><div><strong>{usd(currentValueUsd)}</strong><span>{chainId === "hyperliquid" ? "Hesap değeri" : "Elde kalan değer"}</span></div><div><strong className={estimatedPnlUsd >= 0 ? "positive-text" : "negative-text"}>{signedUsd(estimatedPnlUsd)}</strong><span>Net PnL · %{pnlPercent.toFixed(1)} · Gas {usd(gasCostUsd)}</span></div></div>
              <div className="candidate-bars"><DiscoveryBar label="Kârlılık" value={candidate.scoreBreakdown.profitability} /><DiscoveryBar label="Aktivite" value={candidate.scoreBreakdown.activity} /><DiscoveryBar label="Çeşitlilik" value={candidate.scoreBreakdown.diversity} /><DiscoveryBar label="Güncellik" value={candidate.scoreBreakdown.freshness} /></div>
              <div className="candidate-actions">{(chainId === "hyperliquid" || candidate.sampleTxHashes[0]) && <a href={chainId === "hyperliquid" ? integrationExplorerUrl(chainId, candidate.address, "address") : explorerUrl(chainId, candidate.sampleTxHashes[0])} target="_blank" rel="noreferrer" title={chainId === "hyperliquid" ? "Cüzdanı Hyperliquid Explorer'da aç" : "Örnek işlemi explorer'da aç"}><ExternalLink size={15} /></a>}<button type="button" disabled={tracked || addingAddress === candidate.address} onClick={() => void addCandidate(candidate)}>{addingAddress === candidate.address ? <RefreshCw size={15} className="spin" /> : tracked ? <CheckCircle2 size={15} /> : <UserPlus size={15} />}{tracked ? "Takipte" : "Takibe ekle"}</button></div>
            </article>;
          })}</div> : <EmptyState icon={Radar} title={selectedToken ? "Bu token için uygun cüzdan bulunamadı" : "Yükselen piyasalarda uygun cüzdan bulunamadı"} body={`Son 24 saatte 100–20.000 USD sermaye, ölçülü işlem sayısı, doğrulanmış alım-satım geçmişi ve gas sonrası en az 100 USD net kâr şartlarını sağlayan cüzdan yok.`} />}
        </section>
      </> : <EmptyState icon={Radar} title={`${chainName} keşfi hazır`} body={chainId === "hyperliquid" ? "Leaderboard ve son 24 saatlik fill geçmişini analiz etmek için taramayı çalıştır." : "Son 24 saatlik transfer örneklemini analiz etmek için ağ taramasını çalıştır."} />}</div> : <EmptyState icon={Radar} title="Bir ağ seç" body="Cüzdan keşfini başlatmak için yukarıdaki ağlardan birini seç." />}
    </div>
  );
}

function DiscoveryBar({ label, value }: { label: string; value: number }) {
  return <div><span>{label}</span><i><b style={{ width: `${value}%` }} /></i><strong>{value}</strong></div>;
}

function TradesView({ data, onChanged, onNotice }: { data: DashboardSnapshot; onChanged: () => void; onNotice: (value: { type: "success" | "error"; message: string }) => void }) {
  const [selectedChainId, setSelectedChainId] = useState<ChainId | null>(null);
  const [tradeSelection, setTradeSelection] = useState<{ position: Position; version: number } | null>(null);
  const [closeAllConfirm, setCloseAllConfirm] = useState(false);
  const [closingAll, setClosingAll] = useState(false);
  const selectPosition = (position: Position) => {
    setTradeSelection((current) => ({ position, version: (current?.version ?? 0) + 1 }));
  };
  const evmPositions = data.mode === "paper" ? data.positions : executionEvmPositions(data);
  const hypercorePositions = data.mode === "paper" ? data.hypercorePositions : executionHypercorePositions(data);
  const selectedPositions = selectedChainId && selectedChainId !== "hyperliquid" ? evmPositions.filter((position) => position.chainId === selectedChainId) : [];
  const selectedTrades = selectedChainId && selectedChainId !== "hyperliquid" ? data.trades.filter((trade) => trade.chainId === selectedChainId) : [];
  const selectedAttempts = selectedChainId ? data.executionAttempts.filter((attempt) => attempt.mode === data.mode && attempt.integrationId === selectedChainId) : [];
  const selectedLots = selectedChainId && selectedChainId !== "hyperliquid" ? data.positionLots.filter((lot) => lot.chainId === selectedChainId) : [];
  const selectedNetworkName = selectedChainId ? integrationName(selectedChainId) : null;
  const activePositionCount = evmPositions.length + hypercorePositions.length;
  const totalTradeCount = data.mode === "paper"
    ? data.trades.length + data.hypercoreTrades.length
    : data.executionAttempts.filter((attempt) => attempt.mode === data.mode).length;
  const selectNetwork = (chainId: ChainId) => {
    setSelectedChainId(chainId);
    setTradeSelection(null);
  };
  const closeAll = async () => {
    if (!closeAllConfirm) {
      setCloseAllConfirm(true);
      return;
    }
    setClosingAll(true);
    try {
      const response = await fetch("/api/trades/close-all", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Açık pozisyonlar kapatılamadı.");
      setCloseAllConfirm(false);
      onChanged();
      onNotice({
        type: result.failedCount ? "error" : "success",
        message: `${result.closedCount} pozisyon kapatıldı${result.failedCount ? `, ${result.failedCount} pozisyon kapatılamadı` : ""}.`,
      });
    } catch (error) {
      onNotice({ type: "error", message: error instanceof Error ? error.message : "Açık pozisyonlar kapatılamadı." });
    } finally {
      setClosingAll(false);
    }
  };
  return (
    <div className="view-stack">
      <section className="page-intro"><div><span className="eyebrow">{data.mode === "paper" ? "Paper işlem masası" : data.mode === "shadow" ? "Shadow doğrulama masası" : "Canlı işlem masası"}</span><h2>İşlemler</h2><p>{data.mode === "paper" ? "Emir önizlemesi risk motorundan geçer; simüle edilen bütün maliyetler işlem kaydına işlenir." : data.mode === "shadow" ? "Emir gerçek bakiye ve piyasa koşullarıyla hazırlanır, simüle edilir fakat imzalanmaz." : "Emirler gerçek bakiye oranıyla hazırlanır, imzalanır ve zincir onayı beklenir."}</p></div><div className="trade-page-actions"><span className="paper-badge"><span /> {data.mode === "paper" ? `Paper bakiye ${usd(data.cashBalanceUsd)}` : data.mode === "shadow" ? "Shadow · imza kapalı" : "LIVE · gerçek fon"}</span><button type="button" className={`close-all-button ${closeAllConfirm ? "confirm" : ""}`} disabled={closingAll || activePositionCount === 0 || data.mode === "live"} onClick={() => void closeAll()} onBlur={() => { if (!closingAll) setCloseAllConfirm(false); }} title={data.mode === "live" ? "Canlı pozisyonlar güvenlik gereği ayrı ayrı kapatılır" : `${activePositionCount} açık pozisyonun tamamını kapat`}>{closingAll ? <RefreshCw size={14} className="spin" /> : closeAllConfirm ? <AlertTriangle size={14} /> : <OctagonX size={14} />}{closeAllConfirm ? "Kapatmayı onayla" : `Tümünü kapat · ${activePositionCount}`}</button></div></section>
      <section className="trade-network-filter">
        <div className="discovery-chain-tabs trade-chain-tabs" role="tablist" aria-label="İşlem ağı">
          <button type="button" role="tab" aria-selected={selectedChainId === null} className={selectedChainId === null ? "selected" : ""} onClick={() => { setSelectedChainId(null); setTradeSelection(null); }}>
            <span className="chain-logo all"><Layers3 size={14} /></span>
            <span><strong>Tümü</strong><small>{totalTradeCount} işlem kaydı</small></span>
          </button>
          {INTEGRATION_IDS.map((chainId) => {
            const positionCount = chainId === "hyperliquid" ? hypercorePositions.length : evmPositions.filter((position) => position.chainId === chainId).length;
            return <button type="button" role="tab" aria-selected={selectedChainId === chainId} className={selectedChainId === chainId ? "selected" : ""} key={chainId} onClick={() => selectNetwork(chainId)}><span className={`chain-logo ${chainId}`}>{INTEGRATION_CATALOG[chainId].shortName}</span><span><strong>{integrationName(chainId)}</strong><small>{positionCount} açık pozisyon</small></span></button>;
          })}
        </div>
      </section>
      {selectedChainId && selectedNetworkName ? <div className="trade-network-content" key={selectedChainId}>{selectedChainId === "hyperliquid" ? <>
        <section className="trade-layout">
          <HypercoreManualTradeForm mode={data.mode} positions={hypercorePositions} limits={data.riskSettings.networkExecutionLimits!.hyperliquid} onChanged={onChanged} onNotice={onNotice} />
          <div className="section-block"><div className="section-heading"><div><span className="eyebrow">HyperCore</span><h2>Açık spot ve perp pozisyonları</h2></div></div>{hypercorePositions.length ? <HypercorePositionList positions={hypercorePositions} /> : <EmptyState icon={CircleDollarSign} title="HyperCore pozisyonu yok" body={`Manuel emir veya takip edilen cüzdan fill'i burada bir ${data.mode} pozisyon açar.`} />}</div>
        </section>
        <section className="table-panel"><div className="table-toolbar"><div><h3>HyperCore işlem geçmişi</h3><span>{data.mode === "paper" ? data.hypercoreTrades.length : selectedAttempts.length} kayıt</span></div></div>{data.mode === "paper" ? data.hypercoreTrades.length ? <HypercoreTradeTable trades={data.hypercoreTrades} /> : <EmptyState icon={Activity} title="Henüz HyperCore işlemi yok" body="Spot ve perpetual paper fill'leri burada ayrıntılı görünür." /> : selectedAttempts.length ? <ExecutionAttemptTable attempts={selectedAttempts} /> : <EmptyState icon={Activity} title={`Henüz HyperCore ${data.mode} işlemi yok`} body="İlk emir simülasyonu burada quote ve maliyet ayrıntılarıyla görünür." />}</section>
      </> : <>
        <section className="trade-layout">
          <ManualTradeForm key={`${selectedChainId}:${tradeSelection?.version ?? 0}`} lockedChainId={selectedChainId} mode={data.mode} positions={selectedPositions} initialPosition={tradeSelection?.position ?? null} riskSettings={data.riskSettings} onChanged={onChanged} onNotice={onNotice} />
          <div className="section-block"><div className="section-heading"><div><span className="eyebrow">{selectedNetworkName}</span><h2>Açık pozisyonlar</h2></div></div>{selectedPositions.length ? <GroupedPositionList positions={selectedPositions} lots={data.mode === "paper" ? selectedLots : []} onSelect={selectPosition} /> : <EmptyState icon={CircleDollarSign} title={`${selectedNetworkName} pozisyonu yok`} body={`${data.mode} alım yaptığında pozisyon burada görünecek.`} />}</div>
        </section>
        <section className="table-panel"><div className="table-toolbar"><div><h3>{selectedNetworkName} işlem geçmişi</h3><span>{data.mode === "paper" ? selectedTrades.length : selectedAttempts.length} kayıt</span></div></div>{data.mode === "paper" ? selectedTrades.length ? <TradeTable trades={selectedTrades} /> : <EmptyState icon={Activity} title={`Henüz ${selectedNetworkName} işlemi yok`} body="İlk işlemin bütün maliyetleriyle burada listelenecek." /> : selectedAttempts.length ? <ExecutionAttemptTable attempts={selectedAttempts} /> : <EmptyState icon={Activity} title={`Henüz ${selectedNetworkName} ${data.mode} işlemi yok`} body="İlk emir simülasyonu burada quote ve maliyet ayrıntılarıyla görünür." />}</section>
      </>}</div> : <div className="trade-network-content" key="all">
        {activePositionCount > 0 && <div className="section-block"><div className="section-heading"><div><span className="eyebrow">Tüm ağlar</span><h2>Açık pozisyonlar</h2></div><span>{activePositionCount} açık pozisyon</span></div><div className="all-network-positions">{evmPositions.length > 0 && <GroupedPositionList positions={evmPositions} lots={data.mode === "paper" ? data.positionLots : []} onSelect={(position) => { selectNetwork(position.chainId); selectPosition(position); }} />}{hypercorePositions.length > 0 && <section className="position-group"><header><div><span aria-hidden="true" className="position-group-mark hyperliquid" /><strong>Hyperliquid</strong></div><span>{hypercorePositions.length} açık pozisyon</span></header><HypercorePositionList positions={hypercorePositions} /></section>}</div></div>}
        {data.mode === "paper" ? <><section className="table-panel"><div className="table-toolbar"><div><h3>EVM ve Solana işlem geçmişi</h3><span>{data.trades.length} kayıt</span></div></div>{data.trades.length ? <TradeTable trades={data.trades} /> : <EmptyState icon={Activity} title="Henüz EVM veya Solana işlemi yok" body="İlk işlemin bütün maliyetleriyle burada listelenecek." />}</section>
        <section className="table-panel"><div className="table-toolbar"><div><h3>HyperCore işlem geçmişi</h3><span>{data.hypercoreTrades.length} kayıt</span></div></div>{data.hypercoreTrades.length ? <HypercoreTradeTable trades={data.hypercoreTrades} /> : <EmptyState icon={Activity} title="Henüz HyperCore işlemi yok" body="Spot ve perpetual paper fill'leri burada ayrıntılı görünür." />}</section></> : <section className="table-panel"><div className="table-toolbar"><div><h3>{data.mode === "shadow" ? "Shadow gerçekleşebilirlik kayıtları" : "Canlı execution kayıtları"}</h3><span>{totalTradeCount} kayıt</span></div></div>{totalTradeCount ? <ExecutionAttemptTable attempts={data.executionAttempts.filter((attempt) => attempt.mode === data.mode)} /> : <EmptyState icon={Activity} title={`Henüz ${data.mode} işlemi yok`} body="İlk emir bütün quote, maliyet ve simülasyon ayrıntılarıyla burada listelenecek." />}</section>}
      </div>}
    </div>
  );
}

function executionEvmPositions(data: DashboardSnapshot): Position[] {
  const groups = new Map<string, DashboardSnapshot["executionLots"]>();
  for (const lot of data.executionLots.filter((item) => item.mode === data.mode && (item.marketType === "evm" || item.marketType === "solana") && item.status === "open")) {
    const key = `${lot.integrationId}:${lot.assetKey}`;
    groups.set(key, [...(groups.get(key) ?? []), lot]);
  }
  return [...groups.entries()].map(([key, lots]) => {
    const quantity = lots.reduce((sum, lot) => sum + executionDisplayQuantity(lot), 0);
    const investedUsd = lots.reduce((sum, lot) => sum + executionRemainingCost(lot), 0);
    const positionValueUsd = lots.reduce((sum, lot) => sum + executionDisplayQuantity(lot) * lot.currentPriceUsd, 0);
    const walletLabels = [...new Set(lots.map((lot) => data.wallets.find((wallet) => wallet.id === lot.walletId)?.label).filter((label): label is string => Boolean(label)))];
    const openedAt = lots.reduce((earliest, lot) => lot.openedAt < earliest ? lot.openedAt : earliest, lots[0].openedAt);
    return {
    id: `execution:${key}`, chainId: lots[0].integrationId, tokenAddress: lots[0].assetKey,
    tokenSymbol: lots[0].assetSymbol || `${lots[0].assetKey.slice(0, 6)}…${lots[0].assetKey.slice(-4)}`, pairAddress: null,
    sourceWalletId: lots.length === 1 ? lots[0].walletId : null,
    sourceWalletLabel: walletLabels.join(", ") || null,
    sourceWalletLabels: walletLabels,
    openedAt,
    quantity, averageEntryUsd: quantity > 0 ? investedUsd / quantity : 0,
    currentPriceUsd: quantity > 0 ? positionValueUsd / quantity : 0, investedUsd,
    unrealizedPnlUsd: positionValueUsd - investedUsd,
    updatedAt: lots.reduce((latest, lot) => lot.updatedAt > latest ? lot.updatedAt : latest, lots[0].updatedAt),
  };
  });
}

function executionHypercorePositions(data: DashboardSnapshot): HypercorePaperPosition[] {
  const groups = new Map<string, DashboardSnapshot["executionLots"]>();
  for (const lot of data.executionLots.filter((item) => item.mode === data.mode && item.integrationId === "hyperliquid" && item.status === "open")) {
    const key = `${lot.assetKey}:${lot.positionSide}`;
    groups.set(key, [...(groups.get(key) ?? []), lot]);
  }
  return [...groups.entries()].map(([key, lots]) => {
    const quantity = lots.reduce((sum, lot) => sum + Number(lot.amount), 0);
    const marginUsd = lots.reduce((sum, lot) => sum + executionRemainingCost(lot), 0);
    const entryPriceUsd = quantity > 0 ? lots.reduce((sum, lot) => sum + lot.entryPriceUsd * Number(lot.amount), 0) / quantity : 0;
    const currentPriceUsd = lots[0].currentPriceUsd;
    const direction = lots[0].positionSide === "short" ? -1 : 1;
    const walletLabels = [...new Set(lots.map((lot) => data.wallets.find((wallet) => wallet.id === lot.walletId)?.label).filter((label): label is string => Boolean(label)))];
    const openedAt = lots.reduce((earliest, lot) => lot.openedAt < earliest ? lot.openedAt : earliest, lots[0].openedAt);
    return {
    id: `execution:${key}`, walletId: lots.length === 1 ? lots[0].walletId : null, walletLabel: walletLabels.join(", ") || null,
    coin: lots[0].assetKey.split(":").slice(1).join(":").toUpperCase(), marketType: lots[0].marketType === "perp" ? "perp" : "spot",
    side: lots[0].positionSide ?? "long", quantity, entryPriceUsd, currentPriceUsd,
    marginUsd, leverage: lots[0].leverage, liquidationPriceUsd: null,
    unrealizedPnlUsd: direction * (currentPriceUsd - entryPriceUsd) * quantity,
    fundingUsd: 0, openedAt, updatedAt: lots.reduce((latest, lot) => lot.updatedAt > latest ? lot.updatedAt : latest, lots[0].updatedAt),
  };
  });
}

function executionDisplayQuantity(lot: DashboardSnapshot["executionLots"][number]) {
  if (lot.amountFormat === "decimal") return Number(lot.amount);
  const divisor = 10 ** Math.min(18, Math.max(0, lot.assetDecimals));
  return Number(BigInt(lot.amount) / BigInt(divisor)) + Number(BigInt(lot.amount) % BigInt(divisor)) / divisor;
}

function executionRemainingCost(lot: DashboardSnapshot["executionLots"][number]) {
  if (lot.amountFormat === "decimal") {
    const initial = Number(lot.initialAmount);
    return initial > 0 ? lot.entryCostUsd * Number(lot.amount) / initial : 0;
  }
  const initial = BigInt(lot.initialAmount || "0");
  return initial > 0n ? lot.entryCostUsd * Number(BigInt(lot.amount) * 1_000_000n / initial) / 1_000_000 : 0;
}

function executionLotCurrentValue(lot: DashboardSnapshot["executionLots"][number]) {
  const quantity = executionDisplayQuantity(lot);
  if (lot.marketType !== "perp") return quantity * lot.currentPriceUsd;
  const direction = lot.positionSide === "short" ? -1 : 1;
  return executionRemainingCost(lot) + direction * (lot.currentPriceUsd - lot.entryPriceUsd) * quantity;
}

interface HypercoreMarketPreview {
  key: string;
  symbol: string;
  marketType: "spot" | "perp";
  priceUsd: number;
  priceChange24hPercent: number;
  volume24hUsd: number;
  maxLeverage: number;
  fundingRate: number;
  openInterestUsd: number;
}

function HypercoreManualTradeForm({ mode, positions, limits, onChanged, onNotice }: { mode: TradingMode; positions: DashboardSnapshot["hypercorePositions"]; limits: NonNullable<RiskSettings["networkExecutionLimits"]>["hyperliquid"]; onChanged: () => void; onNotice: (value: { type: "success" | "error"; message: string }) => void }) {
  const [markets, setMarkets] = useState<HypercoreMarketPreview[]>([]);
  const [marketType, setMarketType] = useState<"spot" | "perp">("perp");
  const [action, setAction] = useState<"open" | "close">("open");
  const [positionSide, setPositionSide] = useState<"long" | "short">("long");
  const [coin, setCoin] = useState("");
  const [allocationPercent, setAllocationPercent] = useState(limits.minPositionPercent);
  const [closePercent, setClosePercent] = useState(100);
  const [leverage, setLeverage] = useState(limits.maxLeverage);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/hypercore/markets", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error); return result.markets as HypercoreMarketPreview[]; })
      .then((result) => { setMarkets(result); const first = result.find((market) => market.marketType === "perp"); if (first) setCoin(first.key); })
      .catch((error) => { if (!controller.signal.aborted) onNotice({ type: "error", message: error instanceof Error ? error.message : "HyperCore piyasaları alınamadı." }); });
    return () => controller.abort();
  }, [onNotice]);
  const availableMarkets = markets.filter((market) => market.marketType === marketType);
  const closeablePositions = positions.filter((position) => position.marketType === marketType);
  const selectedMarket = markets.find((market) => market.marketType === marketType && market.key === coin);
  const selectedPosition = closeablePositions.find((position) => position.id === coin);
  const changeMarketType = (value: "spot" | "perp") => {
    setMarketType(value);
    setPositionSide("long");
    const next = action === "close"
      ? positions.find((position) => position.marketType === value)
      : markets.find((market) => market.marketType === value);
    setCoin(next ? "side" in next ? next.id : next.key : "");
  };
  const changeAction = (value: "open" | "close") => {
    setAction(value);
    if (value === "close") {
      const next = closeablePositions[0];
      setCoin(next?.id ?? "");
      if (next) setPositionSide(next.side);
    } else {
      const next = availableMarkets[0];
      setCoin(next?.key ?? "");
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true);
    try {
      const requestedCoin = action === "close" ? selectedPosition?.coin : coin;
      if (!requestedCoin) throw new Error("İşlem yapılacak piyasa seçilmedi.");
      const response = await fetch("/api/trades/hypercore/manual", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ coin: requestedCoin, positionId: action === "close" ? selectedPosition?.id : undefined, marketType, positionSide: action === "close" ? selectedPosition?.side : positionSide, action, allocationPercent, closePercent, leverage, requestId: crypto.randomUUID() }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "HyperCore işlemi tamamlanamadı.");
      onChanged(); onNotice({ type: "success", message: `${requestedCoin} HyperCore ${mode === "paper" ? "paper işlemi" : mode === "shadow" ? "shadow simülasyonu" : "canlı işlemi"} tamamlandı.` });
    } catch (error) { onNotice({ type: "error", message: error instanceof Error ? error.message : "HyperCore işlemi tamamlanamadı." }); }
    finally { setSubmitting(false); }
  };
  return <form className="form-panel trade-form" onSubmit={submit}>
    <div className="segmented"><button type="button" className={action === "open" ? "selected buy" : ""} onClick={() => changeAction("open")}><Plus size={16}/> Aç</button><button type="button" className={action === "close" ? "selected sell" : ""} onClick={() => changeAction("close")}><OctagonX size={16}/> Kapat</button></div>
    <label><span>Piyasa türü</span><select value={marketType} onChange={(event) => changeMarketType(event.target.value as "spot" | "perp")}><option value="perp">Perpetual</option><option value="spot">Spot</option></select></label>
    {action === "open" ? <>
      <label><span>Piyasa</span><select value={coin} onChange={(event) => setCoin(event.target.value)} required>{availableMarkets.map((market) => <option key={`${market.marketType}:${market.key}`} value={market.key}>{market.symbol} · {usd(market.priceUsd)} · {signedPercent(market.priceChange24hPercent)}</option>)}</select></label>
      {marketType === "perp" && <div className="segmented compact"><button type="button" className={positionSide === "long" ? "selected buy" : ""} onClick={() => setPositionSide("long")}>Long</button><button type="button" className={positionSide === "short" ? "selected sell" : ""} onClick={() => setPositionSide("short")}>Short</button></div>}
      <label><span>Portföy payı · %{allocationPercent}</span><input type="range" min={limits.minPositionPercent} max={limits.maxPositionPercent} step="0.5" value={allocationPercent} onChange={(event) => setAllocationPercent(Number(event.target.value))}/></label>
      {marketType === "perp" && <label><span>Kaldıraç · {leverage}x</span><input type="range" min="1" max={Math.max(1, Math.min(limits.maxLeverage, selectedMarket?.maxLeverage ?? limits.maxLeverage))} step="1" value={Math.min(leverage, limits.maxLeverage)} onChange={(event) => setLeverage(Number(event.target.value))}/></label>}
      {selectedMarket && <div className="token-checks"><div><span>Mark fiyatı</span><strong>{usd(selectedMarket.priceUsd)}</strong></div><div><span>24s hacim</span><strong>{compactUsd(selectedMarket.volume24hUsd)}</strong></div><div><span>{marketType === "perp" ? "Funding" : "24s değişim"}</span><strong>{marketType === "perp" ? signedPercent(selectedMarket.fundingRate * 100) : signedPercent(selectedMarket.priceChange24hPercent)}</strong></div></div>}
    </> : <>
      <label><span>Kapatılacak pozisyon</span><select value={coin} onChange={(event) => { setCoin(event.target.value); const next = closeablePositions.find((position) => position.id === event.target.value); if (next) setPositionSide(next.side); }} required><option value="" disabled>{closeablePositions.length ? "Pozisyon seç" : "Açık pozisyon yok"}</option>{closeablePositions.map((position) => <option key={position.id} value={position.id}>{position.coin} · {position.marketType} · {position.side} · {position.leverage}x · {position.walletLabel ?? "Manuel"}</option>)}</select></label>
      <label><span>Kapatma oranı · %{closePercent}</span><input type="range" min="1" max="100" step="1" value={closePercent} onChange={(event) => setClosePercent(Number(event.target.value))}/></label>
    </>}
    <button className="submit-button" disabled={submitting || (action === "close" ? !selectedPosition : !selectedMarket)}>{submitting ? <RefreshCw size={16} className="spin"/> : <Activity size={16}/>} {mode === "paper" ? "Paper emri uygula" : mode === "shadow" ? "Emri simüle et" : "Canlı emri gönder"}</button>
  </form>;
}

function ManualTradeForm({ mode, positions, initialPosition, lockedChainId, riskSettings, onChanged, onNotice }: { mode: TradingMode; positions: Position[]; initialPosition: Position | null; lockedChainId: ChainId; riskSettings: RiskSettings; onChanged: () => void; onNotice: (value: { type: "success" | "error"; message: string }) => void }) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [chainId, setChainId] = useState<ChainId>(initialPosition?.chainId ?? lockedChainId);
  const [tokenAddress, setTokenAddress] = useState(initialPosition?.tokenAddress ?? "");
  const [tokenQuote, setTokenQuote] = useState<TokenQuotePreview | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteVersion, setQuoteVersion] = useState(0);
  const limits = riskSettings.networkExecutionLimits![lockedChainId];
  const [allocationPercent, setAllocationPercent] = useState(limits.minPositionPercent);
  const [sellPercent, setSellPercent] = useState(100);
  const [slippagePercent, setSlippagePercent] = useState(Math.min(0.5, limits.maxSlippagePercent));
  const [submitting, setSubmitting] = useState(false);
  const [sellPositionKey, setSellPositionKey] = useState(initialPosition ? positionKey(initialPosition) : "");
  const selectedSellPosition = positions.find((position) => positionKey(position) === sellPositionKey) ?? null;
  const estimatedSellQuantity = selectedSellPosition ? selectedSellPosition.quantity * (sellPercent / 100) : 0;
  const submitDisabled = submitting || (side === "buy"
    ? quoteLoading || !tokenQuote || !tokenQuote.safety.approved
    : !selectedSellPosition);
  const refreshQuote = () => {
    setTokenQuote(null);
    setQuoteError(null);
    setQuoteVersion((value) => value + 1);
  };

  const choosePosition = (position: Position) => {
    setSellPositionKey(positionKey(position));
    setChainId(position.chainId);
    setTokenAddress(position.tokenAddress);
    setTokenQuote(null);
    setQuoteError(null);
  };

  const changeSide = (nextSide: "buy" | "sell") => {
    setSide(nextSide);
    if (nextSide === "sell") {
      const matchingPosition = positions.find((position) => position.chainId === chainId && position.tokenAddress.toLowerCase() === tokenAddress.toLowerCase());
      const nextPosition = matchingPosition ?? selectedSellPosition ?? positions[0];
      if (nextPosition) choosePosition(nextPosition);
    }
  };

  useEffect(() => {
    const validAddressShape = chainId === "solana" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tokenAddress) : /^0x[a-fA-F0-9]{40}$/.test(tokenAddress);
    if (!validAddressShape) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setQuoteLoading(true);
      try {
        const response = await fetch(`/api/tokens/metadata?chainId=${chainId}&address=${encodeURIComponent(tokenAddress)}`, { signal: controller.signal, cache: "no-store" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Token bilgileri alınamadı.");
        setTokenQuote(result.token);
      } catch (error) {
        if (!controller.signal.aborted) setQuoteError(error instanceof Error ? error.message : "Token bilgileri alınamadı.");
      } finally {
        if (!controller.signal.aborted) setQuoteLoading(false);
      }
    }, 450);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [chainId, tokenAddress, quoteVersion]);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true);
    try {
      const response = await fetch("/api/trades/manual", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId, side, tokenAddress, allocationPercent: side === "buy" ? allocationPercent : undefined, sellPercent: side === "sell" ? sellPercent : undefined, slippagePercent, requestId: crypto.randomUUID() }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? result.trade?.reason ?? "İşlem tamamlanamadı.");
      const tokenSymbol = tokenQuote?.symbol ?? selectedSellPosition?.tokenSymbol ?? "Token";
      onChanged(); onNotice({ type: "success", message: `${tokenSymbol} ${mode === "paper" ? "paper" : mode === "shadow" ? "shadow" : "canlı"} ${side === "buy" ? "alımı" : "satışı"} tamamlandı.` });
      setQuoteVersion((value) => value + 1);
    } catch (error) { onChanged(); onNotice({ type: "error", message: error instanceof Error ? error.message : "İşlem tamamlanamadı." }); }
    finally { setSubmitting(false); }
  };

  return (
    <form className="form-panel trade-form" onSubmit={submit}>
      <div className="segmented"><button type="button" className={side === "buy" ? "selected buy" : ""} onClick={() => changeSide("buy")}><ArrowDownLeft size={16} /> Al</button><button type="button" className={side === "sell" ? "selected sell" : ""} onClick={() => changeSide("sell")}><ArrowUpRight size={16} /> Sat</button></div>
      {side === "buy" ? <>
        <label><span>{chainId === "solana" ? "Token mint adresi" : "Token kontratı"}</span><input value={tokenAddress} onChange={(event) => { setTokenAddress(event.target.value.trim()); setTokenQuote(null); setQuoteError(null); setQuoteLoading(false); }} placeholder={chainId === "solana" ? "Solana mint" : "0x…"} className="mono" required /></label>
      </> : <label><span>Satılacak pozisyon</span><select value={selectedSellPosition ? positionKey(selectedSellPosition) : ""} onChange={(event) => { const position = positions.find((item) => positionKey(item) === event.target.value); if (position) choosePosition(position); }} disabled={!positions.length} required><option value="" disabled>{positions.length ? "Pozisyon seç" : "Açık pozisyon yok"}</option>{positions.map((position) => <option key={position.id} value={positionKey(position)}>{position.tokenSymbol} · {position.sourceWalletLabel ?? "Manuel"} · {integrationName(position.chainId)} · {position.quantity.toFixed(4)}</option>)}</select></label>}
      {quoteLoading && <div className="token-loading"><RefreshCw size={16} className="spin" /><span>Kontrat ve piyasa verileri doğrulanıyor…</span></div>}
      {quoteError && <div className="token-quote-error"><AlertTriangle size={16} /><span>{quoteError}{side === "sell" && selectedSellPosition ? " Satış, açık pozisyonun son fiyatıyla gönderilebilir." : ""}</span><button type="button" onClick={refreshQuote} title="Token bilgisini yeniden dene"><RefreshCw size={14} /></button></div>}
      {tokenQuote && <div className="token-quote">
        <div className="token-quote-head"><span className="token-symbol-mark">{tokenQuote.symbol.slice(0, 2).toUpperCase()}</span><div><strong>{tokenQuote.name}</strong><small>{tokenQuote.symbol} · {tokenQuote.decimals} ondalık · {integrationName(chainId)}</small></div><button type="button" onClick={refreshQuote} title="Piyasa verilerini yenile"><RefreshCw size={14} /></button></div>
        <code className="token-contract-line" title={tokenQuote.address}>{shortAddress(tokenQuote.address)}</code>
        <div className="token-quote-grid"><div><span>Güncel fiyat</span><strong>{usd(tokenQuote.market.priceUsd)}</strong></div><div><span>Market değeri</span><strong>{tokenQuote.market.marketCapUsd ? compactUsd(tokenQuote.market.marketCapUsd) : "Veri yok"}</strong></div><div><span>Likidite</span><strong>{compactUsd(tokenQuote.market.liquidityUsd)}</strong></div><div><span>24s hacim</span><strong>{compactUsd(tokenQuote.market.volume24hUsd)}</strong></div><div><span>DEX</span><strong>{tokenQuote.market.dexId}</strong></div><div><span>Tahmini gas</span><strong>{usd(tokenQuote.gas.feeUsd)}</strong></div></div>
        <div className={`token-safety ${tokenQuote.safety.approved ? "approved" : "rejected"}`}>{tokenQuote.safety.approved ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}<span><strong>Güvenlik skoru {tokenQuote.safety.score}/100</strong>{tokenQuote.safety.warnings.length ? tokenQuote.safety.warnings.join(" ") : tokenQuote.safety.reason}</span></div>
        <div className="token-checks">{tokenQuote.safety.checks.map((check) => <div className={check.status} key={check.label}><i/><span><strong>{check.label}</strong><small>{check.detail}</small></span></div>)}</div>
      </div>}
      {side === "buy" ? <label className="range-field"><span><b>Pozisyon oranı</b><strong>%{allocationPercent}</strong></span><input type="range" min={limits.minPositionPercent} max={limits.maxPositionPercent} step="0.5" value={allocationPercent} onChange={(event) => setAllocationPercent(Number(event.target.value))} /></label> : <>
        <label className="range-field sell-range"><span><b>Satış oranı</b><strong>%{sellPercent}</strong></span><input type="range" min="1" max="100" step="1" value={sellPercent} onChange={(event) => setSellPercent(Number(event.target.value))} /></label>
        <div className="sell-presets" aria-label="Hızlı satış oranları">{[25, 50, 75, 100].map((percent) => <button type="button" className={sellPercent === percent ? "selected" : ""} key={percent} onClick={() => setSellPercent(percent)}>%{percent}</button>)}</div>
        <div className={`position-check ${selectedSellPosition ? "found" : ""}`}>{selectedSellPosition ? <><strong>{estimatedSellQuantity.toFixed(6)} {selectedSellPosition.tokenSymbol}</strong><span>Yaklaşık {usd(estimatedSellQuantity * (tokenQuote?.market.priceUsd ?? selectedSellPosition.currentPriceUsd))} değerinde satış emri</span></> : "Satış için açık bir pozisyon seç."}</div>
      </>}
      <label className="range-field"><span><b>Slippage</b><strong>%{slippagePercent}</strong></span><input type="range" min="0.1" max={limits.maxSlippagePercent} step="0.1" value={slippagePercent} onChange={(event) => setSlippagePercent(Number(event.target.value))} /></label>
      <button className={`submit-button ${side === "sell" ? "sell" : ""}`} disabled={submitDisabled}>{submitting ? <RefreshCw size={16} className="spin" /> : side === "buy" ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />} {mode === "paper" ? "Paper" : mode === "shadow" ? "Shadow" : "Canlı"} {side === "buy" ? "alım" : "satış"} yap</button>
    </form>
  );
}

function AnalyticsView({ data }: { data: DashboardSnapshot }) {
  const analytics = data.analytics;
  return <div className="view-stack"><section className="page-intro"><div><span className="eyebrow">Gerçekleşen sonuçlar</span><h2>Performans</h2><p>Ücretler, gerçekleşme gecikmesi ve kapatılan lot sonuçları dahil hesaplanır.</p></div></section><section className="metric-grid"><Metric label="Yürütme başarısı" value={`%${data.executionQuality.successRate.toFixed(1)}`} meta={`${data.executionQuality.successfulExecutions}/${data.executionQuality.executableAttempts} yürütülebilir emir · ${data.executionQuality.filteredBeforeExecution} ön filtre`} icon={Activity} tone={data.executionQuality.successRate >= 90 ? "positive" : "warning"} /><Metric label="Kazanma oranı" value={`%${analytics.winRate.toFixed(1)}`} meta="Kapanan lotlar" icon={TrendingUp} tone={analytics.winRate >= 50 ? "positive" : "warning"} /><Metric label="Profit factor" value={analytics.profitFactor.toFixed(2)} meta="Brüt kâr / brüt zarar" icon={Gauge} /><Metric label="Maksimum düşüş" value={`%${analytics.maxDrawdownPercent.toFixed(2)}`} meta={`Ort. gecikme ${analytics.averageExecutionDelayMs} ms`} icon={TrendingDown} tone="negative" /></section><PerformanceTable title="Token performansı" rows={analytics.byToken} /><PerformanceTable title="Cüzdan performansı" rows={analytics.byWallet} /><PerformanceTable title="Ağ performansı" rows={analytics.byChain} /></div>;
}

function PerformanceTable({ title, rows }: { title: string; rows: DashboardSnapshot["analytics"]["byToken"] }) {
  return <section className="table-panel performance-panel"><div className="table-toolbar"><div><h3>{title}</h3><span>{rows.length} kırılım</span></div></div>{rows.length ? <div className="table-scroll"><table className="performance-table"><colgroup><col className="performance-source"/><col/><col/><col/><col/><col/></colgroup><thead><tr><th>Kaynak</th><th>İşlem</th><th>Kazanma</th><th>Net PnL</th><th>Ücret</th><th>Gecikme</th></tr></thead><tbody>{rows.map((row) => <tr key={row.key}><td><strong title={row.label}>{row.label}</strong></td><td>{row.tradeCount}</td><td>%{row.winRate.toFixed(1)}</td><td className={row.realizedPnlUsd >= 0 ? "positive-text" : "negative-text"}>{signedUsd(row.realizedPnlUsd)}</td><td>{usd(row.feesUsd)}</td><td>{row.averageExecutionDelayMs} ms</td></tr>)}</tbody></table></div> : <EmptyState icon={BarChart3} title="Henüz yeterli veri yok" body="Tamamlanan paper işlemler performans kırılımlarını oluşturacak." />}</section>;
}

interface SocialSignalsPayload {
  settings: TelegramSocialSettings;
  status: TelegramSocialStatus;
  chats: TelegramUserChat[];
  signals: SocialTokenSignal[];
  aiAdvisories: AiTradeAdvisory[];
  aiUsage: { social: number; total: number; totalLimit: number };
}

function dexScreenerChainName(chainId: string) {
  return chainId
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function socialDexScreenerUrl(chainId: string, pairAddress: string) {
  return `https://dexscreener.com/${encodeURIComponent(chainId)}/${encodeURIComponent(pairAddress)}`;
}

function socialAiQueueStatus(
  signal: SocialTokenSignal,
  signals: SocialTokenSignal[],
  settings: TelegramSocialSettings,
  socialUsage: number,
) {
  if (signal.status !== "analyzed") {
    return {
      tone: "muted",
      title: signal.status === "market_unavailable" ? "Piyasa verisi bulunamadı" : "Piyasa çözümlemesi bekleniyor",
      summary: signal.errorMessage ?? "Doğrulanmış fiyat ve havuz bilgisi henüz hazır değil.",
      details: [signal.errorMessage ?? "Token için doğrulanmış fiyat ve havuz bilgisi henüz hazır değil."],
    };
  }
  if (!signal.chainId) {
    return {
      tone: "warning",
      title: "AI işlem ağı desteklenmiyor",
      summary: "Bu token yalnızca piyasa takibinde.",
      details: [
        `${dexScreenerChainName(signal.dexScreenerChainId ?? "bilinmeyen ağ")} piyasası izleniyor ancak bu ağda NERAXON işlem yürütmüyor.`,
        "Token piyasa tablosunda kalır; AI işlem görüşü oluşturulmaz.",
      ],
    };
  }

  const failedFilters: string[] = [];
  const failedFilterNames: string[] = [];
  if (signal.liquidityUsd < 15_000) {
    failedFilterNames.push("likidite");
    failedFilters.push(`Likidite ${usd(signal.liquidityUsd)}; gerekli minimum ${usd(15_000)}.`);
  }
  if (signal.volume24hUsd < 50_000) {
    failedFilterNames.push("24s hacim");
    failedFilters.push(`24 saatlik hacim ${usd(signal.volume24hUsd)}; gerekli minimum ${usd(50_000)}.`);
  }
  if (signal.marketCapUsd === null) {
    failedFilterNames.push("piyasa değeri");
    failedFilters.push("Piyasa değeri doğrulanamadı; gerekli aralık $25.000–$20.000.000.");
  } else if (signal.marketCapUsd < 25_000 || signal.marketCapUsd > 20_000_000) {
    failedFilterNames.push("piyasa değeri");
    failedFilters.push(`Piyasa değeri ${usd(signal.marketCapUsd)}; gerekli aralık $25.000–$20.000.000.`);
  }
  if (signal.priceChange24hPercent < -70 || signal.priceChange24hPercent > 1_000) {
    failedFilterNames.push("fiyat hareketi");
    failedFilters.push(`24 saatlik değişim %${signal.priceChange24hPercent.toFixed(1)}; kabul edilen aralık -%70 ile +%1.000.`);
  }
  if (failedFilters.length) {
    return {
      tone: "warning",
      title: "AI değerlendirmesine gönderilmedi",
      summary: `Uygun olmayan değerler: ${failedFilterNames.join(", ")}.`,
      details: [
        ...failedFilters,
        "Token bu piyasa koşulları nedeniyle Groq'a gönderilmedi; günlük AI kotası kullanılmadı.",
      ],
    };
  }

  const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1_000;
  const tickerMentions = signals.filter((candidate) =>
    candidate.referenceType === "ticker"
    && candidate.ticker?.toLocaleUpperCase("en-US") === signal.tokenSymbol?.toLocaleUpperCase("en-US")
    && Date.parse(candidate.createdAt) >= sixHoursAgo
  ).length;
  if (!tickerMentions) {
    return {
      tone: "muted",
      title: "Eşleşen ticker paylaşımı bekleniyor",
      summary: `Son 6 saatte $${signal.tokenSymbol ?? "TOKEN"} mesajı bulunamadı.`,
      details: [
        `Piyasa verileri uygun fakat son 6 saatte $${signal.tokenSymbol ?? "TOKEN"} ticker mesajı algılanmadı.`,
        "Yalnızca ticker içeren mesajlar AI kuyruğuna alınır; kontrat paylaşımı tek başına Groq kotası tüketmez.",
      ],
    };
  }
  if (socialUsage >= settings.dailyAiLimit) {
    return {
      tone: "warning",
      title: "Günlük sosyal AI limiti doldu",
      summary: `Bugünkü kullanım ${socialUsage}/${settings.dailyAiLimit}.`,
      details: [
        `Bugünkü kullanım ${socialUsage}/${settings.dailyAiLimit}.`,
        "Aday uygun durumda kalır; günlük sayaç yenilendiğinde yeniden değerlendirilebilir.",
      ],
    };
  }

  const minutesUntilBatch = Math.max(1, Math.ceil(
    (15 * 60_000 - (Date.now() % (15 * 60_000))) / 60_000,
  ));
  return {
    tone: "pending",
    title: "AI değerlendirme kuyruğunda",
    summary: `${tickerMentions} ticker paylaşımı · yaklaşık ${minutesUntilBatch} dk kaldı.`,
    details: [
      `Son 6 saatte ${tickerMentions} eşleşen ticker paylaşımı var ve tüm piyasa eşikleri geçildi.`,
      `Toplu çalışma yaklaşık ${minutesUntilBatch} dakika içinde başlar; her turda paylaşım sayısı, likidite ve hacme göre en güçlü bir aday seçilir.`,
    ],
  };
}

function safeResearchUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function researchSourceName(value: string) {
  try {
    const url = new URL(value);
    if (url.hostname === "x.com" || url.hostname.endsWith(".x.com")
      || url.hostname === "twitter.com" || url.hostname.endsWith(".twitter.com")) return "X";
    return "Web";
  } catch {
    return "";
  }
}

function SocialSignalsView({ language, onNotice }: {
  language: AppLanguage;
  onNotice: (value: { type: "success" | "error"; message: string }) => void;
}) {
  const [payload, setPayload] = useState<SocialSignalsPayload | null>(null);
  const [form, setForm] = useState<TelegramSocialSettings>({
    enabled: false,
    selectedChatIds: [],
    dailyAiLimit: 40,
  });
  const [busy, setBusy] = useState<"load" | "save" | "refresh" | null>("load");
  const [sourceQuery, setSourceQuery] = useState("");

  const load = useCallback(async (refreshChats = false) => {
    setBusy(refreshChats ? "refresh" : "load");
    try {
      const response = await fetch(`/api/social-signals${refreshChats ? "?refreshChats=true" : ""}`, {
        cache: "no-store",
      });
      const result = await response.json() as SocialSignalsPayload & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Sosyal sinyaller alınamadı.");
      setPayload(result);
      setForm(result.settings);
    } catch (error) {
      onNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Sosyal sinyaller alınamadı.",
      });
    } finally {
      setBusy(null);
    }
  }, [onNotice]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const toggleChat = (chatId: string) => {
    setForm((current) => ({
      ...current,
      selectedChatIds: current.selectedChatIds.includes(chatId)
        ? current.selectedChatIds.filter((id) => id !== chatId)
        : [...current.selectedChatIds, chatId].slice(0, 20),
    }));
  };

  const save = async () => {
    setBusy("save");
    try {
      const response = await fetch("/api/social-signals", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Sosyal sinyal ayarları kaydedilemedi.");
      await load();
      onNotice({ type: "success", message: "Telegram sosyal sinyal ayarları güncellendi." });
    } catch (error) {
      onNotice({
        type: "error",
        message: error instanceof Error ? error.message : "Sosyal sinyal ayarları kaydedilemedi.",
      });
      setBusy(null);
    }
  };

  if (!payload) {
    return <div className="view-stack"><EmptyState icon={MessageSquareText} title="Telegram bağlantısı hazırlanıyor" body="Grup ve kanal listesi salt okunur oturumdan alınıyor." /></div>;
  }

  const advisoryBySignal = new Map(
    payload.aiAdvisories.map((entry) => [entry.sourceReference.replace(/^social:/, ""), entry]),
  );
  const signalById = new Map(payload.signals.map((signal) => [signal.id, signal]));
  const advisoryByMarket = new Map(payload.aiAdvisories.flatMap((entry) => {
    const sourceSignal = signalById.get(entry.sourceReference.replace(/^social:/, ""));
    return sourceSignal?.chainId && sourceSignal.tokenAddress
      ? [[`${sourceSignal.chainId}:${sourceSignal.tokenAddress.toLocaleLowerCase("en-US")}`, entry] as const]
      : [];
  }));
  const visibleChats = payload.chats.filter((chat) =>
    chat.title.toLocaleLowerCase("tr").includes(sourceQuery.trim().toLocaleLowerCase("tr")),
  );
  return <div className="view-stack social-signals-view">
    <section className="page-intro">
      <div>
        <span className="eyebrow">Salt okunur piyasa keşfi</span>
        <h2>Sosyal Sinyaller</h2>
        <p>Seçili Telegram kaynaklarındaki ticker ve token adreslerini toplar; uygun adayları 15 dakikada bir AI ile değerlendirir.</p>
      </div>
      <span className={`connection-pill ${payload.status.connected ? "connected" : ""}`}>
        <span className="health-dot" />
        {payload.status.connected ? `${payload.status.accountLabel} bağlı` : "Bağlantı yok"}
      </span>
    </section>

    <section className="metric-grid social-metrics">
      <Metric label="Seçili kaynak" value={String(form.selectedChatIds.length)} meta={`${payload.chats.length} kullanılabilir grup/kanal`} icon={MessageSquareText} />
      <Metric label="Bugünkü sosyal AI" value={`${payload.aiUsage.social}/${form.dailyAiLimit}`} meta={`15 dk toplu · toplam ${payload.aiUsage.total}/${payload.aiUsage.totalLimit}`} icon={Gauge} tone={payload.aiUsage.social >= form.dailyAiLimit ? "warning" : "positive"} />
      <Metric label="Algılanan sinyal" value={String(payload.signals.length)} meta={payload.status.lastSignalAt ? `Son sinyal ${relativeTime(payload.status.lastSignalAt)}` : "Henüz sinyal yok"} icon={Radar} />
      <Metric label="Çalışma durumu" value={form.enabled ? "Aktif" : "Kapalı"} meta="Otomatik emir yetkisi yok" icon={ShieldCheck} tone={form.enabled ? "positive" : "warning"} />
    </section>

    <section className="table-panel">
      <div className="table-toolbar"><div><h3>Token sinyalleri</h3><span>Ham mesaj ve gönderen bilgisi saklanmaz</span></div></div>
      {payload.signals.length ? <div className="table-scroll"><table className="social-signal-table">
        <colgroup><col/><col/><col/><col/><col/><col/><col/><col/></colgroup>
        <thead><tr><th>Token</th><th>Kaynak</th><th>Ağ</th><th>Piyasa değerleri</th><th>24s değişim</th><th>AI görüşü</th><th>Durum</th><th /></tr></thead>
        <tbody>{payload.signals.map((signal) => {
          const advisory = advisoryBySignal.get(signal.id)
            ?? (signal.chainId && signal.tokenAddress
              ? advisoryByMarket.get(`${signal.chainId}:${signal.tokenAddress.toLocaleLowerCase("en-US")}`)
              : undefined);
          const advisorySummary = advisory ? (language === "en" ? advisory.summaryEn : advisory.summaryTr) : "";
          const projectPurpose = advisory ? (language === "en" ? advisory.projectPurposeEn : advisory.projectPurposeTr) : "";
          const socialAssessment = advisory ? (language === "en" ? advisory.socialAssessmentEn : advisory.socialAssessmentTr) : "";
          const aiQueueStatus = advisory
            ? null
            : socialAiQueueStatus(signal, payload.signals, payload.settings, payload.aiUsage.social);
          return <tr key={signal.id}>
            <td><strong>{signal.tokenSymbol ?? (signal.ticker ? `$${signal.ticker}` : "Çözümleniyor")}</strong>{signal.tokenAddress && <><br/><code>{shortAddress(signal.tokenAddress)}</code></>}</td>
            <td><strong>{signal.chatTitle}</strong><br/><small>{relativeTime(signal.createdAt)}</small></td>
            <td>{signal.chainId
              ? integrationName(signal.chainId)
              : signal.dexScreenerChainId
                ? <><strong>{dexScreenerChainName(signal.dexScreenerChainId)}</strong><br/><small>Yalnızca piyasa takibi</small></>
                : "Belirsiz"}</td>
            <td>{signal.status === "analyzed" ? <>
              <strong>MC {signal.marketCapUsd === null ? "—" : usd(signal.marketCapUsd)}</strong>
              <br/><small>Likidite {usd(signal.liquidityUsd)} · 24s hacim {usd(signal.volume24hUsd)}</small>
            </> : "—"}</td>
            <td className={signal.priceChange24hPercent >= 0 ? "positive-text" : "negative-text"}>{signal.status === "analyzed" ? `%${signal.priceChange24hPercent.toFixed(1)}` : "—"}</td>
            <td>{advisory ? <div className="social-ai-advisory">
              <strong>{advisory.recommendation === "proceed" ? "Uygun" : advisory.recommendation === "avoid" ? "Kaçın" : "İncele"}</strong>
              <p>{advisorySummary}</p>
              {projectPurpose && <small><b>Projenin amacı</b>{projectPurpose}</small>}
              {socialAssessment && <small><b>X değerlendirmesi</b>{socialAssessment}</small>}
              {advisory.researchSources.length > 0 && <span>{advisory.researchSources.map((source, index) => {
                const safeUrl = safeResearchUrl(source);
                return safeUrl && <a href={safeUrl} target="_blank" rel="noreferrer" title={researchSourceName(safeUrl)} key={safeUrl}><ExternalLink size={11}/>{researchSourceName(safeUrl) || `Kaynak ${index + 1}`}</a>;
              })}</span>}
            </div> : aiQueueStatus && <div className={`social-ai-status ${aiQueueStatus.tone}`}>
              <strong>{aiQueueStatus.title}</strong>
              <p>{aiQueueStatus.summary}</p>
              <details>
                <summary>Detayları göster</summary>
                <div>{aiQueueStatus.details.map((detail) => <small key={detail}>{detail}</small>)}</div>
              </details>
            </div>}</td>
            <td title={signal.errorMessage ?? undefined}>{signal.status === "analyzed" ? "Analiz edildi" : signal.status === "market_unavailable" ? "Piyasa bulunamadı" : signal.status === "failed" ? "Hata" : "Algılandı"}</td>
            <td>{(signal.dexScreenerChainId ?? signal.chainId) && signal.pairAddress && <a className="row-action" href={socialDexScreenerUrl((signal.dexScreenerChainId ?? signal.chainId)!, signal.pairAddress)} target="_blank" rel="noreferrer" title="Piyasayı aç"><ExternalLink size={14}/></a>}</td>
          </tr>;
        })}</tbody>
      </table></div> : <EmptyState icon={Radar} title="Henüz sosyal token sinyali yok" body="İzleme etkinleştiğinde seçili kaynaklardaki yeni kontrat, mint ve piyasa bağlantıları burada görünür." />}
    </section>

    <section className="table-panel social-source-panel">
      <div className="table-toolbar">
        <div><h3>Telegram kaynakları</h3><span>En fazla 20 grup veya kanal</span></div>
        <div className="toolbar-actions">
          <label className="search-box compact-source-search"><Search size={14}/><input value={sourceQuery} onChange={(event) => setSourceQuery(event.target.value)} placeholder="Kaynak ara"/></label>
          <button className="icon-button" type="button" disabled={busy !== null} onClick={() => void load(true)} title="Kaynakları yenile">
            <RefreshCw size={16} className={busy === "refresh" ? "spin" : ""} />
          </button>
          <label className="compact-toggle">
            <input type="checkbox" checked={form.enabled} onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))} />
            <span>İzlemeyi etkinleştir</span>
          </label>
          <label className="social-limit">
            <span>Günlük AI</span>
            <input type="number" min="1" max="100" value={form.dailyAiLimit} onChange={(event) => setForm((current) => ({ ...current, dailyAiLimit: Math.min(100, Math.max(1, Number(event.target.value) || 1)) }))} />
          </label>
          <button className="submit-button compact" type="button" disabled={busy !== null || (form.enabled && !form.selectedChatIds.length)} onClick={() => void save()}>
            {busy === "save" ? <RefreshCw size={15} className="spin" /> : <CheckCircle2 size={15} />} Kaydet
          </button>
        </div>
      </div>
      <div className="social-source-list">
        {visibleChats.map((chat) => <label className={`social-source-row ${form.selectedChatIds.includes(chat.id) ? "selected" : ""}`} key={chat.id}>
          <input type="checkbox" checked={form.selectedChatIds.includes(chat.id)} onChange={() => toggleChat(chat.id)} />
          <span className="source-kind">{chat.kind === "channel" ? "Kanal" : "Grup"}</span>
          <strong>{chat.title}</strong>
          <code>{chat.id}</code>
        </label>)}
        {!visibleChats.length && <div className="social-source-empty">Aramayla eşleşen Telegram kaynağı yok.</div>}
      </div>
      {payload.status.lastError && <p className="inline-error">{payload.status.lastError}</p>}
    </section>
  </div>;
}

function ConsensusView({ data }: { data: DashboardSnapshot }) {
  const recommendationLabel = { proceed: "Uygun", review: "İncele", avoid: "Kaçın" } as const;
  const riskLabel = { low: "Düşük", medium: "Orta", high: "Yüksek" } as const;
  return <div className="view-stack"><section className="page-intro"><div><span className="eyebrow">Çoklu cüzdan sinyali</span><h2>Konsensüs</h2><p>Birinci alımdan sonra yeni aşamalar 3, 7 ve 15 farklı cüzdan sinyalinde açılır.</p></div></section><section className="table-panel"><div className="table-toolbar"><div><h3>AI görüşleri</h3><span>{data.aiAdvisories.length} değerlendirme</span></div></div>{data.aiAdvisories.length ? <div className="table-scroll"><table><thead><tr><th>Varlık</th><th>Ağ</th><th>Yön</th><th>Görüş</th><th>Risk</th><th>Güven</th><th>Özet</th><th>Gecikme</th></tr></thead><tbody>{data.aiAdvisories.map((entry) => { const summary = data.language === "en" ? entry.summaryEn : entry.summaryTr; const riskFlags = data.language === "en" ? entry.riskFlagsEn : entry.riskFlagsTr; return <tr key={entry.id}><td><strong>{entry.asset}</strong><br/><small>{entry.walletLabel ?? "Kaynak cüzdan yok"}</small></td><td>{integrationName(entry.chainId)}</td><td>{entry.side === "buy" ? "Alım" : "Satış"}</td><td className={entry.recommendation === "proceed" ? "positive-text" : entry.recommendation === "avoid" ? "negative-text" : ""}>{recommendationLabel[entry.recommendation]}</td><td>{riskLabel[entry.riskLevel]}</td><td>%{(entry.confidence * 100).toFixed(0)}</td><td title={riskFlags.join(" · ")}>{summary}</td><td>{entry.latencyMs} ms</td></tr>; })}</tbody></table></div> : <EmptyState icon={Layers3} title="Henüz AI görüşü yok" body="Uygun bir copy-trade sinyali değerlendirildiğinde Groq görüşü burada görünür. AI emir akışını değiştirmez." />}</section><section className="table-panel"><div className="table-toolbar"><div><h3>Token sinyalleri</h3><span>{data.consensus.length} token</span></div></div>{data.consensus.length ? <div className="table-scroll"><table><thead><tr><th>Token</th><th>Ağ</th><th>Farklı cüzdan</th><th>Tamamlanan alım</th><th>Sonraki eşik</th><th>Kaynaklar</th><th /></tr></thead><tbody>{data.consensus.map((entry) => <tr key={`${entry.chainId}:${entry.tokenAddress}`}><td><strong>{entry.tokenSymbol}</strong><br/><code>{shortAddress(entry.tokenAddress)}</code></td><td>{integrationName(entry.chainId)}</td><td>{entry.walletCount}</td><td>{entry.copiedStages}</td><td>{entry.nextThreshold ?? "Tamamlandı"}</td><td title={entry.walletLabels.join(", ")}>{entry.walletLabels.slice(0, 3).join(", ")}{entry.walletLabels.length > 3 ? ` +${entry.walletLabels.length - 3}` : ""}</td><td>{entry.pairAddress && <a className="row-action" href={integrationMarketUrl(entry.chainId, entry.pairAddress)} target="_blank" rel="noreferrer" title="Piyasayı aç"><ExternalLink size={14}/></a>}</td></tr>)}</tbody></table></div> : <EmptyState icon={Layers3} title="Konsensüs sinyali yok" body="Takip edilen cüzdanlardan alım sinyali geldikçe tokenlar burada aşama bazında görünür." />}</section></div>;
}

interface BacktestResult { tradeCount: number; endingBalanceUsd: number; netPnlUsd: number; totalFeesUsd: number; winRate: number; maxDrawdownPercent: number }
function BacktestView() {
  const [feeMultiplier, setFeeMultiplier] = useState(1);
  const [slippageMultiplier, setSlippageMultiplier] = useState(1);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [running, setRunning] = useState(false);
  const run = async (event: FormEvent) => { event.preventDefault(); setRunning(true); try { const response = await fetch("/api/backtest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ feeMultiplier, slippageMultiplier, startingBalanceUsd: 100 }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error ?? "Replay çalıştırılamadı."); setResult(payload); } finally { setRunning(false); } };
  return <div className="view-stack"><section className="page-intro"><div><span className="eyebrow">Deterministik senaryo</span><h2>Replay</h2><p>Saklanan işlem akışını farklı ücret ve slippage koşullarıyla yeniden değerlendirir; gerçek fon veya mevcut portföy değişmez.</p></div></section><form className="replay-panel" onSubmit={run}><NumberField label="Ücret çarpanı" value={feeMultiplier} step={0.1} onChange={setFeeMultiplier}/><NumberField label="Slippage çarpanı" value={slippageMultiplier} step={0.1} onChange={setSlippageMultiplier}/><button className="submit-button" disabled={running}>{running ? <RefreshCw size={16} className="spin"/> : <Play size={16}/>} Replay çalıştır</button></form>{result ? <section className="metric-grid"><Metric label="Bitiş bakiyesi" value={usd(result.endingBalanceUsd)} meta={`${result.tradeCount} işlem`} icon={CircleDollarSign} tone={result.netPnlUsd >= 0 ? "positive" : "negative"}/><Metric label="Net sonuç" value={signedUsd(result.netPnlUsd)} meta={`%${result.winRate.toFixed(1)} kazanma`} icon={TrendingUp} tone={result.netPnlUsd >= 0 ? "positive" : "negative"}/><Metric label="Toplam maliyet" value={usd(result.totalFeesUsd)} meta="Ayarlanmış maliyet" icon={Gauge} tone="warning"/><Metric label="Maksimum düşüş" value={`%${result.maxDrawdownPercent.toFixed(2)}`} meta="Replay eğrisi" icon={TrendingDown} tone="negative"/></section> : <EmptyState icon={History} title="Senaryo çalıştırılmadı" body="Çarpanları ayarlayıp saklanan paper işlem geçmişini yeniden oynat." />}</div>;
}

function SystemView({ data, onChanged, onNotice }: { data: DashboardSnapshot; onChanged: () => void; onNotice: (value: { type: "success" | "error"; message: string }) => void }) {
  const statusLabel = { healthy: "Sağlıklı", degraded: "Yavaş / hatalı", down: "Erişilemiyor", idle: "Henüz ölçülmedi" } as const;
  return <div className="view-stack"><section className="page-intro"><div><span className="eyebrow">Bağlantı görünürlüğü</span><h2>Sistem sağlığı</h2><p>Servis çağrıları, son başarılı veri, ardışık hatalar, rate-limit ve yeniden bağlantılar.</p></div></section><div className="health-grid">{data.serviceHealth.map((service) => <article className={`health-item ${service.status}`} key={service.id}><div><span className="health-dot"/><strong>{service.label}</strong><small>{statusLabel[service.status]}</small></div><dl><div><dt>İstek</dt><dd>{service.requestCount}</dd></div><div><dt>Hata</dt><dd>{service.errorCount}</dd></div><div><dt>Ardışık</dt><dd>{service.consecutiveErrors}</dd></div><div><dt>Ort. gecikme</dt><dd>{service.averageLatencyMs} ms</dd></div><div><dt>Son veri</dt><dd>{service.lastSuccessAt ? relativeTime(service.lastSuccessAt) : "—"}</dd></div><div><dt>Yeniden bağlanma</dt><dd>{service.reconnectCount}</dd></div></dl>{service.rateLimitedUntil && <p>Rate-limit beklemesi: {relativeTime(service.rateLimitedUntil)}</p>}{service.lastError && <p>{service.lastError}</p>}</article>)}</div><LiveCertificationPanel data={data} onChanged={onChanged} onNotice={onNotice}/><section className="section-block"><div className="section-heading"><div><span className="eyebrow">Telegram kontrolü</span><h2>Komutlar</h2></div></div><div className="command-list"><code>/status</code><code>/positions</code><code>/pnl</code><code>/pause ethereum|base|robinhood|solana|hyperliquid|all</code><code>/resume ethereum|base|robinhood|solana|hyperliquid|all</code></div></section></div>;
}

interface IntegrationCredential {
  id: string;
  group: string;
  label: string;
  secret: boolean;
  placeholder: string;
  configured: boolean;
  source: "keychain" | "encrypted-file" | "environment" | null;
}

interface IntegrationResponse {
  backend: "keychain" | "encrypted-file";
  telegramUserSessionConfigured: boolean;
  credentials: IntegrationCredential[];
}

type SignerCredential = "evm" | "solana" | "hyperliquid-agent";
const SIGNER_CREDENTIALS: readonly SignerCredential[] = ["evm", "solana", "hyperliquid-agent"];
interface SignerStatus {
  configured: boolean;
  address: string | null;
  backend: "keychain" | "encrypted-file";
}

function IntegrationSettingsView({ chainsRunning, onNotice }: {
  chainsRunning: boolean;
  onNotice: (value: { type: "success" | "error"; message: string }) => void;
}) {
  const [integrationData, setIntegrationData] = useState<IntegrationResponse | null>(null);
  const [signerStatuses, setSignerStatuses] = useState<Record<SignerCredential, SignerStatus | null>>({ evm: null, solana: null, "hyperliquid-agent": null });
  const [values, setValues] = useState<Record<string, string>>({});
  const [signerValues, setSignerValues] = useState<Record<SignerCredential, string>>({ evm: "", solana: "", "hyperliquid-agent": "" });
  const [telegramLogin, setTelegramLogin] = useState({ phoneNumber: "", code: "", password: "", loginId: "", stage: "phone" as "phone" | "code" | "password" | "complete" });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [integrationResponse, ...signerResponses] = await Promise.all([
      fetch("/api/integrations", { cache: "no-store" }),
      ...SIGNER_CREDENTIALS.map((credential) => fetch(`/api/live-wallet?credential=${credential}`, { cache: "no-store" })),
    ]);
    if (!integrationResponse.ok || signerResponses.some((response) => !response.ok)) throw new Error("Entegrasyon durumu alınamadı.");
    setIntegrationData(await integrationResponse.json() as IntegrationResponse);
    const entries = await Promise.all(signerResponses.map(async (response, index) => [SIGNER_CREDENTIALS[index], await response.json() as SignerStatus] as const));
    setSignerStatuses(Object.fromEntries(entries) as Record<SignerCredential, SignerStatus>);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((error) => onNotice({ type: "error", message: error instanceof Error ? error.message : "Entegrasyon durumu alınamadı." }));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, onNotice]);

  const saveCredential = async (id: string) => {
    const value = values[id]?.trim();
    if (!value) return;
    setBusy(id);
    try {
      const response = await fetch("/api/integrations", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, value }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Entegrasyon kaydedilemedi.");
      setIntegrationData(result as IntegrationResponse);
      setValues((current) => ({ ...current, [id]: "" }));
      onNotice({ type: "success", message: "Entegrasyon güvenli kasaya kaydedildi." });
    } catch (error) {
      onNotice({ type: "error", message: error instanceof Error ? error.message : "Entegrasyon kaydedilemedi." });
    } finally {
      setBusy(null);
    }
  };

  const removeCredential = async (id: string) => {
    setBusy(id);
    try {
      const response = await fetch(`/api/integrations?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Entegrasyon kaldırılamadı.");
      setIntegrationData(result as IntegrationResponse);
      onNotice({ type: "success", message: "Entegrasyon kasadan kaldırıldı." });
    } catch (error) {
      onNotice({ type: "error", message: error instanceof Error ? error.message : "Entegrasyon kaldırılamadı." });
    } finally {
      setBusy(null);
    }
  };

  const saveSigner = async (credential: SignerCredential) => {
    setBusy(`signer:${credential}`);
    try {
      const response = await fetch(`/api/live-wallet?credential=${credential}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential, privateKey: signerValues[credential] }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "İmzalama anahtarı kaydedilemedi.");
      setSignerStatuses((current) => ({ ...current, [credential]: result as SignerStatus }));
      setSignerValues((current) => ({ ...current, [credential]: "" }));
      onNotice({ type: "success", message: "İmzalama anahtarı güvenli kasaya kaydedildi." });
    } catch (error) {
      onNotice({ type: "error", message: error instanceof Error ? error.message : "İmzalama anahtarı kaydedilemedi." });
    } finally {
      setBusy(null);
    }
  };

  const removeSigner = async (credential: SignerCredential) => {
    setBusy(`signer:${credential}`);
    try {
      const response = await fetch(`/api/live-wallet?credential=${credential}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "İmzalama anahtarı kaldırılamadı.");
      setSignerStatuses((current) => ({ ...current, [credential]: result as SignerStatus }));
      onNotice({ type: "success", message: "İmzalama anahtarı kasadan kaldırıldı." });
    } catch (error) {
      onNotice({ type: "error", message: error instanceof Error ? error.message : "İmzalama anahtarı kaldırılamadı." });
    } finally {
      setBusy(null);
    }
  };

  const submitTelegramLogin = async () => {
    const stage = telegramLogin.stage;
    setBusy("telegram-login");
    try {
      const body = stage === "phone"
        ? { action: "request-code", phoneNumber: telegramLogin.phoneNumber }
        : stage === "code"
          ? { action: "confirm-code", loginId: telegramLogin.loginId, code: telegramLogin.code }
          : { action: "confirm-password", loginId: telegramLogin.loginId, password: telegramLogin.password };
      const response = await fetch("/api/integrations/telegram-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as { error?: string; loginId?: string; delivery?: string; authenticated?: boolean; requiresPassword?: boolean };
      if (!response.ok) throw new Error(result.error ?? "Telegram oturumu açılamadı.");
      if (stage === "phone") {
        setTelegramLogin((current) => ({ ...current, loginId: result.loginId ?? "", stage: "code" }));
        onNotice({ type: "success", message: result.delivery === "telegram" ? "Doğrulama kodu Telegram uygulamasına gönderildi." : "Doğrulama kodu SMS ile gönderildi." });
      } else if (result.requiresPassword) {
        setTelegramLogin((current) => ({ ...current, stage: "password" }));
      } else if (result.authenticated) {
        setTelegramLogin((current) => ({ ...current, code: "", password: "", stage: "complete" }));
        await load();
        onNotice({ type: "success", message: "Telegram kullanıcı oturumu güvenli kasaya kaydedildi." });
      }
    } catch (error) {
      onNotice({ type: "error", message: error instanceof Error ? error.message : "Telegram oturumu açılamadı." });
    } finally {
      setBusy(null);
    }
  };

  const groups = integrationData
    ? [...new Set(integrationData.credentials.map((credential) => credential.group))]
    : [];
  const signerLabels: Record<SignerCredential, string> = {
    evm: "EVM signer",
    solana: "Solana signer",
    "hyperliquid-agent": "Hyperliquid agent",
  };

  return <div className="view-stack">
    <section className="page-intro"><div><span className="eyebrow">Güvenli bağlantılar</span><h2>Entegrasyonlar</h2><p>Canlı yürütme, veri sağlayıcıları, Telegram ve AI erişim bilgilerini tek noktadan yönetin.</p></div>{integrationData && <span className="vault-backend"><KeyRound size={15} />{integrationData.backend === "keychain" ? "macOS Keychain" : "Şifreli sunucu kasası"}</span>}</section>
    {chainsRunning && <div className="mode-warning"><AlertTriangle size={16} /><span>İmzalama anahtarlarını değiştirmek için önce tüm ağ botlarını durdurun.</span></div>}
    <section className="integration-section">
      <div className="section-heading"><div><span className="eyebrow">Canlı cüzdanlar</span><h2>İmzalama anahtarları</h2></div></div>
      <div className="integration-fields signer-fields">
        {SIGNER_CREDENTIALS.map((credential) => {
          const status = signerStatuses[credential];
          const isBusy = busy === `signer:${credential}`;
          return <div className="integration-field" key={credential}>
            <div className="integration-field-title"><strong>{signerLabels[credential]}</strong><span className={status?.configured ? "configured" : "missing"}>{status?.configured ? "Yapılandırıldı" : "Eksik"}</span></div>
            {status?.configured
              ? <><code>{status.address}</code><button type="button" className="danger-action" disabled={chainsRunning || isBusy} onClick={() => void removeSigner(credential)}><Trash2 size={14} /> Kaldır</button></>
              : <><input type="password" value={signerValues[credential]} onChange={(event) => setSignerValues((current) => ({ ...current, [credential]: event.target.value }))} placeholder={credential === "solana" ? "Base58 veya JSON secret key" : "0x private key"} autoComplete="new-password" spellCheck={false} /><button type="button" disabled={chainsRunning || isBusy || signerValues[credential].trim().length < 32} onClick={() => void saveSigner(credential)}>{isBusy ? <RefreshCw size={14} className="spin" /> : <ShieldCheck size={14} />} Kaydet</button></>}
          </div>;
        })}
      </div>
    </section>
    <section className="integration-section">
      <div className="section-heading"><div><span className="eyebrow">Telegram kullanıcı hesabı</span><h2>Grup mesajı oturumu</h2></div><span className={integrationData?.telegramUserSessionConfigured ? "positive-text" : "warning-text"}>{integrationData?.telegramUserSessionConfigured ? "Bağlı" : "Bağlantı gerekli"}</span></div>
      <div className="telegram-login-flow">
        {telegramLogin.stage === "phone" && <label><span>Telefon numarası</span><input value={telegramLogin.phoneNumber} onChange={(event) => setTelegramLogin((current) => ({ ...current, phoneNumber: event.target.value }))} placeholder="+905..." autoComplete="tel" /></label>}
        {telegramLogin.stage === "code" && <label><span>Doğrulama kodu</span><input value={telegramLogin.code} onChange={(event) => setTelegramLogin((current) => ({ ...current, code: event.target.value }))} placeholder="Telegram kodu" inputMode="numeric" autoComplete="one-time-code" /></label>}
        {telegramLogin.stage === "password" && <label><span>Telegram 2FA parolası</span><input type="password" value={telegramLogin.password} onChange={(event) => setTelegramLogin((current) => ({ ...current, password: event.target.value }))} autoComplete="current-password" /></label>}
        {telegramLogin.stage === "complete" || integrationData?.telegramUserSessionConfigured
          ? <div className="telegram-session-ready"><CheckCircle2 size={16} /><div><strong>Telegram oturumu hazır</strong><span>Seçilen gruplar kullanıcı hesabı üzerinden okunabilir.</span></div><button type="button" onClick={() => { setTelegramLogin((current) => ({ ...current, stage: "phone", loginId: "", code: "", password: "" })); setIntegrationData((current) => current ? { ...current, telegramUserSessionConfigured: false } : current); }}>Yeniden bağla</button></div>
          : <button type="button" className="telegram-login-action" disabled={busy === "telegram-login" || (telegramLogin.stage === "phone" ? telegramLogin.phoneNumber.length < 8 : telegramLogin.stage === "code" ? telegramLogin.code.length < 4 : !telegramLogin.password)} onClick={() => void submitTelegramLogin()}>{busy === "telegram-login" ? <RefreshCw size={14} className="spin" /> : <KeyRound size={14} />}{telegramLogin.stage === "phone" ? "Kod gönder" : telegramLogin.stage === "code" ? "Kodu doğrula" : "2FA ile tamamla"}</button>}
      </div>
    </section>
    {groups.map((group) => <section className="integration-section" key={group}>
      <div className="section-heading"><div><span className="eyebrow">Servis bağlantıları</span><h2>{group}</h2></div></div>
      <div className="integration-fields">
        {integrationData?.credentials.filter((credential) => credential.group === group).map((credential) => {
          const isBusy = busy === credential.id;
          return <div className="integration-field" key={credential.id}>
            <div className="integration-field-title"><strong>{credential.label}</strong><span className={credential.configured ? "configured" : "missing"}>{credential.configured ? credential.source === "environment" ? "Environment" : "Kasada" : "Eksik"}</span></div>
            <input type={credential.secret ? "password" : "url"} value={values[credential.id] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [credential.id]: event.target.value }))} placeholder={credential.configured ? "Yeni değer girerek güncelleyin" : credential.placeholder} autoComplete="new-password" spellCheck={false} />
            <div className="integration-actions"><button type="button" disabled={isBusy || !(values[credential.id]?.trim())} onClick={() => void saveCredential(credential.id)}>{isBusy ? <RefreshCw size={14} className="spin" /> : <ShieldCheck size={14} />} Kaydet</button>{credential.configured && credential.source !== "environment" && <button type="button" className="danger-action" disabled={isBusy} onClick={() => void removeCredential(credential.id)}><Trash2 size={14} /> Kaldır</button>}</div>
          </div>;
        })}
      </div>
    </section>)}
    <section className="integration-footer">
      <div><strong>Oturum güvenliği</strong><p>Bu tarayıcıdaki yönetici oturumunu kapatır; çalışan bot süreçleri etkilenmez.</p></div>
      <button type="button" onClick={() => void fetch("/api/auth/logout", { method: "POST" }).then(() => window.location.assign("/login"))}><LogOut size={15} /> Oturumu kapat</button>
    </section>
  </div>;
}

function RpcSettingsView({ data }: { data: DashboardSnapshot }) {
  const numericChainIds: Partial<Record<ChainId, number>> = { ethereum: 1, base: 8453, robinhood: 4663 };
  const rpcHealth = new Map(data.serviceHealth.map((metric) => [metric.id.replace(/_rpc$/, ""), metric]));
  const groups = INTEGRATION_IDS
    .filter((chainId) => chainId !== "solana" && chainId !== "hyperliquid")
    .map((chainId) => ({
      chainId,
      endpoints: data.rpcEndpoints.filter((endpoint) => endpoint.chainId === chainId),
      health: rpcHealth.get(chainId),
    }));
  return <div className="view-stack">
    <section className="page-intro"><div><span className="eyebrow">Bağlantı altyapısı</span><h2>RPC Ayarları</h2><p>EVM ağlarının ana ve yedek RPC sırası, güncel sağlık bilgisi ve istek aralıkları.</p></div></section>
    <div className="rpc-network-list">
      {groups.map(({ chainId, endpoints, health }) => <section className="rpc-network" key={chainId}>
        <header>
          <div><span className={`chain-logo ${chainId}`}>{INTEGRATION_CATALOG[chainId].shortName}</span><div><strong>{integrationName(chainId)}</strong><small>Chain ID {numericChainIds[chainId]}</small></div></div>
          <span className={`rpc-health ${health?.status ?? "down"}`}><i />{health?.status === "healthy" ? "Sağlıklı" : health?.status === "degraded" ? "Yavaş / kısıtlı" : "Henüz ölçülmedi"}</span>
        </header>
        <div className="rpc-endpoint-head"><span>Öncelik</span><span>Endpoint</span><span>Tür</span><span>Durum</span><span>İstek aralığı</span></div>
        {endpoints.map((endpoint) => <div className="rpc-endpoint-row" key={`${chainId}:${endpoint.priority}`}>
          <b>#{endpoint.priority}</b>
          <code title={endpoint.url}>{endpoint.url}</code>
          <span>{endpoint.source === "configured" ? "Yapılandırılmış" : "Public fallback"}</span>
          <span className={endpoint.status === "active" ? "positive-text" : "warning-text"}>{endpoint.status === "active" ? "Hazır" : `Beklemede · ${endpoint.cooldownUntil ? relativeTime(endpoint.cooldownUntil) : ""}`}</span>
          <span>{endpoint.pollingIntervalMs ? `${endpoint.pollingIntervalMs / 1_000} sn` : "İsteğe bağlı"}</span>
        </div>)}
        <footer>Ortalama gecikme: <strong>{health?.averageLatencyMs ?? 0} ms</strong><span>İstek: <strong>{health?.requestCount ?? 0}</strong></span><span>Hata: <strong>{health?.errorCount ?? 0}</strong></span></footer>
      </section>)}
    </div>
    <div className="rpc-note"><ShieldCheck size={17} /><div><strong>Gizli bilgiler maskelenir</strong><p>API anahtarları bu sayfaya açık metin olarak gönderilmez. Endpoint sırası `.env` yapılandırması ve uygulamanın doğrulanmış public fallback listesiyle belirlenir.</p></div></div>
  </div>;
}

const certificationSteps: Record<ChainId, Array<{ id: string; label: string }>> = {
  ethereum: [{ id: "small_buy", label: "Küçük alım" }, { id: "partial_sell", label: "Kısmi satış" }, { id: "full_sell", label: "Tam satış" }],
  base: [{ id: "small_buy", label: "Küçük alım" }, { id: "partial_sell", label: "Kısmi satış" }, { id: "full_sell", label: "Tam satış" }],
  robinhood: [{ id: "small_buy", label: "Küçük alım" }, { id: "partial_sell", label: "Kısmi satış" }, { id: "full_sell", label: "Tam satış" }],
  solana: [{ id: "small_buy", label: "Küçük alım" }, { id: "partial_sell", label: "Kısmi satış" }, { id: "full_sell", label: "Tam satış" }],
  hyperliquid: [{ id: "spot_open", label: "Spot alım" }, { id: "spot_close", label: "Spot satış" }, { id: "perp_open", label: "Perp aç" }, { id: "perp_reduce", label: "Perp azalt" }, { id: "perp_close", label: "Perp kapat" }],
};

function LiveCertificationPanel({ data, onChanged, onNotice }: { data: DashboardSnapshot; onChanged: () => void; onNotice: (value: { type: "success" | "error"; message: string }) => void }) {
  const [assets, setAssets] = useState<Record<ChainId, string>>({ ethereum: "", base: "", robinhood: "", solana: "", hyperliquid: "HYPE" });
  const [allocationPercent, setAllocationPercent] = useState(20);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const botsStopped = data.chains.every((chain) => chain.status === "stopped");
  const runStep = async (chainId: ChainId, stepId: string) => {
    setBusy(`${chainId}:${stepId}`);
    try {
      const response = await fetch("/api/live-readiness/certify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId, stepId, tokenAddress: chainId === "hyperliquid" ? undefined : assets[chainId], coin: chainId === "hyperliquid" ? assets.hyperliquid : undefined, allocationPercent, confirmation }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Canlı test tamamlanamadı.");
      onChanged(); onNotice({ type: "success", message: `${integrationName(chainId)} ${certificationSteps[chainId].find((step) => step.id === stepId)?.label} testi ve mutabakatı geçti.` });
    } catch (error) { onChanged(); onNotice({ type: "error", message: error instanceof Error ? error.message : "Canlı test tamamlanamadı." }); }
    finally { setBusy(null); }
  };
  const reconcile = async (chainId: ChainId) => {
    setBusy(`${chainId}:reconcile`);
    try {
      const response = await fetch("/api/live-readiness/reconcile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? result.reconciliation?.details ?? "Mutabakat başarısız.");
      onChanged(); onNotice({ type: "success", message: result.reconciliation.details });
    } catch (error) { onChanged(); onNotice({ type: "error", message: error instanceof Error ? error.message : "Mutabakat başarısız." }); }
    finally { setBusy(null); }
  };
  return <section className="section-block live-certification"><div className="section-heading"><div><span className="eyebrow">Kanıtlı aktivasyon</span><h2>Canlı hazırlık testleri</h2></div><span className={`safety-label ${botsStopped ? "" : "blocked"}`}><ShieldCheck size={15}/>{botsStopped ? "Botlar duruyor" : "Önce tüm botları durdur"}</span></div><div className="certification-controls"><label><span>Mikro bütçe · %{allocationPercent}</span><input type="range" min="5" max="20" step="1" value={allocationPercent} onChange={(event) => setAllocationPercent(Number(event.target.value))}/></label><label><span>Gerçek işlem onayı</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="NERAXON TEST" autoComplete="off"/></label></div><div className="certification-grid">{LIVE_PILOT_INTEGRATION_IDS.map((chainId) => { const reconciliation = data.reconciliation.find((item) => item.integrationId === chainId); return <article className="certification-card" key={chainId}><div className="certification-head"><span className={`chain-logo ${chainId}`}>{INTEGRATION_CATALOG[chainId].shortName}</span><div><strong>{integrationName(chainId)}</strong><small>{reconciliation?.status === "passed" ? "Mutabakat geçti" : reconciliation?.status === "failed" ? "Mutabakat başarısız" : "Mutabakat bekliyor"}</small></div></div><label><span>{chainId === "hyperliquid" ? "Test piyasası" : chainId === "solana" ? "Test token mint'i" : "Test token kontratı"}</span><input className={chainId === "hyperliquid" ? "" : "mono"} value={assets[chainId]} onChange={(event) => setAssets((current) => ({ ...current, [chainId]: event.target.value.trim() }))} placeholder={chainId === "hyperliquid" ? "HYPE" : chainId === "solana" ? "Solana mint" : "0x…"}/></label><div className="certification-steps">{certificationSteps[chainId].map((step) => { const record = data.certificationSteps.find((item) => item.integrationId === chainId && item.stepId === step.id); const status = record?.status ?? "pending"; return <button type="button" className={status} key={step.id} disabled={!botsStopped || confirmation !== "NERAXON TEST" || busy !== null || !assets[chainId]} onClick={() => void runStep(chainId, step.id)} title={record?.details}><span>{status === "passed" ? <CheckCircle2 size={14}/> : status === "failed" ? <AlertTriangle size={14}/> : <PlayCircle size={14}/>}</span>{step.label}</button>; })}</div><button type="button" className="text-button reconcile-button" disabled={!botsStopped || busy !== null} onClick={() => void reconcile(chainId)}>{busy === `${chainId}:reconcile` ? <RefreshCw size={14} className="spin"/> : <RefreshCw size={14}/>} Mutabakatı çalıştır</button></article>; })}</div></section>;
}

function RiskView({ data, onChanged, onNotice }: { data: DashboardSnapshot; onChanged: () => void; onNotice: (value: { type: "success" | "error"; message: string }) => void }) {
  const [form, setForm] = useState(data.riskSettings);
  const [submitting, setSubmitting] = useState(false);
  const update = (key: keyof RiskSettings, value: number) => setForm((current) => ({ ...current, [key]: value }));
  const updateFeeLimit = (chainId: ChainId, key: "maxFeeUsd" | "maxFeePercent", value: number) => setForm((current) => ({
    ...current,
    networkFeeLimits: {
      ...current.networkFeeLimits!,
      [chainId]: { ...current.networkFeeLimits![chainId], [key]: value },
    },
  }));
  const updateExecutionLimit = (chainId: ChainId, key: keyof NonNullable<RiskSettings["networkExecutionLimits"]>[ChainId], value: number) => setForm((current) => ({
    ...current,
    networkExecutionLimits: {
      ...current.networkExecutionLimits!,
      [chainId]: { ...current.networkExecutionLimits![chainId], [key]: value },
    },
  }));
  const updateAssetPolicy = <K extends keyof NonNullable<RiskSettings["assetPolicy"]>>(key: K, value: NonNullable<RiskSettings["assetPolicy"]>[K]) => setForm((current) => ({
    ...current,
    assetPolicy: { ...current.assetPolicy!, [key]: value },
  }));
  const updateAssetList = (chainId: ChainId, list: "trustedAssets" | "deniedAssets", value: string) => updateAssetPolicy(list, {
    ...form.assetPolicy![list],
    [chainId]: value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean),
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true);
    try {
      const response = await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error ?? "Ayarlar kaydedilemedi.");
      onChanged(); onNotice({ type: "success", message: "Risk ayarları kaydedildi." });
    } catch (error) { onNotice({ type: "error", message: error instanceof Error ? error.message : "Ayarlar kaydedilemedi." }); }
    finally { setSubmitting(false); }
  };
  const controlBreaker = async (action: "halt" | "reset") => {
    setSubmitting(true);
    try {
      const response = await fetch("/api/risk/circuit-breaker", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error ?? "Devre kesici güncellenemedi.");
      onChanged(); onNotice({ type: "success", message: action === "halt" ? "Acil durdurma etkinleştirildi." : "Devre kesici sıfırlandı." });
    } catch (error) { onNotice({ type: "error", message: error instanceof Error ? error.message : "Devre kesici güncellenemedi." }); }
    finally { setSubmitting(false); }
  };
  return (
    <div className="view-stack">
      <section className="page-intro"><div><span className="eyebrow">Koruma katmanı</span><h2>Risk ayarları</h2><p>Bu sınırlar otomatik ve manuel bütün işlemlerden önce uygulanır.</p></div><span className="safety-label"><ShieldCheck size={16} /> Değişiklikler audit kaydına yazılır</span></section>
      <section className={`breaker-panel ${data.circuitBreaker.halted ? "halted" : ""}`}><div><OctagonX size={19} /><span><strong>{data.circuitBreaker.halted ? "İşlemler durduruldu" : "Devre kesici hazır"}</strong><small>{data.circuitBreaker.reason ?? `${data.circuitBreaker.consecutiveFailures} ardışık operasyon hatası`}</small></span></div><button type="button" disabled={submitting} onClick={() => void controlBreaker(data.circuitBreaker.halted ? "reset" : "halt")}>{data.circuitBreaker.halted ? "Engeli sıfırla" : "Acil durdur"}</button></section>
      <form className="risk-form" onSubmit={submit}>
        <RiskGroup title="Pozisyon yönetimi" description="Portföy dağılımı ve açık işlem sınırları" icon={CircleDollarSign}>
          <NumberField label="Minimum pozisyon" suffix="%" value={form.minPositionPercent} onChange={(value) => update("minPositionPercent", value)} />
          <NumberField label="Maksimum pozisyon" suffix="%" value={form.maxPositionPercent} onChange={(value) => update("maxPositionPercent", value)} />
          <NumberField label="Maksimum açık pozisyon" value={form.maxOpenPositions} onChange={(value) => update("maxOpenPositions", value)} />
          <NumberField label="Nakit rezervi" suffix="%" value={form.cashReservePercent} onChange={(value) => update("cashReservePercent", value)} />
          <NumberField label="HyperCore kaldıraç üst sınırı" suffix="x" value={form.maxHypercoreLeverage ?? 3} onChange={(value) => update("maxHypercoreLeverage", value)} />
        </RiskGroup>
        <RiskGroup title="Piyasa güvenliği" description="Likidite ve gerçekleşme kalitesi eşikleri" icon={ShieldCheck}>
          <NumberField label="Minimum likidite" prefix="$" value={form.minimumLiquidityUsd} onChange={(value) => update("minimumLiquidityUsd", value)} />
          <NumberField label="Maksimum slippage" suffix="%" value={form.maxSlippagePercent} step={0.1} onChange={(value) => update("maxSlippagePercent", value)} />
          <NumberField label="Maksimum fiyat etkisi" suffix="%" value={form.maxPriceImpactPercent} step={0.1} onChange={(value) => update("maxPriceImpactPercent", value)} />
          <NumberField label="Günlük zarar sınırı" suffix="%" value={form.dailyLossLimitPercent} onChange={(value) => update("dailyLossLimitPercent", value)} />
          <NumberField label="Maksimum 24s hareket" suffix="%" value={form.maxPriceChange24hPercent ?? 80} onChange={(value) => update("maxPriceChange24hPercent", value)} />
        </RiskGroup>
        <RiskGroup title="Devre kesiciler" description="Altyapı hatalarında otomatik işlem engeli" icon={OctagonX}>
          <NumberField label="Ardışık hata sınırı" value={form.maxConsecutiveFailures ?? 3} onChange={(value) => update("maxConsecutiveFailures", value)} />
          <NumberField label="Maksimum RPC gecikmesi" suffix="ms" value={form.maxRpcLatencyMs ?? 2500} onChange={(value) => update("maxRpcLatencyMs", value)} />
          <NumberField label="Canlı işlem USD tavanı" prefix="$" value={form.maxLiveTradeUsd ?? 25} onChange={(value) => update("maxLiveTradeUsd", value)} />
        </RiskGroup>
        <RiskGroup title="Ağ fee sınırları" description="Her emir için toplam fee hem USD hem işlem oranı sınırını geçmelidir" icon={CircleDollarSign}>
          {INTEGRATION_IDS.map((chainId) => <div className="network-fee-row" key={chainId}>
            <span><i className={`chain-logo ${chainId}`}>{INTEGRATION_CATALOG[chainId].shortName}</i><b>{integrationName(chainId)}</b></span>
            <NumberField label="Maksimum toplam fee" prefix="$" value={form.networkFeeLimits![chainId].maxFeeUsd} step={0.01} onChange={(value) => updateFeeLimit(chainId, "maxFeeUsd", value)} />
            <NumberField label="Maksimum işlem oranı" suffix="%" value={form.networkFeeLimits![chainId].maxFeePercent} step={0.1} onChange={(value) => updateFeeLimit(chainId, "maxFeePercent", value)} />
          </div>)}
        </RiskGroup>
        <RiskGroup title="Ağ işlem profilleri" description="Shadow ve canlı emirlerde her ağın sermaye ve gerçekleşme sınırları" icon={Gauge}>
          {INTEGRATION_IDS.map((chainId) => { const limit = form.networkExecutionLimits![chainId]; return <div className="network-risk-row" key={chainId}>
            <header><i className={`chain-logo ${chainId}`}>{INTEGRATION_CATALOG[chainId].shortName}</i><span><b>{integrationName(chainId)}</b><small>{limit.minTradeUsd > 0 ? `$${limit.minTradeUsd}–$${limit.maxTradeUsd}` : `$${limit.maxTradeUsd} tavan`}</small></span></header>
            <NumberField label="Minimum pozisyon" suffix="%" value={limit.minPositionPercent} step={0.5} onChange={(value) => updateExecutionLimit(chainId, "minPositionPercent", value)} />
            <NumberField label="Maksimum pozisyon" suffix="%" value={limit.maxPositionPercent} step={0.5} onChange={(value) => updateExecutionLimit(chainId, "maxPositionPercent", value)} />
            <NumberField label="Minimum işlem" prefix="$" value={limit.minTradeUsd} step={0.5} onChange={(value) => updateExecutionLimit(chainId, "minTradeUsd", value)} />
            <NumberField label="Maksimum işlem" prefix="$" value={limit.maxTradeUsd} step={0.5} onChange={(value) => updateExecutionLimit(chainId, "maxTradeUsd", value)} />
            <NumberField label="Günlük zarar" suffix="%" value={limit.dailyLossLimitPercent} step={0.5} onChange={(value) => updateExecutionLimit(chainId, "dailyLossLimitPercent", value)} />
            <NumberField label="Fee rezervi" suffix="%" value={limit.cashReservePercent} step={0.5} onChange={(value) => updateExecutionLimit(chainId, "cashReservePercent", value)} />
            <NumberField label="Açık pozisyon" value={limit.maxOpenPositions} onChange={(value) => updateExecutionLimit(chainId, "maxOpenPositions", value)} />
            <NumberField label="Slippage" suffix="%" value={limit.maxSlippagePercent} step={0.1} onChange={(value) => updateExecutionLimit(chainId, "maxSlippagePercent", value)} />
            <NumberField label="Kaldıraç" suffix="x" value={limit.maxLeverage} step={1} onChange={(value) => updateExecutionLimit(chainId, "maxLeverage", value)} />
            <NumberField label="Quote yaş sınırı" suffix="sn" value={limit.maxQuoteAgeMs / 1000} step={0.5} onChange={(value) => updateExecutionLimit(chainId, "maxQuoteAgeMs", value * 1000)} />
            <NumberField label="Alım fiyat sapması" suffix="%" value={limit.maxBuyPriceDeviationPercent} step={0.1} onChange={(value) => updateExecutionLimit(chainId, "maxBuyPriceDeviationPercent", value)} />
            <NumberField label="Satış fiyat sapması" suffix="%" value={limit.maxSellPriceDeviationPercent} step={0.1} onChange={(value) => updateExecutionLimit(chainId, "maxSellPriceDeviationPercent", value)} />
            <NumberField label="Acil çıkış sapması" suffix="%" value={limit.maxEmergencyExitDeviationPercent} step={0.1} onChange={(value) => updateExecutionLimit(chainId, "maxEmergencyExitDeviationPercent", value)} />
          </div>; })}
        </RiskGroup>
        <RiskGroup title="Varlık politikası" description="Yeni pozisyonlar için otomatik filtre, trusted istisnası ve kesin denylist" icon={ShieldCheck}>
          <NumberField label="Minimum güvenlik skoru" value={form.assetPolicy!.minimumSafetyScore} onChange={(value) => updateAssetPolicy("minimumSafetyScore", value)} />
          <NumberField label="Genç piyasa süresi" suffix="dk" value={form.assetPolicy!.youngPoolAgeMinutes} onChange={(value) => updateAssetPolicy("youngPoolAgeMinutes", value)} />
          <NumberField label="Genç piyasa cüzdan onayı" value={form.assetPolicy!.youngPoolMinWallets} onChange={(value) => updateAssetPolicy("youngPoolMinWallets", value)} />
          <NumberField label="Genç piyasa pozisyon oranı" suffix="%" value={form.assetPolicy!.youngPoolAllocationMultiplier * 100} onChange={(value) => updateAssetPolicy("youngPoolAllocationMultiplier", value / 100)} />
          <NumberField label="HyperCore minimum 24s hacim" prefix="$" value={form.assetPolicy!.hypercoreMinVolume24hUsd} onChange={(value) => updateAssetPolicy("hypercoreMinVolume24hUsd", value)} />
          <NumberField label="HyperCore minimum açık pozisyon" prefix="$" value={form.assetPolicy!.hypercoreMinOpenInterestUsd} onChange={(value) => updateAssetPolicy("hypercoreMinOpenInterestUsd", value)} />
          <label className="toggle-field"><input type="checkbox" checked={form.assetPolicy!.requireVerifiedExitRoute} onChange={(event) => updateAssetPolicy("requireVerifiedExitRoute", event.target.checked)} /><span><b>Doğrulanmış çıkış rotası</b><small>Genç token alımından önce satış rotası zorunlu</small></span></label>
          <div className="asset-policy-list">
            {INTEGRATION_IDS.map((chainId) => <div className="asset-policy-row" key={chainId}>
              <header><i className={`chain-logo ${chainId}`}>{INTEGRATION_CATALOG[chainId].shortName}</i><b>{integrationName(chainId)}</b></header>
              <TextListField label="Trusted varlıklar" value={form.assetPolicy!.trustedAssets[chainId].join("\n")} placeholder={chainId === "hyperliquid" ? "spot:HYPE veya perp:ETH" : "Kontrat veya mint adresi"} onChange={(value) => updateAssetList(chainId, "trustedAssets", value)} />
              <TextListField label="Denylist" value={form.assetPolicy!.deniedAssets[chainId].join("\n")} placeholder={chainId === "hyperliquid" ? "spot:COIN veya perp:COIN" : "Kontrat veya mint adresi"} onChange={(value) => updateAssetList(chainId, "deniedAssets", value)} />
            </div>)}
          </div>
        </RiskGroup>
        <RiskGroup title="Cüzdan işlem yoğunluğu" description="Aşırı aktif kaynakları otomatik izleme dışına alır" icon={Activity}>
          <NumberField label="Saatlik swap sınırı" value={form.maxWalletSwapsPerHour ?? 8} onChange={(value) => update("maxWalletSwapsPerHour", value)} />
          <NumberField label="24 saatlik swap sınırı" value={form.maxWalletSwapsPer24Hours ?? 50} onChange={(value) => update("maxWalletSwapsPer24Hours", value)} />
        </RiskGroup>
        <RiskGroup title="Maruziyet" description="Tek token ve kaynak cüzdan yoğunluğu" icon={Gauge}>
          <NumberField label="Token başına üst sınır" suffix="%" value={form.maxTokenExposurePercent} onChange={(value) => update("maxTokenExposurePercent", value)} />
          <NumberField label="Cüzdan başına üst sınır" suffix="%" value={form.maxWalletExposurePercent} onChange={(value) => update("maxWalletExposurePercent", value)} />
        </RiskGroup>
        <div className="risk-actions"><p>Kaydettiğinde yeni işlemler güncel kuralları kullanır.</p><button className="submit-button" disabled={submitting}>{submitting ? <RefreshCw size={16} className="spin" /> : <Settings2 size={16} />} Ayarları kaydet</button></div>
      </form>
    </div>
  );
}

function Metric({
  label,
  value,
  meta,
  icon: Icon,
  tone = "neutral",
  networks = [],
}: {
  label: string;
  value: string;
  meta: string;
  icon: typeof Gauge;
  tone?: "neutral" | "positive" | "negative" | "warning";
  networks?: Array<{ chainId: ChainId; value: string; change?: string }>;
}) {
  return <article className={`metric ${networks.length ? "with-networks" : ""}`}>
    <div className={`metric-icon ${tone}`}><Icon size={17} /></div>
    <span>{label}</span>
    <strong>{value}</strong>
    <small className={tone}>{meta}</small>
    {networks.length ? <div className="metric-networks">
      {networks.map((network) => {
        const change = network.change ?? network.value;
        const changeTone = change.startsWith("-") ? "negative" : change.startsWith("+") ? "positive" : "neutral";
        return <div className="metric-network-row" key={network.chainId}>
          <span><i className={`chain-dot ${network.chainId}`} />{integrationName(network.chainId)}</span>
          <strong className={network.change ? "" : changeTone}>{network.value}</strong>
          {network.change ? <small className={changeTone}>{network.change}</small> : null}
        </div>;
      })}
    </div> : null}
  </article>;
}

function StatusBadge({ status }: { status: BotStatus }) {
  const labels: Record<BotStatus, string> = { running: "Çalışıyor", stopped: "Durduruldu", starting: "Başlıyor", stopping: "Durduruluyor", error: "Hata" };
  return <span className={`status-badge ${status}`}><i />{labels[status]}</span>;
}

function WalletTable({ wallets, pnlByWallet, onChanged, onNotice }: { wallets: TrackedWallet[]; pnlByWallet?: Map<string, WalletNetworkPnl>; onChanged: () => void; onNotice: (value: { type: "success" | "error"; message: string }) => void }) {
  const [selected, setSelected] = useState<TrackedWallet | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [favoriteUpdatingId, setFavoriteUpdatingId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<WalletSortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const sortedWallets = sortKey
    ? [...wallets].sort((left, right) => compareWalletRows(left, right, sortKey, sortDirection, pnlByWallet))
    : wallets;
  const changeSort = (nextKey: WalletSortKey) => {
    if (sortKey === nextKey) {
      setSortDirection((current) => current === "desc" ? "asc" : "desc");
      return;
    }
    setSortKey(nextKey);
    setSortDirection("desc");
  };
  const toggleWallet = async (wallet: TrackedWallet) => {
    const paused = wallet.state !== "paused";
    setUpdatingId(wallet.id);
    setConfirmRemoveId(null);
    try {
      const response = await fetch(`/api/wallets/${wallet.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Cüzdan izleme durumu değiştirilemedi.");
      if (selected?.id === wallet.id) setSelected(result.wallet);
      onChanged();
      onNotice({ type: "success", message: paused ? `${wallet.label} (${shortAddress(wallet.address)}) takibi durduruldu; yeni işlemleri izlenmeyecek.` : `${wallet.label} (${shortAddress(wallet.address)}) takibi başlatıldı.` });
    } catch (error) {
      onNotice({ type: "error", message: error instanceof Error ? error.message : "Cüzdan izleme durumu değiştirilemedi." });
    } finally {
      setUpdatingId(null);
    }
  };
  const toggleFavorite = async (wallet: TrackedWallet) => {
    const isFavorite = !wallet.isFavorite;
    setFavoriteUpdatingId(wallet.id);
    setConfirmRemoveId(null);
    try {
      const response = await fetch(`/api/wallets/${wallet.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isFavorite }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Cüzdan favori durumu değiştirilemedi.");
      if (selected?.id === wallet.id) setSelected(result.wallet);
      onChanged();
      onNotice({ type: "success", message: `${wallet.label} ${isFavorite ? "favorilere eklendi" : "favorilerden çıkarıldı"}.` });
    } catch (error) {
      onNotice({ type: "error", message: error instanceof Error ? error.message : "Cüzdan favori durumu değiştirilemedi." });
    } finally {
      setFavoriteUpdatingId(null);
    }
  };
  const removeWallet = async (wallet: TrackedWallet) => {
    if (confirmRemoveId !== wallet.id) {
      setConfirmRemoveId(wallet.id);
      return;
    }
    setRemovingId(wallet.id);
    try {
      const response = await fetch(`/api/wallets/${wallet.id}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Cüzdan takibi bırakılamadı.");
      if (selected?.id === wallet.id) setSelected(null);
      setConfirmRemoveId(null);
      onChanged();
      onNotice({ type: "success", message: `${wallet.label} cüzdanının takibi bırakıldı.` });
    } catch (error) {
      onNotice({ type: "error", message: error instanceof Error ? error.message : "Cüzdan takibi bırakılamadı." });
    } finally {
      setRemovingId(null);
    }
  };
  return <>
    <div className="table-scroll">
      <table>
        <thead><tr>
          <SortableWalletHeader label="Cüzdan" column="wallet" activeColumn={sortKey} direction={sortDirection} onSort={changeSort} />
          <SortableWalletHeader label="Ağlar" column="networks" activeColumn={sortKey} direction={sortDirection} onSort={changeSort} />
          <SortableWalletHeader label="Takip durumu" column="state" activeColumn={sortKey} direction={sortDirection} onSort={changeSort} />
          <SortableWalletHeader label="Skor" column="score" activeColumn={sortKey} direction={sortDirection} onSort={changeSort} />
          <SortableWalletHeader label="Gözlenen" column="observed" activeColumn={sortKey} direction={sortDirection} onSort={changeSort} title="Cüzdanda gözlenen toplam swap sayısı" />
          <SortableWalletHeader label="Copy trade" column="copied" activeColumn={sortKey} direction={sortDirection} onSort={changeSort} title="Başarıyla tamamlanan copy trade sayısı" />
          <SortableWalletHeader label="Kazanma" column="winRate" activeColumn={sortKey} direction={sortDirection} onSort={changeSort} />
          <SortableWalletHeader label="Net PnL" column="pnl" activeColumn={sortKey} direction={sortDirection} onSort={changeSort} title="Gerçekleşmiş sonuç ve açık copy pozisyonların güncel kâr/zararı" />
          <th aria-label="İşlemler" />
        </tr></thead>
        <tbody>{sortedWallets.map((wallet) => {
          const pnlMetric = pnlByWallet?.get(wallet.id);
          const pnlUsd = pnlMetric?.pnlUsd ?? wallet.realizedPnlUsd;
          const investedUsd = pnlMetric?.investedUsd ?? walletCopyInvestedUsd(wallet);
          const pnlPercent = investedUsd > 0 ? pnlUsd / investedUsd * 100 : 0;
          return <tr key={wallet.id}>
          <td data-label="Cüzdan"><button className="wallet-cell wallet-cell-button" onClick={() => setSelected(wallet)} title={`${wallet.label} eklenme ve skor detaylarını aç`}><span className="wallet-avatar">{wallet.label.slice(0, 2).toUpperCase()}</span><span><strong>{wallet.label}</strong><code>{shortAddress(wallet.address)}</code></span></button></td>
          <td data-label="Ağlar"><WalletNetworkBadges chainIds={wallet.trackedChainIds} /></td>
          <td data-label="Takip durumu"><WalletTrackingState wallet={wallet} compact /></td>
          <td data-label="Skor"><div className="score-cell"><span>{wallet.score}</span><div><i style={{ width: `${wallet.score}%` }} /></div></div></td>
          <td data-label="Gözlenen">{wallet.totalTrades}</td>
          <td data-label="Copy trade">{wallet.copiedTradeCount}</td>
          <td data-label="Kazanma">%{wallet.winRate.toFixed(1)}</td>
          <td data-label="Net PnL" className={pnlUsd >= 0 ? "positive-text" : "negative-text"} title={`Seçili ağdaki gerçekleşmiş copy sonucu + açık copy pozisyonların güncel değeri − kalan maliyetler · hesaplanan sermaye ${usd(investedUsd)}`}><strong>{signedUsd(pnlUsd)}</strong><br/><small>{`${pnlPercent >= 0 ? "+" : ""}%${pnlPercent.toFixed(2)}`}</small></td>
          <td data-label="İşlemler"><div className="row-actions"><button className={`row-action favorite ${wallet.isFavorite ? "active" : ""}`} disabled={removingId !== null || updatingId !== null || favoriteUpdatingId !== null} onClick={() => void toggleFavorite(wallet)} title={wallet.isFavorite ? `${wallet.label} favorilerden çıkar` : `${wallet.label} favorilere ekle`} aria-label={wallet.isFavorite ? `${wallet.label} favorilerden çıkar` : `${wallet.label} favorilere ekle`} aria-pressed={wallet.isFavorite}>{favoriteUpdatingId === wallet.id ? <RefreshCw size={15} className="spin" /> : <Star size={15} fill={wallet.isFavorite ? "currentColor" : "none"} />}</button><button className="row-action wallet-detail-action" onClick={() => setSelected(wallet)} title={`${wallet.label} skor detayını aç`}><Eye size={15} /></button><button className={`row-action toggle ${wallet.state === "paused" ? "resume" : ""}`} disabled={removingId !== null || updatingId !== null || favoriteUpdatingId !== null} onClick={() => void toggleWallet(wallet)} title={wallet.state === "paused" ? `${wallet.label} takibini başlat` : `${wallet.label} takibini durdur`} aria-label={wallet.state === "paused" ? `${wallet.label} takibini başlat` : `${wallet.label} takibini durdur`}>{updatingId === wallet.id ? <RefreshCw size={15} className="spin" /> : wallet.state === "paused" ? <PlayCircle size={15} /> : <PauseCircle size={15} />}</button><button className={`row-action remove ${confirmRemoveId === wallet.id ? "confirm" : ""}`} disabled={removingId !== null || updatingId !== null || favoriteUpdatingId !== null} onClick={() => void removeWallet(wallet)} title={confirmRemoveId === wallet.id ? `${wallet.label} takibini bırakmayı onayla` : `${wallet.label} takibini bırak`} aria-label={confirmRemoveId === wallet.id ? `${wallet.label} takibini bırakmayı onayla` : `${wallet.label} takibini bırak`}>{removingId === wallet.id ? <RefreshCw size={15} className="spin" /> : confirmRemoveId === wallet.id ? <CheckCircle2 size={15} /> : <Trash2 size={15} />}</button></div></td>
        </tr>;
        })}</tbody>
      </table>
    </div>
    {selected && <WalletDetail wallet={selected} onClose={() => setSelected(null)} onChanged={onChanged} onNotice={onNotice} />}
  </>;
}

type WalletSortKey = "wallet" | "networks" | "state" | "score" | "observed" | "copied" | "winRate" | "pnl";
type SortDirection = "desc" | "asc";

function SortableWalletHeader({ label, column, activeColumn, direction, onSort, title }: { label: string; column: WalletSortKey; activeColumn: WalletSortKey | null; direction: SortDirection; onSort: (column: WalletSortKey) => void; title?: string }) {
  const active = activeColumn === column;
  return <th aria-sort={active ? direction === "desc" ? "descending" : "ascending" : "none"} title={title}><button className={`table-sort ${active ? "active" : ""}`} onClick={() => onSort(column)} title={`${label} sütununu ${active && direction === "desc" ? "küçükten büyüğe" : "büyükten küçüğe"} sırala`}>{label}{active && direction === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />}</button></th>;
}

function compareWalletRows(left: TrackedWallet, right: TrackedWallet, key: WalletSortKey, direction: SortDirection, pnlByWallet?: Map<string, WalletNetworkPnl>) {
  const pausedOrder = Number(left.state === "paused") - Number(right.state === "paused");
  if (pausedOrder) return pausedOrder;
  const favoriteOrder = Number(right.isFavorite) - Number(left.isFavorite);
  if (favoriteOrder) return favoriteOrder;
  const stateRank = { active: 2, observing: 1, paused: 0 } as const;
  const values = {
    wallet: [left.label, right.label],
    networks: [left.trackedChainIds.map(integrationName).join(", "), right.trackedChainIds.map(integrationName).join(", ")],
    state: [stateRank[left.state], stateRank[right.state]],
    score: [left.score, right.score],
    observed: [left.totalTrades, right.totalTrades],
    copied: [left.copiedTradeCount, right.copiedTradeCount],
    winRate: [left.winRate, right.winRate],
    pnl: [pnlByWallet?.get(left.id)?.pnlUsd ?? left.realizedPnlUsd, pnlByWallet?.get(right.id)?.pnlUsd ?? right.realizedPnlUsd],
  }[key] as [string | number, string | number];
  const comparison = typeof values[0] === "string"
    ? values[0].localeCompare(values[1] as string, uiLocale(), { sensitivity: "base" })
    : values[0] - (values[1] as number);
  const sorted = direction === "desc" ? -comparison : comparison;
  return sorted || right.score - left.score || left.address.localeCompare(right.address);
}

function WalletNetworkBadges({ chainIds }: { chainIds: ChainId[] }) {
  return <div className="wallet-networks">{chainIds.map((chainId) => {
    const integration = INTEGRATION_CATALOG[chainId];
    return <span className={chainId} key={chainId}>{integration.shortName}{integration.shortName !== integration.name && <small>{integration.name}</small>}</span>;
  })}</div>;
}

function WalletTrackingState({ wallet, compact = false }: { wallet: TrackedWallet; compact?: boolean }) {
  const paused = wallet.state === "paused";
  const active = wallet.state === "active";
  const label = paused ? "Takip kapalı" : "Takip açık";
  const detail = paused
    ? wallet.pauseReason === "Kullanıcı tarafından manuel olarak duraklatıldı."
      ? "Manuel kapatıldı · işlemler izlenmiyor"
      : "Koruma kapattı · işlemler izlenmiyor"
    : active
      ? "Copy trade aktif"
      : `Copy trade açık · gözlemde (${wallet.observationSwapCount} swap)`;
  if (compact) return <div className="wallet-state-cell"><span className={`state-label ${paused ? "paused" : "tracking"}`} title={wallet.pauseReason ?? detail}>{label}</span><small className={paused ? "paused" : active ? "active" : "observing"}>{detail}</small></div>;
  return <div className={`wallet-tracking-state ${wallet.state}`}><i /><div><strong>{label}</strong><p>{paused ? "Bu cüzdanın yeni işlemleri izlenmiyor ve copy trade yapılmıyor." : active ? "Yeni swaplar izleniyor; risk kurallarını geçen işlemler copy trade ediliyor." : "Yeni swaplar izleniyor ve risk kurallarını geçen işlemler copy trade ediliyor; cüzdan geçmişi toplanmaya devam ediyor."}</p></div></div>;
}

function PositionList({ positions, lots = [], onSelect, usdFormatter = usd }: { positions: Position[]; lots?: DashboardSnapshot["positionLots"]; onSelect?: (position: Position) => void; usdFormatter?: (value: number) => string }) {
  return <div className={`position-list ${onSelect ? "selectable" : ""}`}>{positions.map((position) => { const pnlPercent = position.investedUsd ? (position.unrealizedPnlUsd / position.investedUsd) * 100 : 0; const matchingLots = lots.filter((lot) => lot.chainId === position.chainId && lot.tokenAddress.toLowerCase() === position.tokenAddress.toLowerCase()); const lotCount = matchingLots.length; const lotLabels = [...new Set(matchingLots.map((lot) => lot.walletLabel).filter((label): label is string => Boolean(label)))]; const sourceLabels = position.sourceWalletLabels?.length ? position.sourceWalletLabels : lotLabels.length ? lotLabels : position.sourceWalletLabel ? [position.sourceWalletLabel] : []; const openedAt = position.openedAt ?? matchingLots.reduce<string | null>((earliest, lot) => !earliest || lot.openedAt < earliest ? lot.openedAt : earliest, null); const content = <><div className={`token-icon ${position.chainId}`}>{position.tokenSymbol.slice(0, 2)}</div><div className="position-main"><strong>{position.tokenSymbol}</strong><small className="position-source">Kaynak: {sourceLabels.join(", ") || "Manuel işlem"}{lotCount > 1 ? ` · ${lotCount} açık lot` : ""}</small><small className="position-opened">Alındı: {openedAt ? dateTime(openedAt) : "Kayıt bulunamadı"}</small><span>{integrationName(position.chainId)} · {position.quantity.toFixed(4)}</span></div><div className="position-value"><strong>{usdFormatter(position.quantity * position.currentPriceUsd)}</strong><span className={pnlPercent >= 0 ? "positive-text" : "negative-text"}>{pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(2)}%</span></div></>; return <div className="position-row-shell" key={position.id}>{onSelect ? <button type="button" className="position-row" onClick={() => onSelect(position)} title={`${position.tokenSymbol} işlem formuna aktar`}>{content}<ChevronRight className="position-chevron" size={16} /></button> : <div className="position-row">{content}</div>}{position.pairAddress && <a className="position-dex-link" href={integrationMarketUrl(position.chainId, position.pairAddress)} target="_blank" rel="noreferrer" title={`${position.tokenSymbol} tokenını DexScreener'da aç`} aria-label={`${position.tokenSymbol} tokenını DexScreener'da aç`}><ExternalLink size={14} /></a>}</div>; })}</div>;
}

function GroupedPositionList({ positions, lots, onSelect }: { positions: Position[]; lots: DashboardSnapshot["positionLots"]; onSelect: (position: Position) => void }) {
  const groups = INTEGRATION_IDS
    .filter((chainId) => chainId !== "hyperliquid")
    .map((chainId) => ({ chainId, positions: positions.filter((position) => position.chainId === chainId) }))
    .filter((group) => group.positions.length > 0);

  return <div className="position-groups">{groups.map((group) => {
    const totalValueUsd = group.positions.reduce((sum, position) => sum + position.quantity * position.currentPriceUsd, 0);
    return <section className="position-group" key={group.chainId}>
      <header><div><span aria-hidden="true" className={`position-group-mark ${group.chainId}`} /><strong>{integrationName(group.chainId)}</strong></div><span>{group.positions.length} pozisyon · {usd(totalValueUsd)}</span></header>
      <PositionList positions={group.positions} lots={lots} onSelect={onSelect} />
    </section>;
  })}</div>;
}

function HypercorePositionList({ positions, usdFormatter = usd }: { positions: HypercorePaperPosition[]; usdFormatter?: (value: number) => string }) {
  if (!positions.length) return null;
  return <div className="position-list hypercore-position-list">{positions.map((position) => {
    const pnlPercent = position.marginUsd ? position.unrealizedPnlUsd / position.marginUsd * 100 : 0;
    return <div className="position-row-shell" key={position.id}><div className="position-row"><div className="token-icon hyperliquid">HL</div><div className="position-main"><strong>{position.coin} <small className={`market-tag ${position.side}`}>{position.marketType === "spot" ? "SPOT" : `${position.side.toUpperCase()} · ${position.leverage}x`}</small></strong><small className="position-source">Kaynak: {position.walletLabel ?? "Manuel işlem"}</small><small className="position-opened">Alındı: {dateTime(position.openedAt)}</small><span>{position.quantity.toFixed(6)} · giriş {usd(position.entryPriceUsd)}</span></div><div className="position-value"><strong>{usdFormatter(position.marginUsd + position.unrealizedPnlUsd)}</strong><span className={pnlPercent >= 0 ? "positive-text" : "negative-text"}>{pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(2)}%</span></div></div><a className="position-dex-link" href={integrationMarketUrl("hyperliquid", position.coin)} target="_blank" rel="noreferrer" title={`${position.coin} Hyperliquid piyasasını aç`}><ExternalLink size={14}/></a></div>;
  })}</div>;
}

function positionKey(position: Pick<Position, "chainId" | "tokenAddress">) {
  return `${position.chainId}:${normalizeAddress(position.chainId, position.tokenAddress)}`;
}

function EventList({ events }: { events: DashboardSnapshot["events"] }) {
  return <div className="event-list">{events.map((event) => <div className="event-row" key={event.id}><span className={`event-dot ${event.level}`} /><div><strong>{event.title}</strong><p>{event.message}</p><small>{relativeTime(event.createdAt)}{event.chainId ? ` · ${integrationName(event.chainId)}` : ""}{event.txHash && event.chainId && event.chainId !== "hyperliquid" ? <a href={explorerUrl(event.chainId, event.txHash)} target="_blank" rel="noreferrer">İşlemi aç <ExternalLink size={9} /></a> : null}</small></div></div>)}</div>;
}

function TradeTable({ trades }: { trades: Trade[] }) {
  const [selected, setSelected] = useState<Trade | null>(null);
  return <><div className="table-scroll"><table><thead><tr><th>İşlem</th><th>Ağ</th><th>Durum</th><th>Miktar</th><th>Net değer</th><th>Maliyet</th><th>Zaman</th><th aria-label="İşlemler" /></tr></thead><tbody>{trades.map((trade) => <tr key={trade.id}><td><div className="trade-cell"><span className={trade.side}>{trade.side === "buy" ? <ArrowDownLeft size={15} /> : <ArrowUpRight size={15} />}</span><div><strong>{trade.tokenSymbol}</strong><small>{trade.side === "buy" ? "Alım" : "Satış"} · {trade.source === "manual" ? "Manuel" : "Kopya"}</small></div></div></td><td>{integrationName(trade.chainId)}</td><td><span className={`trade-status ${trade.status}`}>{trade.status === "confirmed" ? "Tamamlandı" : trade.status === "skipped" ? "Reddedildi" : trade.status}</span></td><td>{trade.quantity ? trade.quantity.toFixed(6) : "—"}</td><td>{usd(trade.netUsd)}</td><td>{usd(trade.fees.totalUsd)}</td><td>{relativeTime(trade.createdAt)}</td><td><button className="row-action" onClick={() => setSelected(trade)} title={`${trade.tokenSymbol} işlem detayını aç`}><Eye size={15} /></button></td></tr>)}</tbody></table></div>{selected && <TradeDetail trade={selected} onClose={() => setSelected(null)} />}</>;
}

function HypercoreTradeTable({ trades }: { trades: DashboardSnapshot["hypercoreTrades"] }) {
  return <div className="table-scroll"><table className="hypercore-trade-table"><thead><tr><th>Piyasa</th><th>Tür</th><th>Eylem</th><th>Notional</th><th>Margin</th><th>Fee</th><th>Net PnL</th><th>Zaman</th></tr></thead><tbody>{trades.map((trade) => <tr key={trade.id}><td><div className="trade-cell"><span className={trade.side}>{trade.side === "buy" ? <ArrowDownLeft size={15}/> : <ArrowUpRight size={15}/>}</span><div><strong>{trade.coin}</strong><small>{trade.source === "manual" ? "Manuel" : "Kopya"} · {trade.positionSide} · {trade.leverage}x</small></div></div></td><td><span className="market-tag">{trade.marketType.toUpperCase()}</span></td><td><span className={`trade-status ${trade.status}`}>{hypercoreActionLabel(trade.action)}</span></td><td>{usd(trade.notionalUsd)}</td><td>{usd(trade.marginUsd)}</td><td>{usd(trade.feeUsd + trade.fundingUsd)}</td><td className={trade.realizedPnlUsd >= 0 ? "positive-text" : "negative-text"}>{signedUsd(trade.realizedPnlUsd)}</td><td>{relativeTime(trade.createdAt)}</td></tr>)}</tbody></table></div>;
}

function ExecutionAttemptTable({ attempts }: { attempts: DashboardSnapshot["executionAttempts"] }) {
  const [selected, setSelected] = useState<DashboardSnapshot["executionAttempts"][number] | null>(null);
  const selectedRentUsd = selected ? executionMetadataNumber(selected.metadata, "refundableRentDepositUsd") : 0;
  return <><div className="table-scroll"><table><thead><tr><th>Emir</th><th>Ağ</th><th>Durum</th><th>Birim fiyat / işlem</th><th>Slippage / etki</th><th>Maliyet</th><th>Simülasyon</th><th aria-label="İşlemler" /></tr></thead><tbody>{attempts.map((attempt) => {
    const tradeValueUsd = executionMetadataNumber(attempt.metadata, "tradeValueUsd");
    return <tr key={attempt.id}><td><div className="trade-cell"><span className={attempt.action === "buy" || attempt.action === "open" ? "buy" : "sell"}>{attempt.action === "buy" || attempt.action === "open" ? <ArrowDownLeft size={15}/> : <ArrowUpRight size={15}/>}</span><div><strong>{attempt.asset}</strong><small>{attempt.source === "copy" ? "Kopya" : attempt.source === "manual" ? "Manuel" : "Sertifikasyon"} · {attempt.action}</small></div></div></td><td>{integrationName(attempt.integrationId)}</td><td><span className={`trade-status ${attempt.reconciliationStatus === "passed" ? "confirmed" : attempt.status}`}>{executionAttemptStatusLabel(attempt)}</span></td><td><div><strong>{attempt.quotedPriceUsd > 0 ? usd(attempt.quotedPriceUsd) : "—"}</strong>{tradeValueUsd > 0 && <small>{preciseUsd(tradeValueUsd)} işlem</small>}</div></td><td>%{attempt.slippagePercent.toFixed(2)} / %{attempt.priceImpactPercent.toFixed(2)}</td><td title={`Ağ: ${preciseUsd(attempt.networkFeeUsd)} · DEX: ${preciseUsd(attempt.dexFeeUsd)}`}>{preciseUsd(attempt.networkFeeUsd + attempt.dexFeeUsd)}</td><td>{attempt.simulationLatencyMs ? `${attempt.simulationLatencyMs} ms` : "—"}</td><td><button className="row-action" onClick={() => setSelected(attempt)} title="Execution ayrıntısını aç"><Eye size={15}/></button></td></tr>;
  })}</tbody></table></div>{selected && <Modal title={`${selected.asset} execution kaydı`} subtitle={`${integrationName(selected.integrationId)} · ${selected.mode}`} onClose={() => setSelected(null)}><div className="detail-grid"><DetailItem label="Durum" value={executionAttemptStatusLabel(selected)} /><DetailItem label="Yerel muhasebe" value={executionAttemptWasNotSubmitted(selected) ? "Gerekmedi" : selected.accountingStatus === "applied" ? "Uygulandı" : "Bekliyor"} /><DetailItem label="Mutabakat" value={executionAttemptWasNotSubmitted(selected) ? "Gerekmedi" : selected.reconciliationStatus === "passed" ? "Geçti" : selected.reconciliationStatus === "failed" ? "Başarısız" : "Bekliyor"} /><DetailItem label="Ağ referansı" value={selected.txHash ?? selected.externalOrderId ?? "—"} /><DetailItem label="Birim fiyat" value={selected.quotedPriceUsd ? usd(selected.quotedPriceUsd) : "—"} /><DetailItem label="İşlem değeri" value={executionMetadataNumber(selected.metadata, "tradeValueUsd") ? preciseUsd(executionMetadataNumber(selected.metadata, "tradeValueUsd")) : "—"} /><DetailItem label="Beklenen çıktı" value={selected.expectedAmountOut ?? "—"} /><DetailItem label="Minimum çıktı" value={selected.minimumAmountOut ?? "—"} /><DetailItem label="Ağ maliyeti" value={preciseUsd(selected.networkFeeUsd)} /><DetailItem label="DEX maliyeti" value={preciseUsd(selected.dexFeeUsd)} />{selectedRentUsd > 0 && <DetailItem label="İade edilebilir hesap kirası" value={`${preciseUsd(selectedRentUsd)} · fee değildir`} />}<DetailItem label="Slippage" value={`%${selected.slippagePercent.toFixed(3)}`} /><DetailItem label="Fiyat etkisi" value={`%${selected.priceImpactPercent.toFixed(3)}`} /><DetailItem label="Hazırlama bakiyesi" value={usd(selected.availableBalanceUsd)} /><DetailItem label="Simülasyon süresi" value={`${selected.simulationLatencyMs} ms`} /></div>{selected.reconciliationDetails && <div className="decision-box"><span>Mutabakat sonucu</span><p>{selected.reconciliationDetails}</p></div>}{selected.errorMessage && <div className="decision-box"><span>Hata</span><p>{selected.errorMessage}</p></div>}<div className="decision-box"><span>Idempotency anahtarı</span><p className="mono">{selected.idempotencyKey}</p></div><div className="decision-box"><span>Teknik metadata</span><p className="mono">{JSON.stringify(selected.metadata)}</p></div></Modal>}</>;
}

function executionMetadataNumber(metadata: unknown, key: string) {
  if (!metadata || typeof metadata !== "object") return 0;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function executionAttemptWasNotSubmitted(attempt: DashboardSnapshot["executionAttempts"][number]) {
  return (attempt.status === "filtered" || attempt.status === "failed")
    && !attempt.submittedAt && !attempt.txHash && !attempt.externalOrderId;
}

function executionAttemptStatusLabel(attempt: DashboardSnapshot["executionAttempts"][number]) {
  if (attempt.status === "filtered") return "Yürütme öncesi filtrelendi";
  if (attempt.status === "simulated") return "Simüle edildi";
  if (attempt.reconciliationStatus === "passed") return "Mutabık";
  if (attempt.reconciliationStatus === "failed") return "Mutabakat hatası";
  if (attempt.status === "submitting") return "Gönderiliyor";
  if (attempt.status === "submitted") return "Gönderildi";
  if (attempt.status === "confirmed") return "Onaylandı";
  if (attempt.status === "preparing") return "Hazırlanıyor";
  if (attempt.status === "stale") return "Belirsiz";
  return "Başarısız";
}

function WalletDetail({ wallet, onClose, onChanged, onNotice }: { wallet: TrackedWallet; onClose: () => void; onChanged: () => void; onNotice: (value: { type: "success" | "error"; message: string }) => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const scores = [["Kârlılık", wallet.scoreBreakdown.profitability], ["Tutarlılık", wallet.scoreBreakdown.consistency], ["Risk kontrolü", wallet.scoreBreakdown.riskControl], ["Kopyalanabilirlik", wallet.scoreBreakdown.copyability], ["Güvenlik", wallet.scoreBreakdown.safety]] as const;
  const mutate = async (method: "PATCH" | "DELETE") => {
    setBusy(true);
    try {
      const response = await fetch(`/api/wallets/${wallet.id}`, { method, headers: { "content-type": "application/json" }, body: method === "PATCH" ? JSON.stringify({ paused: wallet.state !== "paused" }) : undefined });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Cüzdan güncellenemedi.");
      onChanged(); onClose();
      onNotice({ type: "success", message: method === "DELETE" ? "Cüzdan takip listesinden çıkarıldı." : wallet.state === "paused" ? "Cüzdan takibi başlatıldı." : "Cüzdan takibi durduruldu; yeni işlemler izlenmeyecek." });
    } catch (error) { onNotice({ type: "error", message: error instanceof Error ? error.message : "Cüzdan güncellenemedi." }); }
    finally { setBusy(false); }
  };
  return <Modal title={wallet.label} subtitle={shortAddress(wallet.address)} onClose={onClose}><WalletTrackingState wallet={wallet} /><WalletAdditionSummary wallet={wallet} /><div className="score-summary"><strong>{wallet.score}</strong><span>Güncel genel skor</span></div>{wallet.pauseReason && <div className="decision-box"><span>Takibin durdurulma nedeni</span><p>{wallet.pauseReason}</p></div>}<div className="detail-grid"><DetailItem label="Güncel copy Net PnL" value={`${signedUsd(wallet.realizedPnlUsd)} · ${signedWalletPnlPercent(wallet)}`} strong /><DetailItem label="Hesaplanan sermaye" value={usd(walletCopyInvestedUsd(wallet))} /><DetailItem label="Başarılı copy trade" value={wallet.copiedTradeCount.toString()} /><DetailItem label="Gözlenen işlem" value={wallet.totalTrades.toString()} /></div><div className="score-breakdown">{scores.map(([label, score]) => <div key={label}><span>{label}</span><div><i style={{ width: `${score}%` }} /></div><strong>{score}</strong></div>)}</div><p className="detail-note">Net PnL, kapanış beklenmeden açık copy pozisyonların son piyasa fiyatını; kapanmış işlemlerin gerçekleşmiş sonucunu ve işlem maliyetlerini birlikte içerir.</p><div className="wallet-actions"><button disabled={busy} onClick={() => void mutate("PATCH")}>{wallet.state === "paused" ? <PlayCircle size={15} /> : <PauseCircle size={15} />}{wallet.state === "paused" ? "Takibi başlat" : "Takibi durdur"}</button>{confirmDelete ? <button className="danger" disabled={busy} onClick={() => void mutate("DELETE")}><Trash2 size={15} /> Silmeyi onayla</button> : <button className="danger-ghost" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={15} /> Listeden çıkar</button>}</div></Modal>;
}

function WalletAdditionSummary({ wallet }: { wallet: TrackedWallet }) {
  const context = wallet.additionContext;
  if (!context) return <div className="decision-box wallet-origin legacy"><span>Eklenme nedeni</span><p>Bu cüzdan önceki veri sürümünde eklendiği için ekleme anındaki keşif özeti kayıtlı değil.</p></div>;
  return <section className="wallet-origin"><div className="wallet-origin-head"><div><span className="eyebrow">Eklenme nedeni</span><p>{context.reason}</p></div><small>{context.source === "discovery" && context.chainId ? `${integrationName(context.chainId)} keşfi` : "Manuel ekleme"}<br />{dateTime(context.capturedAt)}</small></div>{context.source === "discovery" && <><div className="wallet-origin-metrics"><DetailItem label="Toplam alım" value={usd(context.boughtUsd)} /><DetailItem label="Toplam satış" value={usd(context.soldUsd)} /><DetailItem label="Tahmini net PnL" value={signedUsd(context.estimatedPnlUsd)} strong /><DetailItem label="Ekleme anı ROI" value={`%${context.estimatedPnlPercent.toFixed(2)}`} /><DetailItem label="Swap dağılımı" value={`${context.buyCount} alım · ${context.sellCount} satış`} /><DetailItem label="Token / swap" value={`${context.uniqueTokenCount} / ${context.swapCount}`} /></div>{context.tokens.length > 0 && <div className="wallet-origin-tokens"><h4>Keşifte öne çıkan piyasalar</h4>{context.tokens.map((token) => <div key={token.address}><div><strong>{token.symbol}</strong><code>{shortAddress(token.address)}</code></div><span><small>Alım</small>{usd(token.boughtUsd)}</span><span><small>Satış</small>{usd(token.soldUsd)}</span><span className={token.estimatedPnlUsd >= 0 ? "positive-text" : "negative-text"}><small>PnL</small>{signedUsd(token.estimatedPnlUsd)}</span><span><small>İşlem</small>{token.swapCount}</span>{token.pairAddress && context.chainId && <a className="row-action" href={integrationMarketUrl(context.chainId, token.pairAddress)} target="_blank" rel="noreferrer" title={`${token.symbol} piyasa sayfasını aç`}><ExternalLink size={13} /></a>}</div>)}</div>}</>}</section>;
}

function TradeDetail({ trade, onClose }: { trade: Trade; onClose: () => void }) {
  return <Modal title={`${trade.tokenSymbol} ${trade.side === "buy" ? "alımı" : "satışı"}`} subtitle={`${integrationName(trade.chainId)} · ${trade.source === "copy" ? "Kopya işlem" : "Manuel işlem"}`} onClose={onClose}><div className="detail-grid"><DetailItem label="Brüt değer" value={usd(trade.grossUsd)} /><DetailItem label="Net değer" value={usd(trade.netUsd)} /><DetailItem label="Token miktarı" value={trade.quantity ? trade.quantity.toFixed(8) : "—"} /><DetailItem label="Birim fiyat" value={usd(trade.priceUsd)} /></div><h4 className="detail-heading">Maliyet dağılımı</h4><div className="fee-list"><DetailItem label="DEX ücreti" value={usd(trade.fees.dexFeeUsd)} /><DetailItem label="Gas" value={usd(trade.fees.gasFeeUsd)} /><DetailItem label="Slippage" value={usd(trade.fees.slippageUsd)} /><DetailItem label="Fiyat etkisi" value={usd(trade.fees.priceImpactUsd)} /><DetailItem label="Token vergisi" value={usd(trade.fees.tokenTaxUsd)} /><DetailItem label="Toplam" value={usd(trade.fees.totalUsd)} strong /></div><div className="decision-box"><span>Karar gerekçesi</span><p>{trade.reason}</p></div>{trade.txHash && <a className="explorer-link" href={explorerUrl(trade.chainId, trade.txHash)} target="_blank" rel="noreferrer">Kaynak işlemi explorer’da aç <ExternalLink size={14} /></a>}</Modal>;
}

function Modal({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="detail-modal" role="dialog" aria-modal="true" aria-label={title}><header><div><h3>{title}</h3><p>{subtitle}</p></div><button className="icon-button" onClick={onClose} title="Detayı kapat"><X size={17} /></button></header><div className="modal-body">{children}</div></section></div>;
}

function DetailItem({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <div className={`detail-item ${strong ? "strong" : ""}`}><span>{label}</span><b>{value}</b></div>;
}

function RiskGroup({ title, description, icon: Icon, children }: { title: string; description: string; icon: typeof Gauge; children: React.ReactNode }) {
  return <section className="risk-group"><div className="risk-group-heading"><span><Icon size={18} /></span><div><h3>{title}</h3><p>{description}</p></div></div><div className="risk-fields">{children}</div></section>;
}

function NumberField({ label, value, onChange, prefix, suffix, step = 1 }: { label: string; value: number; onChange: (value: number) => void; prefix?: string; suffix?: string; step?: number }) {
  return <label className="number-field"><span>{label}</span><div>{prefix && <i>{prefix}</i>}<input type="number" value={value} step={step} onChange={(event) => onChange(Number(event.target.value))} />{suffix && <i>{suffix}</i>}</div></label>;
}

function TextListField({ label, value, placeholder, onChange }: { label: string; value: string; placeholder: string; onChange: (value: string) => void }) {
  return <label className="text-list-field"><span>{label}</span><textarea rows={3} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} spellCheck={false} /></label>;
}

function EmptyState({ icon: Icon, title, body }: { icon: typeof Gauge; title: string; body: string }) {
  return <div className="empty-state"><span><Icon size={20} /></span><strong>{title}</strong><p>{body}</p></div>;
}

function DashboardSkeleton() {
  return <div className="skeleton-stack"><div className="skeleton-metrics">{Array.from({ length: 4 }).map((_, index) => <div key={index} />)}</div><div className="skeleton-wide" /><div className="skeleton-columns"><div /><div /></div></div>;
}

function PortfolioMetricSkeleton({ count = 5 }: { count?: number }) {
  return <section className={`portfolio-metric-skeleton count-${count}`} aria-label="Portföy verileri yükleniyor">{Array.from({ length: count }).map((_, index) => <div key={index}><span /><strong /><small /><i /></div>)}</section>;
}

function PageIntroSkeleton() {
  return <div className="page-intro-skeleton"><span /><strong /><small /></div>;
}

function DashboardPanelSkeleton() {
  return <div className="dashboard-panel-skeleton" />;
}

const uiLanguage = (): AppLanguage => typeof document !== "undefined" && document.documentElement.lang === "en" ? "en" : "tr";
const uiLocale = () => localeFor(uiLanguage());
const usd = (value: number) => new Intl.NumberFormat(uiLocale(), { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(value);
const preciseUsd = (value: number) => new Intl.NumberFormat(uiLocale(), { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
const overviewUsd = (value: number) => new Intl.NumberFormat(uiLocale(), { style: "currency", currency: "USD", minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(value);
const wholeUsd = (value: number) => new Intl.NumberFormat(uiLocale(), { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
const compactUsd = (value: number) => new Intl.NumberFormat(uiLocale(), { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);
const signedUsd = (value: number) => `${value >= 0 ? "+" : "−"}${usd(Math.abs(value))}`;
const signedOverviewUsd = (value: number) => `${value >= 0 ? "+" : "−"}${overviewUsd(Math.abs(value))}`;
const walletCopyInvestedUsd = (wallet: TrackedWallet) => Number.isFinite(wallet.copyInvestedUsd) ? wallet.copyInvestedUsd : 0;
const walletCopyPnlPercent = (wallet: TrackedWallet) => {
  if (Number.isFinite(wallet.copyPnlPercent)) return wallet.copyPnlPercent;
  const investedUsd = walletCopyInvestedUsd(wallet);
  return investedUsd > 0 ? (wallet.realizedPnlUsd / investedUsd) * 100 : 0;
};
const signedWalletPnlPercent = (wallet: TrackedWallet) => {
  const value = walletCopyPnlPercent(wallet);
  return `${value >= 0 ? "+" : "−"}%${Math.abs(value).toFixed(2)}`;
};
const formatTokenQuantity = (value: number) => new Intl.NumberFormat(uiLocale(), { maximumFractionDigits: 6 }).format(value);
const dateTime = (value: string) => new Intl.DateTimeFormat(uiLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const percentOf = (value: number, total: number) => total ? ((value / total) * 100).toFixed(0) : "0";
const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const normalizeAddress = (chainId: ChainId, address: string) => chainId === "solana" ? address.trim() : address.toLowerCase();
const explorerUrl = (chainId: ChainId, txHash: string) => integrationExplorerUrl(chainId, txHash);
const signedPercent = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(3)}%`;
const hypercoreActionLabel = (action: DashboardSnapshot["hypercoreTrades"][number]["action"]) => ({ open: "Açıldı", increase: "Artırıldı", reduce: "Azaltıldı", close: "Kapatıldı", spot_buy: "Spot alım", spot_sell: "Spot satış", skipped: "Atlandı" })[action];
const relativeTime = (date: string) => {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return "Az önce";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} dk önce`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} sa önce`;
  return new Intl.DateTimeFormat(uiLocale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(date));
};
