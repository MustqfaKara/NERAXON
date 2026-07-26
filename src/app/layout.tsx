import type { Metadata } from "next";
import "./globals.css";
import { getInitialLanguage } from "@/lib/server-language";

export const metadata: Metadata = {
  applicationName: "NERAXON",
  title: "NERAXON",
  description: "Yerel EVM işlem otomasyonu ve akıllı cüzdan takip sistemi",
  icons: {
    icon: [{ url: "/neraxon-symbol-v2.png", type: "image/png" }],
    shortcut: "/neraxon-symbol-v2.png",
    apple: "/neraxon-symbol-v2.png",
  },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const language = await getInitialLanguage();
  return (
    <html lang={language}>
      <body>{children}</body>
    </html>
  );
}
