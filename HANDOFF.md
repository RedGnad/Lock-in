# Lock In — agent handoff (July 15, 2026)

Read this before changing or deploying anything. The project currently has a stable public UI and a more advanced development branch that are **not yet safely reconciled**.

## 1. Product objective

Ship a real English-language consumer app on Monad where friends create competitive self-improvement challenges called **Locks**:

- Strava running and Duolingo learning are the first missions.
- Every player stakes the same amount, never more than 1 USDC.
- A Lock lasts 3–30 days and requires a published number of successful days.
- Finishers recover their stake and split quitters' stakes; fair refund cases remain possible.
- The experience is social/PVP, not a solitary habit tracker: crews, progress, sharing, reactions, handles, score and leaderboards are desired.
- Proofs must be replay-resistant and identity-bound. Do not claim that zkTLS proves physical reality: Strava can still receive spoofed GPS. The system can reject manual/trainer/flagged/no-GPS/implausible activities, but cannot make consumer GPS unforgeable.
- No “coming soon” surfaces. Do not expose unfinished modes.
- Public product wording is **LOCK**, never PACT. `pact`, `pactId`, `PactCreated`, contract functions, ABI names, CSS classes and the legacy `/pact/:id` route may remain internal for compatibility.
- Privacy contact: `mookipstore@hotmail.com`.

## 2. Current public production

- URL: https://lock-in-liart-theta.vercel.app
- Vercel project: `redgnads-projects/lock-in`
- Project ID: `prj_IZDcfqcBXuennEWxenqaGWHTAY0y`
- Org ID: `team_i44oL7YoLoQASeSJ0k7SDAfe`
- Production source branch: `hotfix/production-ui`
- This branch is based on stable commit `a71f7a9`, then adds isolated UI/branding fixes.
- The legacy `/pact/:id` URL redirects to `/lock/:id`; new links and shares use `/lock/:id`.

The public UI was deliberately restored after the advanced release branch was accidentally deployed and showed only fail-closed “paused/unavailable” screens. Do **not** deploy `agent/release-locks-hybrid-proofs` directly to production until its contract, verifier, hashes and Vercel configuration all satisfy its release health checks.

Useful rollback deployment if a future deploy breaks the UI:

- Original stable deployment: `dpl_AudyZ4QsK2AtUgZPRB8vL3VagASs`
- Restore with: `vercel promote dpl_AudyZ4QsK2AtUgZPRB8vL3VagASs --yes`

This rollback loses later UI hotfixes, so use it only as recovery.

## 3. Git branch topology

### `hotfix/production-ui`

What users currently see. It contains:

- stable pre-release app behavior from `a71f7a9`;
- consistent tactile button/card shadows;
- mission cards with equal neutral surfaces and black shadows, with no initial visual selection;
- orange outline on hover/selection;
- mission click advances directly to pace selection, so no first-step Continue button;
- complete visible terminology migration from PACT to LOCK;
- `/lock/:id` public route with backward-compatible `/pact/:id` redirect.

Known limitation: this branch still contains the older Duolingo bio-code product flow and does not contain all later social/provider work.

### `agent/release-locks-hybrid-proofs`

Advanced development branch, pushed at commit `60ebf8c1f853752718f579efd41e8c70ca0bf2a3`.

PR: https://github.com/RedGnad/Lock-in/pull/1

It contains the stronger release architecture, newer Reclaim work, social Lock Score/leaderboard work and fail-closed production validation. Before the UI hotfix split it passed:

- 91 TypeScript tests;
- 55 Solidity tests;
- Next production build and TypeScript;
- contract-size checks under Monad's limit.

Raw deployment of this branch produced a paused UI because the deployed contract and environment did not satisfy its expected code hashes, schema, ownership, verifier bindings and live-provider gates. This was correct fail-closed behavior but unacceptable as the public UI.

### `main`

`origin/main` is still `a71f7a9`. It is behind both branches. Do not assume main represents the final product.

