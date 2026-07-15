# Lock In controlled-testing runbook

This runbook governs controlled testing on Monad mainnet before Lock In is released. Lock In is not open to participants. Every stake and gas fee is real, and the public app remains closed outside the short, monitored transaction windows below.

## Required people, accounts and funds

- Two controlled wallets, called wallet A and wallet B. Never place their private keys in this repository or in Vercel.
- Each wallet needs MON for gas and at least `0.2 USDC` of official Monad USDC to run the Strava and Duolingo pacts in parallel.
- Two distinct Strava accounts with real GPS runs. One Strava identity cannot represent both wallets in one pact. Use dedicated canary accounts whose athlete marker, activity ID/title, and signed activity fields may safely become permanent transaction calldata.
- Two distinct Duolingo profiles with working sign-in sessions. Use dedicated canary profiles whose username, stable profile ID, cumulative XP, and disclosed non-sensitive marker name `disable_social` may safely become permanent transaction calldata. No username or display-Name change is required.
- Two disposable Lock In handles. Their complete wallet-linked history, changes, moderation events, scores, and reactions will remain public even after the active handle is cleared.
- One operator watching contract events, production health and the transaction ledger throughout every open window.

The stake is exactly `0.1 USDC` per wallet per pact. Run the underfilled and emergency-refund rehearsals after the two main pacts claim if the same USDC must be recycled.

Configure only public wallet addresses for the observer:

```bash
export CANARY_WALLET_A=0x...
export CANARY_WALLET_B=0x...
pnpm canary:preflight
```

`canary:preflight` exits nonzero when an input, balance, deployment invariant or paused production control is missing. It never reads a participant private key and never sends a transaction.

## Release checks

Before touching a pause control:

1. `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm build`, `forge build`, and `git diff --check` pass.
2. `pnpm provider:check` confirms the pinned Strava provider plus Duolingo `cdf8cb3b-2976-4413-ab2d-693ae5028380@1.0.8`, its ownership request hash `0xea3ca9aeaa60e89d8f4a9134f5b314a78295e7e164f75eddb6d89f911a83766e`, and its XP request hash `0x92d80894f1f9e2f3574b840e846e41a49ae7491b587da9bd96cbcccbe001c8ed`. Reviewed live proofs must match the direct-verifier schemas, TEE binding, witness configuration, order, and expected proof counts.
3. `pnpm production:check` and the production `/api/health` endpoint are green with creation, joining and check-ins disabled.
4. `pnpm canary:preflight` is green for both wallets.
5. The final paused escrow and both direct verifiers have verified source and constructor data; contract schema ID, verifier addresses and runtime code hashes, mission policies, USDC, cap, evidence signer, admission signer, multisig owner and all four pauses match the release manifest.
6. Evidence and admission signing use the reviewed KMS-backed production path; no funded key is present in Vercel.
7. A real-proof inspection confirms that signed parameters and context contain no cookie, Authorization header, access token, API key, secret, or similar sensitive header, and that the top-level TEE JWT is absent from `transformForOnchain` output.
8. Handle, invite, score, high-five, and moderation tests pass, including one scoring wallet per mission identity without changing another wallet's valid payout.
9. Record the current `nextPactId`, escrow USDC balance, UTC time and operator.

## Paused deployment and ownership handoff

Configure `LOCK_IN_DEPLOYER_ADDRESS` with the public address of the one-time funded deployer and `LOCK_IN_OWNER_ADDRESS` with the already-deployed, tested multisig contract. The multisig must be distinct from the deployer, evidence signer and admission signer.

Run `pnpm deploy:verifiers` without arguments first. It cannot execute until all three audited live-schema gates are enabled. After reviewing the live fixtures, source, bytecode hashes and exact confirmation, deploy the parser and both verifiers with `--execute`, then copy the printed addresses and runtime code hashes into the server-only release environment.

