# Lock In

**Your word. Locked in.** Challenge your friends to run, stake up to 1 USDC each, and let the finishers split the pool funded by whoever quit.

Lock In is a small-cohort, adult-only accountability product on Monad mainnet. It is **not open to participants**: the deployed escrow is paused and must not be presented as accepting funds from anyone.

## How it works

1. **Connect Strava once.** You authorise Lock In through Strava's own consent screen.
2. **Create or join a Lock.** Pick the distance and the days, bring your crew, everyone stakes the same amount.
3. **Run, then check in.** One tap. Lock In reads the run from Strava and publishes the day on Monad.

There is nothing to rename, nothing to install, and no second login per check-in.

## Verification, and what you are trusting

A day counts when the run is a GPS **Run**, started inside that day of the Lock, reaching the distance target, not manual, not on a treadmill, not flagged by Strava, and with plausible motion. One run can only ever count once, in this Lock or any other, and one Strava account can only back one participant per Lock.

**Read this part.** Lock In's server reads your activity through Strava's official API over your OAuth grant, applies the policy above, and signs the result with an EIP-712 attestation. The escrow accepts that signature as sufficient. The verification scheme is named on chain as `STRAVA_OAUTH_V1`.

That means **the Lock In evidence signer is a trusted party**: a stolen signing key could create completions that never happened. Verification also does not prove physical movement, or the absence of GPS spoofing, account sharing, bots, modified devices, or errors by Strava. It reduces obvious and replayable fraud. No consumer data source makes cheating impossible.

