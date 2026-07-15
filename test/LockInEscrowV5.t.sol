// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LockInEscrowV5} from "../contracts/LockInEscrowV5.sol";

interface VmV5 {
    function addr(uint256 privateKey) external returns (address);
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 timestamp) external;
}

contract MockUsdcV5 is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public pure override returns (uint8) { return 6; }
}

contract LockInEscrowV5Test {
    VmV5 private constant VM = VmV5(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant ONE_USDC = 1_000_000;
    uint256 private constant SIGNER_KEY = 0xA11CE51;
    uint256 private constant WRONG_SIGNER_KEY = 0xBAD51;
    uint256 private constant START = 1_784_073_600;
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA401);
    bytes32 private constant ALICE_ID = keccak256("duolingo:alice");
    bytes32 private constant BOB_ID = keccak256("duolingo:bob");

    MockUsdcV5 private token;
    LockInEscrowV5 private escrow;

    function setUp() public {
        VM.warp(START - 1 hours);
        token = new MockUsdcV5();
        escrow = new LockInEscrowV5(token, VM.addr(SIGNER_KEY));
        require(escrow.creationPaused() && escrow.joiningPaused() && escrow.evidencePaused(), "deploy not paused");
        escrow.setCreationPaused(false);
        escrow.setJoiningPaused(false);
        escrow.setEvidencePaused(false);
        _fund(ALICE);
        _fund(BOB);
        _fund(CAROL);
    }

    function testStravaFinishersSplitQuitterStake() public {
        uint256 pactId = _createStrava(3, 2);
        _joinStrava(pactId, BOB);
        _joinStrava(pactId, CAROL);

        VM.warp(START + 1 hours);
        _submit(ALICE, pactId, 0, 1, keccak256("strava-alice"), keccak256("activity-a-0"), 1_500, START + 300);
        _submit(BOB, pactId, 0, 1, keccak256("strava-bob"), keccak256("activity-b-0"), 1_200, START + 400);

        VM.warp(START + 1 days + 1 hours);
        _submit(ALICE, pactId, 1, 1, keccak256("strava-alice"), keccak256("activity-a-1"), 1_100, START + 1 days + 300);
        _submit(BOB, pactId, 1, 1, keccak256("strava-bob"), keccak256("activity-b-1"), 1_400, START + 1 days + 400);

        VM.warp(START + 3 days);
        escrow.finalizePact(pactId);
        VM.prank(ALICE);
        require(escrow.claim(pactId) == 1_500_000, "alice share wrong");
        VM.prank(BOB);
        require(escrow.claim(pactId) == 1_500_000, "bob share wrong");
        VM.prank(CAROL);
        (bool ok,) = address(escrow).call(abi.encodeCall(escrow.claim, (pactId)));
        require(!ok, "quitter claimed");
    }

    function testDuolingoRequiresFreshSignedBaselineBeforeStakeMoves() public {
        LockInEscrowV5.BaselineEvidence memory empty;
        uint256 beforeBalance = token.balanceOf(ALICE);
        VM.prank(ALICE);
        (bool ok,) = address(escrow).call(abi.encodeCall(
            escrow.createPact,
            (uint96(ONE_USDC), 20, 3, 2, 2, uint64(START), uint8(2), empty)
        ));
        require(!ok, "Duolingo pact accepted without baseline");
        require(token.balanceOf(ALICE) == beforeBalance, "stake moved on rejected baseline");
    }

    function testDuolingoCountsOnlyNewXpAndCannotReuseItAcrossPacts() public {
        uint256 first = _createDuolingo(ALICE, ALICE_ID, 1_000, 3, 2);
        _joinDuolingo(first, BOB, BOB_ID, 600);

        VM.warp(START + 1 hours);
        _submit(ALICE, first, 0, 2, ALICE_ID, keccak256("duo-a-1020"), 1_020, block.timestamp);
        require(escrow.lastMetric(first, ALICE) == 1_020, "first XP delta not recorded");

        VM.warp(START + 1 days + 1 hours);
        (bool reused,) = _trySubmit(
            ALICE, first, 1, 2, ALICE_ID, keccak256("duo-a-reuse"), 1_020, block.timestamp, SIGNER_KEY
        );
        require(!reused, "same XP was reused on another day");
        _submit(ALICE, first, 1, 2, ALICE_ID, keccak256("duo-a-1040"), 1_040, block.timestamp);

        VM.warp(START + 3 days + 1 hours);
        uint256 secondStart = block.timestamp + 1 hours;
        uint256 second = _createDuolingoAt(ALICE, ALICE_ID, 1_040, 3, 1, secondStart);
        _joinDuolingoAt(second, BOB, BOB_ID, 600);
        VM.warp(secondStart + 1 hours);
        (bool oldXp,) = _trySubmit(
            ALICE, second, 0, 2, ALICE_ID, keccak256("duo-old-range"), 1_040, block.timestamp, SIGNER_KEY
        );
        require(!oldXp, "pre-pact XP satisfied a new pact");
        _submit(ALICE, second, 0, 2, ALICE_ID, keccak256("duo-a-1060"), 1_060, block.timestamp);
    }

    function testConcurrentBaselineCannotConsumeProgressFromAnotherPact() public {
        uint256 first = _createDuolingo(ALICE, ALICE_ID, 100, 3, 1);
        _joinDuolingo(first, BOB, BOB_ID, 100);

        uint256 second = _createDuolingo(ALICE, ALICE_ID, 120, 3, 1);
        _joinDuolingo(second, BOB, BOB_ID, 100);
        require(escrow.lastMetric(second, ALICE) == 120, "second baseline not recorded");
        require(escrow.consumedDuolingoMetric(ALICE_ID) == 0, "baseline consumed XP globally");

        VM.warp(START + 1 hours);
        _submit(ALICE, first, 0, 2, ALICE_ID, keccak256("duo-first-120"), 120, block.timestamp);
        require(escrow.consumedDuolingoMetric(ALICE_ID) == 120, "accepted XP not consumed");
    }

    function testDuolingoCreateBaselineCannotBeInvalidatedByAnotherCreation() public {
        LockInEscrowV5.BaselineEvidence memory baseline = _baseline(0, ALICE, ALICE_ID, 100, SIGNER_KEY);
        uint256 consumedId = _createStrava(3, 2);
        VM.prank(ALICE);
        uint256 duoId = escrow.createPact(
            uint96(ONE_USDC), 20, 3, 2, 2, uint64(START), uint8(2), baseline
        );
        require(duoId == consumedId + 1, "sentinel baseline did not survive id change");
        require(escrow.lastMetric(duoId, ALICE) == 100, "baseline not bound to created pact");
    }

    function testCannotPointTwoWalletsAtOneDuolingoProfile() public {
        uint256 pactId = _createDuolingo(ALICE, ALICE_ID, 1_000, 3, 1);
        LockInEscrowV5.BaselineEvidence memory baseline = _baseline(pactId, BOB, ALICE_ID, 1_000, SIGNER_KEY);
        VM.prank(BOB);
        (bool ok,) = address(escrow).call(abi.encodeCall(escrow.joinPact, (pactId, baseline)));
        require(!ok, "one profile backed two wallets");
    }

    function testWrongSignerAndWrongIdentityAreRejected() public {
        uint256 pactId = _createDuolingo(ALICE, ALICE_ID, 1_000, 3, 2);
        _joinDuolingo(pactId, BOB, BOB_ID, 500);
        VM.warp(START + 1 hours);

        (bool wrongSigner,) = _trySubmit(
            ALICE, pactId, 0, 2, ALICE_ID, keccak256("wrong-signer"), 1_020, block.timestamp, WRONG_SIGNER_KEY
        );
        require(!wrongSigner, "wrong signer accepted");

        (bool switched,) = _trySubmit(
            ALICE, pactId, 0, 2, BOB_ID, keccak256("switched-id"), 520, block.timestamp, SIGNER_KEY
        );
        require(!switched, "wallet switched identity");
    }

    function testSameStravaActivityCannotSettleTwice() public {
        uint256 pactId = _createStrava(3, 2);
        _joinStrava(pactId, BOB);
        VM.warp(START + 1 hours);
        bytes32 nullifier = keccak256("one-strava-activity");
        _submit(ALICE, pactId, 0, 1, keccak256("strava-alice"), nullifier, 1_500, block.timestamp);
        (bool ok,) = _trySubmit(
            BOB, pactId, 0, 1, keccak256("strava-bob"), nullifier, 1_500, block.timestamp, SIGNER_KEY
        );
        require(!ok, "Strava activity was reused");
    }

    function testUnderfilledAndNobodyFinishedAreRefundable() public {
        uint256 underfilled = _createStrava(3, 2);
        VM.warp(START);
        escrow.finalizePact(underfilled);
        VM.prank(ALICE);
        require(escrow.claim(underfilled) == ONE_USDC, "underfilled refund wrong");

        VM.warp(START + 4 days);
        uint256 nobodyStart = block.timestamp + 1 hours;
        uint256 nobody = _createStravaAt(3, 2, nobodyStart);
        _joinStrava(nobody, BOB);
        VM.warp(nobodyStart + 3 days);
        escrow.finalizePact(nobody);
        VM.prank(ALICE);
        require(escrow.claim(nobody) == ONE_USDC, "alice no-finisher refund wrong");
        VM.prank(BOB);
        require(escrow.claim(nobody) == ONE_USDC, "bob no-finisher refund wrong");
    }

    function testOneDollarCapAndPauseControlsFailClosed() public {
        LockInEscrowV5.BaselineEvidence memory empty;
        VM.prank(ALICE);
        (bool dust,) = address(escrow).call(abi.encodeCall(
            escrow.createPact,
            (uint96(escrow.MIN_STAKE() - 1), 1_000, 3, 2, 2, uint64(START), uint8(1), empty)
        ));
        require(!dust, "dust stake accepted");

        VM.prank(ALICE);
        (bool capped,) = address(escrow).call(abi.encodeCall(
            escrow.createPact,
            (uint96(ONE_USDC + 1), 1_000, 3, 2, 2, uint64(START), uint8(1), empty)
        ));
        require(!capped, "stake above one dollar accepted");

        escrow.setCreationPaused(true);
        VM.prank(ALICE);
        (bool paused,) = address(escrow).call(abi.encodeCall(
            escrow.createPact,
            (uint96(ONE_USDC), 1_000, 3, 2, 2, uint64(START), uint8(1), empty)
        ));
        require(!paused, "creation pause bypassed");
    }

    function testCannotLockJoinersIntoFarFuturePact() public {
        LockInEscrowV5.BaselineEvidence memory empty;
        VM.prank(ALICE);
        (bool ok,) = address(escrow).call(abi.encodeCall(
            escrow.createPact,
            (
                uint96(ONE_USDC),
                1_000,
                3,
                2,
                2,
                uint64(block.timestamp + escrow.MAX_START_DELAY() + 1),
                uint8(1),
                empty
            )
        ));
        require(!ok, "far-future pact accepted");
    }

    function _createStrava(uint8 daysCount, uint8 required) private returns (uint256) {
        return _createStravaAt(daysCount, required, START);
    }

    function _createStravaAt(uint8 daysCount, uint8 required, uint256 startsAt) private returns (uint256 pactId) {
        LockInEscrowV5.BaselineEvidence memory empty;
        VM.prank(ALICE);
        pactId = escrow.createPact(
            uint96(ONE_USDC), 1_000, daysCount, required, 2, uint64(startsAt), 1, empty
        );
    }

    function _createDuolingo(address account, bytes32 identity, uint64 xp, uint8 daysCount, uint8 required)
        private
        returns (uint256)
    {
        return _createDuolingoAt(account, identity, xp, daysCount, required, START);
    }

    function _createDuolingoAt(
        address account,
        bytes32 identity,
        uint64 xp,
        uint8 daysCount,
        uint8 required,
        uint256 startsAt
    ) private returns (uint256 pactId) {
        pactId = escrow.nextPactId();
        LockInEscrowV5.BaselineEvidence memory baseline = _baselineAt(
            0, account, identity, xp, SIGNER_KEY, startsAt - 1 hours
        );
        VM.prank(account);
        require(
            escrow.createPact(uint96(ONE_USDC), 20, daysCount, required, 2, uint64(startsAt), 2, baseline) == pactId,
            "unexpected pact id"
        );
    }

    function _joinStrava(uint256 pactId, address account) private {
        LockInEscrowV5.BaselineEvidence memory empty;
        VM.prank(account);
        escrow.joinPact(pactId, empty);
    }

    function _joinDuolingo(uint256 pactId, address account, bytes32 identity, uint64 xp) private {
        _joinDuolingoAt(pactId, account, identity, xp);
    }

    function _joinDuolingoAt(uint256 pactId, address account, bytes32 identity, uint64 xp) private {
        LockInEscrowV5.BaselineEvidence memory baseline = _baseline(pactId, account, identity, xp, SIGNER_KEY);
        VM.prank(account);
        escrow.joinPact(pactId, baseline);
    }

    function _baseline(uint256 pactId, address account, bytes32 identity, uint64 xp, uint256 signerKey)
        private
        returns (LockInEscrowV5.BaselineEvidence memory)
    {
        return _baselineAt(pactId, account, identity, xp, signerKey, block.timestamp);
    }

    function _baselineAt(
        uint256 pactId,
        address account,
        bytes32 identity,
        uint64 xp,
        uint256 signerKey,
        uint256 observedAt
    ) private returns (LockInEscrowV5.BaselineEvidence memory evidence) {
        evidence = LockInEscrowV5.BaselineEvidence({
            identityHash: identity,
            totalMetric: xp,
            proofHash: keccak256(abi.encode("baseline", pactId, account, identity, xp, observedAt)),
            observedAt: uint64(observedAt),
            expiresAt: uint64(block.timestamp + 5 minutes),
            signature: ""
        });
        bytes32 structHash = keccak256(abi.encode(
            escrow.BASELINE_TYPEHASH(), pactId, account, identity, xp, evidence.proofHash,
            evidence.observedAt, evidence.expiresAt
        ));
        evidence.signature = _sign(signerKey, structHash);
    }

    function _submit(
        address account,
        uint256 pactId,
        uint8 dayIndex,
        uint8 missionType,
        bytes32 identity,
        bytes32 nullifier,
        uint64 metric,
        uint256 occurredAt
    ) private {
        (bool ok, bytes memory returnData) = _trySubmit(
            account, pactId, dayIndex, missionType, identity, nullifier, metric, occurredAt, SIGNER_KEY
        );
        if (!ok) assembly { revert(add(returnData, 32), mload(returnData)) }
    }

    function _trySubmit(
        address account,
        uint256 pactId,
        uint8 dayIndex,
        uint8 missionType,
        bytes32 identity,
        bytes32 nullifier,
        uint64 metric,
        uint256 occurredAt,
        uint256 signerKey
    ) private returns (bool ok, bytes memory returnData) {
        LockInEscrowV5.CompletionEvidence memory evidence = LockInEscrowV5.CompletionEvidence({
            identityHash: identity,
            eventNullifier: nullifier,
            metric: metric,
            proofHash: keccak256(abi.encode("proof", pactId, account, nullifier, metric)),
            occurredAt: uint64(occurredAt),
            expiresAt: uint64(block.timestamp + 5 minutes),
            signature: ""
        });
        bytes32 structHash = keccak256(abi.encode(
            escrow.COMPLETION_TYPEHASH(), pactId, account, dayIndex, missionType, identity,
            nullifier, metric, evidence.proofHash, evidence.occurredAt, evidence.expiresAt
        ));
        evidence.signature = _sign(signerKey, structHash);
        VM.prank(account);
        (ok, returnData) = address(escrow).call(abi.encodeCall(escrow.submitCompletion, (pactId, dayIndex, evidence)));
    }

    function _sign(uint256 signerKey, bytes32 structHash) private returns (bytes memory) {
        bytes32 domainSeparator = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Lock In"), keccak256("5"), block.chainid, address(escrow)
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _fund(address account) private {
        token.mint(account, 20 * ONE_USDC);
        VM.prank(account);
        token.approve(address(escrow), type(uint256).max);
    }
}
