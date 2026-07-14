# Lock In V2 product model

## What is deployed today

Each pact is an isolated, invite-style pool with its own distance, 1–5 day duration, stake, start time, and Strava challenge. Participants only compete with wallets that joined that exact pact. A 1-day participant never competes with a 5-day participant. The creator joins automatically; other wallets must join before the pact starts, currently five minutes after creation.

Every participant must prove one qualifying GPS run on every calendar day of the pact. After the deadline, wallets that proved every day split the entire pool. If nobody finishes, everyone can recover their stake. There is no protocol fee in the deployed hackathon contract.

## Consumer V2 recommendation

Use standardized public cohorts instead of arbitrary user-created public pools:

- one mission type per cohort: Strava running;
- fixed target tiers: 1 km/day or 3 km/day;
- one primary duration: 3 consecutive days;
- fixed stake: 1 USDC maximum;
- scheduled UTC start windows and a visible registration deadline;
- minimum cohort size before activation, otherwise automatic cancellation/refund;
- capped cohort size and one wallet entry per cohort;
- separate pools for every mission, target, duration, stake, and start window.

Keep custom pacts as an invite-only mode. They should not be mixed into the public matchmaking liquidity.

## Why not make 1 day the main competitive mode

A one-day pact is useful for onboarding and live hackathon demos, but it measures a single event rather than consistency. It is easier to coordinate, subsidize with related wallets, and repeatedly enter if future rewards are added. With the current zero-subsidy, zero-reward pool it cannot create money from nothing: profit still comes from a real losing stake. It nevertheless becomes farmable as soon as the product distributes points, tokens, sponsor rewards, or referral credit.

Treat 1-day pacts as practice or invite-only challenges with no external rewards. Use 3 days as the shortest public competitive streak. Five days can follow when the proof flow is reliable enough that repeated Reclaim friction does not hurt completion.

## Anti-collusion constraints for public cohorts

- No protocol rewards based solely on number of proofs, pacts, or volume.
- One entry per wallet per cohort and global activity nullifiers across all pacts.
- Minimum number of unrelated participants before a cohort activates.
- Publish exact rules and payouts before registration closes.
- Do not claim Sybil resistance: multiple wallets, shared accounts, and synthetic GPS remain residual risks.
- Keep the $1 cap until real-world attack data supports a change.

## Service strategy

Ship Strava as the only enabled mission for the hackathon. It already has a pinned Reclaim provider, onchain verification, GPS/trainer/flag/motion checks, tests, and a deployed escrow. Adding an unfinished Duolingo path to the main flow would widen the attack surface and make the product promise less credible.

Design the frontend around a mission registry now, but mark Duolingo as unavailable until its independent proof adapter is complete. Duolingo requires two authenticated snapshots of the same account: baseline XP at entry and final XP at settlement. A streak or final XP total alone is insufficient. Its provider, policy, nullifier, tests, and escrow adapter must remain separate from Strava.

## Delivery order

1. Complete a genuine Strava GPS run end to end in production.
2. Improve the current invite-pact UX and show its join deadline explicitly.
3. Add a mission registry with Strava enabled and Duolingo marked as coming later.
4. Implement standardized 3-day public cohorts in a new factory/router contract.
5. Capture authenticated Duolingo baseline and final responses with Reclaim, then build and test the separate adapter.
