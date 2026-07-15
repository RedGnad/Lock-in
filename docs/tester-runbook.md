# Lock In V4 private tester runbook

This runbook covers a small, invited cohort using real USDC on Monad mainnet. V4 check-ins are native Monad transactions and do not depend on Strava or Reclaim. Every stake and every network fee is real.

## Safety invariants

- A participation is capped by the contract at 1 USDC. This is a per-pact cap, not a cumulative wallet cap.
- `NEW_PACTS_ENABLED`, `JOIN_ENABLED`, and `CHECK_INS_ENABLED` are web-product circuit breakers. Missing or invalid values disable the corresponding action.
- The V4 owner pause switches are the onchain enforcement layer. Effective UI actions require both an enabled environment flag and an unpaused contract action.
- Settlement and claim are always enabled and have no environment switch.
- Environment flags do not pause the public contract. A user can still call it directly until the owner applies the corresponding V4 onchain pause.
- Never ask for a seed phrase, private key, wallet export, or signed arbitrary transaction during support.

## Roles and evidence

Before opening, name one incident lead and one backup. Both need access to Vercel logs, the deployment dashboard, Monadscan, the public contract state, and the support inbox. Only the designated contract owner may perform an incident cancellation.

For every operational change, record:

- UTC time and operator;
- release/commit and contract address;
- previous and new flag values;
- reason and affected pact IDs;
- resulting deployment and transaction hashes.

Do not record wallet secrets, full RPC credentials, or sensitive user data.

## Gate 0 — before accepting a tester

Keep all three product flags explicitly set to `false` and confirm `/api/health` returns:

- `configuration.productFlags` all `true` (each variable is explicitly configured);
- `actions.newPacts`, `actions.join`, and `actions.checkIns` all `false`;
- `actions.settlement` and `actions.claim` both `true`;
- chain ID 143, V4 contract code, native Monad USDC, six decimals, symbol `USDC`, and the 1 USDC cap;
- readable V4 creation, joining, and check-in pause controls;
- no failed infrastructure check.

Then complete all of the following:

1. Typecheck, policy tests, Solidity tests, and production build pass from the release commit.
2. V4 source and constructor arguments are verified on a public explorer.
3. The owner wallet has enough MON for at least two emergency cancellations.
4. Every tester has the correct Monad mainnet network, native USDC, and enough MON for create/join/check-in/settle/claim transactions.
5. Rules, privacy notice, real-funds warning, support email, contract address, token address, and explorer links match the deployed release.
6. External uptime monitoring alerts on a non-200 `/api/health` response.
7. Two internal wallets complete a 0.1 USDC rehearsal through create, join, every required native check-in, settlement, and claim.
8. A separate 0.1 USDC rehearsal covers underfilled cancellation and refunds.

Do not open the cohort if any item is incomplete.

## Controlled opening

Use a fresh Vercel deployment for every flag change; environment changes do not alter an already running deployment. Verify the resulting `/api/health` payload before sharing a link.

1. Confirm the V4 creation pause is off, then enable `NEW_PACTS_ENABLED=true` only for the operator's planned pact creation window.
2. Inspect the created pact on Monadscan, then set `NEW_PACTS_ENABLED=false` unless more creation is intentional.
3. Confirm the V4 joining pause is off, then enable `JOIN_ENABLED=true` for the invited wallets. Track expected versus actual participants, then close joining when the cohort is full.
4. Confirm the V4 check-in pause is off, then enable `CHECK_INS_ENABLED=true` before the first check-in window. Keep it enabled throughout every unaffected active pact.

Use 0.1 USDC for the first external cohort. Raise a later cohort only after all funds from the first one are accounted for.

## Monitoring active funds

Maintain an at-risk ledger from public contract state and events. For every funded pact record:

- pact ID and transaction hash;
- starts, ends, and settlement eligibility time in UTC;
- participant count and total pool;
- check-in progress by wallet;
- current expected path: normal settlement, underfilled refund, or incident cancellation;
- last operator review and next required action.

Review the ledger before every check-in boundary and at least hourly during an incident. Alert immediately when a contract transaction reverts repeatedly, RPC state becomes stale, the UI and chain disagree, or a pact approaches settlement without a known operator.

## Pause matrix

### UI or creation defect