The escrow used to require a zkTLS witness proof **and** this attestation, so neither alone was enough. That property is gone, deliberately: see [the pivot](#why-not-zktls). `test/LockInEscrowRelease.t.sol:testCompletionRestsOnTheBackendSignatureAlone` asserts the current model rather than leaving it to be inferred, and `/api/health` names the scheme and its trusted party.

## Settlement

Locks run 3, 7, 14 or 30 days with a fixed target and a fixed crew size. Registration closes at the published start. Everyone stakes the same amount, 0.1 to 1 USDC per participant per Lock. Monad gas is separate.

- if some finish, finishers recover their stakes and split the stakes of those who did not;
- if everyone or nobody finishes, each participant recovers their own stake;
- underfilled and cancelled Locks refund everyone;
- settlement and claims stay permissionless even while admission or check-ins are paused;
- there is no protocol fee and no operator withdrawal path.

[`contracts/LockInEscrow.sol`](contracts/LockInEscrow.sol) binds one Strava identity per wallet inside each Lock, enforces capacity, and holds a global nullifier per activity so a run cannot settle twice.

## Deployment

Read back from chain, in full, in [`deployments/monad-mainnet-oauth.json`](deployments/monad-mainnet-oauth.json).

| | |
|---|---|
| Escrow | `0xD37121112F240fE03a18D754B2fdB9dC750034d4` |
| Runtime code hash | `0x50c65525ac451c96b0dd9128e105d9e55080f1fbc8b73d9601dfc07100b8adf8` |
| Deployment tx | `0xa3e978e1456a8fe15e06249d4f689b38a5afc454681628feb759ee05900a0a31` (block 88203155) |
| Ownership transfer tx | `0xd15d376cf818fd93a7661fe8e1792593e05ba013eb731b8abb2aba2bd67cd8eb` (block 88203160) |
| Owner | `0xf1be884698B9Ba4438f529699eC92320427b4dA1` (Safe 2/2) |
| Evidence signer | `0x4a06010d269b335c3471dA9AABfc41a56b4ea1f6` |
| Access signer | `0x8a63E4828F3B35C12FC23d644C80DA67aF1EA304` |
| Stake token | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` (USDC, Monad) |
| App shell | https://lock-in-liart-theta.vercel.app |

Creation, joining and check-ins are **all paused**. Ownership sits with the Safe, so opening them takes a multisig signature over calldata that `pnpm exec tsx scripts/set-pauses.ts` prints and that a release gate refuses to produce unless the escrow, chain, token, cap, scheme, owner and both signers all verify on chain first.

`0xA75375E11A8564b9DFe5fe2084Ff277Bb41c6a6a` is a historical paused test escrow from the zkTLS era. It is not this release.

## Privacy

A check-in publishes, permanently and publicly, in Monad calldata: distance, moving and elapsed time, elevation gain, the activity start time, your wallet, the Lock and the day, plus three values derived from your Strava data by HMAC under a server-held key: one standing for your athlete account, one for that single activity, one summarising the activity. Raw Strava identifiers are not published. **A hash is not anonymity**: anyone who already knows an identifier and the key could confirm a match.

Your Strava tokens are held server-side only, encrypted with AES-256-GCM under a dedicated key, tied to your wallet. They are never exposed to your browser, to other users, or to the blockchain; they are decrypted in server memory only to talk to Strava. Your route, your other activities and your Strava password never reach Lock In. Disconnecting revokes the grant at Strava and deletes the stored connection outright.

Full notice: [`app/privacy/page.tsx`](app/privacy/page.tsx).

## Why not zkTLS

Lock In was built on Reclaim zkTLS first. Two findings ended that, both measured rather than assumed:

- **The hosted flow re-authenticates on every check-in.** Verification runs in a remote browser that never holds the athlete's Strava or Google session, so a 30-day Lock means 30 logins. That is a channel problem, not something a provider version can fix.
- **When the TEE proof fails, the portal silently substitutes an AI-witnessed proof** and still reports `PROOF_SUBMITTED`, despite `acceptAiProviders: false`. The fail-closed gate caught it, which is the part that worked as designed.

The zkTLS work is not deleted. [`contracts/verifiers/`](contracts/verifiers/) still holds the Strava and Duolingo witness verifiers and their 35 passing tests. The verification layer is modular: the escrow binds a Lock to a **named scheme**, so a future scheme can serve platforms with no official API, which is where zkTLS earns its cost. Duolingo has no public API, so it is out of scope for now rather than impossible forever.

## Status and what it would take to open

Unaudited. No participant has been invited. Before any public opening:

- an independent security review of the escrow, the attestation signer and the OAuth token boundary;
- the evidence and access keys in a managed KMS rather than environment variables, with rotation and monitoring, since the evidence key alone can now mint completions;
- Strava's developer terms clarified in writing: Strava reserves the right to revoke applications enabling **virtual races or competitions**, and Lock In is a competition with real stakes. That question is open, and this README does not claim otherwise;
- a two-wallet canary at the minimum stake, then create, join, check-in, settle and claim rehearsed end to end;
- production health, source verification, monitoring and support coverage all green.

Until then admission and check-ins stay paused.

## Local development

Node.js 22+, pnpm 10+, Foundry, a Monad RPC, a Strava API application and a Postgres database.

```bash
cp .env.example .env
pnpm install
pnpm db:migrate          # creates the Strava connection tables
pnpm exec tsc --noEmit
pnpm test                # TypeScript policy + Solidity
pnpm build
```

Server-only configuration: `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_TOKEN_ENCRYPTION_KEY` (32 bytes, base64), `DATABASE_URL`, `SESSION_SIGNING_SECRET`, and separate `EVIDENCE_SIGNER_PRIVATE_KEY` and `ACCESS_SIGNER_PRIVATE_KEY`. Strava allows one callback domain per application, so local and deployed need two applications.

Every deployment starts closed:

```dotenv
NEW_PACTS_ENABLED=false
JOIN_ENABLED=false
CHECK_INS_ENABLED=false
```

`pnpm deploy:escrow` is a read-only dry run until `--execute` plus an exact confirmation string. It deploys paused, transfers ownership to `LOCK_IN_OWNER_ADDRESS` and verifies both on chain before reporting success. Owner actions afterwards are multisig operations: `pnpm pauses` and `pnpm incident:cancel-pact` read the chain and print ordered calldata to review and sign. `pnpm production:check` matches the deployed escrow against configuration.

## Repository map

- `contracts/LockInEscrow.sol` — the escrow: stakes, settlement, claims, nullifiers, pauses.
- `contracts/verifiers/*` — the zkTLS witness verifiers, kept as a prototype, not wired to the escrow.
- `src/strava-oauth.ts` — authorize URL, signed single-use state, token exchange, refresh, revoke.
- `src/strava-token-store.ts` — encrypted token storage, atomic refresh rotation, state consumption.
- `src/strava-activities.ts` — the run policy and the pseudonymised evidence it produces.
- `src/completion-attestation.ts` — the EIP-712 attestation the escrow accepts.
- `app/api/strava/*` — authorize, callback, connection, check-in.
- `app/api/access/*` — authenticated, capacity-aware admission attestations.
- `docs/product-model.md` — product and settlement decisions.
- `docs/tester-runbook.md` — controlled-testing operations.

Privacy, incident and security contact: **mookipstore@hotmail.com**.
