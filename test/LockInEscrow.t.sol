// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Reclaim} from "@reclaimprotocol/solidity-sdk/contracts/Reclaim.sol";
import {LockInEscrow, IReclaimVerifier} from "../contracts/LockInEscrow.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 timestamp) external;
}

contract MockUsd is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public pure override returns (uint8) { return 6; }
}

contract MockReclaim is IReclaimVerifier {
    function verifyProof(Reclaim.Proof calldata) external pure returns (bool) { return true; }

    function extractFieldFromContext(
        string calldata data,
        string calldata target
    ) external pure returns (string memory) {
        bytes memory source = bytes(data);
        bytes memory needle = bytes(target);
        if (source.length < needle.length) return "";
        for (uint256 i; i <= source.length - needle.length; ++i) {
            bool found = true;
            for (uint256 j; j < needle.length; ++j) {
                if (source[i + j] != needle[j]) { found = false; break; }
            }
            if (!found) continue;
            uint256 start = i + needle.length;
            uint256 end = start;
            while (end < source.length && source[end] != '"') ++end;
            bytes memory output = new bytes(end - start);
            for (uint256 k = start; k < end; ++k) output[k - start] = source[k];
            return string(output);
        }
        return "";
    }
}

contract LockInEscrowTest {
    using Strings for uint256;
    using Strings for address;

    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant ONE_USD = 1_000_000;
    uint256 private constant SIGNER_KEY = 0x51A9E2;
    uint256 private constant JUL_14_2026 = 1_783_987_200;
    bytes32 private constant IDENTITY_HASH = 0xdbb40a205e1a2036ccd2b371eebc19d6e01ae3a9b2cfd414d4d7abfbd9d11f67;
    bytes32 private constant CORE_HASH = 0x2ef5ed61f33aa62f83c1ebf18c191b1b897db0d4a959368a365fff0c036dab2b;
    bytes32 private constant GPS_HASH = 0x0bf30795f8148a6ec4d8609a71b7b6f7962f265169f6626e5b36b1f842460e27;
    bytes32 private constant TRAINER_HASH = 0x26f22ca533a47f4af000231fd0a4de10b055985f2a32126bf2407de878a22040;
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA401);
    string private constant CHALLENGE = "LI-7M4Q9X2K8P6R3T5V";

    MockUsd private token;
    MockReclaim private verifier;
    LockInEscrow private escrow;

    function setUp() public {
        vm.warp(JUL_14_2026 - 1 hours);
        token = new MockUsd();
        verifier = new MockReclaim();
        escrow = new LockInEscrow(token, verifier, vm.addr(SIGNER_KEY), ONE_USD);
        _fund(ALICE);
        _fund(BOB);
        _fund(CAROL);
    }

    function testOneDollarCapIsEnforced() public {
        vm.prank(ALICE);
        (bool ok,) = address(escrow).call(abi.encodeCall(
            escrow.createPact,
            (uint96(ONE_USD + 1), 1_000, 1, 1, 1, uint64(JUL_14_2026), uint64(JUL_15_2026() + 1 hours), CHALLENGE)
        ));
        require(!ok, "stake above cap accepted");
    }

    function testNominalTwoDayCycleSlashesTheQuitter() public {
        uint256 pactId = _createPact(2);
        _join(pactId, BOB);

        vm.warp(JUL_14_2026 + 14 hours);
        _submit(ALICE, pactId, 0, "100", 100, "2026-07-14T13:04:46+0000", "1000");
        _submit(BOB, pactId, 0, "200", 200, "2026-07-14T13:05:46+0000", "1200");

        vm.warp(JUL_15_2026() + 14 hours);
        _submit(ALICE, pactId, 1, "101", 101, "2026-07-15T13:04:46+0000", "1500");

        vm.warp(JUL_16_2026() + 2 hours);
        escrow.finalizePact(pactId);
        uint256 beforeBalance = token.balanceOf(ALICE);
        vm.prank(ALICE);
        require(escrow.claim(pactId) == 2 * ONE_USD, "finisher did not receive pool");
        require(token.balanceOf(ALICE) == beforeBalance + 2 * ONE_USD, "pool not transferred");
        vm.prank(BOB);
        (bool ok,) = address(escrow).call(abi.encodeCall(escrow.claim, (pactId)));
        require(!ok, "quitter claimed");
    }

    function testRejectsProofBoundToAnotherWallet() public {
        uint256 pactId = _createPact(1);
        vm.warp(JUL_14_2026 + 14 hours);
        (uint64 expiresAt, bytes memory signature) = _attestation(pactId, ALICE, 0, 300);
        vm.prank(ALICE);
        (bool ok,) = address(escrow).call(abi.encodeCall(
            escrow.submitStravaProofs,
            (pactId, 0, CHALLENGE, _proofs(BOB, pactId, 0, "300", "2026-07-14T13:04:46+0000", "1000", true, false), expiresAt, signature)
        ));
        require(!ok, "Bob proof accepted for Alice");
    }

    function testRejectsActivityOutsideTheDay() public {
        uint256 pactId = _createPact(1);
        vm.warp(JUL_14_2026 + 14 hours);
        (uint64 expiresAt, bytes memory signature) = _attestation(pactId, ALICE, 0, 400);
        vm.prank(ALICE);
        (bool ok,) = address(escrow).call(abi.encodeCall(
            escrow.submitStravaProofs,
            (pactId, 0, CHALLENGE, _proofs(ALICE, pactId, 0, "400", "2026-07-13T13:04:46+0000", "1000", true, false), expiresAt, signature)
        ));
        require(!ok, "old activity accepted");
    }

    function testRejectsManualActivityWithoutGps() public {
        uint256 pactId = _createPact(1);
        vm.warp(JUL_14_2026 + 14 hours);
        (uint64 expiresAt, bytes memory signature) = _attestation(pactId, ALICE, 0, 500);
        vm.prank(ALICE);
        (bool ok,) = address(escrow).call(abi.encodeCall(
            escrow.submitStravaProofs,
            (pactId, 0, CHALLENGE, _proofs(ALICE, pactId, 0, "500", "2026-07-14T13:04:46+0000", "1000", false, false), expiresAt, signature)
        ));
        require(!ok, "manual no-GPS activity accepted");
    }

    function testRejectsStravaFlaggedActivity() public {
        uint256 pactId = _createPact(1);
        vm.warp(JUL_14_2026 + 14 hours);
        (uint64 expiresAt, bytes memory signature) = _attestation(pactId, ALICE, 0, 550);
        Reclaim.Proof[4] memory proofs = _proofsWithMotion(
            ALICE, pactId, 0, "550", "2026-07-14T13:04:46+0000", "1000", true, false,
            "true", "600", "600", "0"
        );
        vm.prank(ALICE);
        (bool ok,) = address(escrow).call(abi.encodeCall(
            escrow.submitStravaProofs,
            (pactId, 0, CHALLENGE, proofs, expiresAt, signature)
        ));
        require(!ok, "Strava-flagged activity accepted");
    }

    function testRejectsImplausibleRunningSpeed() public {
        uint256 pactId = _createPact(1);
        vm.warp(JUL_14_2026 + 14 hours);
        (uint64 expiresAt, bytes memory signature) = _attestation(pactId, ALICE, 0, 575);
        Reclaim.Proof[4] memory proofs = _proofsWithMotion(
            ALICE, pactId, 0, "575", "2026-07-14T13:04:46+0000", "1000", true, false,
            "false", "100", "100", "0"
        );
        vm.prank(ALICE);
        (bool ok,) = address(escrow).call(abi.encodeCall(
            escrow.submitStravaProofs,
            (pactId, 0, CHALLENGE, proofs, expiresAt, signature)
        ));
        require(!ok, "implausibly fast activity accepted");
    }

    function testRejectsWrongProviderConfiguration() public {
        uint256 pactId = _createPact(1);
        vm.warp(JUL_14_2026 + 14 hours);
        Reclaim.Proof[4] memory proofs = _proofs(
            ALICE, pactId, 0, "600", "2026-07-14T13:04:46+0000", "1000", true, false
        );
        proofs[2].claimInfo.context = _context(
            ALICE, pactId, 0, keccak256("attacker-provider"), '"latlng":"true"'
        );
        (uint64 expiresAt, bytes memory signature) = _attestation(pactId, ALICE, 0, 600);
        vm.prank(ALICE);
        (bool ok,) = address(escrow).call(abi.encodeCall(
            escrow.submitStravaProofs,
            (pactId, 0, CHALLENGE, proofs, expiresAt, signature)
        ));
        require(!ok, "wrong provider hash accepted");
    }

    function testRejectsMissingSdkValidatorAttestation() public {
        uint256 pactId = _createPact(1);
        vm.warp(JUL_14_2026 + 14 hours);
        Reclaim.Proof[4] memory proofs = _proofs(
            ALICE, pactId, 0, "650", "2026-07-14T13:04:46+0000", "1000", true, false
        );
        vm.prank(ALICE);
        (bool ok,) = address(escrow).call(abi.encodeCall(
            escrow.submitStravaProofs,
            (pactId, 0, CHALLENGE, proofs, uint64(block.timestamp + 300), hex"00")
        ));
        require(!ok, "proof accepted without SDK validator attestation");
    }

    function testActivityCannotSettleTwoPacts() public {
        uint256 firstPact = _createPact(1);
        uint256 secondPact = _createPact(1);
        vm.warp(JUL_14_2026 + 14 hours);
        _submit(ALICE, firstPact, 0, "700", 700, "2026-07-14T13:04:46+0000", "1000");
        (uint64 expiresAt, bytes memory signature) = _attestation(secondPact, ALICE, 0, 700);
        vm.prank(ALICE);
        (bool ok,) = address(escrow).call(abi.encodeCall(
            escrow.submitStravaProofs,
            (secondPact, 0, CHALLENGE, _proofs(ALICE, secondPact, 0, "700", "2026-07-14T13:04:46+0000", "1000", true, false), expiresAt, signature)
        ));
        require(!ok, "activity reused across pacts");
    }

    function testFixedStakeMakesSybilPayoutProportionalToCapital() public {
        uint256 pactId = _createPact(1);
        _join(pactId, BOB);
        _join(pactId, CAROL);
        require(token.balanceOf(address(escrow)) == 3 * ONE_USD, "each identity did not fund equal stake");
        (, , , uint96 stake, , uint32 participantCount, , , , , , , , , , ) = escrow.pacts(pactId);
        require(stake == ONE_USD && participantCount == 3, "payout weights diverged from stake");
    }

    function testCancellationRefundsParticipants() public {
        uint256 pactId = _createPact(1);
        _join(pactId, BOB);
        escrow.cancelPact(pactId);
        escrow.finalizePact(pactId);
        vm.prank(ALICE);
        require(escrow.claim(pactId) == ONE_USD, "alice refund wrong");
        vm.prank(BOB);
        require(escrow.claim(pactId) == ONE_USD, "bob refund wrong");
    }

    function testThirtyDayPactUsesWideBitmapAndFlexibleTarget() public {
        uint256 pactId = _createPactWithPolicy(30, 2, 2);
        _join(pactId, BOB);

        vm.warp(JUL_14_2026 + 14 hours);
        _submit(ALICE, pactId, 0, "800", 800, "2026-07-14T13:04:46+0000", "1000");

        vm.warp(JUL_14_2026 + 29 days + 14 hours);
        _submit(ALICE, pactId, 29, "801", 801, "2026-08-12T13:04:46+0000", "1000");

        uint256 bitmap = escrow.completionBitmap(pactId, ALICE);
        require(bitmap & 1 == 1, "day zero missing");
        require(bitmap & (uint256(1) << 29) != 0, "day twenty-nine missing");
        require(escrow.completionCount(pactId, ALICE) == 2, "completion target not counted");

        vm.warp(JUL_14_2026 + 30 days + 2 hours);
        escrow.finalizePact(pactId);
        vm.prank(ALICE);
        require(escrow.claim(pactId) == 2 * ONE_USD, "flexible-target finisher did not receive pool");
        vm.prank(BOB);
        (bool loserClaimed,) = address(escrow).call(abi.encodeCall(escrow.claim, (pactId)));
        require(!loserClaimed, "non-finisher claimed flexible-target pool");
    }

    function testUnderfilledPactCancelsAndRefundsAtStart() public {
        uint256 pactId = _createPactWithPolicy(3, 3, 2);
        vm.warp(JUL_14_2026);
        escrow.finalizePact(pactId);
        (, , , , , , , , , , , , , , bool finalized, bool cancelled) = escrow.pacts(pactId);
        require(finalized && cancelled, "underfilled pact stayed active");
        vm.prank(ALICE);
        require(escrow.claim(pactId) == ONE_USD, "underfilled creator not refunded");
    }

    function testSameStravaIdentityCannotBackTwoWalletsInOnePact() public {
        uint256 pactId = _createPact(1);
        _join(pactId, BOB);
        vm.warp(JUL_14_2026 + 14 hours);
        _submit(ALICE, pactId, 0, "900", 900, "2026-07-14T13:04:46+0000", "1000");

        string memory aliceMarker = _athleteMarker(ALICE);
        Reclaim.Proof[4] memory proofs = _proofs(
            BOB, pactId, 0, "901", "2026-07-14T13:05:46+0000", "1000", true, false
        );
        proofs[0].claimInfo.context = _context(
            BOB,
            pactId,
            0,
            IDENTITY_HASH,
            string.concat('"marker":"', aliceMarker, '"')
        );
        (uint64 expiresAt, bytes memory signature) = _attestationForMarker(
            pactId, BOB, 0, 901, aliceMarker
        );
        vm.prank(BOB);
        (bool ok,) = address(escrow).call(abi.encodeCall(
            escrow.submitStravaProofs,
            (pactId, 0, CHALLENGE, proofs, expiresAt, signature)
        ));
        require(!ok, "one Strava identity backed two wallets");
    }

    function testMultiDayPactCannotBeConfiguredAsSolo() public {
        vm.prank(ALICE);
        (bool ok,) = address(escrow).call(abi.encodeCall(
            escrow.createPact,
            (uint96(ONE_USD), 1_000, 3, 1, 1, uint64(JUL_14_2026), uint64(JUL_14_2026 + 3 days + 1 hours), CHALLENGE)
        ));
        require(!ok, "multi-day solo pact accepted");
    }

    function testProofCannotStartEarlyOrInUnderfilledPact() public {
        uint256 pactId = _createPactWithPolicy(3, 1, 2);
        (uint64 earlyExpiry, bytes memory earlySignature) = _attestation(pactId, ALICE, 0, 910);
        vm.prank(ALICE);
        (bool earlyOk,) = address(escrow).call(abi.encodeCall(
            escrow.submitStravaProofs,
            (pactId, 0, CHALLENGE, _proofs(ALICE, pactId, 0, "910", "2026-07-14T00:00:00+0000", "1000", true, false), earlyExpiry, earlySignature)
        ));
        require(!earlyOk, "proof accepted before start");

        vm.warp(JUL_14_2026);
        (uint64 expiry, bytes memory signature) = _attestation(pactId, ALICE, 0, 911);
        vm.prank(ALICE);
        (bool underfilledOk,) = address(escrow).call(abi.encodeCall(
            escrow.submitStravaProofs,
            (pactId, 0, CHALLENGE, _proofs(ALICE, pactId, 0, "911", "2026-07-14T00:00:00+0000", "1000", true, false), expiry, signature)
        ));
        require(!underfilledOk, "proof accepted in underfilled pact");
    }

    function testJoinClosesAtStart() public {
        uint256 pactId = _createPactWithPolicy(3, 1, 2);
        vm.warp(JUL_14_2026);
        vm.prank(BOB);
        (bool ok,) = address(escrow).call(abi.encodeCall(escrow.joinPact, (pactId)));
        require(!ok, "join accepted at pact start");
    }

    function testAdditionalProofIsRejectedAfterTarget() public {
        uint256 pactId = _createPactWithPolicy(3, 1, 2);
        _join(pactId, BOB);
        vm.warp(JUL_14_2026 + 14 hours);
        _submit(ALICE, pactId, 0, "920", 920, "2026-07-14T13:04:46+0000", "1000");

        vm.warp(JUL_15_2026() + 14 hours);
        (uint64 expiry, bytes memory signature) = _attestation(pactId, ALICE, 1, 921);
        vm.prank(ALICE);
        (bool ok,) = address(escrow).call(abi.encodeCall(
            escrow.submitStravaProofs,
            (pactId, 1, CHALLENGE, _proofs(ALICE, pactId, 1, "921", "2026-07-15T13:04:46+0000", "1000", true, false), expiry, signature)
        ));
        require(!ok, "extra proof consumed after target");
        require(escrow.completionCount(pactId, ALICE) == 1, "completion count changed after target");
    }

    function testWalletCannotSwitchStravaIdentityAcrossDays() public {
        uint256 pactId = _createPactWithPolicy(2, 2, 2);
        _join(pactId, BOB);
        vm.warp(JUL_14_2026 + 14 hours);
        _submit(ALICE, pactId, 0, "930", 930, "2026-07-14T13:04:46+0000", "1000");

        vm.warp(JUL_15_2026() + 14 hours);
        string memory bobMarker = _athleteMarker(BOB);
        Reclaim.Proof[4] memory proofs = _proofs(
            ALICE, pactId, 1, "931", "2026-07-15T13:04:46+0000", "1000", true, false
        );
        proofs[0].claimInfo.context = _context(
            ALICE, pactId, 1, IDENTITY_HASH, string.concat('"marker":"', bobMarker, '"')
        );
        (uint64 expiry, bytes memory signature) = _attestationForMarker(pactId, ALICE, 1, 931, bobMarker);
        vm.prank(ALICE);
        (bool ok,) = address(escrow).call(abi.encodeCall(
            escrow.submitStravaProofs,
            (pactId, 1, CHALLENGE, proofs, expiry, signature)
        ));
        require(!ok, "wallet switched Strava identity");
    }

    function _createPact(uint8 durationDays) private returns (uint256 pactId) {
        return _createPactWithPolicy(durationDays, durationDays, durationDays > 1 ? 2 : 1);
    }

    function _createPactWithPolicy(
        uint8 durationDays,
        uint8 requiredCompletions,
        uint8 minParticipants
    ) private returns (uint256 pactId) {
        uint64 deadline = uint64(JUL_14_2026 + uint256(durationDays) * 1 days + 1 hours);
        vm.prank(ALICE);
        pactId = escrow.createPact(
            uint96(ONE_USD), 1_000, durationDays, requiredCompletions, minParticipants,
            uint64(JUL_14_2026), deadline, CHALLENGE
        );
    }

    function _join(uint256 pactId, address account) private {
        vm.prank(account);
        escrow.joinPact(pactId);
    }

    function _fund(address account) private {
        token.mint(account, 10 * ONE_USD);
        vm.prank(account);
        token.approve(address(escrow), type(uint256).max);
    }

    function _submit(
        address account,
        uint256 pactId,
        uint8 dayIndex,
        string memory activityId,
        uint256 numericActivityId,
        string memory startTime,
        string memory distance
    ) private {
        Reclaim.Proof[4] memory proofs = _proofs(
            account, pactId, dayIndex, activityId, startTime, distance, true, false
        );
        (uint64 expiresAt, bytes memory signature) = _attestation(
            pactId, account, dayIndex, numericActivityId
        );
        vm.prank(account);
        escrow.submitStravaProofs(
            pactId, dayIndex, CHALLENGE, proofs, expiresAt, signature
        );
    }

    function _attestation(
        uint256 pactId,
        address account,
        uint8 dayIndex,
        uint256 activityId
    ) private returns (uint64 expiresAt, bytes memory signature) {
        return _attestationForMarker(pactId, account, dayIndex, activityId, _athleteMarker(account));
    }

    function _attestationForMarker(
        uint256 pactId,
        address account,
        uint8 dayIndex,
        uint256 activityId,
        string memory athleteMarker
    ) private returns (uint64 expiresAt, bytes memory signature) {
        bytes32 nullifier = keccak256(abi.encode(
            escrow.STRAVA_PROVIDER_KEY(), athleteMarker, activityId
        ));
        bytes32 setHash = keccak256(abi.encode(
            bytes32(0), bytes32(0), bytes32(0), bytes32(0)
        ));
        expiresAt = uint64(block.timestamp + 300);
        bytes32 digest = escrow.completionDigest(
            pactId, account, dayIndex, nullifier, setHash, expiresAt
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _proofs(
        address account,
        uint256 pactId,
        uint8 dayIndex,
        string memory activityId,
        string memory startTime,
        string memory distance,
        bool hasGps,
        bool trainer
    ) private view returns (Reclaim.Proof[4] memory proofs) {
        proofs = _proofsWithMotion(
            account,
            pactId,
            dayIndex,
            activityId,
            startTime,
            distance,
            hasGps,
            trainer,
            "false",
            "600",
            "600",
            "0"
        );
    }

    function _proofsWithMotion(
        address account,
        uint256 pactId,
        uint8 dayIndex,
        string memory activityId,
        string memory startTime,
        string memory distance,
        bool hasGps,
        bool trainer,
        string memory flagged,
        string memory moving,
        string memory elapsed,
        string memory elevation
    ) private view returns (Reclaim.Proof[4] memory proofs) {
        proofs[0] = _proof(_context(
            account,
            pactId,
            dayIndex,
            IDENTITY_HASH,
            string.concat('"marker":"', _athleteMarker(account), '"')
        ));
        proofs[1] = _proof(_context(
            account,
            pactId,
            dayIndex,
            CORE_HASH,
            string.concat(
                '"id":"', activityId,
                '","name":"', _proofCode(dayIndex),
                '","raw":"', distance,
                '","time":"', startTime,
                '","type":"Run","flagged":"', flagged,
                '","moving":"', moving,
                '","elapsed":"', elapsed,
                '","elevation":"', elevation, '"'
            )
        ));
        proofs[2] = _proof(_context(
            account,
            pactId,
            dayIndex,
            GPS_HASH,
            hasGps ? '"latlng":"true"' : '"latlng":"false"'
        ));
        proofs[3] = _proof(_context(
            account,
            pactId,
            dayIndex,
            TRAINER_HASH,
            trainer ? '"trainer":"true"' : '"trainer":"false"'
        ));
    }

    function _proof(string memory context) private view returns (Reclaim.Proof memory proof) {
        proof.claimInfo.context = context;
        proof.claimInfo.provider = "http";
        proof.signedClaim.claim.timestampS = uint32(block.timestamp);
    }

    function _context(
        address account,
        uint256 pactId,
        uint8 dayIndex,
        bytes32 providerHash,
        string memory fields
    ) private pure returns (string memory) {
        return string.concat(
            '{"contextAddress":"', account.toHexString(),
            '","contextMessage":"', pactId.toString(), ":", uint256(dayIndex).toString(),
            '","extractedParameters":{', fields,
            '},"providerHash":"', uint256(providerHash).toHexString(32),
            '","reclaimSessionId":"session-test"}'
        );
    }

    function _athleteMarker(address account) private pure returns (string memory) {
        return string.concat("userId: ", uint256(uint160(account)).toString());
    }

    function _proofCode(uint8 dayIndex) private pure returns (string memory) {
        uint256 dayNumber = uint256(dayIndex) + 1;
        return dayNumber < 10
            ? string.concat(CHALLENGE, "D0", dayNumber.toString())
            : string.concat(CHALLENGE, "D", dayNumber.toString());
    }

    function JUL_15_2026() private pure returns (uint256) { return JUL_14_2026 + 1 days; }
    function JUL_16_2026() private pure returns (uint256) { return JUL_14_2026 + 2 days; }
}