Next run `pnpm deploy:escrow` without arguments. This dry-run refuses any direct-proof address or runtime bytecode hash that differs from that environment, then prints the paused deployment estimate, ownership-transfer gas reserve, final owner and exact execution confirmation. After independent review, set only the printed `CONFIRM_DEPLOY_ESCROW` value and rerun with `--execute`.

The execute flow is complete only when both transaction receipts succeed and the final read confirms the configured multisig plus all four pauses. Record both transaction hashes, then copy the printed `NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS` and `LOCK_IN_ESCROW_CODE_HASH` into the release environment. Every health, signing, pause-opening, production-check and canary path must match that runtime hash. If the flow stops after deployment, keep the address closed, do not publish or configure it as the release escrow, and complete an incident review before any further action.

## Pause-control safety

`pauses` is read-only by default and never requires an owner key. Arguments are, in order, creation, joining, baseline evidence, and completion evidence.

```bash
pnpm pauses -- true true true true
```

The output lists each zero-value call's exact destination, calldata and hash. Review those fields independently, submit the ordered bundle through `LOCK_IN_OWNER_ADDRESS`, collect the configured multisig threshold, and wait for every receipt. Then verify the external execution without an owner key:

```bash
pnpm pauses:verify -- true true true true
```

Replace the booleans with the intended state. The script skips unchanged controls and places every requested closure before any opening. Local `--execute` is development compatibility only: it refuses a contract/multisig owner and must not be used for the release contract.

Pause setters are separate transactions. Watch every receipt; never assume the four changes are atomic.

Use this ordering across systems:

- **Opening:** change the Vercel production flags, deploy that configuration, confirm the requested actions, then unpause only the necessary contract controls.
- **Closing:** pause the necessary contract controls first, confirm receipts, then disable the Vercel flags and deploy the closed configuration.

Changing a Vercel environment variable does not change the running deployment. A production redeployment and a fresh `/api/health` read are required.

## Create window

Start with contract pauses `true / true / true / true` and Vercel flags all `false`.

1. Set Vercel production to `NEW_PACTS_ENABLED=true`, `JOIN_ENABLED=false`, `CHECK_INS_ENABLED=false`; deploy production.
2. Generate contract pauses `false / true / false / true`, inspect and execute the ordered calls through the multisig, then run `pnpm pauses:verify -- false true false true`.
3. Wallet A creates one Strava pact and one Duolingo pact through the production UI, each at exactly `0.1 USDC` and the three-day template. For Duolingo, enter the existing username, sign in inside Reclaim, and complete both the self-only ownership claim and the matching ID/XP claim before the short-lived attestation expires. Review the wallet calldata warning and confirm that the transaction carries both transformed Reclaim claims plus the matching backend attestation, without a username, cookie, credential, privacy-setting value, or profile rename. Record each displayed `LOCK-…` invite code and confirm it deterministically resolves to the created onchain Lock ID.
4. Record both pact IDs and every approval/create transaction hash.
5. Immediately close the contract to `true / true / true / true`.
6. Set all three Vercel flags back to `false`, redeploy, then run a snapshot for each pact and reconcile the escrow.

Only creation and baseline evidence are open during this window. Daily completion evidence remains paused. No unrelated or already-active pact may exist during this exception. If `nextPactId` advances unexpectedly, close first and investigate every new pact.

```bash
pnpm canary:status -- --pact 1
pnpm canary:status -- --pact 2
CANARY_EXPECTED_PACT_IDS=1,2 pnpm canary:reconcile
```

Replace the example IDs with the recorded IDs.

## Join window

Complete this before the published start time.

