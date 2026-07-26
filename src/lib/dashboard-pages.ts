export const DASHBOARD_PAGES = {
  overview: "overview",
  "my-wallets": "my-wallets",
  wallets: "wallets",
  "wallet-discovery": "discovery",
  "social-signals": "social",
  trades: "trades",
  performance: "analytics",
  consensus: "consensus",
  replay: "backtest",
  "system-health": "system",
  "risk-settings": "risk",
  "rpc-settings": "rpc",
  integrations: "integrations",
} as const;

export type DashboardPageSlug = keyof typeof DASHBOARD_PAGES;
export type DashboardViewId = (typeof DASHBOARD_PAGES)[DashboardPageSlug];

const VIEW_PATHS = Object.fromEntries(
  Object.entries(DASHBOARD_PAGES).map(([slug, view]) => [view, `/${slug}`]),
) as Record<DashboardViewId, string>;

export const dashboardPageSlugs = Object.keys(DASHBOARD_PAGES) as DashboardPageSlug[];

export function isDashboardPageSlug(value: string): value is DashboardPageSlug {
  return value in DASHBOARD_PAGES;
}

export function isDashboardViewId(value: string): value is DashboardViewId {
  return Object.values(DASHBOARD_PAGES).includes(value as DashboardViewId);
}

export function dashboardViewForSlug(slug: DashboardPageSlug): DashboardViewId {
  return DASHBOARD_PAGES[slug];
}

export function dashboardPathForView(view: DashboardViewId): string {
  return VIEW_PATHS[view];
}
