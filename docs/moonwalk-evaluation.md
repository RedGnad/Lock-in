# Moonwalk evaluation

Evaluated on July 14, 2026.

## Decision

Moonwalk should not replace Strava as Lock In's proof source. [Moonwalk](https://moonwalk.fit/) is an accountability product, not a primary fitness-data provider: it already runs step contests, accepts crypto deposits, and redistributes missed commitments on Solana. Its underlying step sources are documented in its [FAQ](https://moonwalk.fit/faq).

Using Moonwalk as the settlement oracle would stack one wagering/accountability product on top of another, inherit Moonwalk's availability and policy risk, and make Lock In dependent on a direct product analogue. It would also fail to prove more than Moonwalk itself already claims.

The public Reclaim registry contained 20,368 active providers when checked and had no provider whose configuration referenced `Moonwalk` or `moonwalk.fit`.

## What Lock In should reuse

- Accessible daily step goals alongside higher-friction GPS running goals.
- Invite and crew-based social accountability.
- Progress that is visible throughout the challenge rather than only at settlement.
- User-local day boundaries as a future consumer improvement; the unreleased build uses displayed UTC boundaries for deterministic settlement.
- Explicit registration, active, grace, and claim states.
- Fitness data sourced from an established health platform rather than from the accountability app itself.

## Recommended physical mission stack

1. Keep Strava GPS Run as the high-integrity launch mission. It has the strongest implemented evidence policy: the 3-day template is strict, while the 7-day template includes two non-required days.
2. Add a lower-friction Steps mission from a primary source. Prefer Fitbit's supported web API for the web product; Health Connect requires an Android path, and Apple Health requires a native iOS/HealthKit path. Do not build a new integration on the deprecated Google Fit APIs.
3. Consider Moonwalk only as a future distribution or partnership integration. A direct integration requires an official API, documented onchain game interface, or written permission. Do not capture its private web traffic merely because Reclaim could technically do so.

## Product positioning

Moonwalk validates demand for social financial accountability. Lock In differentiates through multi-domain missions, minimized proof fields with explicit onchain-data disclosure, Monad settlement, a strict one-dollar cap during controlled testing, and independently verifiable mission adapters.
