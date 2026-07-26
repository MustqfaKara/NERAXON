import assert from "node:assert/strict";
import test from "node:test";
import {
  dashboardPageSlugs,
  dashboardPathForView,
  dashboardViewForSlug,
  isDashboardPageSlug,
  isDashboardViewId,
} from "../src/lib/dashboard-pages.ts";

test("her panel görünümü kalıcı ve benzersiz bir URL kullanır", () => {
  const views = dashboardPageSlugs.map((slug) => dashboardViewForSlug(slug));
  const paths = views.map((view) => dashboardPathForView(view));

  assert.equal(new Set(views).size, views.length);
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(dashboardPathForView("discovery"), "/wallet-discovery");
  assert.equal(dashboardPathForView("system"), "/system-health");
  assert.equal(dashboardPathForView("rpc"), "/rpc-settings");
});

test("bilinmeyen route ve görünüm kimlikleri reddedilir", () => {
  assert.equal(isDashboardPageSlug("overview"), true);
  assert.equal(isDashboardPageSlug("unknown"), false);
  assert.equal(isDashboardViewId("trades"), true);
  assert.equal(isDashboardViewId("unknown"), false);
});
