# Lock In

**Your word. Locked in.** Challenge friends to run or learn, stake up to 1 USDC each, and let finishers split the pool funded by those who quit.

Lock In is being built as a small-cohort, adult-only accountability product on Monad. It has not opened to participants: the public test deployment is paused and must not be presented as accepting real funds.

No public product version has shipped. Internal prototype labels belong only in the historical archive; the first build that clears the complete release gate is the first real release.

The unreleased build supports two independent mission policies:

- **Strava run:** a challenge-named GPS Run must reach the distance target. Manual, trainer, Strava-flagged, missing-GPS, and implausible-motion records are rejected.
- **Duolingo XP:** the participant must prove control of the named profile by temporarily setting its public Name to a wallet-specific code. A fresh cumulative-XP baseline is accepted with the stake; only later XP above both the Lock baseline and previously consumed XP can count.

Reclaim zkTLS proves what each service returned over HTTPS. It does not prove physical movement, human learning, exclusive account use, or the absence of GPS spoofing, bots, modified devices, outside help, or upstream errors. The mission policies reduce impersonation, replay, identity switching, old-progress reuse, obvious manual Strava entries, and several implausible-motion cases; they cannot make offchain activity fraud impossible.

## Product and settlement

The app offers 3, 7, 14, and 30-day Locks with fixed completion targets and a fixed crew capacity. Registration closes at the published start. Every participant stakes the same amount, from 0.1 to 1 USDC. The 1 USDC cap applies per participant, per Lock; Monad gas is separate.

- if some participants finish, finishers recover their stakes and split non-finishers' stakes;
- if everyone or nobody finishes, each participant recovers their own stake;
- underfilled and cancelled Locks refund every participant;
- settlement and claims remain permissionless even while admission or evidence is paused;
- there is no protocol fee or operator withdrawal path.

[`contracts/LockInEscrow.sol`](contracts/LockInEscrow.sol) is the current escrow candidate. A mission completion succeeds only when a direct Reclaim witness proof and a short-lived backend EIP-712 attestation derived from the same canonical proof set agree on the settlement fields. The contract also binds one external identity per wallet inside each Lock, enforces fixed capacity and global event nullifiers, and prevents a consumed Duolingo XP range from settling another completion.

The direct proof is not private. The Reclaim SDK's `transformForOnchain` output places signed `claimInfo.parameters`, signed `claimInfo.context`, claim metadata, and witness signatures in transaction calldata. Those bytes are public and permanent even though detailed provider fields are not copied into contract storage or events. The top-level TEE attestation JWT is excluded from this transform, and Lock In never requests a Strava GPS route.

## Release status — closed

- App shell: https://lock-in-liart-theta.vercel.app
- Historical paused canary escrow: `0xA75375E11A8564b9DFe5fe2084Ff277Bb41c6a6a`
- Historical canary transaction: `0x1d67657eedb350206e49a44256bdb8c42625b987ed83884713e463a392cec3ba`
- Strava proof provider: `f3ec8292-d8f3-487c-a79d-f53f482f88e2@1.0.3`
- Duolingo proof provider: `cdf8cb3b-2976-4413-ab2d-693ae5028380@1.0.3`
- Release owner Safe: `0xf1be884698B9Ba4438f529699eC92320427b4dA1` (2/2)

The listed escrow is historical test infrastructure, not the Lock In release contract and not an invitation to deposit funds. The release contract address will be published only after a fresh paused deployment, source and constructor verification, signer checks, independent review, and complete two-wallet rehearsals for every enabled mission.

## Duolingo account-control decision

The inspected public Reclaim provider `7c57a498-6b0e-4b3a-8235-de7ba938e823` is not used. It accepts a user-selected profile identifier and extracts only `totalXp`, so it can target somebody else's account.

The Lock In provider in [`providers/duolingo-owned-xp.json`](providers/duolingo-owned-xp.json) extracts stable profile ID, username, public Name, and `totalXp` from one response. The backend accepts it only when the public Name equals the exact code derived for the proof-bound wallet. Creation or joining and baseline acceptance are atomic: a failed account-control proof cannot leave the user's stake locked. This demonstrates control at proof time; it does not prove who earned the XP.

The proof reads Duolingo's public profile endpoint in an incognito Reclaim webview. Participants temporarily replace the editable Name in their normal Duolingo session; they never need to enter Duolingo credentials again inside Reclaim or Lock In.

## Privacy

The website currently has no product-account database. Before a proof or admission request, the wallet authenticates with a short-lived, origin-bound signed challenge. During verification, Reclaim and the server function process the provider fields needed by the selected policy and return a short-lived attestation. Lock In does not intentionally retain the full Reclaim SDK proof object in a product database after verification.

Monad permanently exposes wallet, Lock terms, stake, mission, day, completion metric, hashed identity, nullifier, timestamps, settlement, and claims. Proof transaction calldata can additionally expose the Duolingo username, stable profile ID, temporary public Name code, cumulative XP, Reclaim session, wallet, internal Lock identifier and phase, or the Strava athlete marker, activity ID and title, start time, distance, motion and elevation fields, GPS-presence status, trainer and flag status, Reclaim session, wallet, internal Lock identifier and day. The GPS route is not requested or published. See [`app/privacy/page.tsx`](app/privacy/page.tsx) and [`PRIVACY.md`](PRIVACY.md).

## Trust and launch requirements

