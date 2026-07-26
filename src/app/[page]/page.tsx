import { notFound } from "next/navigation";
import { DashboardApp } from "@/components/dashboard-app";
import {
  dashboardPageSlugs,
  dashboardViewForSlug,
  isDashboardPageSlug,
} from "@/lib/dashboard-pages";

export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return dashboardPageSlugs.map((page) => ({ page }));
}

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ page: string }>;
}) {
  const { page } = await params;
  if (!isDashboardPageSlug(page)) notFound();
  return <DashboardApp key={page} initialView={dashboardViewForSlug(page)} />;
}
