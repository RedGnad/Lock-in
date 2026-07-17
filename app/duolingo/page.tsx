import type { Metadata } from "next";
import { DuolingoExperience } from "@/components/duolingo-experience";

export const metadata: Metadata = {
  title: "Duolingo XP — Beta — Lock In",
  description: "Prove your starting XP, learn, then prove your progress. Cumulative XP delta, proved by zkTLS.",
  robots: { index: false, follow: false },
};

export default function DuolingoPage() {
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
          <p>
            This mission counts a <b>total</b>, not a streak. It says nothing about learning every day: for
            that, use a Strava Run Lock, which verifies one day at a time.
          </p>
        </div>
      </details>
    </main>
  );
}
