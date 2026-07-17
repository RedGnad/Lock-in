// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LockInEscrow} from "../contracts/LockInEscrow.sol";

interface VmForecast {
    function addr(uint256 privateKey) external returns (address);
    function createSelectFork(string calldata urlOrAlias) external returns (uint256);
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory);
    function envOr(string calldata name, uint256 defaultValue) external returns (uint256);
    function getBlockTimestamp() external view returns (uint256);
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function skip(bool skipTest) external;
    function warp(uint256 timestamp) external;
}

interface IERC20Forecast {
    function balanceOf(address account) external view returns (uint256);
}

/**
 * Runs the REAL canary forward, against the REAL escrow, on a fork of Monad mainnet.
 *
 * The Lock settles on 21 July, after the submission deadline. Waiting to find out what settlement does is
 * not an option, and reasoning about it is not evidence. This forks mainnet at the live state of Lock #1,
 * warps through its three days, submits the three completions with the real evidence signer, finalizes and
 * claims. Whatever this prints is what the chain will do, unless someone changes the pauses.
 *
 * Needs a fork URL and the evidence key, so it skips by default:
 *   MONAD_FORK_URL=<rpc> forge test --match-contract LockInCanaryForecast -vv
 */
contract LockInCanaryForecastTest {
    VmForecast private constant VM = VmForecast(address(uint160(uint256(keccak256("hevm cheat code")))));

    LockInEscrow private constant ESCROW = LockInEscrow(0xD37121112F240fE03a18D754B2fdB9dC750034d4);
    address private constant WALLET_A = 0x79C53151315FaD9163f75a65A8Bd4D04a10e1e45;
    address private constant WALLET_B = 0x344412229B3b581C19572f9BF1F5d08d4Ae897E6;
    uint256 private constant PACT_ID = 1;
    uint8 private constant STRAVA_RUN = 1;

    uint256 private evidenceKey;
    bool private ready;

    function setUp() public {
        string memory forkUrl = VM.envOr("MONAD_FORK_URL", string(""));
        evidenceKey = VM.envOr("EVIDENCE_SIGNER_PRIVATE_KEY", uint256(0));
        if (bytes(forkUrl).length == 0 || evidenceKey == 0) return;
        VM.createSelectFork(forkUrl);
        ready = true;
    }

    function testTheCanarySettlesWithAliceTakingBothStakes() public {
        if (!ready) {
            VM.skip(true);
            return;
        }

        // The signer this test uses must be the one the escrow trusts, or every completion below is
        // fiction rather than a forecast.
        require(ESCROW.evidenceSigner() == VM.addr(evidenceKey), "evidence signer is not the deployed one");

        (
            address creator,
            uint64 startsAt,
            uint96 stake,
            ,
            uint32 participantCount,
            ,
            ,
            uint8 durationDays,
            uint8 requiredCompletions,
            uint8 minParticipants,
            ,
            ,
            ,
            ,
            ,
            bool finalized,
            bool cancelled
        ) = ESCROW.pacts(PACT_ID);

        require(creator == WALLET_A, "Lock 1 was not created by wallet A");
        require(participantCount == 2 && participantCount >= minParticipants, "the crew is not two");
        require(!finalized && !cancelled, "the Lock is already settled");
        require(!ESCROW.completionPaused(), "completion is paused: settlement would refund everyone");

        IERC20Forecast usdc = IERC20Forecast(address(ESCROW.stakeToken()));
        uint256 aliceBefore = usdc.balanceOf(WALLET_A);
        uint256 escrowHolds = usdc.balanceOf(address(ESCROW));
        require(escrowHolds >= uint256(stake) * 2, "the escrow does not hold both stakes");

        // Wallet A runs every day and checks in. Wallet B never does. Days already checked in on the real
        // chain are skipped: after D1 the live bitmap already has day 0 set, and resubmitting it reverts
        // DayAlreadyCompleted. Skipping them makes this a forecast from wherever the canary actually is.
        uint256 liveBitmap = ESCROW.completionBitmap(PACT_ID, WALLET_A);
        // A's identity is bound to the Lock by D1 already; the escrow reverts IdentityMismatch if a later
        // day uses a different one. Reuse the real bound identity so the forecast is faithful.
        bytes32 identity = ESCROW.participantIdentity(PACT_ID, WALLET_A);
        require(identity != bytes32(0), "D1 has not bound an identity yet");
        for (uint8 day = 0; day < durationDays; ++day) {
            if (liveBitmap & (uint256(1) << day) != 0) continue;
            uint64 dayStart = startsAt + uint64(day) * 1 days;
            VM.warp(dayStart + 2 hours);
            _submit(day, dayStart + 1 hours, identity);
        }
        require(ESCROW.completionCount(PACT_ID, WALLET_A) == requiredCompletions, "A did not reach the target");

        require(ESCROW.isFinisher(PACT_ID, WALLET_A), "A ran every day and is not a finisher");
        require(!ESCROW.isFinisher(PACT_ID, WALLET_B), "B never ran and is a finisher");

        // Settlement opens at endsAt + the 24h grace period, and not one second earlier.
        VM.warp(uint256(startsAt) + uint256(durationDays) * 1 days + 1 days + 1);
        ESCROW.finalizePact(PACT_ID);

        (,,,,,,,,,,,,,,, bool nowFinalized, bool nowCancelled) = ESCROW.pacts(PACT_ID);
        require(nowFinalized, "finalize did not finalize");
        // The whole point of the forecast: cancelled means everyone is refunded and A wins nothing.
        require(!nowCancelled, "the Lock was cancelled at settlement");

        VM.prank(WALLET_A);
        uint256 payout = ESCROW.claim(PACT_ID);
        require(payout == uint256(stake) * 2, "the only finisher did not take both stakes");
        require(usdc.balanceOf(WALLET_A) == aliceBefore + uint256(stake) * 2, "A's balance did not move by the pot");

        // B is not eligible and must not be able to take anything.
        VM.prank(WALLET_B);
        (bool bobClaimed,) = address(ESCROW).call(abi.encodeCall(ESCROW.claim, (PACT_ID)));
        require(!bobClaimed, "the wallet that never ran claimed");
    }

    function _submit(uint8 dayIndex, uint64 occurredAt, bytes32 identity) private {
        uint64 issuedAt = uint64(VM.getBlockTimestamp());
        LockInEscrow.CompletionEvidence memory evidence;
        evidence.missionType = STRAVA_RUN;
        evidence.policyHash = ESCROW.missionPolicyHash(STRAVA_RUN);
        // Distinct per day, exactly as the server derives them: one run can never settle twice.
        evidence.sessionIdHash = keccak256(abi.encode("forecast:session", dayIndex));
        evidence.identityHash = identity;
        evidence.eventNullifier = keccak256(abi.encode("forecast:activity", dayIndex));
        evidence.metric = 1_100;
        evidence.proofSetHash = keccak256(abi.encode("forecast:run", dayIndex));
        evidence.occurredAt = occurredAt;
        evidence.oldestProofTimestamp = uint32(issuedAt);
        evidence.newestProofTimestamp = uint32(issuedAt);
        evidence.movingTimeSeconds = 400;
        evidence.elapsedTimeSeconds = 480;
        evidence.elevationGainMeters = 5;
        evidence.issuedAt = issuedAt;
        evidence.expiresAt = issuedAt + 600;

        bytes32 structHash = keccak256(
            abi.encode(
                ESCROW.COMPLETION_TYPEHASH(),
                PACT_ID,
                WALLET_A,
                dayIndex,
                evidence.missionType,
                evidence.policyHash,
                evidence.sessionIdHash,
                evidence.identityHash,
                evidence.eventNullifier,
                evidence.metric,
                evidence.proofSetHash,
                evidence.occurredAt,
                evidence.oldestProofTimestamp,
                evidence.newestProofTimestamp,
                evidence.movingTimeSeconds,
                evidence.elapsedTimeSeconds,
                evidence.elevationGainMeters,
                evidence.issuedAt,
                evidence.expiresAt
            )
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Lock In"),
                keccak256("1"),
                block.chainid,
                address(ESCROW)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(evidenceKey, digest);
        evidence.signature = abi.encodePacked(r, s, v);

        VM.prank(WALLET_A);
        ESCROW.submitCompletion(PACT_ID, dayIndex, evidence);
    }
}
