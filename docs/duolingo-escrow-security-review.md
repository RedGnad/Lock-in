# LockInDuolingoEscrow (contract B) — security review

Scope: `contracts/LockInDuolingoEscrow.sol`, its backend attestation
(`src/duolingo-escrow-*.ts`, `app/api/duolingo/escrow/*`), and the client flow
(`components/duolingo/*`, `src/lock-in-duolingo-abi.ts`,
`src/duolingo-escrow-client.ts`). This is the **real-USDC** escrow, separate from the
Strava escrow A: it shares no storage, never calls A, and holds no social layer.

Status at review: **not deployed**, no real USDC, fully paused by construction.

## Trust model (stated explicitly)

> The Duolingo evidence signer is a **trusted party**. A compromise of
> `DUOLINGO_EVIDENCE_SIGNER_PRIVATE_KEY` can fabricate completions that never
> happened, and can mint a baseline for any account. The contract's only defence
> against a forged attestation is the ECDSA recovery to `evidenceSigner`; there is
> no independent on-chain re-verification of the Reclaim proof (unlike the hybrid
> model in SECURITY.md). This is the accepted trade-off for contract B.

Consequences the owner accepts:
- the signer key must live only in the Duolingo Vercel project's secret store,
  never in Git, a report, a client bundle, or a Strava environment;
- it must be distinct from the Safe owner, the deployer, and every Strava key;
- the release gate (`scripts/check-duolingo-escrow.ts`) pins the on-chain
  `evidenceSigner` to the exact expected address and refuses a mismatch.

What the proof does and does not establish (unchanged from the platform stance):
zkTLS proves what Duolingo's API returned to an authenticated session, not the
underlying human learning. Account sharing, imported progress, upstream
compromise and provider error remain possible. We never claim otherwise.

## Backend attestation boundary

- The wallet is taken from the signed session cookie, never the request body
  (`requireWalletAuthSession`); the financial allowlist is separate from the
  preview and canary lists (`assertEscrowWalletAllowed`).
- A proof is accepted only with a verified TEE attestation (`verifyProof` +
  `isTeeAttestationVerified`); the self-reported `isAiProof` flag is never the
  gate. Provider id `cdf8cb3b…`, version `1.0.8`, both request hashes, and
  `disable_social` are pinned in `validateDuolingoEvidence`.
- The on-chain identity is an **HMAC pseudonym** of the profile id
  (`duolingoIdentityHash`), never the raw id and never a bare enumerable hash.
- The signed Reclaim context binds each proof to the wallet, the phase, the
  session, and the create-nonce or pactId, so a baseline cannot be replayed as a
  final nor a proof moved between Locks or wallets.
- The financial baseline row is written once per `(wallet, configHash)` and never
  lowered: a staked baseline an athlete could reduce would break the whole delta.
- A final's terms are read from the **chain**, never the browser: the backend
  resolves `configHash`, `participantIdentity`, `targetXp` and the window from the
  contract before signing (`readEscrowPact`, `assertEscrowFinalOpen`).
- Attestations expire in 5 minutes (`ESCROW_ATTESTATION_TTL_SECONDS`), inside the
  contract's `MAX_ATTESTATION_AGE` of 10 minutes; the UI re-checks freshness after
  the approve and refuses to send a doomed transaction.

## Scenario review (each maps to a test)

| Scenario | Handling | Test |
|---|---|---|
| Pool conservation, exact split | `remainingPool = stake · participants`, split by `claimsRemaining` with no dust path that loses funds | `testOnlyFinisherTakesTheWholePot`, `testStakeTiersAllSettle` |
| Rounding | integer division with `remainingPool -=` and `--claimsRemaining`; the last claimant takes the remainder | `testStakeTiersAllSettle` |
| Double claim | `claimed[pactId][account]` set before payout | `testDoubleClaimRejected` |
| No finisher | everyone joined is refunded their stake | `testNobodyFinishesRefundsEveryone` |
| One finisher takes the pot | non-finishers are `NotEligible` | `testOnlyFinisherTakesTheWholePot` |
| Finalize too early | `FinalizationTooEarly` before the submission deadline | `testFinalizeTooEarly` |
| Finalize after grace | permissionless finalize allowed once `now ≥ deadline` | `testOnlyFinisherTakesTheWholePot` (warps past grace) |
| Pause during a live Lock | a completion pause overlapping the Lock cancels it and refunds everyone | `testPauseDuringLiveLockRefundsEveryone` |
| Baseline without stake / stake without baseline | `_consumeBaseline` and `_pullStake` are in one `createPact`/`joinPact` call; a forged baseline reverts before funds move | `testCreateRejectsForgedBaseline` |
| Wrong profile at final | final identity must equal the bound identity | `testFinalIdentityMustMatchBaseline` |
| One profile, two wallets | `identityOwner[pactId]` binds the identity to the first wallet | `testOneProfileCannotBackTwoWallets` |
| Replay (baseline) | global `usedNullifiers`; a reused baseline nullifier reverts | `testBaselineNullifierCannotReplay` |
| Replay (final across wallets) | shared final nullifier reverts on the second wallet | `testFinalNullifierCannotReplayAcrossWallets` |
| Wrong signer | ECDSA recovery must equal `evidenceSigner` | `testWrongSignerRejected` |
| Insufficient final then retry | a short final does not consume the participant; a later sufficient one works | `testExactTargetPassesAndShortfallFails` |
| Nonce binding | zero nonce rejected; identical terms made distinct; a baseline for another nonce or Lock rejected | `testZeroCreateNonceRejected`, `testNonceMakesIdenticalTermsDistinct`, `testBaselineForOtherNonceRejected`, `testJoinBaselineBoundToOnePact` |
| Attestation expiry | `_validateAttestationWindow`; backend TTL 5 min inside the 10-min max | `duolingo-escrow-attestation.test.ts` (window), contract window checks |
| Backend unavailable / final closed | `assertEscrowFinalOpen` refuses before signing; the client shows a factual reason | `duolingo-escrow-chain.test.ts` |
| EIP-712 parity | scheme, policy, config, both typehashes pinned on both sides | `DuolingoParity.t.sol`, `duolingo-attestation.test.ts`, gate `schemeParity`/`policyParity`/`*TypehashParity` |
| Calldata mapping | create/join/final structs encode/decode round-trip | `lock-in-duolingo-abi.test.ts` |

## Refund if verification becomes impossible

If the backend or Reclaim is down for the whole challenge, no participant can
submit a final, `finisherCount` stays 0, and `finalizePact` refunds everyone their
stake. A completion pause that overlaps a live Lock likewise cancels it and
refunds. So a verification outage costs gas and time, never stake.

## Residual risks / open items

- **Evidence-signer trust** is the dominant risk, stated above. Mitigation is
  operational (secret hygiene, gate pinning), not cryptographic.
- **In-memory rate limiting** is best-effort per warm instance; a distributed
  limiter or the Vercel firewall should supplement it at scale.
- **Route integration E2E** (real Reclaim + Neon + chain) is validated at the
  canary, not in CI; the DB-free gating paths and the pure core are unit-tested.
- The client reads pauses and the signer to decide the display mode, but the
  contract remains the sole enforcer of every write.