## 4. Reclaim providers and proof status

### Strava

- Published private provider: `f3ec8292-d8f3-487c-a79d-f53f482f88e2`
- App/release branch is pinned to published version `1.0.3`.
- Version `1.0.3` has four exact requests and was previously replay-tested.
- Draft `1.0.4` source is in `providers/strava-date-distance-injection.js` and `providers/strava-date-distance.json` on the advanced branch.
- Draft 1.0.4 is not yet safely published/canaried and must not replace 1.0.3 blindly.
- Existing policy rejects manual/no-GPS, trainer, Strava-flagged, wrong sport, implausible speed/pause ratio, wrong day/title/session, stale proof and activity reuse.
- It proves what authenticated Strava displays, not that a human physically ran without GPS spoofing.

### Duolingo

- Published private provider: `cdf8cb3b-2976-4413-ab2d-693ae5028380`
- Validated version: `1.0.8`.
- Successful real canary session: `b63359fc37`.
- Result: `PROOF_SUBMITTED`, two proofs, SDK-valid and TEE-attestation-valid.
- Injection immediately calls `requiresUserInteraction(true)`, waits for login and both exact requests, then releases interaction. This fixed the portal auto-close race.
- Reclaim did not reuse the Duolingo login between verification-kernel sessions. Expect a Duolingo login on each proof unless Reclaim behavior changes.
- The advanced branch's proof excludes username and exposes stable profile identity, XP and marker as required by the policy.
- Production still uses older bio-code wording/flow. Reconcile production with provider 1.0.8 before inviting real Duolingo testers.

Relevant advanced-branch files:

- `providers/duolingo-owned-xp.json`
- `providers/duolingo-owned-xp-injection.js`
- `docs/duolingo-integration.md`
- `src/duolingo-proof-policy.ts`
- `src/reclaim-client.ts`
- `contracts/verifiers/LockInReclaimVerifier.sol`

## 5. Onchain and release safety

- Network: Monad mainnet, chain ID 143.
- Previously observed escrow address: `0xA75375E11A8564b9DFe5fe2084Ff277Bb41c6a6a`.
- Intended release-owner Safe supplied by user: `0x79C53151315FaD9163f75a65A8Bd4D04a10e1e45`.
- Real-money behavior is capped at 1 USDC/player, but contracts remain unaudited. Never remove the cap or silently bypass health checks.
- Advanced-branch Strava and Duolingo `LIVE_SCHEMA_CONFIRMED` gates remain false/fail-closed until exact live evidence schemas and witnesses are confirmed.
- Do not unpause creation/join/check-in until contract code hash, owner, schema, pause state, stake token metadata/cap, verifier addresses/code hashes/provider IDs/parser and evidence/access signers all match the release manifest.
- Settlement, refunds and claims must remain available even when new risk-taking actions are paused.

The user's funded `PRIVATE_KEY` is local only. It was never uploaded to Vercel. The user previously authorized gas-only Monad deployment using that local key, but do not print it, commit it or upload it. `.env` is ignored and must remain untracked.

Vercel is authorized to contain only:

- `SECRET`;
- non-funded evidence/access validation signer keys as required;
- generated `SESSION_SIGNING_SECRET`;
- `NEXT_PUBLIC_PRIVACY_EMAIL`;
- public addresses/configuration.

## 6. Product and UI decisions already made

- English only for the product UI.
- Hero direction: accountability that pays; competitive and cooperative. Preserve the punch of “funded by those who quit” without excessive legal/product copy on the landing.
- Stakes are preset and seamless: 0.1, 0.5 or 1 USDC; users must never enter more than 1 USDC.
- Durations favor multi-day progression; 3–30 days. Avoid a farmable one-day core mode.
- Strava and Duolingo mission cards are equal neutral surfaces. Do not color-code services as red/green or black/white categories.
- Both mission cards use black shadows. Orange indicates hover/selection through the border, not elevation.
- Clicking a mission selects it and advances immediately. No Continue button on mission selection.
- Buttons use the same “physical press” interaction: visible shadow at rest, reduced shadow + down/right translation on hover, no shadow on active press.
- Favicon is a simple orange `IN`, not a generated/AI-looking icon.
- Avoid redundant privacy copy in the main flow; Rules/Privacy remain reachable in footer and at consent/transaction points.
- Public brand noun is Lock. Technical Solidity/TypeScript names may remain Pact to preserve ABI/storage compatibility.

