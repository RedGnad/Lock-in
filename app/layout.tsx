import type { Metadata } from "next";
import Link from "next/link";
import { Providers } from "@/components/providers";
import { WalletButton } from "@/components/wallet-button";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lock In — Stake-backed accountability",
  description: "Stake up to 1 USDC, verify a mission record, and settle the pact on Monad.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const repositoryUrl = process.env.NEXT_PUBLIC_REPOSITORY_URL?.trim();
  return (
    <html lang="en">
      <body>
        <Providers>
          <header className="site-header">
            <Link href="/" className="wordmark"><span>LOCK</span><i>IN</i></Link>
            <div className="header-rule" />
            <WalletButton />
          </header>
          {children}
          <footer><span>LOCK IN / MONAD 2026 · EXPERIMENTAL BETA · 18+</span><div><Link href="/rules">Rules</Link><Link href="/privacy">Privacy</Link>{repositoryUrl && <a href={repositoryUrl} target="_blank" rel="noreferrer">Code</a>}</div></footer>
        </Providers>
      </body>
    </html>
  );
}
