"use client";

import Image from "next/image";
import { useCallback, useEffect, useState, type FormEvent } from "react";
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
} from "@/lib/domain/types";
import { MIN_DISCOVERY_BOUGHT_USD, MIN_DISCOVERY_PNL_USD } from "@/lib/engine/discovery-pnl";
import { useDocumentTranslation } from "@/lib/client-translation";
import { localeFor } from "@/lib/i18n";

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

type View = "overview" | "wallets" | "discovery" | "trades" | "analytics" | "consensus" | "backtest" | "system" | "risk";

const navigation: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Genel Bakış", icon: LayoutDashboard },
  { id: "wallets", label: "Cüzdanlar", icon: WalletCards },
  { id: "discovery", label: "Cüzdan Keşfi", icon: Radar },
  { id: "trades", label: "İşlemler", icon: Activity },
  { id: "analytics", label: "Performans", icon: BarChart3 },
  { id: "consensus", label: "Konsensüs", icon: Layers3 },
  { id: "backtest", label: "Replay", icon: History },
  { id: "system", label: "Sistem Sağlığı", icon: ServerCog },
  { id: "risk", label: "Risk Ayarları", icon: SlidersHorizontal },
];

const ACTIVE_VIEW_STORAGE_KEY = "neraxon.activeView";
const LEGACY_ACTIVE_VIEW_STORAGE_KEY = "copydesk.activeView";
const DASHBOARD_POLL_INTERVAL_MS = 30_000;
const scrollPageToTop = () => window.scrollTo({ top: 0, left: 0, behavior: "auto" });

