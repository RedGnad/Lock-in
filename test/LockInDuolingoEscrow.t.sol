// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LockInDuolingoEscrow} from "../contracts/LockInDuolingoEscrow.sol";

interface VmDuo {
    function addr(uint256 privateKey) external returns (address);
    function expectRevert(bytes4 selector) external;
    function getBlockTimestamp() external view returns (uint256);
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 timestamp) external;
}

contract MockUsdcDuo is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function decimals() public pure override returns (uint8) { return 6; }
}

contract LockInDuolingoEscrowTest {
    VmDuo private constant VM = VmDuo(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant EVIDENCE_KEY = 0xE1D3;
    uint256 private constant WRONG_KEY = 0xBAD;
    uint256 private constant START = 1_800_000_000;
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    bytes32 private constant ALICE_ID = keccak256("duo:alice");
    bytes32 private constant BOB_ID = keccak256("duo:bob");

    uint96 private constant STAKE = 100_000; // 0.1 USDC
    uint32 private constant TARGET = 50;
    uint32 private constant DURATION = 1 hours;

    MockUsdcDuo private token;
    LockInDuolingoEscrow private escrow;
    uint256 private nonceSeed;

    function setUp() public {
        VM.warp(START - 30 minutes);
        token = new MockUsdcDuo();
        escrow = new LockInDuolingoEscrow(token, VM.addr(EVIDENCE_KEY));
        require(escrow.creationPaused() && escrow.joiningPaused() && escrow.completionPaused(), "not fail-closed");
        escrow.setCreationPaused(false);
        escrow.setJoiningPaused(false);
        escrow.setCompletionPaused(false);
        _fund(ALICE);
        _fund(BOB);
    }

    // --- the money path -------------------------------------------------------------------------------

    function testOnlyFinisherTakesTheWholePot() public {
        uint256 pactId = _createAndJoin();

        VM.warp(START + 10 minutes);
        _submitFinal(pactId, ALICE, ALICE_ID, TARGET, 60); // earned 60 >= 50
        require(escrow.isFinisher(pactId, ALICE), "A did not finish");
        require(!escrow.isFinisher(pactId, BOB), "B finished without proving");

        VM.warp(START + DURATION + escrow.SUBMISSION_GRACE_PERIOD() + 1);
        escrow.finalizePact(pactId);

        VM.prank(ALICE);
        require(escrow.claim(pactId) == uint256(STAKE) * 2, "A did not take both stakes");
        VM.expectRevert(LockInDuolingoEscrow.NotEligible.selector);
        VM.prank(BOB);
        escrow.claim(pactId);
    }

    function testStakeTiersAllSettle() public {
        for (uint96 i = 0; i < 3; ++i) {
            uint96 stake = [uint96(100_000), 500_000, 1_000_000][i];
            uint256 pactId = _createAndJoinWithStake(stake);
            VM.warp(START + 5 minutes);
            _submitFinal(pactId, ALICE, ALICE_ID, TARGET, TARGET);
            VM.warp(START + DURATION + escrow.SUBMISSION_GRACE_PERIOD() + 1);
            escrow.finalizePact(pactId);
            VM.prank(ALICE);
            require(escrow.claim(pactId) == uint256(stake) * 2, "tier payout wrong");
            VM.warp(START - 30 minutes); // reset the clock for the next round's create
        }
    }

    function testNobodyFinishesRefundsEveryone() public {
        uint256 pactId = _createAndJoin();
        VM.warp(START + DURATION + escrow.SUBMISSION_GRACE_PERIOD() + 1);
        escrow.finalizePact(pactId);
        VM.prank(ALICE);
        require(escrow.claim(pactId) == STAKE, "A not refunded own stake");
        VM.prank(BOB);
        require(escrow.claim(pactId) == STAKE, "B not refunded own stake");
    }

    // --- security invariants --------------------------------------------------------------------------

    function testExactTargetPassesAndShortfallFails() public {
        uint256 pactId = _createAndJoin();
        VM.warp(START + 5 minutes);
        LockInDuolingoEscrow.FinalEvidence memory short_ =
            _finalEvidence(pactId, ALICE, ALICE_ID, TARGET, TARGET - 1, uint64(START + 4 minutes), _nextNullifier(), EVIDENCE_KEY);
        VM.expectRevert(LockInDuolingoEscrow.TargetNotMet.selector);
        VM.prank(ALICE);
        escrow.submitFinal(pactId, short_);
        // A short final does not consume the participant; a later, sufficient one still works.
        _submitFinal(pactId, ALICE, ALICE_ID, TARGET, TARGET);
        require(escrow.isFinisher(pactId, ALICE), "retry after shortfall failed");
    }

    function testWrongSignerRejected() public {
        uint256 pactId = _createAndJoin();
        VM.warp(START + 5 minutes);
        LockInDuolingoEscrow.FinalEvidence memory e =
            _finalEvidence(pactId, ALICE, ALICE_ID, TARGET, 60, uint64(START + 4 minutes), _nextNullifier(), WRONG_KEY);
        VM.expectRevert(LockInDuolingoEscrow.InvalidEvidenceSigner.selector);
        VM.prank(ALICE);
        escrow.submitFinal(pactId, e);
    }

    function testFinalIdentityMustMatchBaseline() public {
        uint256 pactId = _createAndJoin();
        VM.warp(START + 5 minutes);
        LockInDuolingoEscrow.FinalEvidence memory e =
            _finalEvidence(pactId, ALICE, BOB_ID, TARGET, 60, uint64(START + 4 minutes), _nextNullifier(), EVIDENCE_KEY);
        VM.expectRevert(LockInDuolingoEscrow.IdentityMismatch.selector);
        VM.prank(ALICE);
        escrow.submitFinal(pactId, e);
    }

    function testOneProfileCannotBackTwoWallets() public {
        uint256 pactId = _create(ALICE, ALICE_ID, STAKE);
        // Bob tries to join the same Lock with Alice's Duolingo identity.
        bytes32 config = escrow.pactConfigHash(pactId);
        LockInDuolingoEscrow.BaselineEvidence memory b = _baseline(BOB, config, ALICE_ID, _nextNullifier(), EVIDENCE_KEY);
        VM.expectRevert(LockInDuolingoEscrow.IdentityAlreadyUsed.selector);
        VM.prank(BOB);
        escrow.joinPact(pactId, b);
    }

    function testBaselineNullifierCannotReplay() public {
        bytes32 nonce = keccak256("dup-nonce");
        bytes32 config = escrow.hashConfiguration(STAKE, TARGET, DURATION, 2, 2, uint64(START), nonce);
        bytes32 nullifier = keccak256("dup-baseline");
        LockInDuolingoEscrow.BaselineEvidence memory b = _baseline(ALICE, config, ALICE_ID, nullifier, EVIDENCE_KEY);
        VM.prank(ALICE);
        escrow.createPact(STAKE, TARGET, DURATION, 2, 2, uint64(START), nonce, b);
        // Reusing the same baseline nullifier on a second create must fail.
        LockInDuolingoEscrow.BaselineEvidence memory b2 = _baseline(ALICE, config, ALICE_ID, nullifier, EVIDENCE_KEY);
        VM.expectRevert(LockInDuolingoEscrow.NullifierAlreadyUsed.selector);
        VM.prank(ALICE);
        escrow.createPact(STAKE, TARGET, DURATION, 2, 2, uint64(START), nonce, b2);
    }

    function testFinalNullifierCannotReplayAcrossWallets() public {
        uint256 pactId = _createAndJoin();
        VM.warp(START + 5 minutes);
        bytes32 shared = keccak256("shared-final-nullifier");
        _submitFinalRaw2(pactId, ALICE, ALICE_ID, TARGET, 60, uint64(START + 4 minutes), shared, EVIDENCE_KEY);
        LockInDuolingoEscrow.FinalEvidence memory e =
            _finalEvidence(pactId, BOB, BOB_ID, TARGET, 60, uint64(START + 4 minutes), shared, EVIDENCE_KEY);
        VM.expectRevert(LockInDuolingoEscrow.NullifierAlreadyUsed.selector);
        VM.prank(BOB);
        escrow.submitFinal(pactId, e);
    }

    function testCannotCompleteTwice() public {
        uint256 pactId = _createAndJoin();
        VM.warp(START + 5 minutes);
        _submitFinal(pactId, ALICE, ALICE_ID, TARGET, 60);
        LockInDuolingoEscrow.FinalEvidence memory e =
            _finalEvidence(pactId, ALICE, ALICE_ID, TARGET, 70, uint64(START + 5 minutes), _nextNullifier(), EVIDENCE_KEY);
        VM.expectRevert(LockInDuolingoEscrow.AlreadyCompleted.selector);
        VM.prank(ALICE);
        escrow.submitFinal(pactId, e);
    }

    function testFinalOutsideWindowRejected() public {
        uint256 pactId = _createAndJoin();
        VM.warp(START + 5 minutes);
        // occurredAt before the challenge start
        LockInDuolingoEscrow.FinalEvidence memory e =
            _finalEvidence(pactId, ALICE, ALICE_ID, TARGET, 60, uint64(START - 1), _nextNullifier(), EVIDENCE_KEY);
        VM.expectRevert(LockInDuolingoEscrow.OutsideChallengeWindow.selector);
        VM.prank(ALICE);
        escrow.submitFinal(pactId, e);
    }

    function testFinalizeTooEarly() public {
        uint256 pactId = _createAndJoin();
        VM.warp(START + 5 minutes);
        _submitFinal(pactId, ALICE, ALICE_ID, TARGET, 60);
        VM.expectRevert(LockInDuolingoEscrow.FinalizationTooEarly.selector);
        escrow.finalizePact(pactId);
    }

    function testDoubleClaimRejected() public {
        uint256 pactId = _createAndJoin();
        VM.warp(START + 5 minutes);
        _submitFinal(pactId, ALICE, ALICE_ID, TARGET, 60);
        VM.warp(START + DURATION + escrow.SUBMISSION_GRACE_PERIOD() + 1);
        escrow.finalizePact(pactId);
        VM.prank(ALICE);
        escrow.claim(pactId);
        VM.expectRevert(LockInDuolingoEscrow.AlreadyClaimed.selector);
        VM.prank(ALICE);
        escrow.claim(pactId);
    }

    function testMaxStakeExceededRejected() public {
        bytes32 nonce = keccak256("max-stake-nonce");
        bytes32 config = escrow.hashConfiguration(2_000_000, TARGET, DURATION, 2, 2, uint64(START), nonce);
        LockInDuolingoEscrow.BaselineEvidence memory b = _baseline(ALICE, config, ALICE_ID, keccak256("x"), EVIDENCE_KEY);
        VM.expectRevert(LockInDuolingoEscrow.InvalidStake.selector);
        VM.prank(ALICE);
        escrow.createPact(2_000_000, TARGET, DURATION, 2, 2, uint64(START), nonce, b);
    }

    function testCreateRejectsForgedBaseline() public {
        bytes32 nonce = keccak256("forged-nonce");
        bytes32 config = escrow.hashConfiguration(STAKE, TARGET, DURATION, 2, 2, uint64(START), nonce);
        LockInDuolingoEscrow.BaselineEvidence memory b = _baseline(ALICE, config, ALICE_ID, keccak256("y"), WRONG_KEY);
        uint256 before = token.balanceOf(ALICE);
        VM.expectRevert(LockInDuolingoEscrow.InvalidEvidenceSigner.selector);
        VM.prank(ALICE);
        escrow.createPact(STAKE, TARGET, DURATION, 2, 2, uint64(START), nonce, b);
        require(token.balanceOf(ALICE) == before, "forged baseline still moved funds");
    }

    // --- createNonce binding ---------------------------------------------------------------------------

    function testZeroCreateNonceRejected() public {
        bytes32 config = escrow.hashConfiguration(STAKE, TARGET, DURATION, 2, 2, uint64(START), bytes32(0));
        LockInDuolingoEscrow.BaselineEvidence memory b = _baseline(ALICE, config, ALICE_ID, _nextNullifier(), EVIDENCE_KEY);
        VM.expectRevert(LockInDuolingoEscrow.InvalidCreateNonce.selector);
        VM.prank(ALICE);
        escrow.createPact(STAKE, TARGET, DURATION, 2, 2, uint64(START), bytes32(0), b);
    }

    function testNonceMakesIdenticalTermsDistinct() public view {
        bytes32 configA = escrow.hashConfiguration(STAKE, TARGET, DURATION, 2, 2, uint64(START), keccak256("A"));
        bytes32 configB = escrow.hashConfiguration(STAKE, TARGET, DURATION, 2, 2, uint64(START), keccak256("B"));
        require(configA != configB, "same terms, different nonce collided");
    }

    // A baseline signed for nonce A cannot be spent on a create that declares nonce B: the contract
    // recomputes the configHash from the submitted nonce and the bound configHash no longer matches.
    function testBaselineForOtherNonceRejected() public {
        bytes32 nonceA = keccak256("nonce-A");
        bytes32 configA = escrow.hashConfiguration(STAKE, TARGET, DURATION, 2, 2, uint64(START), nonceA);
        LockInDuolingoEscrow.BaselineEvidence memory b = _baseline(ALICE, configA, ALICE_ID, _nextNullifier(), EVIDENCE_KEY);
        VM.expectRevert(LockInDuolingoEscrow.InvalidConfigurationHash.selector);
        VM.prank(ALICE);
        escrow.createPact(STAKE, TARGET, DURATION, 2, 2, uint64(START), keccak256("nonce-B"), b);
    }

    // A baseline bound to one pact's configHash cannot join a second, identical-terms pact: its stored
    // configHash carries a different creator nonce.
    function testJoinBaselineBoundToOnePact() public {
        uint256 pactOne = _create(ALICE, ALICE_ID, STAKE);
        // A second, identical-terms Lock by the same creator gets a different nonce, so a different config.
        uint256 pactTwo = _create(ALICE, ALICE_ID, STAKE);
        bytes32 configOne = escrow.pactConfigHash(pactOne);
        LockInDuolingoEscrow.BaselineEvidence memory b = _baseline(BOB, configOne, BOB_ID, _nextNullifier(), EVIDENCE_KEY);
        VM.expectRevert(LockInDuolingoEscrow.InvalidConfigurationHash.selector);
        VM.prank(BOB);
        escrow.joinPact(pactTwo, b);
    }

    function testPauseDuringLiveLockRefundsEveryone() public {
        uint256 pactId = _createAndJoin();
        VM.warp(START + 5 minutes);
        _submitFinal(pactId, ALICE, ALICE_ID, TARGET, 60);
        escrow.setCompletionPaused(true); // overlaps the live Lock
        VM.warp(START + DURATION + escrow.SUBMISSION_GRACE_PERIOD() + 1);
        escrow.finalizePact(pactId);
        LockInDuolingoEscrow.DuoPact memory p = escrow.getPact(pactId);
        require(p.finalized && p.cancelled, "pause did not cancel");
        VM.prank(ALICE);
        require(escrow.claim(pactId) == STAKE, "finisher not refunded own stake");
        VM.prank(BOB);
        require(escrow.claim(pactId) == STAKE, "B not refunded");
    }

    // --- helpers --------------------------------------------------------------------------------------

    function _fund(address who) private {
        token.mint(who, 10_000_000);
        VM.prank(who);
        token.approve(address(escrow), type(uint256).max);
    }

    function _nextNullifier() private returns (bytes32) {
        return keccak256(abi.encode("n", ++nonceSeed));
    }

    function _createAndJoin() private returns (uint256 pactId) {
        return _createAndJoinWithStake(STAKE);
    }

    function _createAndJoinWithStake(uint96 stake) private returns (uint256 pactId) {
        pactId = _create(ALICE, ALICE_ID, stake);
        _joinRaw(pactId, BOB, BOB_ID, stake, EVIDENCE_KEY);
    }

    function _create(address who, bytes32 identity, uint96 stake) private returns (uint256 pactId) {
        bytes32 nonce = keccak256(abi.encode("create-nonce", ++nonceSeed));
        bytes32 config = escrow.hashConfiguration(stake, TARGET, DURATION, 2, 2, uint64(START), nonce);
        LockInDuolingoEscrow.BaselineEvidence memory b = _baseline(who, config, identity, _nextNullifier(), EVIDENCE_KEY);
        VM.prank(who);
        pactId = escrow.createPact(stake, TARGET, DURATION, 2, 2, uint64(START), nonce, b);
    }

    // The joiner binds to the pact's STORED configHash, which already carries the creator's nonce.
    function _joinRaw(uint256 pactId, address who, bytes32 identity, uint96 stake, uint256 key) private {
        bytes32 config = escrow.pactConfigHash(pactId);
        LockInDuolingoEscrow.BaselineEvidence memory b = _baseline(who, config, identity, _nextNullifier(), key);
        VM.prank(who);
        escrow.joinPact(pactId, b);
    }

    function _finalEvidence(
        uint256 pactId, address who, bytes32 identity, uint32 target, uint32 earned, uint64 occurredAt, bytes32 nullifier, uint256 key
    ) private returns (LockInDuolingoEscrow.FinalEvidence memory e) {
        uint64 issuedAt = uint64(VM.getBlockTimestamp());
        e = LockInDuolingoEscrow.FinalEvidence({
            identityHash: identity,
            earnedXp: earned,
            targetXp: target,
            nullifier: nullifier,
            occurredAt: occurredAt,
            issuedAt: issuedAt,
            expiresAt: issuedAt + 5 minutes,
            signature: ""
        });
        bytes32 structHash = keccak256(
            abi.encode(escrow.FINAL_TYPEHASH(), pactId, who, e.identityHash, e.earnedXp, e.targetXp, e.nullifier, e.occurredAt, e.issuedAt, e.expiresAt)
        );
        e.signature = _sign(key, structHash);
    }

    function _submitFinal(uint256 pactId, address who, bytes32 identity, uint32 target, uint32 earned) private {
        _submitFinalRaw(pactId, who, identity, target, earned, uint64(VM.getBlockTimestamp()), EVIDENCE_KEY);
    }

    function _submitFinalRaw(uint256 pactId, address who, bytes32 identity, uint32 target, uint32 earned, uint64 occurredAt, uint256 key) private {
        _submitFinalRaw2(pactId, who, identity, target, earned, occurredAt, _nextNullifier(), key);
    }

    function _submitFinalRaw2(
        uint256 pactId, address who, bytes32 identity, uint32 target, uint32 earned, uint64 occurredAt, bytes32 nullifier, uint256 key
    ) private {
        LockInDuolingoEscrow.FinalEvidence memory e = _finalEvidence(pactId, who, identity, target, earned, occurredAt, nullifier, key);
        VM.prank(who);
        escrow.submitFinal(pactId, e);
    }

    function _baseline(address who, bytes32 config, bytes32 identity, bytes32 nullifier, uint256 key)
        private
        returns (LockInDuolingoEscrow.BaselineEvidence memory b)
    {
        uint64 issuedAt = uint64(VM.getBlockTimestamp());
        b = LockInDuolingoEscrow.BaselineEvidence({
            configHash: config,
            identityHash: identity,
            nullifier: nullifier,
            issuedAt: issuedAt,
            expiresAt: issuedAt + 5 minutes,
            signature: ""
        });
        bytes32 structHash = keccak256(abi.encode(escrow.BASELINE_TYPEHASH(), who, config, identity, nullifier, b.issuedAt, b.expiresAt));
        b.signature = _sign(key, structHash);
    }

    function _sign(uint256 key, bytes32 structHash) private returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Lock In Duolingo"),
                keccak256("1"),
                block.chainid,
                address(escrow)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
