# Lock In V4 product and UX rationale

## Evidence behind the social loop

- Strava reports that group activities receive roughly twice as many kudos, that 55% of younger athletes name social connection as their leading reason for joining a fitness group, and that new running clubs tripled in 2025. Source: [Strava mid-year 2025](https://press.strava.com/en-gb/articles/strava-mid-year-data-shows-how-athletes-are-tracking-toward-2025-goals).
- Duolingo reports that users with a Friend Streak are 22% more likely to complete a daily lesson and identifies the first invitation as the largest funnel obstacle. Source: [Duolingo Friend Streak](https://blog.duolingo.com/product-lessons-friend-streak/).
- A randomized trial of 602 adults measured a 920-step/day lift for competition, 689 for support, and 637 for collaboration. Source: [JAMA Internal Medicine STEP UP trial](https://jamanetwork.com/journals/jamainternalmedicine/fullarticle/2749761).
- A separate analysis of almost 2,500 competitions found an average 23% activity lift but weaker effects when competitors were badly matched. Source: [Stanford/NIH competition analysis](https://pmc.ncbi.nlm.nih.gov/articles/PMC5627651/).

The product therefore optimizes small crews, shared consistency, and the first invite. It does not rank athletes by speed or excess distance.

## V4 interaction model

1. The home has two explicit entry points: start a pact or join a crew.
2. Creation asks for one decision at a time: distance, schedule, then stake.
3. The Join view reads live Monad state. It never fabricates activity or participants.
4. Connected wallets recover their joined pacts from `PactJoined` events.
5. A pact is a social room: the current action, crew, per-wallet day state, personal calendar, pool, then technical details.
6. Creation redirects into an invitation-first room. Native share text includes goal, duration, and stake.
7. Shared consistency is the competitive unit. Extra kilometres do not improve payout.

## Funnel to measure

Primary metric: percentage of created pacts that reach the minimum crew before registration closes.

Supporting events, in order:

1. `create_started`
2. `pact_created`
3. `invite_opened`
4. `pact_joined`
5. `proof_day_1`
6. `proof_day_3` / `proof_day_7`
7. `target_completed`
8. `payout_claimed`

Analytics are intentionally not installed yet. No production analytics claim should be made until a privacy-reviewed, consent-aware implementation exists.

## Privacy placement

The footer links the full policy, but it is not the only notice. A short contextual review appears immediately before a wallet transaction and the exact Strava disclosure appears immediately before Reclaim opens. This follows layered, just-in-time notice guidance while keeping routine screens quiet.

V3 remains a constrained hackathon beta. Its transformed Reclaim contexts are public transaction calldata. A broader consumer release requires the V4 privacy architecture described in `privacy-architecture.md`, an operator identity and lawful-basis review, a DPIA where required, and a real two-wallet GPS proof-to-payout exercise.
