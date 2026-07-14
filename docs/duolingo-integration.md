# Duolingo research gate

## Current decision

Duolingo is not a live Lock In mission and cannot be used for a money-bearing pact. Duolingo does not expose a supported public API for this use, and its terms restrict automated extraction. Lock In will not publish a provider or activate an escrow until an official API or written permission makes the integration supportable.

The mission catalogue is intentionally informational: there is no Duolingo provider, API route, contract adapter, environment variable, or activation control in the product.

## What a future proof could establish

If the permission gate is cleared, Reclaim could prove that Duolingo credited activity to an authenticated account. It could not prove that a person learned without automation, account sharing, or outside help. Product wording must therefore say “Duolingo credited progress,” never “you learned.”

A streak alone is insufficient because it can be protected or repaired. A final XP total alone does not show when XP was earned. A future adapter would need:

1. A fresh authenticated baseline bound to the wallet and pact.
2. A fresh final state from the same Duolingo account.
3. Active-day evidence or a capped progression threshold inside the pact window.
4. Account commitments and proof nullifiers that prevent replay and multi-wallet reuse within a pool.

Raw XP must never be used as a competitive ranking because earning rates differ by exercise, bonuses, and product mechanics.

## Research-only technical candidates

Authenticated responses for the current user and daily XP summaries may be technically observable, but they are internal endpoints rather than a supported developer contract. They may be inspected only in a non-monetary research environment after confirming that the test complies with platform rules. No credentials, cookies, tokens, email addresses, or unnecessary profile fields may be retained.

## Activation checklist

1. Obtain a supported API or written permission.
2. Complete a privacy and legal review, including the fact that Duolingo serves minors while Lock In money modes are 18+.
3. Capture the minimum authenticated fields and prove that account A cannot submit account B’s data.
4. Publish and pin a separate provider and adapter; never weaken the Strava verifier to accommodate it.
5. Test replay, wrong-account, stale-state, baseline/final mixing, bot-like progression, cancellation, and refund paths.
6. Update the privacy policy and rules before any public activation.