## 7. Social scope

The product should feel multiplayer, not like a form around a contract. The advanced branch contains work for handles, Lock Score, leaderboard, crew progress and high-fives. Production stable does not necessarily include all of it.

Do not require users to rename their Duolingo account or replace an existing social identity with a random verification code. Verification codes should be temporary/additive and product social identity should be separate. Desired public identity mechanics:

- optional unique Lock In handle;
- crew roster and daily progress;
- high-fives/reactions;
- all-time and mission-filtered leaderboard;
- Lock Score based on verified performance, not stake size;
- shareable invitation/progress cards.

## 8. Highest-priority remaining work

Work in this order to minimize wasted tokens and avoid another broken production deploy:

1. **Reconcile branches deliberately.** Start from the advanced branch or a new integration branch. Bring over the small production UI commits from `hotfix/production-ui`; do not overwrite advanced proof/security files with old stable versions. Resolve copy and component conflicts manually.
2. **Preserve a preview before production.** Deploy the integrated branch to a non-production Vercel preview and visually test landing, wallet, create, join, Strava, Duolingo, mobile and `/lock/:id`.
3. **Finish live schemas.** Publish/canary the intended Strava provider revision only if needed; capture exact Strava and Duolingo proof payloads; update parser/verifier fixtures; turn each live-schema gate true only with evidence.
4. **Deploy final contracts once.** Run contract size checks, full tests and deployment dry-run. Deploy verifier/parser/escrow with the local funded key, gas only. Set the release-owner Safe. Verify bytecode and bindings onchain.
5. **Wire Vercel without the funded key.** Update public addresses, hashes, providers and non-funded signer secrets. Run `scripts/check-production.ts` and `/api/health` until every required check is green.
6. **Unpause narrowly.** Enable creation, joining and check-ins only after all checks match. Keep the 1 USDC cap. Test refund/settlement/claim exits.
7. **End-to-end tester run.** Use two wallets and the smallest stake. Create and join one Strava Lock and one Duolingo Lock; verify a day; attempt replay/wrong-wallet/wrong-day/manual activity; settle and claim/refund.
8. **Only then promote production** and re-run smoke checks against the public alias.

## 9. Validation commands

From the chosen integration branch:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm exec tsc --noEmit
pnpm check:contract-sizes
git diff --check
```

Advanced branch also has provider/production scripts in `package.json`; inspect names before running. Never infer that a green frontend build means contracts/providers are production-ready.

For Vercel:

```bash
vercel inspect https://lock-in-liart-theta.vercel.app
vercel deploy --yes          # preview first
vercel deploy --prod --yes   # only after preview + health + onchain checks
```

## 10. Current handoff acceptance criteria

The project is not “done” merely because the landing is polished. Final acceptance requires:

- public UI remains visually intact and uses LOCK everywhere;
- Strava and Duolingo both complete real Reclaim proofs from the app;
- exact proof schemas verify onchain and replay/wrong identity/wrong day fail;
- two real wallets can create/join/check in/settle/claim or refund with at most 1 USDC;
- no funded private key is hosted or committed;
- privacy/rules accurately match emitted public data;
- social features render real onchain-derived state;
- production health is green without bypasses;
- legacy links redirect and all new links use `/lock`.

When reporting progress, distinguish clearly between: source pushed, provider published, contract deployed, Vercel preview deployed, production promoted and real end-to-end test passed. They are not interchangeable.