The current unreleased build is unaudited and has no release deployment. The candidate escrow requires both direct witness verification and the matching backend attestation, so the evidence signing key alone cannot fabricate a completion. The signer still applies TEE and business-policy checks, and failures involving the signer, direct verifier, witness configuration, upstream service, or user device remain security risks. The owner can pause or rotate authorities.

The repository contains direct-verification contracts for Duolingo and Strava and the escrow candidate is wired to require them. While `LIVE_SCHEMA_CONFIRMED=false`, both verifier entry points fail closed with `LiveSchemaUnconfirmed`; only test harnesses can exercise the synthetic parsers. Modern TEE contexts remain rejected until current live proofs are captured and audited. The web proof path, deployed verifier bytecode, and real-proof gas flow are therefore not release-ready.

- evidence and admission signing must use isolated, least-privilege keys in a managed KMS or equivalent auditable signing service, with rotation and monitoring;
- contract ownership must move from a single deployer to a documented multisig with tested incident procedures;
- live Strava and Duolingo proofs must confirm the exact signed schemas, provider versions, TEE binding, witness configuration, direct-verifier outputs, and absence of credentials or secret headers;
- the direct verifier bytecode, oracle boundary, signer code, contract, and deployment configuration must receive an independent security review;
- direct-proof calldata size, gas cost, mobile-wallet handoff, rejection behavior, and transaction privacy notice must pass end-to-end testing;
- complete Strava and Duolingo success, failure, replay, capacity, settlement, claim, underfilled-refund, and emergency-refund rehearsals must pass with two controlled wallets at 0.1 USDC;
- production health, source verification, addresses, privacy, rules, monitoring, and support coverage must all be green.

Until those criteria pass, all admission and evidence controls remain paused and no tester should be invited to send real funds.

## Local development

Requirements: Node.js 22+, pnpm 10+, Foundry, and a Monad RPC.

```bash
cp .env.example .env
pnpm install
pnpm exec tsc --noEmit
pnpm test
pnpm build
forge test
```

Required server-only configuration includes Reclaim credentials, a wallet-session secret, and separate unfunded evidence and admission signing keys. `LOCK_IN_OWNER_ADDRESS` identifies the deployed, tested multisig; `LOCK_IN_DEPLOYER_ADDRESS` records the public address used for the one-time deployment. Never expose private values through `NEXT_PUBLIC_*`, and never upload the funded deployer key to Vercel.

Every deployment starts closed:

```dotenv
NEW_PACTS_ENABLED=false
JOIN_ENABLED=false
CHECK_INS_ENABLED=false
```

`pnpm deploy:verifiers` is the first read-only dry-run. Execution stays locked until the audited live Strava parser, Strava verifier and Duolingo verifier all compile with their live-schema gates enabled. A successful execution prints the three addresses and runtime code hashes that must be copied into the server-only release environment. `pnpm deploy:escrow` then refuses any address, witness, provider metadata, parser schema or bytecode hash that differs from that configuration. It validates that the owner is a deployed contract distinct from the deployer and application signers, estimates gas, and reserves ownership-transfer gas. The execute flow deploys with all four controls paused, verifies that state, transfers ownership to `LOCK_IN_OWNER_ADDRESS`, then verifies the final owner and pauses at the transfer block. Its final output includes `NEXT_PUBLIC_LOCK_IN_ESCROW_ADDRESS` and the exact `LOCK_IN_ESCROW_CODE_HASH`; copy both into the release environment before any production check or canary. A release address is not valid if that complete flow does not finish successfully.

After that handoff, owner actions are multisig operations. `pnpm pauses` and `pnpm incident:cancel-pact` read the chain and print ordered zero-value calls with exact destination and calldata without loading an owner key. Submit those calls through the configured multisig, then use `pauses:verify` or `incident:cancel-pact:verify` to confirm the external execution. The command names retain the contract's internal `pact` identifier; the consumer product term is **Lock**. Local `--execute` exists only for an EOA-owned development contract and refuses a contract/multisig owner.

`pnpm production:check` must additionally match the onchain owner to `LOCK_IN_OWNER_ADDRESS`, confirm that it has contract code, reject any owner reused as the deployer or an application signer, and match the escrow plus every direct-proof runtime code hash. `/api/health` verifies the same code and direct-proof bindings plus Monad chain 143, contract schema ID 1, native Monad USDC, the immutable 1 USDC cap, the configured multisig, both configured signer addresses, every onchain pause, explicit product flags, and the privacy contact. Website flags do not stop direct contract calls; the matching onchain controls are authoritative.

## Repository map

- `contracts/LockInEscrow.sol` — current unreleased multi-mission escrow candidate.
- `src/strava-proof-policy.ts` — Strava anti-cheat and challenge binding.
- `src/duolingo-proof-policy.ts` — Duolingo account-control code and XP snapshot policy.
- `src/reclaim-onchain.ts` — strict SDK-proof validation and canonical direct-proof transformation.
- `contracts/verifiers/*` — mission-specific direct Reclaim witness verifiers.
- `app/api/reclaim/*` — session, polling, zkTLS verification, and evidence attestation.
- `app/api/access/*` — authenticated, capacity-aware admission attestations.
- `providers/*` — pinned private Strava and Duolingo provider configurations.
- `docs/product-model.md` — product and settlement decisions.
- `docs/tester-runbook.md` — controlled-testing operations.

Privacy, incident, and security contact: **mookipstore@hotmail.com**.
