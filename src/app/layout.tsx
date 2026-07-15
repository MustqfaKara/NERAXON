import type { Metadata } from "next";
import "./globals.css";

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

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
