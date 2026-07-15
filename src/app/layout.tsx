import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EVM CopyDesk",
  description: "Yerel EVM cüzdan izleme ve paper trading çalışma alanı",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