Set `NEW_PACTS_ENABLED=false`. If direct contract calls are unsafe, the owner also enables the V4 creation pause. Disable joining too if the defect changes stake, schedule, eligibility, or participant display. Leave check-ins, settlement, and claims available for unaffected existing pacts.

### Join defect or cohort full

Set `JOIN_ENABLED=false`. If joining must be enforced onchain, the owner also enables the V4 joining pause. Existing participants retain check-ins, settlement, and claim.

### Check-in or chain-state defect

Set `NEW_PACTS_ENABLED=false` and `JOIN_ENABLED=false` first, then apply the matching onchain pauses when direct calls are unsafe. Set `CHECK_INS_ENABLED=false` and enable the V4 check-in pause only when allowing another check-in would make settlement less fair or less safe. Immediately identify every active pact whose deadline can be affected and publish a support notice.

If valid check-ins cannot be restored inside the affected window, the owner must use the documented incident-cancellation path so participants can recover their stakes. A UI flag alone does not refund anyone.

Preview the exact pact and refund action without sending a transaction:

```bash
PACT_ID=123 pnpm incident:cancel-pact
```

The command checks Monad chain 143, V4, the owner key, pact state, pause state, gas, and contract simulation. After the incident lead verifies the printed snapshot and records the approval, repeat with the one-time confirmation shown by the preview:

```bash
PACT_ID=123 CONFIRM_CANCEL_PACT=CANCEL_PACT_123 pnpm incident:cancel-pact
```

This sends the owner cancellation into the refund-only path and then permissionlessly finalizes the pact so participant claims are enabled. Never run it for a normal losing pact or as a substitute for restoring a harmless UI outage.

### RPC or website outage

The contract remains live. Publish the verified contract and explorer links through the support channel. Do not direct inexperienced testers to arbitrary calldata. Restore the read path or provide one reviewed transaction procedure for settlement/claim.

## Settlement and refunds

- Normal pact: after the contract deadline, call the permissionless settlement function, confirm finalization onchain, then notify every eligible wallet to claim.
- Underfilled pact: finalize it as cancelled as soon as the contract permits, confirm the refundable pool, then notify every participant.
- Product incident: the owner cancels only the documented affected pact, records the cancellation hash, finalizes if required, and tells participants exactly how to claim.
- Nobody, including the operator, can claim on behalf of another wallet. Keep the support case open until every participant has claimed or explicitly acknowledged the outstanding amount.

Before marking a pact resolved, reconcile deposits, payouts, remaining pool, participant count, claimed count, and the escrow's USDC balance from chain state. Never promise reimbursement of network gas unless a separately funded policy explicitly authorizes it.

## Incident response

1. Acknowledge the incident in the support channel with UTC time and affected actions.
2. Apply the narrowest safe environment flags and onchain pause controls, then verify the effective actions in the new health response.
3. Snapshot affected pact state and transaction hashes before taking an admin action.
4. Classify each pact as unaffected, recoverable before deadline, or cancellation/refund required.
5. Communicate the next update time even when the diagnosis is incomplete.
6. Restore an action only after the root cause is understood and two internal wallets reproduce the repaired path.
7. Publish a short post-incident note covering impact, funds accounting, resolution, and prevention.

Server logs must use request IDs and coarse error codes. Do not log calldata, wallet signatures, private RPC URLs, or more wallet data than is necessary to locate an onchain transaction.

## Support intake

Ask only for:

- wallet public address;
- pact ID;
- transaction hash, if one exists;
- UTC time;
- action attempted and the exact visible error;
- browser/wallet name and network shown.

First verify the transaction and pact directly on Monad. Distinguish wallet rejection, insufficient MON, insufficient USDC, pending/replaced transaction, closed action flag, contract revert, and stale UI state. Never ask the tester to retry a value-moving action until the previous transaction status is known.

During an active cohort, acknowledge fund-affecting reports within two hours. Use the public privacy contact for support until a separate support address is published.

## Closing the cohort

1. Stop new pacts and joins.
2. Keep check-ins enabled until every unaffected pact has passed its final required window.
3. Set check-ins to false only after all active obligations are complete or cancelled.
4. Finalize every eligible pact and send claim reminders.
5. Reconcile the escrow balance against all unclaimed pools.
6. Confirm `/api/health` is healthy in `paused` mode with settlement and claim still true.
7. Archive the at-risk ledger and incident notes without secrets.
