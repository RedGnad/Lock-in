# Lock In product and UX rationale

This rationale applies to the unreleased Lock In build. Lock In is not open to participants.

## Evidence behind the social loop

- Strava reports that group activities receive roughly twice as many kudos, that 55% of younger athletes name social connection as their leading reason for joining a fitness group, and that new running clubs tripled in 2025. Source: [Strava mid-year 2025](https://press.strava.com/en-gb/articles/strava-mid-year-data-shows-how-athletes-are-tracking-toward-2025-goals).
- Duolingo reports that users with a Friend Streak are 22% more likely to complete a daily lesson and identifies the first invitation as the largest funnel obstacle. Source: [Duolingo Friend Streak](https://blog.duolingo.com/product-lessons-friend-streak/).
- A randomized trial of 602 adults measured a 920-step/day lift for competition, 689 for support, and 637 for collaboration. Source: [JAMA Internal Medicine STEP UP trial](https://jamanetwork.com/journals/jamainternalmedicine/fullarticle/2749761/).
- A separate analysis of almost 2,500 competitions found an average 23% activity lift but weaker effects when competitors were badly matched. Source: [Stanford/NIH competition analysis](https://pmc.ncbi.nlm.nih.gov/articles/PMC5627651/).

These findings support small, invited crews, visible shared consistency, and a low-friction first invite. They do not support ranking runners by speed or rewarding excess distance. Lock In combines cooperative momentum with a PvP consequence: the crew helps everyone persist, but quitters fund the finishers.

## Interaction model

1. The home presents two obvious actions: start a Lock or join a crew.
2. Creation asks for one meaningful decision at a time: mission and target, schedule, crew capacity, then stake.
3. The stake control is bounded from 0.1 to 1 USDC before review and defaults controlled tests to 0.1 USDC.
4. The Join view reads live Monad state and blocks entry when registration is closed or capacity is full.
5. Connected wallets recover their joined Locks from public contract events.
6. A Lock is a social room: next action, crew and capacity, per-wallet progress, personal calendar, pool, then technical details.
7. Creation redirects to an invitation-first room. Native share text includes mission, schedule, stake, capacity, and the exact invite link.
8. Shared consistency is the competitive unit. Extra kilometres or XP do not improve payout.
9. Money, proof, and public-data disclosures appear at the decision that triggers them, while the full rules and privacy notice remain in the footer.

The experience must never present an unfinished or disabled mission as a product feature. Only implemented, tested, and enabled missions appear.

## Funnel to measure

Primary metric: percentage of created Locks that reach their minimum crew before registration closes.

Supporting events, in order:

1. `create_started`
2. `pact_created`
3. `invite_opened`
4. `pact_joined`
5. `proof_day_1`
6. `proof_day_3` / `proof_day_7`
7. `target_completed`
8. `payout_claimed`

Analytics are intentionally not installed. No production analytics claim should be made until a privacy-reviewed, consent-aware implementation exists and the privacy notice names the provider and retention policy.

## Trust placement

The footer links the full policy, but it is not the only notice. The transaction review states the exact stake, gas separation, capacity, schedule, payout rule, and permanent onchain fields immediately before the wallet transaction. Before Reclaim opens, the proof flow names the service fields that will be processed. Before the wallet signs, it also explains that the transformed proof's signed parameters, context, claim metadata, and witness signatures become permanent transaction calldata, while the top-level TEE JWT and Strava GPS route stay out.

If real signed proof data contains a cookie, Authorization header, access token, API key, secret, or unexpected personal field, the flow must stop before presenting a transaction. A short consumer notice cannot replace this technical release gate.

Routine screens should not repeat legal paragraphs. Short contextual disclosures and clear failure messages carry the necessary information without burying the primary action.

## Release constraint

The public release stays closed until the final paused escrow and direct verifiers, live-schema and secret-header canaries, KMS-backed evidence and admission signers, multisig ownership, independent review, complete two-wallet hybrid-proof rehearsals, calldata/gas/mobile checks, privacy and rules, monitoring, liability reconciliation, and incident response all pass. Product polish cannot substitute for this gate.
