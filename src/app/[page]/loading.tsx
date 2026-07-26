export default function DashboardRouteLoading() {
  return (
    <div className="route-loading-shell" role="status" aria-label="Sayfa yükleniyor">
      <aside className="route-loading-sidebar">
        <div className="route-loading-brand route-loading-shimmer" />
        <div className="route-loading-nav">
          {Array.from({ length: 8 }).map((_, index) => (
            <div className="route-loading-nav-item route-loading-shimmer" key={index} />
          ))}
        </div>
      </aside>
      <main className="route-loading-main">
        <header className="route-loading-topbar">
          <div className="route-loading-title route-loading-shimmer" />
          <div className="route-loading-action route-loading-shimmer" />
        </header>
        <div className="route-loading-content">
          <div className="route-loading-metrics">
            {Array.from({ length: 5 }).map((_, index) => (
              <div className="route-loading-shimmer" key={index} />
            ))}
          </div>
          <div className="route-loading-panel route-loading-shimmer" />
          <div className="route-loading-columns">
            <div className="route-loading-shimmer" />
            <div className="route-loading-shimmer" />
          </div>
        </div>
      </main>
      <span className="sr-only">Sayfa yükleniyor</span>
    </div>
  );
}