export function DashboardApp() {
  const [data, setData] = useState<DashboardSnapshot | null>(null);
  const [language, setLanguage] = useState<AppLanguage>("tr");
  const [view, setView] = useState<View>("overview");
  const [mobileMenu, setMobileMenu] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const refresh = useCallback(async ({
    silent = false,
    refreshMarkets = false,
    showSuccess = true,
  }: {
    silent?: boolean;
    refreshMarkets?: boolean;
    showSuccess?: boolean;
  } = {}) => {
    if (!silent) setLoading(true);
    try {
      const endpoint = refreshMarkets ? "/api/dashboard?refreshMarkets=true" : "/api/dashboard";
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error("Panel verileri alınamadı.");
      const snapshot = await response.json() as DashboardSnapshot;
      document.documentElement.lang = snapshot.language;
      setLanguage(snapshot.language);
      setData(snapshot);
      if (refreshMarkets && showSuccess) {
        setNotice({ type: "success", message: "Portföy bakiyeleri güncel piyasa fiyatlarıyla yenilendi." });
      }
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Bağlantı hatası." });
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useDocumentTranslation(language);

  useEffect(() => {
    const initialTimer = window.setTimeout(
      () => void refresh({ refreshMarkets: true, showSuccess: false }),
      0,
    );
    const savedView = window.localStorage.getItem(ACTIVE_VIEW_STORAGE_KEY)
      ?? window.localStorage.getItem(LEGACY_ACTIVE_VIEW_STORAGE_KEY);
    if (savedView) {
      window.localStorage.setItem(ACTIVE_VIEW_STORAGE_KEY, savedView);
      window.localStorage.removeItem(LEGACY_ACTIVE_VIEW_STORAGE_KEY);
    }
    const viewTimer = navigation.some((item) => item.id === savedView)
      ? window.setTimeout(() => setView(savedView as View), 0)
      : null;
    return () => { window.clearTimeout(initialTimer); if (viewTimer) window.clearTimeout(viewTimer); };
  }, [refresh]);

  const hasRunningChain = data?.chains.some((chain) => chain.status === "running") ?? false;
  useEffect(() => {
    if (!hasRunningChain) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh({ silent: true });
    }, DASHBOARD_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasRunningChain, refresh]);

  const navigate = useCallback((nextView: View) => {
    setView(nextView);
    window.localStorage.setItem(ACTIVE_VIEW_STORAGE_KEY, nextView);
    setMobileMenu(false);
    scrollPageToTop();
  }, []);

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
      setNotice({ type: "success", message: `${chainId === "base" ? "Base" : "Ethereum"} botu ${action === "start" ? "çalıştırıldı" : "durduruldu"}.` });
      await refresh({ silent: true });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "İşlem başarısız." });
    } finally {
      setBusyKey(null);
    }
  };

  const controlAll = async () => {
    if (!data) return;
    const shouldStart = data.chains.every((chain) => chain.status !== "running");
    setBusyKey("all");
    try {
      await Promise.all(data.chains.map(async (chain) => {
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
      setNotice({ type: "success", message: shouldStart ? "Tüm ağ botları çalıştırıldı." : "Tüm ağ botları durduruldu." });
      await refresh({ silent: true });
    } catch (error) {
      setNotice({ type: "error", message: error instanceof Error ? error.message : "Toplu işlem başarısız." });
    } finally {
      setBusyKey(null);
    }
  };

  const activeLabel = navigation.find((item) => item.id === view)?.label ?? "Genel Bakış";
  const allRunning = data?.chains.every((chain) => chain.status === "running") ?? false;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><Image src="/neraxon-symbol-v2.png" alt="" width={34} height={34} priority /></div>
          <div><strong>NERAXON</strong><span>EVM çalışma alanı</span></div>
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
          <div className="mode-panel">
            <div className="mode-row"><span className="pulse-dot" /><strong>Paper mod</strong></div>
            <p>Gerçek fon kullanılmıyor</p>
          </div>
          <div className="local-state"><ShieldCheck size={15} /><span>Yalnızca bu Mac</span></div>
        </div>
      </aside>

      {mobileMenu && <button className="backdrop" onClick={() => setMobileMenu(false)} aria-label="Menüyü kapat" />}

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-title">
            <button className="icon-button menu-button" onClick={() => setMobileMenu(true)} title="Menüyü aç"><Menu size={20} /></button>
            <div><span>Çalışma alanı</span><h1>{activeLabel}</h1></div>
          </div>
          <div className="topbar-actions">
            <button className="icon-button refresh-button" disabled={loading} onClick={() => void refresh({ refreshMarkets: true })} title="Bakiyeleri ve fiyatları yenile"><RefreshCw size={17} className={loading ? "spin" : ""} /></button>
            <button className={`primary-control ${allRunning ? "stop" : ""}`} disabled={!data || busyKey !== null} onClick={() => void controlAll()}>
              {busyKey === "all" ? <RefreshCw size={16} className="spin" /> : allRunning ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
              {allRunning ? "Tümünü durdur" : "Tümünü çalıştır"}
            </button>
          </div>
        </header>

        <div className="content-area">
          {!data && loading ? <DashboardSkeleton /> : data && (
            <>
              {view === "overview" && <Overview data={data} busyKey={busyKey} onControl={controlChain} onNavigate={navigate} />}
              {view === "wallets" && <WalletsView wallets={data.wallets} onChanged={() => refresh({ silent: true })} onNotice={setNotice} />}
              {view === "discovery" && <DiscoveryView wallets={data.wallets} onChanged={() => refresh({ silent: true })} onNotice={setNotice} />}
              {view === "trades" && <TradesView data={data} onChanged={() => refresh({ silent: true })} onNotice={setNotice} />}
              {view === "analytics" && <AnalyticsView data={data} />}
              {view === "consensus" && <ConsensusView data={data} />}
              {view === "backtest" && <BacktestView />}
              {view === "system" && <SystemView data={data} />}
              {view === "risk" && <RiskView data={data} onChanged={() => refresh({ silent: true })} onNotice={setNotice} />}
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
  const pnl = data.equityUsd - data.startingBalanceUsd;
  const runningCount = data.chains.filter((chain) => chain.status === "running").length;
  return (
    <div className="view-stack">
      <section className="metric-grid" aria-label="Portföy özeti">
        <Metric label="Toplam portföy" value={overviewUsd(data.equityUsd)} meta={`${signedOverviewUsd(pnl)} toplam`} icon={CircleDollarSign} tone={pnl >= 0 ? "positive" : "negative"} />
        <Metric label="Kullanılabilir nakit" value={overviewUsd(data.cashBalanceUsd)} meta={`%${percentOf(data.cashBalanceUsd, data.equityUsd)} portföy`} icon={WalletCards} />
        <Metric label="Gerçekleşmemiş PnL" value={signedOverviewUsd(data.unrealizedPnlUsd)} meta={`${data.positions.length} açık pozisyon`} icon={data.unrealizedPnlUsd >= 0 ? TrendingUp : TrendingDown} tone={data.unrealizedPnlUsd >= 0 ? "positive" : "negative"} />
        <Metric label="Toplam maliyet" value={overviewUsd(data.totalFeesUsd)} meta="Gas, fee ve kayma" icon={Gauge} tone="warning" />
      </section>

      <section className="section-block">
        <div className="section-heading"><div><span className="eyebrow">Canlı altyapı</span><h2>Ağ botları</h2></div><span className="section-meta">{runningCount}/{data.chains.length} çalışıyor</span></div>
        <div className="chain-grid">
          {data.chains.map((chain) => <ChainCard key={chain.id} chain={chain} busy={busyKey === chain.id} onControl={onControl} />)}
        </div>
      </section>

      <div className="overview-grid">
        <section className="section-block positions-preview">
          <div className="section-heading"><div><span className="eyebrow">Portföy</span><h2>Açık pozisyonlar</h2></div><button className="text-button" onClick={() => onNavigate("trades")}>Tümünü gör <ChevronRight size={15} /></button></div>
          {data.positions.length ? <PositionList positions={data.positions.slice(0, 4)} lots={data.positionLots} usdFormatter={overviewUsd} /> : <EmptyState icon={CircleDollarSign} title="Henüz açık pozisyon yok" body="Manuel paper işlem açabilir veya bir cüzdanı izlemeye başlayabilirsin." />}
        </section>
        <section className="section-block activity-preview">
          <div className="section-heading"><div><span className="eyebrow">Audit akışı</span><h2>Son hareketler</h2></div><span className="live-label"><span /> Gerçek zamanlı</span></div>
          <EventList events={data.events.slice(0, 6)} />
        </section>
      </div>
    </div>
  );
}

function ChainCard({ chain, busy, onControl }: { chain: ChainRuntime; busy: boolean; onControl: (id: ChainId, action: "start" | "stop") => Promise<void> }) {
  const running = chain.status === "running";
  return (
    <article className="chain-card">
      <div className="chain-top">
        <div className={`chain-logo ${chain.id}`}>{chain.id === "ethereum" ? "Ξ" : "B"}</div>
        <div className="chain-name"><h3>{chain.name}</h3><StatusBadge status={chain.status} /></div>
        <button className={`chain-control ${running ? "pause" : "play"}`} disabled={busy || chain.status === "starting" || chain.status === "stopping"} onClick={() => void onControl(chain.id, running ? "stop" : "start")} title={running ? `${chain.name} botunu durdur` : `${chain.name} botunu çalıştır`}>
          {busy ? <RefreshCw size={17} className="spin" /> : running ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
        </button>
      </div>
      <div className="chain-stats">
        <div><span>Son blok</span><strong>{chain.lastBlock ? chain.lastBlock.toLocaleString(uiLocale()) : "—"}</strong></div>
        <div><span>RPC gecikmesi</span><strong>{chain.latencyMs !== null ? `${chain.latencyMs} ms` : "—"}</strong></div>
        <div><span>İzleme</span><strong>{running ? "Aktif" : "Kapalı"}</strong></div>
      </div>
      {chain.errorMessage && <p className="chain-error">{chain.errorMessage}</p>}
    </article>
  );
}

function WalletsView({ wallets, onChanged, onNotice }: { wallets: TrackedWallet[]; onChanged: () => void; onNotice: (value: { type: "success" | "error"; message: string }) => void }) {
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = wallets.filter((wallet) => `${wallet.label} ${wallet.address}`.toLowerCase().includes(query.toLowerCase()));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const response = await fetch("/api/wallets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, label }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Cüzdan eklenemedi.");
      setAddress(""); setLabel(""); onChanged();
      onNotice({ type: "success", message: "Cüzdan gözlem listesine eklendi." });
    } catch (error) { onNotice({ type: "error", message: error instanceof Error ? error.message : "Cüzdan eklenemedi." }); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="view-stack">
      <section className="page-intro"><div><span className="eyebrow">Takip merkezi</span><h2>Cüzdanlar</h2><p>Eklediğin adresler iki ağda izlenir; skor, gözlenen davranışlarla zaman içinde güncellenir.</p></div></section>
      <section className="wallet-layout">
        <form className="form-panel" onSubmit={submit}>
          <div className="panel-title"><Plus size={17} /><h3>Yeni cüzdan</h3></div>
          <label><span>Etiket</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Örn. Base swing 01" maxLength={40} /></label>
          <label><span>EVM adresi</span><input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="0x…" className="mono" required /></label>
          <button className="submit-button" disabled={submitting}>{submitting ? <RefreshCw size={16} className="spin" /> : <Plus size={16} />} Gözleme ekle</button>
          <p className="form-note"><ShieldCheck size={14} /> Yeni cüzdanlar 50 başlangıç skoruyla gözlem moduna alınır.</p>
        </form>
        <div className="table-panel wallet-table-panel">
          <div className="table-toolbar"><div><h3>Takip listesi</h3><span>{wallets.length} cüzdan</span></div><label className="search-box"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ara" /></label></div>
          {filtered.length ? <WalletTable wallets={filtered} onChanged={onChanged} onNotice={onNotice} /> : <EmptyState icon={WalletCards} title={wallets.length ? "Sonuç bulunamadı" : "Takip listesi boş"} body={wallets.length ? "Arama ifadesini değiştirerek tekrar dene." : "İlk başarılı cüzdanını soldaki formdan ekleyebilirsin."} />}
        </div>
      </section>
    </div>
  );
}

function DiscoveryView({ wallets, onChanged, onNotice }: { wallets: TrackedWallet[]; onChanged: () => void; onNotice: (value: { type: "success" | "error"; message: string }) => void }) {
  const [chainId, setChainId] = useState<ChainId>("base");
  const [scans, setScans] = useState<Partial<Record<ChainId, WalletDiscoveryScan>>>({});
  const [scanning, setScanning] = useState<ChainId | null>(null);
  const [addingAddress, setAddingAddress] = useState<string | null>(null);
  const [selectedTokens, setSelectedTokens] = useState<Partial<Record<ChainId, string | null>>>({});
  const [sortBy, setSortBy] = useState<DiscoverySort>("score");
  const scan = scans[chainId];
  const visibleScan = scan && Array.isArray(scan.topGainers) ? scan : undefined;
  const selectedTokenAddress = selectedTokens[chainId] ?? null;
  const selectedToken = visibleScan?.topGainers.find((token) => token.address === selectedTokenAddress);
  const rankedCandidates: Array<{ candidate: WalletDiscoveryCandidate; performance: DiscoveryTokenPerformance | null }> = (visibleScan?.candidates ?? [])
    .map((candidate) => ({
      candidate,
      performance: selectedTokenAddress
        ? candidate.gainerTokens.find((token) => token.address === selectedTokenAddress) ?? null
        : null,
    }))
    .filter(({ performance }) => !selectedTokenAddress || Boolean(performance && performance.boughtUsd >= MIN_DISCOVERY_BOUGHT_USD && performance.estimatedPnlUsd >= MIN_DISCOVERY_PNL_USD))
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
  const trackedAddresses = new Set(wallets.map((wallet) => wallet.address.toLowerCase()));

  const runScan = async () => {
    setScanning(chainId);
    try {
      const response = await fetch("/api/discovery/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chainId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Cüzdan keşfi tamamlanamadı.");
      const nextScan = result.scan as WalletDiscoveryScan;
      setScans((current) => ({ ...current, [chainId]: nextScan }));
      setSelectedTokens((current) => ({ ...current, [chainId]: null }));
      onNotice({ type: "success", message: `${chainId === "base" ? "Base" : "Ethereum"} cüzdan keşfi tamamlandı.` });
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
          label: `${chainId === "base" ? "Base" : "Ethereum"} keşif · ${candidate.score}`,
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
      onNotice({ type: "success", message: "Keşfedilen cüzdan takip listesine eklendi." });
    } catch (error) {
      onNotice({ type: "error", message: error instanceof Error ? error.message : "Cüzdan takip listesine eklenemedi." });
    } finally {
      setAddingAddress(null);
    }
  };

  return (
    <div className="view-stack">
      <section className="page-intro"><div><span className="eyebrow">On-chain aday havuzu</span><h2>Cüzdan Keşfi</h2><p>DexScreener pool verisiyle son 24 saatin token akışını tarar; EOA doğrulamalı cüzdanları skor, swap sayısı, net PnL, alım veya satış tutarına göre sıralamana izin verir.</p></div></section>
      <section className="discovery-controls">
        <div className="discovery-chain-tabs" role="tablist" aria-label="Keşif ağı">
          {(["base", "ethereum"] as ChainId[]).map((id) => <button type="button" role="tab" aria-selected={chainId === id} className={chainId === id ? "selected" : ""} key={id} onClick={() => setChainId(id)}><span className={`chain-logo ${id}`}>{id === "base" ? "B" : "Ξ"}</span><span><strong>{id === "base" ? "Base" : "Ethereum"}</strong><small>{scans[id] ? `${scans[id]?.candidates.length} aday bulundu` : "Henüz taranmadı"}</small></span></button>)}
        </div>
        <button className="discovery-run" type="button" disabled={scanning !== null} onClick={() => void runScan()}>{scanning === chainId ? <RefreshCw size={17} className="spin" /> : <Radar size={17} />} {scanning === chainId ? "24 saat taranıyor" : `${chainId === "base" ? "Base" : "Ethereum"} taramasını çalıştır`}</button>
      </section>
      {visibleScan ? <>
        <div className="scan-summary"><span><strong>{rankedCandidates.length}</strong> uygun cüzdan</span><span><strong>$100+</strong> alım filtresi</span><span><strong>$100+</strong> net kâr filtresi</span><span><strong>{visibleScan.topGainers.length}</strong> yükselen token</span><span><strong>{visibleScan.transferSampleSize}</strong> token transferi</span><span>Kaynak: <strong>DexScreener + Alchemy</strong></span><span>Güncellendi: <strong>{relativeTime(visibleScan.generatedAt)}</strong></span></div>
        <div className="gainer-strip" role="group" aria-label="24 saatlik örneklemde yükselen tokenlar">{visibleScan.topGainers.map((token, index) => <div className={`gainer-card ${token.address === selectedTokenAddress ? "selected" : ""}`} key={token.address}><button type="button" className="gainer-filter" aria-pressed={token.address === selectedTokenAddress} onClick={() => setSelectedTokens((current) => ({ ...current, [chainId]: current[chainId] === token.address ? null : token.address }))}><span>#{index + 1}</span><strong>{token.symbol}</strong><b>+%{token.priceChange24hPercent.toFixed(1)}</b><small>{compactUsd(token.volume24hUsd)} hacim · {compactUsd(token.liquidityUsd)} likidite</small></button><a className="gainer-dex-link" href={dexScreenerUrl(chainId, token.pairAddress)} target="_blank" rel="noreferrer" title={`${token.symbol} tokenını DexScreener'da aç`} aria-label={`${token.symbol} tokenını DexScreener'da aç`}><ExternalLink size={13} /></a></div>)}</div>
        <section className="discovery-results">
          <div className="section-heading"><div><span className="eyebrow">Günlük sıralama</span><h2>{selectedToken ? `${selectedToken.symbol} tokenındaki aday cüzdanlar` : "10 tokendaki aday cüzdanlar"}</h2></div><div className="discovery-heading-actions">{selectedToken && <button type="button" className="text-button" onClick={() => setSelectedTokens((current) => ({ ...current, [chainId]: null }))}>Tüm cüzdanları göster</button>}<label className="sort-control"><span>Sırala</span><select value={sortBy} onChange={(event) => setSortBy(event.target.value as DiscoverySort)}><option value="score">Skor: yüksekten düşüğe</option><option value="swaps">24s swap: yüksekten düşüğe</option><option value="pnl">Net PnL: yüksekten düşüğe</option><option value="bought">Alım: yüksekten düşüğe</option><option value="sold">Satış: yüksekten düşüğe</option></select></label></div></div>
          {rankedCandidates.length ? <div className="candidate-list">{rankedCandidates.map(({ candidate, performance }, index) => {
            const tracked = trackedAddresses.has(candidate.address.toLowerCase());
            const boughtUsd = performance?.boughtUsd ?? candidate.boughtUsd;
            const soldUsd = performance?.soldUsd ?? candidate.soldUsd;
            const currentValueUsd = performance?.currentValueUsd ?? candidate.currentValueUsd;
            const estimatedPnlUsd = performance?.estimatedPnlUsd ?? candidate.estimatedPnlUsd;
            const gasCostUsd = performance?.gasCostUsd ?? candidate.gasCostUsd;
            const pnlPercent = boughtUsd > 0 ? estimatedPnlUsd / boughtUsd * 100 : 0;
            const tokenLabel = performance?.symbol ?? candidate.gainerTokens.map((token) => token.symbol).join(", ");
            return <article className="candidate-row" key={candidate.address}>
              <div className="candidate-rank">{index + 1}</div>
              <div className="candidate-wallet"><strong>{shortAddress(candidate.address)}</strong><code>{candidate.address}</code><span>{tokenLabel} · {performance?.swapCount ?? candidate.swapCount} swap · {relativeTime(candidate.lastActiveAt)} aktif</span></div>
              <div className="candidate-score"><strong>{candidate.score}</strong><span>Keşif skoru</span></div>
              <div className="candidate-metrics financial"><div><strong title={`Tam tutar: ${usd(boughtUsd)}`}>{descriptiveUsd(boughtUsd)}</strong><span>Toplam alım</span></div><div><strong title={`Tam tutar: ${usd(soldUsd)}`}>{descriptiveUsd(soldUsd)}</strong><span>Toplam satış</span></div><div><strong title={`Tam tutar: ${usd(currentValueUsd)}`}>{descriptiveUsd(currentValueUsd)}</strong><span>Elde kalan değer</span></div><div><strong className={estimatedPnlUsd >= 0 ? "positive-text" : "negative-text"} title={`Tam tutar: ${signedUsd(estimatedPnlUsd)}`}>{signedDescriptiveUsd(estimatedPnlUsd)}</strong><span>Net PnL · %{pnlPercent.toFixed(1)} · Gas {usd(gasCostUsd)}</span></div></div>
              <div className="candidate-bars"><DiscoveryBar label="Kârlılık" value={candidate.scoreBreakdown.profitability} /><DiscoveryBar label="Aktivite" value={candidate.scoreBreakdown.activity} /><DiscoveryBar label="Çeşitlilik" value={candidate.scoreBreakdown.diversity} /><DiscoveryBar label="Güncellik" value={candidate.scoreBreakdown.freshness} /></div>
              <div className="candidate-actions">{candidate.sampleTxHashes[0] && <a href={explorerUrl(chainId, candidate.sampleTxHashes[0])} target="_blank" rel="noreferrer" title="Örnek işlemi explorer'da aç"><ExternalLink size={15} /></a>}<button type="button" disabled={tracked || addingAddress === candidate.address} onClick={() => void addCandidate(candidate)}>{addingAddress === candidate.address ? <RefreshCw size={15} className="spin" /> : tracked ? <CheckCircle2 size={15} /> : <UserPlus size={15} />}{tracked ? "Takipte" : "Takibe ekle"}</button></div>
            </article>;
          })}</div> : <EmptyState icon={Radar} title={selectedToken ? "Bu token için uygun cüzdan bulunamadı" : "10 tokenda uygun cüzdan bulunamadı"} body="Son 24 saatte en az iki pool bağlantılı alım-satım, 100 USD alım ve gas sonrası 100 USD net kâr şartlarını sağlayan EOA cüzdan yok." />}
        </section>
      </> : <EmptyState icon={Radar} title={`${chainId === "base" ? "Base" : "Ethereum"} keşfi hazır`} body="Son 24 saatlik transfer örneklemini analiz etmek için ağ taramasını çalıştır." />}
    </div>
  );
}

function DiscoveryBar({ label, value }: { label: string; value: number }) {
  return <div><span>{label}</span><i><b style={{ width: `${value}%` }} /></i><strong>{value}</strong></div>;
}

function TradesView({ data, onChanged, onNotice }: { data: DashboardSnapshot; onChanged: () => void; onNotice: (value: { type: "success" | "error"; message: string }) => void }) {
  const [tradeSelection, setTradeSelection] = useState<{ position: Position; version: number } | null>(null);
  const selectPosition = (position: Position) => {
    setTradeSelection((current) => ({ position, version: (current?.version ?? 0) + 1 }));
  };
  return (
    <div className="view-stack">
      <section className="page-intro"><div><span className="eyebrow">Paper işlem masası</span><h2>İşlemler</h2><p>Emir önizlemesi risk motorundan geçer; simüle edilen bütün maliyetler işlem kaydına işlenir.</p></div><span className="paper-badge"><span /> Paper bakiye {usd(data.cashBalanceUsd)}</span></section>
      <section className="trade-layout">
        <ManualTradeForm key={tradeSelection?.version ?? 0} positions={data.positions} initialPosition={tradeSelection?.position ?? null} onChanged={onChanged} onNotice={onNotice} />
        <div className="section-block"><div className="section-heading"><div><span className="eyebrow">Varlıklar</span><h2>Açık pozisyonlar</h2></div></div>{data.positions.length ? <PositionList positions={data.positions} lots={data.positionLots} onSelect={selectPosition} /> : <EmptyState icon={CircleDollarSign} title="Açık pozisyon yok" body="Paper alım yaptığında pozisyon burada görünecek." />}</div>
      </section>
      <section className="table-panel"><div className="table-toolbar"><div><h3>İşlem geçmişi</h3><span>{data.trades.length} kayıt</span></div></div>{data.trades.length ? <TradeTable trades={data.trades} /> : <EmptyState icon={Activity} title="Henüz işlem yok" body="İlk paper işlemin bütün maliyetleriyle burada listelenecek." />}</section>
    </div>
  );
}

function ManualTradeForm({ positions, initialPosition, onChanged, onNotice }: { positions: Position[]; initialPosition: Position | null; onChanged: () => void; onNotice: (value: { type: "success" | "error"; message: string }) => void }) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [chainId, setChainId] = useState<ChainId>(initialPosition?.chainId ?? "base");
  const [tokenAddress, setTokenAddress] = useState(initialPosition?.tokenAddress ?? "");
  const [tokenQuote, setTokenQuote] = useState<TokenQuotePreview | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteVersion, setQuoteVersion] = useState(0);
  const [allocationPercent, setAllocationPercent] = useState(7.5);
  const [sellPercent, setSellPercent] = useState(100);
  const [slippagePercent, setSlippagePercent] = useState(0.5);
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
    if (!/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) return;
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
      const response = await fetch("/api/trades/manual", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chainId, side, tokenAddress, allocationPercent: side === "buy" ? allocationPercent : undefined, sellPercent: side === "sell" ? sellPercent : undefined, slippagePercent }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? result.trade?.reason ?? "İşlem tamamlanamadı.");
      const tokenSymbol = tokenQuote?.symbol ?? selectedSellPosition?.tokenSymbol ?? "Token";
      onChanged(); onNotice({ type: "success", message: `${tokenSymbol} paper ${side === "buy" ? "alımı" : "satışı"} tamamlandı.` });
      setQuoteVersion((value) => value + 1);
    } catch (error) { onChanged(); onNotice({ type: "error", message: error instanceof Error ? error.message : "İşlem tamamlanamadı." }); }
    finally { setSubmitting(false); }
  };

  return (
    <form className="form-panel trade-form" onSubmit={submit}>
      <div className="segmented"><button type="button" className={side === "buy" ? "selected buy" : ""} onClick={() => changeSide("buy")}><ArrowDownLeft size={16} /> Al</button><button type="button" className={side === "sell" ? "selected sell" : ""} onClick={() => changeSide("sell")}><ArrowUpRight size={16} /> Sat</button></div>
      {side === "buy" ? <>
        <label><span>Ağ</span><select value={chainId} onChange={(event) => { setChainId(event.target.value as ChainId); setTokenQuote(null); setQuoteError(null); }}><option value="base">Base</option><option value="ethereum">Ethereum</option></select></label>
        <label><span>Token kontratı</span><input value={tokenAddress} onChange={(event) => { setTokenAddress(event.target.value.trim()); setTokenQuote(null); setQuoteError(null); setQuoteLoading(false); }} placeholder="0x…" className="mono" required /></label>
      </> : <label><span>Satılacak pozisyon</span><select value={selectedSellPosition ? positionKey(selectedSellPosition) : ""} onChange={(event) => { const position = positions.find((item) => positionKey(item) === event.target.value); if (position) choosePosition(position); }} disabled={!positions.length} required><option value="" disabled>{positions.length ? "Pozisyon seç" : "Açık pozisyon yok"}</option>{positions.map((position) => <option key={position.id} value={positionKey(position)}>{position.tokenSymbol} · {position.sourceWalletLabel ?? "Manuel"} · {position.chainId === "base" ? "Base" : "Ethereum"} · {position.quantity.toFixed(4)}</option>)}</select></label>}
      {quoteLoading && <div className="token-loading"><RefreshCw size={16} className="spin" /><span>Kontrat ve piyasa verileri doğrulanıyor…</span></div>}
      {quoteError && <div className="token-quote-error"><AlertTriangle size={16} /><span>{quoteError}{side === "sell" && selectedSellPosition ? " Satış, açık pozisyonun son fiyatıyla gönderilebilir." : ""}</span><button type="button" onClick={refreshQuote} title="Token bilgisini yeniden dene"><RefreshCw size={14} /></button></div>}
      {tokenQuote && <div className="token-quote">
        <div className="token-quote-head"><span className="token-symbol-mark">{tokenQuote.symbol.slice(0, 2).toUpperCase()}</span><div><strong>{tokenQuote.name}</strong><small>{tokenQuote.symbol} · {tokenQuote.decimals} ondalık · {chainId === "base" ? "Base" : "Ethereum"}</small></div><button type="button" onClick={refreshQuote} title="Piyasa verilerini yenile"><RefreshCw size={14} /></button></div>
        <code className="token-contract-line" title={tokenQuote.address}>{shortAddress(tokenQuote.address)}</code>
        <div className="token-quote-grid"><div><span>Güncel fiyat</span><strong>{usd(tokenQuote.market.priceUsd)}</strong></div><div><span>Market değeri</span><strong>{tokenQuote.market.marketCapUsd ? compactUsd(tokenQuote.market.marketCapUsd) : "Veri yok"}</strong></div><div><span>Likidite</span><strong>{compactUsd(tokenQuote.market.liquidityUsd)}</strong></div><div><span>24s hacim</span><strong>{compactUsd(tokenQuote.market.volume24hUsd)}</strong></div><div><span>DEX</span><strong>{tokenQuote.market.dexId}</strong></div><div><span>Tahmini gas</span><strong>{usd(tokenQuote.gas.feeUsd)}</strong></div></div>
        <div className={`token-safety ${tokenQuote.safety.approved ? "approved" : "rejected"}`}>{tokenQuote.safety.approved ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}<span><strong>Güvenlik skoru {tokenQuote.safety.score}/100</strong>{tokenQuote.safety.warnings.length ? tokenQuote.safety.warnings.join(" ") : tokenQuote.safety.reason}</span></div>
        <div className="token-checks">{tokenQuote.safety.checks.map((check) => <div className={check.status} key={check.label}><i/><span><strong>{check.label}</strong><small>{check.detail}</small></span></div>)}</div>
      </div>}
      {side === "buy" ? <label className="range-field"><span><b>Pozisyon oranı</b><strong>%{allocationPercent}</strong></span><input type="range" min="5" max="10" step="0.5" value={allocationPercent} onChange={(event) => setAllocationPercent(Number(event.target.value))} /></label> : <>
        <label className="range-field sell-range"><span><b>Satış oranı</b><strong>%{sellPercent}</strong></span><input type="range" min="1" max="100" step="1" value={sellPercent} onChange={(event) => setSellPercent(Number(event.target.value))} /></label>
        <div className="sell-presets" aria-label="Hızlı satış oranları">{[25, 50, 75, 100].map((percent) => <button type="button" className={sellPercent === percent ? "selected" : ""} key={percent} onClick={() => setSellPercent(percent)}>%{percent}</button>)}</div>
        <div className={`position-check ${selectedSellPosition ? "found" : ""}`}>{selectedSellPosition ? <><strong>{estimatedSellQuantity.toFixed(6)} {selectedSellPosition.tokenSymbol}</strong><span>Yaklaşık {usd(estimatedSellQuantity * (tokenQuote?.market.priceUsd ?? selectedSellPosition.currentPriceUsd))} değerinde satış emri</span></> : "Satış için açık bir pozisyon seç."}</div>
      </>}
      <label className="range-field"><span><b>Slippage</b><strong>%{slippagePercent}</strong></span><input type="range" min="0.1" max="5" step="0.1" value={slippagePercent} onChange={(event) => setSlippagePercent(Number(event.target.value))} /></label>
      <button className={`submit-button ${side === "sell" ? "sell" : ""}`} disabled={submitDisabled}>{submitting ? <RefreshCw size={16} className="spin" /> : side === "buy" ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />} Paper {side === "buy" ? "alım" : "satış"} yap</button>
    </form>
  );
}

function AnalyticsView({ data }: { data: DashboardSnapshot }) {
  const analytics = data.analytics;
  return <div className="view-stack"><section className="page-intro"><div><span className="eyebrow">Gerçekleşen sonuçlar</span><h2>Performans</h2><p>Ücretler, gerçekleşme gecikmesi ve kapatılan lot sonuçları dahil hesaplanır.</p></div></section><section className="metric-grid"><Metric label="Tamamlanan işlem" value={analytics.confirmedTrades.toString()} meta="Alım ve satış" icon={Activity} /><Metric label="Kazanma oranı" value={`%${analytics.winRate.toFixed(1)}`} meta="Kapanan lotlar" icon={TrendingUp} tone={analytics.winRate >= 50 ? "positive" : "warning"} /><Metric label="Profit factor" value={analytics.profitFactor.toFixed(2)} meta="Brüt kâr / brüt zarar" icon={Gauge} /><Metric label="Maksimum düşüş" value={`%${analytics.maxDrawdownPercent.toFixed(2)}`} meta={`Ort. gecikme ${analytics.averageExecutionDelayMs} ms`} icon={TrendingDown} tone="negative" /></section><PerformanceTable title="Token performansı" rows={analytics.byToken} /><PerformanceTable title="Cüzdan performansı" rows={analytics.byWallet} /><PerformanceTable title="Ağ performansı" rows={analytics.byChain} /></div>;
}

function PerformanceTable({ title, rows }: { title: string; rows: DashboardSnapshot["analytics"]["byToken"] }) {
  return <section className="table-panel performance-panel"><div className="table-toolbar"><div><h3>{title}</h3><span>{rows.length} kırılım</span></div></div>{rows.length ? <div className="table-scroll"><table className="performance-table"><colgroup><col className="performance-source"/><col/><col/><col/><col/><col/></colgroup><thead><tr><th>Kaynak</th><th>İşlem</th><th>Kazanma</th><th>Net PnL</th><th>Ücret</th><th>Gecikme</th></tr></thead><tbody>{rows.map((row) => <tr key={row.key}><td><strong title={row.label}>{row.label}</strong></td><td>{row.tradeCount}</td><td>%{row.winRate.toFixed(1)}</td><td className={row.realizedPnlUsd >= 0 ? "positive-text" : "negative-text"}>{signedUsd(row.realizedPnlUsd)}</td><td>{usd(row.feesUsd)}</td><td>{row.averageExecutionDelayMs} ms</td></tr>)}</tbody></table></div> : <EmptyState icon={BarChart3} title="Henüz yeterli veri yok" body="Tamamlanan paper işlemler performans kırılımlarını oluşturacak." />}</section>;
}

function ConsensusView({ data }: { data: DashboardSnapshot }) {
  return <div className="view-stack"><section className="page-intro"><div><span className="eyebrow">Çoklu cüzdan sinyali</span><h2>Konsensüs</h2><p>Birinci alımdan sonra yeni aşamalar 3, 7 ve 15 farklı cüzdan sinyalinde açılır.</p></div></section><section className="table-panel"><div className="table-toolbar"><div><h3>Token sinyalleri</h3><span>{data.consensus.length} token</span></div></div>{data.consensus.length ? <div className="table-scroll"><table><thead><tr><th>Token</th><th>Ağ</th><th>Farklı cüzdan</th><th>Tamamlanan alım</th><th>Sonraki eşik</th><th>Kaynaklar</th><th /></tr></thead><tbody>{data.consensus.map((entry) => <tr key={`${entry.chainId}:${entry.tokenAddress}`}><td><strong>{entry.tokenSymbol}</strong><br/><code>{shortAddress(entry.tokenAddress)}</code></td><td>{entry.chainId === "base" ? "Base" : "Ethereum"}</td><td>{entry.walletCount}</td><td>{entry.copiedStages}</td><td>{entry.nextThreshold ?? "Tamamlandı"}</td><td title={entry.walletLabels.join(", ")}>{entry.walletLabels.slice(0, 3).join(", ")}{entry.walletLabels.length > 3 ? ` +${entry.walletLabels.length - 3}` : ""}</td><td>{entry.pairAddress && <a className="row-action" href={dexScreenerUrl(entry.chainId, entry.pairAddress)} target="_blank" rel="noreferrer" title="DexScreener'da aç"><ExternalLink size={14}/></a>}</td></tr>)}</tbody></table></div> : <EmptyState icon={Layers3} title="Konsensüs sinyali yok" body="Takip edilen cüzdanlardan alım sinyali geldikçe tokenlar burada aşama bazında görünür." />}</section></div>;
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

function SystemView({ data }: { data: DashboardSnapshot }) {
  const statusLabel = { healthy: "Sağlıklı", degraded: "Yavaş / hatalı", down: "Erişilemiyor", idle: "Henüz ölçülmedi" } as const;
  return <div className="view-stack"><section className="page-intro"><div><span className="eyebrow">Bağlantı görünürlüğü</span><h2>Sistem sağlığı</h2><p>Servis çağrı sayısı, hata oranı, önbellek kullanımı ve gözlenen gecikmeler.</p></div></section><div className="health-grid">{data.serviceHealth.map((service) => <article className={`health-item ${service.status}`} key={service.id}><div><span className="health-dot"/><strong>{service.label}</strong><small>{statusLabel[service.status]}</small></div><dl><div><dt>İstek</dt><dd>{service.requestCount}</dd></div><div><dt>Hata</dt><dd>{service.errorCount}</dd></div><div><dt>Cache</dt><dd>{service.cacheHitCount}</dd></div><div><dt>Ort. gecikme</dt><dd>{service.averageLatencyMs} ms</dd></div></dl>{service.lastError && <p>{service.lastError}</p>}</article>)}</div><section className="section-block"><div className="section-heading"><div><span className="eyebrow">Telegram kontrolü</span><h2>Komutlar</h2></div></div><div className="command-list"><code>/status</code><code>/positions</code><code>/pnl</code><code>/pause ethereum|base|all</code><code>/resume ethereum|base|all</code></div></section></div>;
}

function RiskView({ data, onChanged, onNotice }: { data: DashboardSnapshot; onChanged: () => void; onNotice: (value: { type: "success" | "error"; message: string }) => void }) {
  const [form, setForm] = useState(data.riskSettings);
  const [submitting, setSubmitting] = useState(false);
  const update = (key: keyof RiskSettings, value: number) => setForm((current) => ({ ...current, [key]: value }));
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
      <section className="page-intro"><div><span className="eyebrow">Koruma katmanı</span><h2>Risk ayarları</h2><p>Bu sınırlar otomatik ve manuel bütün paper alımlarından önce uygulanır.</p></div><span className="safety-label"><ShieldCheck size={16} /> Değişiklikler audit kaydına yazılır</span></section>
      <section className={`breaker-panel ${data.circuitBreaker.halted ? "halted" : ""}`}><div><OctagonX size={19} /><span><strong>{data.circuitBreaker.halted ? "İşlemler durduruldu" : "Devre kesici hazır"}</strong><small>{data.circuitBreaker.reason ?? `${data.circuitBreaker.consecutiveFailures} ardışık operasyon hatası`}</small></span></div><button type="button" disabled={submitting} onClick={() => void controlBreaker(data.circuitBreaker.halted ? "reset" : "halt")}>{data.circuitBreaker.halted ? "Engeli sıfırla" : "Acil durdur"}</button></section>
      <form className="risk-form" onSubmit={submit}>
        <RiskGroup title="Pozisyon yönetimi" description="Portföy dağılımı ve açık işlem sınırları" icon={CircleDollarSign}>
          <NumberField label="Minimum pozisyon" suffix="%" value={form.minPositionPercent} onChange={(value) => update("minPositionPercent", value)} />
          <NumberField label="Maksimum pozisyon" suffix="%" value={form.maxPositionPercent} onChange={(value) => update("maxPositionPercent", value)} />
          <NumberField label="Maksimum açık pozisyon" value={form.maxOpenPositions} onChange={(value) => update("maxOpenPositions", value)} />
          <NumberField label="Nakit rezervi" suffix="%" value={form.cashReservePercent} onChange={(value) => update("cashReservePercent", value)} />
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
        </RiskGroup>
        <RiskGroup title="Cüzdan işlem yoğunluğu" description="Aşırı aktif kaynakları otomatik izleme dışına alır" icon={Activity}>
          <NumberField label="Saatlik swap sınırı" value={form.maxWalletSwapsPerHour ?? 8} onChange={(value) => update("maxWalletSwapsPerHour", value)} />
          <NumberField label="24 saatlik swap sınırı" value={form.maxWalletSwapsPer24Hours ?? 25} onChange={(value) => update("maxWalletSwapsPer24Hours", value)} />
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

function Metric({ label, value, meta, icon: Icon, tone = "neutral" }: { label: string; value: string; meta: string; icon: typeof Gauge; tone?: "neutral" | "positive" | "negative" | "warning" }) {
  return <article className="metric"><div className={`metric-icon ${tone}`}><Icon size={17} /></div><span>{label}</span><strong>{value}</strong><small className={tone}>{meta}</small></article>;
}

function StatusBadge({ status }: { status: BotStatus }) {
  const labels: Record<BotStatus, string> = { running: "Çalışıyor", stopped: "Durduruldu", starting: "Başlıyor", stopping: "Durduruluyor", error: "Hata" };
  return <span className={`status-badge ${status}`}><i />{labels[status]}</span>;
}

function WalletTable({ wallets, onChanged, onNotice }: { wallets: TrackedWallet[]; onChanged: () => void; onNotice: (value: { type: "success" | "error"; message: string }) => void }) {
  const [selected, setSelected] = useState<TrackedWallet | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<WalletSortKey | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const sortedWallets = sortKey
    ? [...wallets].sort((left, right) => compareWalletRows(left, right, sortKey, sortDirection))
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
      onNotice({ type: "success", message: paused ? `${wallet.label} (${shortAddress(wallet.address)}) pasif duruma alındı.` : `${wallet.label} (${shortAddress(wallet.address)}) yeniden izleniyor.` });
    } catch (error) {
      onNotice({ type: "error", message: error instanceof Error ? error.message : "Cüzdan izleme durumu değiştirilemedi." });
    } finally {
      setUpdatingId(null);
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
  return <><div className="table-scroll"><table><thead><tr><SortableWalletHeader label="Cüzdan" column="wallet" activeColumn={sortKey} direction={sortDirection} onSort={changeSort} /><SortableWalletHeader label="Durum" column="state" activeColumn={sortKey} direction={sortDirection} onSort={changeSort} /><SortableWalletHeader label="Skor" column="score" activeColumn={sortKey} direction={sortDirection} onSort={changeSort} /><SortableWalletHeader label="Gözlenen" column="observed" activeColumn={sortKey} direction={sortDirection} onSort={changeSort} title="Cüzdanda gözlenen toplam swap sayısı" /><SortableWalletHeader label="Copy trade" column="copied" activeColumn={sortKey} direction={sortDirection} onSort={changeSort} title="Başarıyla tamamlanan copy trade sayısı" /><SortableWalletHeader label="Kazanma" column="winRate" activeColumn={sortKey} direction={sortDirection} onSort={changeSort} /><SortableWalletHeader label="Net PnL" column="pnl" activeColumn={sortKey} direction={sortDirection} onSort={changeSort} title="Yalnızca confirmed copy trade işlemlerinin net sonucu" /><th aria-label="İşlemler" /></tr></thead><tbody>{sortedWallets.map((wallet) => <tr key={wallet.id}><td><button className="wallet-cell wallet-cell-button" onClick={() => setSelected(wallet)} title={`${wallet.label} eklenme ve skor detaylarını aç`}><span className="wallet-avatar">{wallet.label.slice(0, 2).toUpperCase()}</span><span><strong>{wallet.label}</strong><code>{shortAddress(wallet.address)}</code></span></button></td><td><div className="wallet-state-cell"><span className={`state-label ${wallet.state}`} title={wallet.pauseReason ?? undefined}>{wallet.state === "observing" ? "Gözlemde" : wallet.state === "active" ? "Aktif" : "Duraklatıldı"}</span>{wallet.state === "observing" && <small>{wallet.observationSwapCount} swap</small>}</div></td><td><div className="score-cell"><span>{wallet.score}</span><div><i style={{ width: `${wallet.score}%` }} /></div></div></td><td>{wallet.totalTrades}</td><td>{wallet.copiedTradeCount}</td><td>%{wallet.winRate.toFixed(1)}</td><td className={wallet.realizedPnlUsd >= 0 ? "positive-text" : "negative-text"} title="Satış gelirleri + açık copy değeri − alım maliyetleri">{signedUsd(wallet.realizedPnlUsd)}</td><td><div className="row-actions"><button className="row-action" onClick={() => setSelected(wallet)} title={`${wallet.label} skor detayını aç`}><Eye size={15} /></button><button className={`row-action toggle ${wallet.state === "paused" ? "resume" : ""}`} disabled={removingId !== null || updatingId !== null} onClick={() => void toggleWallet(wallet)} title={wallet.state === "paused" ? `${wallet.label} izlemeyi etkinleştir` : `${wallet.label} izlemeyi pasif duruma al`} aria-label={wallet.state === "paused" ? `${wallet.label} izlemeyi etkinleştir` : `${wallet.label} izlemeyi pasif duruma al`}>{updatingId === wallet.id ? <RefreshCw size={15} className="spin" /> : wallet.state === "paused" ? <PlayCircle size={15} /> : <PauseCircle size={15} />}</button><button className={`row-action remove ${confirmRemoveId === wallet.id ? "confirm" : ""}`} disabled={removingId !== null || updatingId !== null} onClick={() => void removeWallet(wallet)} title={confirmRemoveId === wallet.id ? `${wallet.label} takibini bırakmayı onayla` : `${wallet.label} takibini bırak`} aria-label={confirmRemoveId === wallet.id ? `${wallet.label} takibini bırakmayı onayla` : `${wallet.label} takibini bırak`}>{removingId === wallet.id ? <RefreshCw size={15} className="spin" /> : confirmRemoveId === wallet.id ? <CheckCircle2 size={15} /> : <Trash2 size={15} />}</button></div></td></tr>)}</tbody></table></div>{selected && <WalletDetail wallet={selected} onClose={() => setSelected(null)} onChanged={onChanged} onNotice={onNotice} />}</>;
}

type WalletSortKey = "wallet" | "state" | "score" | "observed" | "copied" | "winRate" | "pnl";
type SortDirection = "desc" | "asc";

function SortableWalletHeader({ label, column, activeColumn, direction, onSort, title }: { label: string; column: WalletSortKey; activeColumn: WalletSortKey | null; direction: SortDirection; onSort: (column: WalletSortKey) => void; title?: string }) {
  const active = activeColumn === column;
  return <th aria-sort={active ? direction === "desc" ? "descending" : "ascending" : "none"} title={title}><button className={`table-sort ${active ? "active" : ""}`} onClick={() => onSort(column)} title={`${label} sütununu ${active && direction === "desc" ? "küçükten büyüğe" : "büyükten küçüğe"} sırala`}>{label}{active && direction === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />}</button></th>;
}

function compareWalletRows(left: TrackedWallet, right: TrackedWallet, key: WalletSortKey, direction: SortDirection) {
  const pausedOrder = Number(left.state === "paused") - Number(right.state === "paused");
  if (pausedOrder) return pausedOrder;
  const stateRank = { active: 2, observing: 1, paused: 0 } as const;
  const values = {
    wallet: [left.label, right.label],
    state: [stateRank[left.state], stateRank[right.state]],
    score: [left.score, right.score],
    observed: [left.totalTrades, right.totalTrades],
    copied: [left.copiedTradeCount, right.copiedTradeCount],
    winRate: [left.winRate, right.winRate],
    pnl: [left.realizedPnlUsd, right.realizedPnlUsd],
  }[key] as [string | number, string | number];
  const comparison = typeof values[0] === "string"
    ? values[0].localeCompare(values[1] as string, uiLocale(), { sensitivity: "base" })
    : values[0] - (values[1] as number);
  const sorted = direction === "desc" ? -comparison : comparison;
  return sorted || right.score - left.score || left.address.localeCompare(right.address);
}

function PositionList({ positions, lots = [], onSelect, usdFormatter = usd }: { positions: Position[]; lots?: DashboardSnapshot["positionLots"]; onSelect?: (position: Position) => void; usdFormatter?: (value: number) => string }) {
  return <div className={`position-list ${onSelect ? "selectable" : ""}`}>{positions.map((position) => { const pnlPercent = position.investedUsd ? (position.unrealizedPnlUsd / position.investedUsd) * 100 : 0; const lotCount = lots.filter((lot) => lot.chainId === position.chainId && lot.tokenAddress.toLowerCase() === position.tokenAddress.toLowerCase()).length; const content = <><div className={`token-icon ${position.chainId}`}>{position.tokenSymbol.slice(0, 2)}</div><div className="position-main"><strong>{position.tokenSymbol}</strong><small className="position-source">Kaynak: {position.sourceWalletLabel ?? "Manuel işlem"}{lotCount ? ` · ${lotCount} açık lot` : ""}</small><span>{position.chainId === "base" ? "Base" : "Ethereum"} · {position.quantity.toFixed(4)}</span></div><div className="position-value"><strong>{usdFormatter(position.quantity * position.currentPriceUsd)}</strong><span className={pnlPercent >= 0 ? "positive-text" : "negative-text"}>{pnlPercent >= 0 ? "+" : ""}{pnlPercent.toFixed(2)}%</span></div></>; return <div className="position-row-shell" key={position.id}>{onSelect ? <button type="button" className="position-row" onClick={() => onSelect(position)} title={`${position.tokenSymbol} işlem formuna aktar`}>{content}<ChevronRight className="position-chevron" size={16} /></button> : <div className="position-row">{content}</div>}{position.pairAddress && <a className="position-dex-link" href={dexScreenerUrl(position.chainId, position.pairAddress)} target="_blank" rel="noreferrer" title={`${position.tokenSymbol} tokenını DexScreener'da aç`} aria-label={`${position.tokenSymbol} tokenını DexScreener'da aç`}><ExternalLink size={14} /></a>}</div>; })}</div>;
}

function positionKey(position: Pick<Position, "chainId" | "tokenAddress">) {
  return `${position.chainId}:${position.tokenAddress.toLowerCase()}`;
}

function EventList({ events }: { events: DashboardSnapshot["events"] }) {
  return <div className="event-list">{events.map((event) => <div className="event-row" key={event.id}><span className={`event-dot ${event.level}`} /><div><strong>{event.title}</strong><p>{event.message}</p><small>{relativeTime(event.createdAt)}{event.chainId ? ` · ${event.chainId === "base" ? "Base" : "Ethereum"}` : ""}{event.txHash && event.chainId ? <a href={explorerUrl(event.chainId, event.txHash)} target="_blank" rel="noreferrer">İşlemi aç <ExternalLink size={9} /></a> : null}</small></div></div>)}</div>;
}

function TradeTable({ trades }: { trades: Trade[] }) {
  const [selected, setSelected] = useState<Trade | null>(null);
  return <><div className="table-scroll"><table><thead><tr><th>İşlem</th><th>Ağ</th><th>Durum</th><th>Miktar</th><th>Net değer</th><th>Maliyet</th><th>Zaman</th><th aria-label="İşlemler" /></tr></thead><tbody>{trades.map((trade) => <tr key={trade.id}><td><div className="trade-cell"><span className={trade.side}>{trade.side === "buy" ? <ArrowDownLeft size={15} /> : <ArrowUpRight size={15} />}</span><div><strong>{trade.tokenSymbol}</strong><small>{trade.side === "buy" ? "Alım" : "Satış"} · {trade.source === "manual" ? "Manuel" : "Kopya"}</small></div></div></td><td>{trade.chainId === "base" ? "Base" : "Ethereum"}</td><td><span className={`trade-status ${trade.status}`}>{trade.status === "confirmed" ? "Tamamlandı" : trade.status === "skipped" ? "Reddedildi" : trade.status}</span></td><td>{trade.quantity ? trade.quantity.toFixed(6) : "—"}</td><td>{usd(trade.netUsd)}</td><td>{usd(trade.fees.totalUsd)}</td><td>{relativeTime(trade.createdAt)}</td><td><button className="row-action" onClick={() => setSelected(trade)} title={`${trade.tokenSymbol} işlem detayını aç`}><Eye size={15} /></button></td></tr>)}</tbody></table></div>{selected && <TradeDetail trade={selected} onClose={() => setSelected(null)} />}</>;
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
      onNotice({ type: "success", message: method === "DELETE" ? "Cüzdan takip listesinden çıkarıldı." : wallet.state === "paused" ? "Cüzdan takibi yeniden başlatıldı." : "Cüzdan takibi duraklatıldı." });
    } catch (error) { onNotice({ type: "error", message: error instanceof Error ? error.message : "Cüzdan güncellenemedi." }); }
    finally { setBusy(false); }
  };
  return <Modal title={wallet.label} subtitle={shortAddress(wallet.address)} onClose={onClose}><WalletAdditionSummary wallet={wallet} /><div className="score-summary"><strong>{wallet.score}</strong><span>Güncel genel skor</span></div>{wallet.pauseReason && <div className="decision-box"><span>Duraklatma nedeni</span><p>{wallet.pauseReason}</p></div>}<div className="detail-grid"><DetailItem label="Copy trade Net PnL" value={signedUsd(wallet.realizedPnlUsd)} strong /><DetailItem label="Başarılı copy trade" value={wallet.copiedTradeCount.toString()} /><DetailItem label="Gözlenen işlem" value={wallet.totalTrades.toString()} /></div><div className="score-breakdown">{scores.map(([label, score]) => <div key={label}><span>{label}</span><div><i style={{ width: `${score}%` }} /></div><strong>{score}</strong></div>)}</div><p className="detail-note">Copy trade sayısına yalnızca başarıyla tamamlanan kopya alım ve satış işlemleri dahil edilir.</p><div className="wallet-actions"><button disabled={busy} onClick={() => void mutate("PATCH")}>{wallet.state === "paused" ? <PlayCircle size={15} /> : <PauseCircle size={15} />}{wallet.state === "paused" ? "Takibi sürdür" : "Takibi duraklat"}</button>{confirmDelete ? <button className="danger" disabled={busy} onClick={() => void mutate("DELETE")}><Trash2 size={15} /> Silmeyi onayla</button> : <button className="danger-ghost" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={15} /> Listeden çıkar</button>}</div></Modal>;
}

function WalletAdditionSummary({ wallet }: { wallet: TrackedWallet }) {
  const context = wallet.additionContext;
  if (!context) return <div className="decision-box wallet-origin legacy"><span>Eklenme nedeni</span><p>Bu cüzdan önceki veri sürümünde eklendiği için ekleme anındaki keşif özeti kayıtlı değil.</p></div>;
  return <section className="wallet-origin"><div className="wallet-origin-head"><div><span className="eyebrow">Eklenme nedeni</span><p>{context.reason}</p></div><small>{context.source === "discovery" ? `${context.chainId === "base" ? "Base" : "Ethereum"} keşfi` : "Manuel ekleme"}<br />{dateTime(context.capturedAt)}</small></div>{context.source === "discovery" && <><div className="wallet-origin-metrics"><DetailItem label="Toplam alım" value={usd(context.boughtUsd)} /><DetailItem label="Toplam satış" value={usd(context.soldUsd)} /><DetailItem label="Tahmini net PnL" value={signedUsd(context.estimatedPnlUsd)} strong /><DetailItem label="Ekleme anı ROI" value={`%${context.estimatedPnlPercent.toFixed(2)}`} /><DetailItem label="Swap dağılımı" value={`${context.buyCount} alım · ${context.sellCount} satış`} /><DetailItem label="Token / swap" value={`${context.uniqueTokenCount} / ${context.swapCount}`} /></div>{context.tokens.length > 0 && <div className="wallet-origin-tokens"><h4>Keşifte öne çıkan tokenlar</h4>{context.tokens.map((token) => <div key={token.address}><div><strong>{token.symbol}</strong><code>{shortAddress(token.address)}</code></div><span><small>Alım</small>{usd(token.boughtUsd)}</span><span><small>Satış</small>{usd(token.soldUsd)}</span><span className={token.estimatedPnlUsd >= 0 ? "positive-text" : "negative-text"}><small>PnL</small>{signedUsd(token.estimatedPnlUsd)}</span><span><small>Swap</small>{token.swapCount}</span>{token.pairAddress && context.chainId && <a className="row-action" href={dexScreenerUrl(context.chainId, token.pairAddress)} target="_blank" rel="noreferrer" title={`${token.symbol} DexScreener sayfasını aç`}><ExternalLink size={13} /></a>}</div>)}</div>}</>}</section>;
}

function TradeDetail({ trade, onClose }: { trade: Trade; onClose: () => void }) {
  return <Modal title={`${trade.tokenSymbol} ${trade.side === "buy" ? "alımı" : "satışı"}`} subtitle={`${trade.chainId === "base" ? "Base" : "Ethereum"} · ${trade.source === "copy" ? "Kopya işlem" : "Manuel işlem"}`} onClose={onClose}><div className="detail-grid"><DetailItem label="Brüt değer" value={usd(trade.grossUsd)} /><DetailItem label="Net değer" value={usd(trade.netUsd)} /><DetailItem label="Token miktarı" value={trade.quantity ? trade.quantity.toFixed(8) : "—"} /><DetailItem label="Birim fiyat" value={usd(trade.priceUsd)} /></div><h4 className="detail-heading">Maliyet dağılımı</h4><div className="fee-list"><DetailItem label="DEX ücreti" value={usd(trade.fees.dexFeeUsd)} /><DetailItem label="Gas" value={usd(trade.fees.gasFeeUsd)} /><DetailItem label="Slippage" value={usd(trade.fees.slippageUsd)} /><DetailItem label="Fiyat etkisi" value={usd(trade.fees.priceImpactUsd)} /><DetailItem label="Token vergisi" value={usd(trade.fees.tokenTaxUsd)} /><DetailItem label="Toplam" value={usd(trade.fees.totalUsd)} strong /></div><div className="decision-box"><span>Karar gerekçesi</span><p>{trade.reason}</p></div>{trade.txHash && <a className="explorer-link" href={explorerUrl(trade.chainId, trade.txHash)} target="_blank" rel="noreferrer">Kaynak işlemi explorer’da aç <ExternalLink size={14} /></a>}</Modal>;
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

function EmptyState({ icon: Icon, title, body }: { icon: typeof Gauge; title: string; body: string }) {
  return <div className="empty-state"><span><Icon size={20} /></span><strong>{title}</strong><p>{body}</p></div>;
}

function DashboardSkeleton() {
  return <div className="skeleton-stack"><div className="skeleton-metrics">{Array.from({ length: 4 }).map((_, index) => <div key={index} />)}</div><div className="skeleton-wide" /><div className="skeleton-columns"><div /><div /></div></div>;
}

const uiLanguage = (): AppLanguage => typeof document !== "undefined" && document.documentElement.lang === "en" ? "en" : "tr";
const uiLocale = () => localeFor(uiLanguage());
const usd = (value: number) => new Intl.NumberFormat(uiLocale(), { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(value);
const overviewUsd = (value: number) => new Intl.NumberFormat(uiLocale(), { style: "currency", currency: "USD", minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(value);
const compactUsd = (value: number) => new Intl.NumberFormat(uiLocale(), { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(value);
const signedUsd = (value: number) => `${value >= 0 ? "+" : "−"}${usd(Math.abs(value))}`;
const signedOverviewUsd = (value: number) => `${value >= 0 ? "+" : "−"}${overviewUsd(Math.abs(value))}`;
const dateTime = (value: string) => new Intl.DateTimeFormat(uiLocale(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const descriptiveUsd = (value: number) => {
  const absoluteValue = Math.abs(value);
  const formatter = new Intl.NumberFormat(uiLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (absoluteValue >= 1_000_000_000) return `${formatter.format(value / 1_000_000_000)} ${uiLanguage() === "en" ? "billion" : "milyar"} USD`;
  if (absoluteValue >= 1_000_000) return `${formatter.format(value / 1_000_000)} ${uiLanguage() === "en" ? "million" : "milyon"} USD`;
  if (absoluteValue >= 1_000) return `${formatter.format(value / 1_000)} ${uiLanguage() === "en" ? "thousand" : "bin"} USD`;
  return usd(value);
};
const signedDescriptiveUsd = (value: number) => `${value >= 0 ? "+" : "−"}${descriptiveUsd(Math.abs(value))}`;
const percentOf = (value: number, total: number) => total ? ((value / total) * 100).toFixed(0) : "0";
const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const explorerUrl = (chainId: ChainId, txHash: string) => chainId === "base" ? `https://basescan.org/tx/${txHash}` : `https://etherscan.io/tx/${txHash}`;
const dexScreenerUrl = (chainId: ChainId, pairAddress: string) => `https://dexscreener.com/${chainId}/${pairAddress}`;
const relativeTime = (date: string) => {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return "Az önce";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} dk önce`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} sa önce`;
  return new Intl.DateTimeFormat(uiLocale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(date));
};
