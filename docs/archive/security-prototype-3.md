# Historical prototype 3 Strava security model

> Retired on July 15, 2026. This document describes a Reclaim experiment only. It is not a public product release or the active Lock In security model. See the root [`SECURITY.md`](../../SECURITY.md) for the current unreleased security model.

## What V3 acceptance proved

A V3 acceptance meant four authenticated Strava responses were attested through Reclaim and matched the private provider `f3ec8292-d8f3-487c-a79d-f53f482f88e2@1.0.2`. Together they established that Strava exposed a challenge-bound Run in the pact window, with the expected distance and motion fields, `has_latlng=true`, `trainer=false`, and `flagged=false`.

The proof was bound to a wallet, pact, and short-lived Lock In session. Exact provider hashes, an application attestation, onchain nullifiers, and the completion bitmap reduced configuration substitution and replay.

## Fundamental limitation

Strava and zkTLS attested a Strava record, not biological movement. Imported or synthetic GPS, account sharing, a lent device, or sophisticated automation remained possible. The transformed proof context also became public transaction calldata and could not be deleted from Monad.

Those integrity, privacy, provider-permission, and operational limits are why V3 is not used for funded production. The source and tests remain only as auditable development history.
