import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "TIMEŒ Rug Check", description: "Free, read-only Solana token rug check. Not financial advice." };
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
