import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "TIMEŒ Rug Check", description: "Free, read-only multichain token rug check for Solana and EVM chains. Not financial advice." };
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
