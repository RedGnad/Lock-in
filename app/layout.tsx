import type { Metadata } from "next";
import Link from "next/link";
import { Providers } from "@/components/providers";
import { WalletButton } from "@/components/wallet-button";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lock In — Quitters pay finishers",
  description: "Dépose. Prouve ta mission. Les finishers prennent le pot.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const repositoryUrl = process.env.NEXT_PUBLIC_REPOSITORY_URL?.trim();
  return (
    <html lang="fr">
      <body>
        <Providers>
          <header className="site-header">
            <Link href="/" className="wordmark"><span>LOCK</span><i>IN</i></Link>
            <div className="header-rule" />
            <WalletButton />
          </header>
          {children}
          <footer><span>LOCK IN / MONAD 2026</span><div><Link href="/privacy">Confidentialité</Link>{repositoryUrl && <a href={repositoryUrl} target="_blank" rel="noreferrer">Code</a>}</div></footer>
        </Providers>
      </body>
    </html>
  );
}
