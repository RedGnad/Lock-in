# Proof privacy architecture

## V3 beta trade-off

V3 verifies four Reclaim proofs directly on Monad and also requires a short-lived Lock In policy attestation. This maximizes independent settlement checks, but the transformed proof contexts are transaction calldata. The athlete marker, activity ID, exact day-code-only title, start time, distance, motion metrics, GPS/trainer/flag booleans, and proof metadata are therefore public and permanent.

The detailed GPS route, Strava credentials, cookies, and access tokens are never included. Requiring the activity title to equal the random pact prefix plus its fixed `D01`–`D30` suffix prevents accidental publication of a free-form title and makes each day independently searchable.

This disclosure is acceptable only for the experimental, 18+, one-USDC-cap beta with explicit acknowledgement. It is not the target privacy architecture for a general consumer launch.

## Consumer launch gate

Before a broader launch, Lock In must complete a data-protection impact assessment and move personal activity fields out of public calldata. The target design is a minimal onchain completion statement containing only:

- pact, wallet, and day;
- provider/version commitment;
- service-identity commitment scoped to the pact;
- globally unique activity nullifier;
- policy result and short expiry.

The corresponding Reclaim proof must be verified in an auditable environment with key isolation, rotation, monitoring, and a published trust model. A plain application-server signature alone is not an equivalent replacement for direct Reclaim verification; selective disclosure, an attested verifier, or another cryptographic proof layer is required before calling the design consumer-grade.

## Decision rule

Do not raise stakes, remove the beta label, enable sensitive-data missions, or market V3 as privacy-preserving until that migration and legal review are complete.
