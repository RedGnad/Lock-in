# Lock In — Duolingo + Strava proof pipeline: status report for the advisor

Date: 2026-07-16. Branch: `integration/locks-production`. This report is **evidence-based**: every claim below was re-verified by running the suites against the working tree, not relayed from a summary.

## 0. One-paragraph summary

Both missions are now technically demonstrated end to end at the proof + on-chain-grammar layer. Duolingo was captured and its real proof passes the deployed verifier after a TEE-grouping fix. Strava was unblocked by redesigning the provider from 4 claims to 2 (the 4-claim set was too heavy for Reclaim's hosted browser and timed out); the real 2-claim capture passes the production `verifyProof` (SDK + TEE) and, after a full verifier refactor, passes the new on-chain grammar. **Both `LIVE_SCHEMA_CONFIRMED` gates remain `false`. Nothing is committed or deployed.** Remaining before flipping gates: resolve the `isAiProof` provenance question, then deploy contracts and run a two-wallet E2E.

## 1. Verified test state (working tree, just re-run)

- Solidity: **65 tests pass** (`forge test`), 0 fail. Includes:
  - `testRealCapturedDuolingoProofPassesFinalGrammar` (real Duolingo proof)
  - `testRealCapturedStravaProofsPassFinalGrammar` (real Strava 2-claim capture, session `fa8968844e`)
  - `testRealCapturedStravaContextFlagsAreParsedNotGated` (isAiProof/isPortalProof parsed, not gated)
  - `testRealProofsRejectAnotherAccount` (wrong wallet reverts)
  - 31 synthetic Strava verifier tests + the Duolingo synthetic set still pass.
- TypeScript: **92 tests pass** (`pnpm test:policy`), `tsc --noEmit` clean.
- Contract sizes under Monad's 128 KiB limit (margins ~104–130 KB).
- `LIVE_SCHEMA_CONFIRMED = false` in both `LockInReclaimVerifier.sol` (Duolingo) and `LockInStravaReclaimVerifier.sol` (Strava).
- Working tree is **uncommitted** (refactor held for review); nothing deployed on Monad.

## 2. Duolingo

- Real 1.0.8 proof captured (session `7bc9142e25`); passes production `verifyProof` semantics; `providerHash` values match the two pinned request hashes.
- The real proof initially reverted `InvalidContext` at the cross-proof TEE-group equality check because Reclaim ran the two requests in different enclave instances, so `pcr0_t` and `tee_session_id` differ. **Fix:** the cross-proof group now folds only the stable enclave-image measurement `pcr0_k`; `pcr0_t` is format-checked per proof but not required equal. Bound by `attestationNonce`, attestation timestamp, `pcr0_k`, witness signature.
- Evidence: `test/LockInDuolingoRealProof.t.sol` + `test/fixtures/duolingo-real-onchain.json`. Passing; all 31 synthetic Duolingo tests still pass.

## 3. Strava — the blocker and the fix

### 3.1 Root cause (proven via Reclaim session analytics)
`logs.reclaimprotocol.org/api/analytics-logs/session/<id>` showed, for every failed Strava session: `LOGIN_INDICATORS_NOT_FOUND` on `strava.com/athlete/training` (logged in), then ~30 s later `LOGIN_INDICATORS_FOUND` with `indicator: timeout` on the same page. The login-indicator re-check **times out while the heavy 4-claim proof set is being generated**, so Reclaim declares `BROWSER_CONNECTION_FAILED: Session ended due to inactivity` (then `notify-callback` 502 → `ERROR_SUBMISSION_FAILED`). Duolingo (2 light claims) ends with a clean `LOGIN_INDICATORS_NOT_FOUND` and succeeds. This was reproduced ~7 times, including a manually opened, focused tab (rules out our CDP automation).

### 3.2 The fix: 4 claims → 2
The three `training_activities` claims (identity/metrics, GPS, trainer) hit the same response and were merged into one combined claim (11 response matches/redactions), keeping the marker claim. Published on Reclaim as **v6.0.0**. The hosted, no-install web flow then reaches submission: real capture `sessions/strava-6.0.0-capture-fa8968844e.json`.

### 3.3 The capture passes the production barrier
`verifyProof(providerId, "6.0.0", allowedTags: [], teeAttestation: { appSecret })` returns `isVerified=true`, `isTeeAttestationVerified=true`, no error. `fetchStatusUrl` reports `statusV2=PROOF_SUBMITTED`, `providerVersionString="6.0.0"` (no `-ai.*` prerelease). `claimData.parameters` carries the full HTTP grammar (url, method, headers incl. `X-Requested-With`, responseMatches, responseRedactions); a real top-level `teeAttestation` object is present; witness is `0x244897572368Eadf65bfBc5aec98D8e5443a9072`. So this is **not** the degenerate empty-parameter AI-portal form.

## 4. The isAiProof question (still open, gate stays false)

The context carries `isAiProof: true` and `isPortalProof: true`, and `claimData.owner` is the legacy placeholder `0x1234…7890`.

- What is resolved: executed `providerVersionString == "6.0.0"` (no `-ai` tag); `statusV2 == PROOF_SUBMITTED` (not `AI_PROOF_SUBMITTED`); `verifyProof` + TEE pass with `allowedTags: []`; full HTTP grammar present. These strongly indicate `isAiProof` here is a portal-orchestration flag, not the AI-provider path.
- What is NOT yet resolved (the one hard gate on going live): a definitive statement of `isAiProof` semantics. We could not reach Reclaim support/community (no accessible channel), so we cannot get their confirmation that the flag denotes only portal orchestration while the claim remains a WITNESS attestation over the pinned HTTP grammar.
- We also could not find a `Verification Type` field on the current Reclaim dashboard for this provider to confirm `verificationType == WITNESS` directly; the version/status/verifyProof signals are our best available evidence.

Per the advisor's directive, the verifier **parses `isAiProof`/`isPortalProof` and surfaces them but does not gate on them yet**. Flipping `LIVE_SCHEMA_CONFIRMED` to `true` is held until the semantics are confirmed.

## 5. The Strava verifier refactor (4 roles → 2), as implemented

`contracts/verifiers/LockInStravaReclaimVerifier.sol` (~513 lines changed) + `src/strava-proof-policy.ts` mirror it. Verified against the real fixture in `test/LockInStravaRealProof.t.sol` (reads back 209 m, moving 117 s, elapsed 147 s, the real run).

Advisor constraints, each implemented and code-verified:
- **Two roles:** `ROLE_MARKER` (`GET https://www.strava.com/athlete/training`, marker/userId) and `ROLE_ACTIVITY` (the single combined `training_activities` request with id, name, sport_type, start_time, distance_raw, flagged, moving/elapsed/elevation raw, has_latlng, trainer).
- **Schema pinned from `claimData.parameters`, not `context.providerHash`:** exact URL, method, empty body, keccak of responseMatches, keccak of responseRedactions, exact paramValues field set, and `paramValues == context.extractedParameters`. The live 6.0.0 context has no `providerHash`, so that context check was removed (fabricating one would change the signed identifier).
- **8-key context grammar** matched to the real capture: `attestationNonce`, `attestationNonceData` (applicationId == Lock In app id, sessionId, attestationVersion v3), `contextAddress`, `contextMessage`, `extractedParameters`, `isAiProof`, `isPortalProof`, `reclaimSessionId`. No `pcr0_*`/`tee_session_id` (they are not in the Strava context; the full TEE is the off-chain top-level object). So the Duolingo `pcr0_t` relaxation does not apply here.
- **User binding via signed context** (`contextAddress == wallet`, `contextMessage == pactId:dayIndex`, `reclaimSessionId == session`), never via `owner` (deliberately unchecked; legacy placeholder is expected).
- **Business policy** on the activity claim: name == challenge, sport_type == Run, flagged == false, has_latlng == true, trainer == false, distance ≥ target, plausible speed/pause ratios, start_time within the Lock window.
- **Version re-pinned to 6.0.0** across the verifier, `src/strava-proof-policy.ts`, `app/api/health/route.ts`, `app/api/reclaim/verify/route.ts`, and the deploy/canary/check scripts.

The hybrid trust model is unchanged: the backend `/verify` route validates the full SDK proof, provider schema (`allowedTags: []`), and TEE attestation, then requires exact parity with the Solidity verifier before signing evidence.

## 6. Exit gate before `LIVE_SCHEMA_CONFIRMED = true` and mainnet

Done: two-claim provider live; capture passes verifyProof + TEE; providerVersionString == 6.0.0; exactly two proofs; two pinned request hashes; real fixture passes the two-claim parser; off-chain policy and Solidity agree; mutations revert (negative tests); Duolingo pcr0_t fix; both real fixtures committed as tests.

Open: (a) confirm `isAiProof` semantics with Reclaim (the only hard blocker to flipping the Strava gate); (b) deploy verifier + parser + escrow on Monad with the funded key (gas only) and set the release-owner Safe; (c) wire Vercel non-funded secrets + hashes; (d) `/api/health` green; (e) two-wallet E2E: create/join/baseline (Duolingo) or day check-in (Strava)/settle/claim/refund with ≤ 1 USDC.

## 7. Direct questions for the advisor

1. Given `providerVersionString == "6.0.0"`, `statusV2 == PROOF_SUBMITTED`, `verifyProof` + TEE true with `allowedTags: []`, and full HTTP grammar present — is `isAiProof: true` acceptable to gate on as WITNESS, or is an explicit Reclaim confirmation strictly required before going live? With no reachable Reclaim support channel, what independent check would you accept as sufficient?
2. Is there any objection to committing the refactor now (it keeps `LIVE_SCHEMA_CONFIRMED=false`), so the code is reviewable on GitHub?
