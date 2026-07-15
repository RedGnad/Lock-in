// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LockInEscrowV4} from "../contracts/LockInEscrowV4.sol";

interface VmV4 {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
}

contract MockUsdV4 is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract MockWrongDecimalsV4 is ERC20 {
    constructor() ERC20("Wrong Decimals", "WRONG") {}
}

contract LockInEscrowV4Test {
    VmV4 private constant vm = VmV4(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint96 private constant ONE_USDC = 1_000_000;
    uint64 private constant START = 1_783_987_200;
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA401);
    address private constant DAVE = address(0xD0D);
    bytes32 private constant CONFIG_HASH = keccak256("monad-daily-check-in");

    MockUsdV4 private token;
    LockInEscrowV4 private escrow;

    function setUp() public {
        vm.warp(START - 1 hours);
        token = new MockUsdV4();
        escrow = new LockInEscrowV4(token);
        _fund(ALICE);
        _fund(BOB);
        _fund(CAROL);
        _fund(DAVE);
    }

    function testCreateStoresVersionedMissionAndEscrowsCreatorStake() public {
        uint256 pactId = _create(ONE_USDC, 3, 2, 2, START);
        LockInEscrowV4.Pact memory pact = escrow.getPact(pactId);

        require(pact.creator == ALICE, "creator mismatch");
        require(pact.startsAt == START, "start mismatch");
        require(pact.stake == ONE_USDC, "stake mismatch");
        require(pact.participantCount == 1, "creator not counted");
        require(pact.durationDays == 3 && pact.requiredCompletions == 2, "goal mismatch");
        require(pact.minParticipants == 2, "minimum mismatch");
        require(pact.missionType == escrow.MISSION_MONAD_CHECK_IN(), "mission type mismatch");
        require(pact.missionKey == escrow.MONAD_CHECK_IN_MISSION_KEY(), "mission key mismatch");
        require(pact.missionConfigHash == CONFIG_HASH, "config commitment mismatch");
        require(escrow.joined(pactId, ALICE), "creator not joined");
        require(token.balanceOf(address(escrow)) == ONE_USDC, "stake not escrowed");
        require(escrow.pactEndsAt(pactId) == START + 3 days, "end mismatch");
    }

    function testDeploymentRejectsNonSixDecimalToken() public {
        MockWrongDecimalsV4 wrongToken = new MockWrongDecimalsV4();
        bool deployed;
        try new LockInEscrowV4(wrongToken) returns (LockInEscrowV4) {
            deployed = true;
        } catch {}
        require(!deployed, "non-USDC decimals accepted");
    }

    function testCreationBoundsAndOnlySupportedMissionAreEnforced() public {
        require(!_tryCreate(0, 3, 1, 2, START, 1), "zero stake accepted");
        require(!_tryCreate(ONE_USDC + 1, 3, 1, 2, START, 1), "stake above cap accepted");
        require(!_tryCreate(ONE_USDC, 2, 1, 2, START, 1), "two-day pact accepted");
        require(!_tryCreate(ONE_USDC, 31, 1, 2, START, 1), "thirty-one-day pact accepted");
        require(!_tryCreate(ONE_USDC, 3, 0, 2, START, 1), "zero target accepted");
        require(!_tryCreate(ONE_USDC, 3, 4, 2, START, 1), "target above duration accepted");
        require(!_tryCreate(ONE_USDC, 3, 1, 1, START, 1), "solo pact accepted");
        require(!_tryCreate(ONE_USDC, 3, 1, 101, START, 1), "participant cap bypassed");
        require(!_tryCreate(ONE_USDC, 3, 1, 2, uint64(block.timestamp), 1), "non-future start accepted");
        require(!_tryCreate(ONE_USDC, 3, 1, 2, START, 2), "unsupported mission accepted");

        require(_tryCreate(ONE_USDC, 3, 1, 2, START, 1), "minimum valid pact rejected");
        require(_tryCreate(ONE_USDC, 30, 30, 100, START, 1), "maximum valid pact rejected");
    }

    function testJoinIsFixedStakeAndClosesExactlyAtStart() public {
        uint256 pactId = _create(ONE_USDC, 3, 2, 2, START);
        _join(pactId, BOB);
        require(token.balanceOf(address(escrow)) == 2 * ONE_USDC, "join stake missing");

        require(!_callAs(BOB, abi.encodeCall(escrow.joinPact, (pactId))), "duplicate join accepted");
        vm.warp(START);
        require(!_callAs(CAROL, abi.encodeCall(escrow.joinPact, (pactId))), "join accepted at start");
    }

    function testParticipantCapIsOneHundred() public {
        uint256 pactId = _create(1, 3, 1, 100, START);
        for (uint256 i = 1; i < 100; ++i) {
            address account = address(uint160(0x10000 + i));
            _fundAmount(account, 1);
            _join(pactId, account);
        }

        LockInEscrowV4.Pact memory pact = escrow.getPact(pactId);
        require(pact.participantCount == 100, "cap not reached");
        require(!_callAs(DAVE, abi.encodeCall(escrow.joinPact, (pactId))), "participant 101 joined");
    }

    function testCheckInIsStrictlyCurrentDayAndNeverRetroactive() public {
        uint256 pactId = _create(ONE_USDC, 3, 3, 2, START);
        _join(pactId, BOB);

        require(!_callAs(ALICE, abi.encodeCall(escrow.checkIn, (pactId, uint8(0)))), "early check-in accepted");

        vm.warp(START);
        bytes32 nullifier = _checkIn(ALICE, pactId, 0);
        require(escrow.usedEventNullifiers(nullifier), "nullifier not consumed");
        require(!_callAs(ALICE, abi.encodeCall(escrow.checkIn, (pactId, uint8(0)))), "duplicate day accepted");
        require(!_callAs(ALICE, abi.encodeCall(escrow.checkIn, (pactId, uint8(1)))), "future day accepted");

        vm.warp(START + 1 days);
        require(!_callAs(BOB, abi.encodeCall(escrow.checkIn, (pactId, uint8(0)))), "retroactive day accepted");
        _checkIn(ALICE, pactId, 1);

        vm.warp(START + 3 days);
        require(!_callAs(ALICE, abi.encodeCall(escrow.checkIn, (pactId, uint8(2)))), "last day accepted after close");
        require(!_callAs(ALICE, abi.encodeCall(escrow.checkIn, (pactId, uint8(3)))), "out-of-range day accepted");
    }

    function testCheckInRequiresParticipantAndFilledPact() public {
        uint256 underfilled = _create(ONE_USDC, 3, 1, 2, START);
        vm.warp(START);
        require(
            !_callAs(ALICE, abi.encodeCall(escrow.checkIn, (underfilled, uint8(0)))), "underfilled check-in accepted"
        );

        vm.warp(START + 10 days);
        uint64 laterStart = uint64(block.timestamp + 1 hours);
        uint256 filled = _create(ONE_USDC, 3, 1, 2, laterStart);
        _join(filled, BOB);
        vm.warp(laterStart);
        require(!_callAs(CAROL, abi.encodeCall(escrow.checkIn, (filled, uint8(0)))), "outsider checked in");
    }

    function testNullifierIsUniqueAcrossPactWalletAndDay() public {
        uint256 first = _create(ONE_USDC, 3, 1, 2, START);
        uint256 second = _create(ONE_USDC, 3, 1, 2, START);
        _join(first, BOB);
        _join(second, BOB);

        bytes32 base = escrow.checkInNullifier(first, ALICE, 0);
        require(base != escrow.checkInNullifier(first, BOB, 0), "wallet not namespaced");
        require(base != escrow.checkInNullifier(first, ALICE, 1), "day not namespaced");
        require(base != escrow.checkInNullifier(second, ALICE, 0), "pact not namespaced");

        vm.warp(START);
        require(_checkIn(ALICE, first, 0) == base, "returned nullifier mismatch");
    }

    function testCheckInStopsAfterTargetAndFinisherIsCountedOnce() public {
        uint256 pactId = _create(ONE_USDC, 3, 1, 2, START);
        _join(pactId, BOB);

        vm.warp(START);
        _checkIn(ALICE, pactId, 0);
        vm.warp(START + 1 days);
        require(!_callAs(ALICE, abi.encodeCall(escrow.checkIn, (pactId, uint8(1)))), "check-in accepted after target");

        LockInEscrowV4.Pact memory pact = escrow.getPact(pactId);
        require(pact.finisherCount == 1, "finisher counted more than once");
        require(escrow.completionCount(pactId, ALICE) == 1, "count exceeded target");
        require(escrow.isFinisher(pactId, ALICE), "finisher view false");
    }

    function testFinisherReceivesOwnStakeAndQuitterStake() public {
        uint256 pactId = _create(ONE_USDC, 3, 2, 2, START);
        _join(pactId, BOB);

        vm.warp(START);
        _checkIn(ALICE, pactId, 0);
        _checkIn(BOB, pactId, 0);
        vm.warp(START + 1 days);
        _checkIn(ALICE, pactId, 1);

        require(!_callAs(ALICE, abi.encodeCall(escrow.claim, (pactId))), "claim before finalization accepted");
        require(!_callAs(CAROL, abi.encodeCall(escrow.finalizePact, (pactId))), "early finalization accepted");

        vm.warp(START + 3 days);
        vm.prank(CAROL);
        escrow.finalizePact(pactId);

        uint256 beforeBalance = token.balanceOf(ALICE);
        vm.prank(ALICE);
        require(escrow.claim(pactId) == 2 * ONE_USDC, "winner pool wrong");
        require(token.balanceOf(ALICE) == beforeBalance + 2 * ONE_USDC, "winner transfer wrong");
        require(!_callAs(BOB, abi.encodeCall(escrow.claim, (pactId))), "quitter claimed");
        require(!_callAs(ALICE, abi.encodeCall(escrow.claim, (pactId))), "double claim accepted");
    }

    function testFinishersSplitPoolAndLastClaimReceivesDust() public {
        uint96 stake = 999_999;
        uint256 pactId = _create(stake, 3, 1, 2, START);
        _join(pactId, BOB);
        _join(pactId, CAROL);

        vm.warp(START);
        _checkIn(ALICE, pactId, 0);
        _checkIn(BOB, pactId, 0);
        vm.warp(START + 3 days);
        escrow.finalizePact(pactId);

        vm.prank(ALICE);
        uint256 firstAmount = escrow.claim(pactId);
        vm.prank(BOB);
        uint256 lastAmount = escrow.claim(pactId);

        require(firstAmount == 1_499_998, "first rounded share wrong");
        require(lastAmount == 1_499_999, "last dust share wrong");
        require(firstAmount + lastAmount == uint256(stake) * 3, "pool not conserved");
        LockInEscrowV4.Pact memory pact = escrow.getPact(pactId);
        require(pact.remainingPool == 0 && pact.claimsRemaining == 0, "settlement dust trapped");
    }

    function testZeroFinishersRefundsEveryParticipant() public {
        uint256 pactId = _create(ONE_USDC, 3, 3, 2, START);
        _join(pactId, BOB);
        vm.warp(START + 3 days);
        escrow.finalizePact(pactId);

        vm.prank(ALICE);
        require(escrow.claim(pactId) == ONE_USDC, "alice refund wrong");
        vm.prank(BOB);
        require(escrow.claim(pactId) == ONE_USDC, "bob refund wrong");
    }

    function testUnderfilledPactFinalizesAtStartAndRefunds() public {
        uint256 pactId = _create(ONE_USDC, 3, 1, 2, START);
        vm.warp(START);
        vm.prank(DAVE);
        escrow.finalizePact(pactId);

        LockInEscrowV4.Pact memory pact = escrow.getPact(pactId);
        require(pact.finalized && pact.cancelled, "underfilled pact stayed live");
        vm.prank(ALICE);
        require(escrow.claim(pactId) == ONE_USDC, "underfilled refund wrong");
    }

    function testCreatorCancellationDuringRegistrationRefundsEveryone() public {
        uint256 pactId = _create(ONE_USDC, 3, 1, 2, START);
        _join(pactId, BOB);
        require(!_callAs(BOB, abi.encodeCall(escrow.cancelPact, (pactId))), "non-creator cancelled");

        vm.prank(ALICE);
        escrow.cancelPact(pactId);
        vm.prank(CAROL);
        escrow.finalizePact(pactId);

        vm.prank(ALICE);
        require(escrow.claim(pactId) == ONE_USDC, "creator cancellation refund wrong");
        vm.prank(BOB);
        require(escrow.claim(pactId) == ONE_USDC, "joiner cancellation refund wrong");
    }

    function testCancellationClosesAtStart() public {
        uint256 pactId = _create(ONE_USDC, 3, 1, 2, START);
        _join(pactId, BOB);
        vm.warp(START);
        require(!_callAs(ALICE, abi.encodeCall(escrow.cancelPact, (pactId))), "started pact cancelled");
    }

    function testOwnerEmergencyCancellationWorksPostStartAndOnlyRefunds() public {
        uint256 pactId = _create(ONE_USDC, 3, 1, 2, START);
        _join(pactId, BOB);
        vm.warp(START);
        _checkIn(ALICE, pactId, 0);

        require(!_callAs(CAROL, abi.encodeCall(escrow.cancelPactByOwner, (pactId))), "non-owner emergency-cancelled");
        escrow.cancelPactByOwner(pactId);
        vm.prank(DAVE);
        escrow.finalizePact(pactId);

        vm.prank(ALICE);
        require(escrow.claim(pactId) == ONE_USDC, "owner cancel did not refund alice");
        vm.prank(BOB);
        require(escrow.claim(pactId) == ONE_USDC, "owner cancel did not refund bob");
    }

    function testIndependentPausesNeverBlockFinalizeOrClaim() public {
        escrow.setCreationPaused(true);
        require(!_tryCreate(ONE_USDC, 3, 1, 2, START, 1), "created while paused");
        escrow.setCreationPaused(false);

        uint256 pactId = _create(ONE_USDC, 3, 1, 2, START);
        escrow.setJoiningPaused(true);
        require(!_callAs(BOB, abi.encodeCall(escrow.joinPact, (pactId))), "joined while paused");
        escrow.setJoiningPaused(false);
        _join(pactId, BOB);

        vm.warp(START);
        escrow.setCheckInsPaused(true);
        require(!_callAs(ALICE, abi.encodeCall(escrow.checkIn, (pactId, uint8(0)))), "checked in while paused");

        escrow.setCreationPaused(true);
        escrow.setJoiningPaused(true);
        vm.warp(START + 3 days);
        vm.prank(CAROL);
        escrow.finalizePact(pactId);
        vm.prank(ALICE);
        require(escrow.claim(pactId) == ONE_USDC, "pause blocked alice refund");
        vm.prank(BOB);
        require(escrow.claim(pactId) == ONE_USDC, "pause blocked bob refund");
    }

    function testFinalizeIsPermissionlessAndCannotRunTwice() public {
        uint256 pactId = _create(ONE_USDC, 3, 1, 2, START);
        _join(pactId, BOB);
        vm.warp(START + 3 days);

        vm.prank(DAVE);
        escrow.finalizePact(pactId);
        require(!_callAs(DAVE, abi.encodeCall(escrow.finalizePact, (pactId))), "double finalization accepted");
        require(!_callAs(CAROL, abi.encodeCall(escrow.claim, (pactId))), "outsider claimed");
    }

    function testThirtyDayBitmapSupportsDayTwentyNine() public {
        uint256 pactId = _create(ONE_USDC, 30, 2, 2, START);
        _join(pactId, BOB);

        vm.warp(START);
        _checkIn(ALICE, pactId, 0);
        vm.warp(START + 29 days);
        _checkIn(ALICE, pactId, 29);

        uint256 bitmap = escrow.completionBitmap(pactId, ALICE);
        require(bitmap & 1 != 0, "day zero missing");
        require(bitmap & (uint256(1) << 29) != 0, "day twenty-nine missing");
        require(escrow.isFinisher(pactId, ALICE), "flexible target not met");
    }

    function _create(
        uint96 stake,
        uint8 durationDays,
        uint8 requiredCompletions,
        uint8 minParticipants,
        uint64 startsAt
    ) private returns (uint256 pactId) {
        uint8 missionType = escrow.MISSION_MONAD_CHECK_IN();
        vm.prank(ALICE);
        pactId = escrow.createPact(
            stake, durationDays, requiredCompletions, minParticipants, startsAt, missionType, CONFIG_HASH
        );
    }

    function _tryCreate(
        uint96 stake,
        uint8 durationDays,
        uint8 requiredCompletions,
        uint8 minParticipants,
        uint64 startsAt,
        uint8 missionType
    ) private returns (bool) {
        return _callAs(
            ALICE,
            abi.encodeCall(
                escrow.createPact,
                (stake, durationDays, requiredCompletions, minParticipants, startsAt, missionType, CONFIG_HASH)
            )
        );
    }

    function _join(uint256 pactId, address account) private {
        vm.prank(account);
        escrow.joinPact(pactId);
    }

    function _checkIn(address account, uint256 pactId, uint8 dayIndex) private returns (bytes32 nullifier) {
        vm.prank(account);
        nullifier = escrow.checkIn(pactId, dayIndex);
    }

    function _callAs(address account, bytes memory data) private returns (bool ok) {
        vm.prank(account);
        (ok,) = address(escrow).call(data);
    }

    function _fund(address account) private {
        _fundAmount(account, 10 * ONE_USDC);
    }

    function _fundAmount(address account, uint256 amount) private {
        token.mint(account, amount);
        vm.prank(account);
        token.approve(address(escrow), type(uint256).max);
    }
}
