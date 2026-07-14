# Lock In V3 product model

## Mission strategy

Lock In is a multi-domain accountability protocol with independent proof rules per mission. The consumer surface exposes three lanes:

- **GPS Run — beta:** Strava plus a pinned Reclaim provider and onchain checks.
- **Daily Steps — next:** an authorized primary source such as the Fitbit API; Health Connect or Apple Health require native mobile paths.
- **Daily Learning — permission gated:** Duolingo only after an official API or written permission makes the integration supportable.

Moonwalk validates demand for social, stake-backed fitness accountability, but it should not be Lock In's oracle. It already implements contests and settlement on Solana. See [moonwalk-evaluation.md](moonwalk-evaluation.md).

## Strava templates

| Template | Duration | Required runs | Use |
| --- | ---: | ---: | --- |
| Proof Sprint | 1 day | 1 | Solo proof rehearsal; stake refundable, gas not refundable |
| Kickstart | 3 days | 3 | Short competitive commitment |
| Momentum | 7 days | 5 | Two non-required days |
| Consistency | 14 days | 8 | Six non-required days |
| Build | 30 days | 12 | Roughly three runs per week |

One qualifying activity can count per day. Duration and required completions are separate contract fields so long programs include non-required days rather than encouraging daily running.

## Pool isolation and scheduling

Every pact is an isolated pool. Participants only compete against wallets in that exact pact; different missions, targets, durations, start windows, and stakes never mix.

The web preset starts one-day rehearsals after 30 minutes. Multi-day programs start on a UTC day boundary after at least twelve hours of registration and require at least two participants at protocol level. If a multi-day pact is still underfilled at the start, anyone can finalize it as cancelled and enable refunds.

The next public-cohort iteration must canonicalize a pool key from `mission + template version + target + start + stake`, provide a catalogue, and require at least three participants. Custom invite pacts must remain separate from public matchmaking liquidity.

## Settlement and anti-farming

- Immutable maximum stake of 1 USDC during beta.
- No protocol fee and no external token, point, airdrop, referral, or volume reward.
- Equal stake per participant; success is threshold-based, never proportional to distance or XP.
- One wallet entry per pact.
- One service identity per pact, even across multiple wallets.
- One proof slot per day and one global activity nullifier across all pacts.
- If everyone succeeds, everyone receives their stake back.
- If nobody succeeds, everyone can recover their stake.
- Underfilled and incident-cancelled pacts are refundable after finalization and claim transactions.

Multiple real service accounts, account sharing, compromised devices, and synthetic GPS remain residual risks. Lock In must not claim proof of physical movement; it proves a policy-conforming authenticated service record.

Direct onchain verification also makes transformed proof contexts and minimized Strava fields public in transaction calldata. Entry and proof flows must disclose this before a wallet stakes. Detailed GPS routes and credentials are not included.

## Progress UX

The pact page distinguishes registration, active, proof grace, underfilled, settlement-ready, cancelled, refunds-open, and settled states. It shows UTC boundaries, required crew size, completion target, progress bar, and a compact calendar with proved, today, past, and upcoming states.

## Learning mission constraint

Duolingo is valuable as a mental-accountability lane, but its internal endpoints are not a supported developer API and its terms restrict automated extraction. No money-bearing Duolingo pact may launch until permission or an official API exists. If enabled later, the mission will verify active learning days or a capped threshold, never rank users by grindable XP.

## Remaining delivery order

1. Complete a genuine GPS run end to end against the deployed V3 escrow.
2. Add canonical public cohorts and an indexed catalogue.
3. Capture and publish a Steps provider only through an authorized Fitbit or native health-platform flow.
4. Revisit Duolingo only after the platform-permission gate is cleared.