1. Set Vercel production to `NEW_PACTS_ENABLED=false`, `JOIN_ENABLED=true`, `CHECK_INS_ENABLED=false`; deploy production.
2. Generate contract pauses `true / false / false / true`, execute the ordered calls through the multisig, then run `pnpm pauses:verify -- true false false true`.
3. Wallet B opens both Locks from wallet A's shared `LOCK-…` invite links, then joins through the production UI at exactly `0.1 USDC`. Confirm an altered checksum is rejected and that the valid code does not bypass admission, capacity, timing, stake, or baseline requirements. Its Duolingo proof pair must resolve to a stable profile ID different from wallet A's, and the authenticated self-only claim must be authorized for that exact ID. Confirm the same two-claim ordering, direct-proof, attestation, no-secret, no-settings-value, and transaction-time privacy checks used for wallet A.
4. Record approval, baseline and join transaction hashes.
5. Close the contract to `true / true / true / true` first.
6. Disable all Vercel flags, redeploy, snapshot both pacts and reconcile.

The two-wallet participant counts, event counts, identities and escrow liability must agree before either pact starts.

## Daily proof windows

Run the Strava and Duolingo pacts in parallel. The three-day template cannot finalize early; settlement becomes available only after the full third day and the 24-hour proof-submission grace period both end.

For each open pact day:

1. Set Vercel production to `NEW_PACTS_ENABLED=false`, `JOIN_ENABLED=false`, `CHECK_INS_ENABLED=true`; deploy production.
2. Generate contract pauses `true / true / true / false`, execute the ordered calls through the multisig, then run `pnpm pauses:verify -- true true true false`.
3. Complete the planned Reclaim proofs and wait for every `submitCompletion` receipt. Each transaction must carry the SDK-transformed witness proof and matching backend attestation. A returned attestation expires after five minutes, so do not close the window while a valid participant transaction is pending. Record calldata bytes, gas estimate, receipt gas, wallet type, device, and any handoff failure.
4. Close the contract to `true / true / true / true` first.
5. Set `CHECK_INS_ENABLED=false`, redeploy, snapshot both pacts and reconcile.

Never leave evidence open overnight. The transformed proof necessarily becomes public transaction calldata, including the signed parameters, context, claim metadata, and witness signatures; do not separately publish or archive the complete SDK proof object. Abort before the wallet transaction if a proof contains a cookie, Authorization header, access token, API key, secret, or unexpected personal field. Never request or publish a GPS route.

## Social-layer rehearsal

Social profile functions are public onchain actions and are not protected by the admission or evidence pause flags. Use only disposable handles whose permanent wallet link is acceptable, and record every transaction hash and gas cost.

1. Wallet A claims a valid lowercase handle. Wallet B attempts that same active handle and must be rejected, then claims a different handle. Confirm neither operation changes the wallets' Strava or Duolingo names.
2. Complete both a Strava and Duolingo day for wallet A inside the same UTC day. Overall Lock Score must increase by exactly 10, not 20. In a separate eligible Strava Lock, submit that same Strava identity from wallet B: completion and payout state remain valid, but score must not increase and `missionIdentityOwner` must not change. This is service-account deduplication, not proof that wallet A is one human across both services.
3. After wallet B has an accepted day, wallet A sends one high-five for that exact Lock and day. The public event must identify sender, recipient, Lock, and day. A duplicate must be rejected, and the reaction must not change either score, completion bitmap, finisher status, escrow liability, or expected payout.
4. Wallet A changes, then clears, its handle. Confirm the active mapping becomes empty, the previous string becomes available for reuse, normal Lock In surfaces fall back to the wallet address, and all earlier `PlayerHandleSet` events remain visible.
5. Through the configured multisig, hide wallet B's profile and confirm normal Lock In surfaces suppress its handle while retaining its wallet, verified days, rank, score, completion state, and claim rights. Restore visibility and confirm the current handle returns. Record both `PlayerProfileVisibilityUpdated` events.
6. Check Overall, Running, and Learning weekly boards against the raw events. The displayed week must be Monday 00:00 UTC through the next Monday, while all-time Lock Score remains cumulative.

Before and after every social write, snapshot both main Locks and reconcile the escrow. The balance, remaining liability, finishers, and claim amounts must be identical except for mission completion changes already expected by the test plan.

