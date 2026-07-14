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
    bytes32 private constant CORE_HASH = 0x5c93d136e5aa70f1b170f12a0eda9720f3e7c3436b0956e9bd59a85059d1db24;
    bytes32 private constant GPS_HASH = 0xacaa6d30e913b76499b4f06db6c7feca367c0c925c4d5ef55fb836f27922e1d0;
    bytes32 private constant TRAINER_HASH = 0x5c82d40177d4abaf29329b0c9dccb8eb06a8eb4882ea2b736d3ac5a9631521bf;
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
            (uint96(ONE_USD + 1), 1_000, 1, uint64(JUL_14_2026), uint64(JUL_15_2026() + 1 hours), CHALLENGE)
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
        (, , , uint96 stake, , uint32 participantCount, , , , , , , , ) = escrow.pacts(pactId);
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

    function _createPact(uint8 daysRequired) private returns (uint256 pactId) {
        uint64 deadline = uint64(JUL_14_2026 + uint256(daysRequired) * 1 days + 1 hours);
        vm.prank(ALICE);
        pactId = escrow.createPact(
            uint96(ONE_USD), 1_000, daysRequired, uint64(JUL_14_2026), deadline, CHALLENGE
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
        bytes32 nullifier = keccak256(abi.encode(
            escrow.STRAVA_PROVIDER_KEY(), "userId: 1815502280", activityId
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
        proofs[0] = _proof(_context(
            account,
            pactId,
            dayIndex,
            IDENTITY_HASH,
            '"marker":"userId: 1815502280"'
        ));
        proofs[1] = _proof(_context(
            account,
            pactId,
            dayIndex,
            CORE_HASH,
            string.concat(
                '"id":"', activityId,
                '","name":"Morning Run ', CHALLENGE,
                '","raw":"', distance,
                '","time":"', startTime,
                '","type":"Run"'
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

    function JUL_15_2026() private pure returns (uint256) { return JUL_14_2026 + 1 days; }
    function JUL_16_2026() private pure returns (uint256) { return JUL_14_2026 + 2 days; }
}
