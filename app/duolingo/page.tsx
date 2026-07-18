import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isDuolingoPreviewMode } from "@/src/preview-mode";
import { DuolingoExperience } from "@/components/duolingo-experience";

const base: Metadata = {
  title: "Duolingo XP - Beta - Lock In",
  description: "Prove your starting XP, learn, then prove your progress. Cumulative XP delta, proved end to end.",
  robots: { index: false, follow: false },
};

// A shared invite (?lock=<id>) gets a truthful Open Graph card rendered from the Lock's real on-chain state.
export async function generateMetadata({ searchParams }: { searchParams: Promise<{ lock?: string }> }): Promise<Metadata> {
  const { lock } = await searchParams;
  if (!lock || !/^[1-9]\d{0,29}$/.test(lock)) return base;
  const image = `/api/og/lock?m=duolingo&id=${lock}`;
  const title = `Join my Duolingo XP Lock #${lock} - Lock In`;
  const description = "Prove your XP, stake USDC, finishers split the pool. Settled on Monad.";
  return {
    ...base,
    title,
    description,
    openGraph: { title, description, type: "website", url: `/duolingo?lock=${lock}`, images: [{ url: image, width: 1200, height: 630, alt: title }] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default async function DuolingoPage({ searchParams }: { searchParams: Promise<{ lock?: string }> }) {
  const { lock } = await searchParams;
  const validLock = lock && /^[1-9]\d{0,29}$/.test(lock) ? lock : undefined;
  const preview = isDuolingoPreviewMode();

  // On the Preview deployment this page is the whole demonstrative product: keep its explanatory hero.
  if (preview) {
    return (
      <main className="pact-shell">
        <section className="pact-hero">
          <div className="eyebrow"><span>BETA</span> Duolingo XP</div>
          <h1>Duolingo <em>XP</em></h1>
          <p>
            Prove your starting XP through Reclaim, go and learn, then come back and prove your progress.
            Lock In compares the two proofs and reads the difference.
          </p>
        </section>
        <DuolingoExperience />
        <details className="pact-details">
          <summary>HOW THE PROOF WORKS <span aria-hidden="true">+</span></summary>
          <div className="details-body">
            <p>
              Reclaim opens Duolingo in a secure browser you sign into yourself. It returns a proof, signed
              inside a trusted execution environment, that your account really shows that XP. Lock In never
              sees your Duolingo password, and a proof without a verified attestation is refused.
            </p>
            <p>
              Your starting XP is held by Lock In, not by your browser, so it cannot be edited to make the
              challenge easier. Both proofs must come from the same Duolingo account.
            </p>
          </div>
        </details>
      </main>
    );
  }

  // Production: Duolingo lives inside the main product. Creation is the home wizard; this URL is the native
  // Lock (and social invite). A visit with no valid Lock returns to the mission selector.
  if (!validLock) redirect("/#play");

  return (
    <main className="pact-shell">
      <DuolingoExperience initialLock={validLock} />
    </main>
  );
}