## Two-wallet outcome matrix

Use the two main pacts to exercise different settlement branches:

| Pact | Wallet A | Wallet B | Expected settlement |
| --- | --- | --- | --- |
| Strava | Three valid challenge-titled GPS runs | At least one valid run, then deliberately misses the target | A is the only finisher and receives `0.2 USDC`; B is ineligible |
| Duolingo | Three valid post-baseline XP gains | Three valid post-baseline XP gains from a different profile | Both finish and each receives `0.1 USDC` |

The partial Strava participation by wallet B proves its separate identity and submission path without making it a finisher. Do not spend gas on an intentionally reverting claim; the ineligible-claim branch remains covered by the contract tests.

Safe live negative checks include wrong Strava title; a Duolingo session targeting another username/profile ID (the self-only request must fail with `403`); an anonymous Duolingo replay (it must fail with `401`); mismatched IDs across the two claims; unchanged XP; and another wallet/profile binding. Manual/no-GPS, trainer, flagged, stale and replay cases remain deterministic automated policy/contract tests; do not manufacture unsafe external account states solely for a canary and do not submit expected failures onchain.

## Settlement and claims

After each main pact's exact `submissionDeadline` (`endsAt + 24 hours`):

1. Anyone calls `finalizePact`; creation, joining and evidence remain paused.
2. Eligible wallets claim through the production UI.
3. Snapshot each pact after finalization and after every claim.
4. Run `CANARY_EXPECTED_PACT_IDS=<comma-separated IDs> pnpm canary:reconcile`.
5. Confirm the escrow USDC balance equals the sum of every pact's remaining liability.

The observer snapshots contain public contract state only. Maintain the transaction-hash and gas ledger alongside them and store both outside Git, for example under the ignored `proofs/` directory. Do not copy the full SDK proof into that ledger; the required transformed subset is already public by transaction hash.

## Refund rehearsals

### Underfilled pact

Create a separate `0.1 USDC` pact with wallet A, close creation immediately, and do not join wallet B. At its start, call `finalizePact`; it must enter the cancelled refund path. Wallet A then claims exactly `0.1 USDC`.

### Owner emergency cancellation

Create a separate pact, close all four risk paths, set `PACT_ID`, and run `pnpm incident:cancel-pact`. Inspect the snapshot and ordered zero-value calls, then submit the bundle through the multisig. After every receipt, run `pnpm incident:cancel-pact:verify`; it must confirm both cancellation and finalization before any refund claim. Every joined wallet claims only its original stake. Local `--execute` is EOA-development compatibility only and refuses the release multisig.

After each rehearsal, snapshot the pact and reconcile the whole escrow.

## Incident response

- **Unexpected pact or participant:** close all contract controls immediately, then close Vercel, reconcile and inspect every new event.
- **Creation defect:** pause creation onchain before disabling `NEW_PACTS_ENABLED` in Vercel.
- **Join/funding defect:** pause joining onchain before disabling `JOIN_ENABLED`; identify every forming pact.
- **Baseline/provider/signer defect:** pause baseline evidence before disabling create and join paths; identify every forming Duolingo pact.
- **Completion/provider/signer defect:** pause completion evidence before disabling `CHECK_INS_ENABLED`; move affected unsettled pacts into refunds if continuing would be unfair.
- **Abusive or impersonating Lock In handle:** hide the profile from normal product surfaces through the multisig, preserve the moderation transaction and reason, and notify the wallet if a contact channel exists. Do not alter score, mission state, settlement, or claims; onchain history cannot be erased.
- **RPC/UI defect only:** keep permissionless settlement and claims available and publish direct contract/explorer instructions.
- **Suspected key compromise:** close risky actions, rotate the affected authority, inventory every pact and publish a UTC incident notice.

Record decisions, addresses, pact IDs, transaction hashes, UTC times and the operator for every step. Never promise reimbursement before chain state and responsibility are known.
