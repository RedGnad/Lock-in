# Lock In — Strava zkTLS blocker: investigation brief for a new advisor

Date: 2026-07-16. Author: engineering session. Audience: an advisor who will research a fix.

This brief separates **facts** (observed, reproducible) from **inferences** (our best guess). The goal is a fresh, independent investigation of one blocker: **Strava proofs generate but never finalize through Reclaim's hosted flow.**

---

## 1. What Lock In is

A real-money, PVP self-improvement app on **Monad mainnet (chain id 143)**. Friends stake USDC (max 1 USDC/player) on a "Lock" (a multi-day challenge). Completion is verified with **zkTLS proofs (Reclaim Protocol)** of real behaviour on third-party sites, then settled on-chain (finishers split quitters' stakes; fair-refund cases exist). Two missions: **Strava** (a GPS run) and **Duolingo** (XP gained). Public wording is "Lock"; internal Solidity/TS names may still say "Pact" for ABI/storage compatibility.

The differentiator is the **multi-provider, verified, on-chain, PVP** combination, with running (Strava) as the intended flagship. Shipping Duolingo-only is considered weak.

---

## 2. Repository and how to inspect it

- GitHub: **`https://github.com/RedGnad/Lock-in`**
- Active integration branch: **`integration/locks-production`** (all work below is here)
- Other branches: `agent/release-locks-hybrid-proofs` (advanced release architecture), `hotfix/production-ui` (current public UI), `main` (behind).
- Stack: Next.js 16 (App Router) + TypeScript, Solidity 0.8.30 with Foundry, viem/wagmi, `@reclaimprotocol/js-sdk@5.8.2`.
- Validation: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test` (91 TS + 56 Solidity), `pnpm exec tsc --noEmit`, `pnpm check:contract-sizes`. All green on the integration branch.

Key files:
- Strava provider (custom Reclaim provider definition + injection): `providers/strava-date-distance.json`, `providers/strava-date-distance-injection.js`
- Strava on-chain verifier: `contracts/verifiers/LockInStravaReclaimVerifier.sol`
- Duolingo on-chain verifier: `contracts/verifiers/LockInReclaimVerifier.sol`
- Off-chain policies: `src/strava-proof-policy.ts`, `src/duolingo-proof-policy.ts`
- On-chain proof bundling: `src/reclaim-onchain.ts` (`toDirectProofBundle`, `canonicalClaimContext`)
- App proof flow: `app/api/reclaim/session/route.ts`, `app/api/reclaim/status/route.ts`, `app/api/reclaim/verify/route.ts`, `app/api/health/route.ts`
- Diagnostic tooling we wrote: `scripts/capture-strava-proof.ts`, `scripts/capture-duolingo-proof.ts`, `scripts/poll-proof.ts`, `scripts/transform-duolingo-proof.ts`, `scripts/validate-capture.ts`
- Real-proof on-chain test + fixture: `test/LockInDuolingoRealProof.t.sol`, `test/fixtures/duolingo-real-onchain.json`

---

## 3. Status summary (honest)

| Item | State |
|---|---|
| Branch reconciliation (advanced release + production UI) | Done, validated, pushed |
| Vercel preview | Deployed (SSO-gated), production untouched |
| **Duolingo proof capture** | **Works.** Real 1.0.8 proof captured, SDK+TEE valid, providerHashes match on-chain pins |
| **Duolingo on-chain verification** | **Works after a fix** (see §5). Real proof passes the final verifier grammar in a forge test |
| **Strava proof capture (generation)** | **Works.** The TEE proof is generated every attempt |
| **Strava proof submission (finalization)** | **FAILS consistently through Reclaim's hosted flow** (see §4) |
| Contract deployment on Monad | Not done. Escrow requires both verifiers' `LIVE_SCHEMA_CONFIRMED=true` |
| Production (real testers) | Not live. Public site is paused on an old escrow |

---

## 4. THE BLOCKER — Strava hosted-flow submission failure (main research target)

### 4.1 Provider background (facts)
- Private Reclaim provider id `f3ec8292-d8f3-487c-a79d-f53f482f88e2`, app id `0x15678cD04e54ccc2bC1c24cb455be3C60Eb11ADf`.
- Originally published as **1.0.3 with NO custom injection**. Symptom: after login the hosted flow sat on "fetching" and never issued the provider's requests (the requests were defined but nothing drove them).
- We added a **custom JS injection** (repo: `providers/strava-date-distance-injection.js`) that, after sign-in on `www.strava.com`, issues the exact provider requests and releases `reclaim.requiresUserInteraction(false)` once it finds the challenge-titled activity. Publishing it auto-bumped the provider version through the Reclaim dashboard: 1.0.3 → 2.0.0 → 3.0.0 → 4.0.0 → **5.0.0** (current). The provider's **request schema is unchanged** from 1.0.3; only the injection was added, plus `Accept: application/json` + `X-Requested-With: XMLHttpRequest` on the activities request.
- Provider config on Reclaim shows `"useProxy": true`, `"injectionType": "HAWKEYE"`, `"verificationType": "WITNESS"`. The hosted flow runs in a **remote datacenter browser** ("Popcorn" kernel, streamed to the user via VNC over `wss://popcorn-gateway-*.reclaimprotocol.org/vnc-ws/...`). The user must **re-login to Strava inside that remote browser** (their local Chrome session is not used).

### 4.2 The activity data is correct (fact)
Running the exact activities request manually in the user's own logged-in Strava tab returns valid JSON:
`models=1 name0="LI-CEA91BDAEFB2DEF1D8459F57D01" has_latlng=true trainer=false`.
So the target activity, title match, GPS and trainer flags are all correct. The injection's match logic (`payload.models[0].name === challenge`) is satisfiable.

### 4.3 The failure (facts, reproduced ~7 times over ~35 minutes)
Every recent attempt reaches proof generation then fails at finalization. From the Reclaim portal console (client side):
1. `isGeneratingProof=true`, poll keys include `teeProofAvailable`, `proofsGenerated`, `extractedParameters`, `responseRedactions`, `perClaimParams` → **the TEE proof IS generated**.
2. Then: `❌ Session ended due to inactivity` → `❌ [SEVERE] Verification aborted with error: {"type":"BROWSER_CONNECTION_FAILED","message":"Session ended due to inactivity"}`.
3. Then: `portal-api.reclaimprotocol.org/api/session/notify-callback` returns **502** (repeatedly).
4. Final session status via SDK `fetchStatusUrl`: **`ERROR_SUBMISSION_FAILED`**, `proofs: []`.

Reproduced session ids (all `ERROR_SUBMISSION_FAILED`, 0 proofs): `0fc5fb059b`, `5f155a6834`, `024b209070`, `22a0a6194a`.

### 4.4 What we have ruled out (facts)
- **Not our activity / title / GPS** — verified correct (§4.2); the user made real GPS runs.
- **Not our CDP automation** — we reproduced the identical `ERROR_SUBMISSION_FAILED` by opening the request URL **manually in a normal, focused Chrome tab** (session `22a0a6194a`), no automation involved.
- **Not the injection failing to run** — when it fails at generation the injection would `reportProviderError` with a diagnostic string; it does not, i.e. it released successfully and generation started.
- **Not app credentials** — the same app id/secret and the same SDK/hosted flow **work for the Duolingo provider** (`cdf8cb3b-2976-4413-ab2d-693ae5028380@1.0.8`); a Duolingo proof was captured successfully.

### 4.5 Inference (our best guess, NOT verified)
The failure is on **Reclaim's hosted-flow finalization**: the remote browser session is declared "inactive"/`BROWSER_CONNECTION_FAILED` at or just after proof generation, and the portal-api `notify-callback` is returning 502. Whether this is a **transient Reclaim incident** or a **persistent limitation of this heavy 4-request Strava provider in the remote browser** we could not determine from public docs.

### 4.6 Open research questions for the advisor
1. What exactly triggers `BROWSER_CONNECTION_FAILED: Session ended due to inactivity` in Reclaim's hosted (Popcorn) flow, and is there a keep-alive/timeout/config to make a generated proof actually submit? Is the `notify-callback` 502 a current incident (check Reclaim status/Telegram/Discord)?
2. Can this provider run **without the remote proxy** (`useProxy: false` / client-side execution) so the proof is generated and submitted in the user's own browser (own IP, own Strava session), bypassing the failing remote-browser finalization? Is that supported for a private HAWKEYE provider?
3. Is the **Reclaim browser-extension SDK** (`@reclaimprotocol/browser-extension-sdk`) the only reliable on-device path, or is there a lighter one? Note: we consider a desktop extension a poor consumer fit (≈280 MB circuits, permissions, exploit surface for a money-staking app). The natural on-device path is the **Reclaim mobile SDK** (out of scope for the 1-week deadline).
4. Is depending on Reclaim's **hosted backend reliability** acceptable for a production money-staking consumer app? What is their SLA/uptime story?
5. **Alternatives to Reclaim** for authenticated Strava data (other zkTLS/oracle providers: zkPass, Opacity, Primus/PADO, or a Strava OAuth + server-attestation fallback)? Trade-offs vs the current Reclaim on-chain verifier design?

---

## 5. Duolingo on-chain verification — a fixed, reusable finding

Rigorous validation (the kind the previous advisor demanded) uncovered and fixed a real verifier bug that also affects Strava:

- The real captured Duolingo proof was initially **rejected** by the deployed verifier with `InvalidContext()` at `LockInReclaimVerifier.sol:132`.
- **Root cause:** Reclaim runs the two requests (ownership + XP) in **different TEE enclave instances**, so `pcr0_t` and `tee_session_id` differ between the two proofs, while the verifier required an **identical cross-proof TEE group**.
- **Fix (commit `a77fccf`):** the cross-proof TEE group now folds only the **stable** enclave-image measurement `pcr0_k`; `pcr0_t` is format-checked per proof but not required equal. The two proofs stay bound by the shared `attestationNonce`, attestation timestamp, `pcr0_k`, and the pinned witness signature.
- **Evidence:** `test/LockInDuolingoRealProof.t.sol` feeds the real captured proof (fixture `test/fixtures/duolingo-real-onchain.json`, built via `scripts/transform-duolingo-proof.ts` using the app's `toDirectProofBundle` canonical-context logic) through the final grammar and now **passes** (reads `totalXp=8193`). All 31 synthetic verifier tests still pass, so the relaxation is surgical.
- Note for the advisor: the identifier check requires the **canonical** claim context (`src/reclaim-onchain.ts: canonicalClaimContext`), not the raw context; `Claims.hashClaimInfo(rawContext)` does NOT equal the signed identifier, but the canonicalized one does. The same `pcr0_t` relaxation will be needed in `LockInStravaReclaimVerifier.sol` once a real Strava proof exists to test against.

Remaining for Duolingo to be production-real: deploy the (fixed) verifier + parser + escrow on Monad, wire env, flip `LIVE_SCHEMA_CONFIRMED`, and run a 2-wallet create/join/baseline/XP-delta/settle/claim E2E.

---

## 6. On-chain / release facts

- Monad mainnet, chain id 143. Stake token expected `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` (USDC), cap 1 USDC/player.
- Pinned Reclaim witness: `0x244897572368Eadf65bfBc5aec98D8e5443a9072`.
- `LockInEscrow` constructor reverts unless BOTH verifiers report `LIVE_SCHEMA_CONFIRMED=true`, so nothing deploys until Strava is also resolved (or the escrow is changed to allow a single mission).
- Current public site is paused on an older escrow `0xA75375E11A8564b9DFe5fe2084Ff277Bb41c6a6a` (creation/join/check-ins disabled; settlement/claims remain available by design).

---

## 7. Resources to consult

- Reclaim Protocol docs: `https://docs.reclaimprotocol.org`
- Reclaim GitHub org: `https://github.com/reclaimprotocol` — notably `js-sdk`, `reclaim-extension`, `reclaim-browser-extension-sdk`, `provider-web-script-dev`, `reclaim-solidity-sdk`, `verifier-solidity-sdk`
- Reclaim developer dashboard (where the provider + injection live): `https://dev.reclaimprotocol.org`
- Reclaim community support (Telegram/Discord) — fastest path to confirm whether §4 is an incident
- Monad docs: `https://docs.monad.xyz`
- Our repo: `https://github.com/RedGnad/Lock-in` (branch `integration/locks-production`); this brief lives at `docs/reclaim-strava-investigation.md`

---

## 8. The one-sentence ask

Strava zkTLS **proof generation works**; the block is **Reclaim's hosted-flow finalization** (`BROWSER_CONNECTION_FAILED` + `notify-callback` 502, `ERROR_SUBMISSION_FAILED`), reproduced ~7x including a manual non-automated run. We need either (a) a way to make the hosted flow reliably submit, (b) a client-side/`useProxy:false` path that avoids the remote browser, or (c) a viable alternative — without shipping a heavy desktop extension.
