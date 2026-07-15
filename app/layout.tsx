import type { Metadata } from "next";
import Link from "next/link";
import { Providers } from "@/components/providers";
import { WalletButton } from "@/components/wallet-button";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://lock-in-liart-theta.vercel.app"),
  title: "Lock In — Accountability that pays",
  description: "Challenge your friends to an onchain streak. Finishers split the pool funded by those who quit.",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    title: "Lock In — Accountability that pays",
    description: "Challenge your friends to an onchain streak. Finishers split the pool funded by those who quit.",
    url: "/",
    siteName: "Lock In",
  },
  twitter: {
    card: "summary_large_image",
    title: "Lock In — Accountability that pays",
    description: "Challenge your friends to an onchain streak. Finishers split the pool funded by those who quit.",
  },
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
          <footer><span>LOCK IN / MONAD 2026 · 18+</span><div><Link href="/rules">Rules</Link><Link href="/privacy">Privacy</Link>{repositoryUrl && <a href={repositoryUrl} target="_blank" rel="noreferrer">Code</a>}</div></footer>
        </Providers>
      </body>
    </html>
  );
}
