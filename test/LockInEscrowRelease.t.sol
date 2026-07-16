// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LockInEscrow} from "../contracts/LockInEscrow.sol";

interface VmRelease {
    function addr(uint256 privateKey) external returns (address);
    function getBlockTimestamp() external view returns (uint256);
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 timestamp) external;
}

contract MockUsdcRelease is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

contract FeeOnTransferUsdcRelease is MockUsdcRelease {
    function _transfer(address from, address to, uint256 amount) internal override {
        super._transfer(from, to, amount - 1);
        _burn(from, 1);
    }
}

contract LockInEscrowReleaseTest {
    VmRelease private constant VM = VmRelease(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant ONE_USDC = 1_000_000;
    uint256 private constant EVIDENCE_KEY = 0xE11D3CE;
    uint256 private constant ACCESS_KEY = 0xACC355;
    uint256 private constant WRONG_KEY = 0xBAD;
    uint256 private constant START = 1_784_073_600;
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA401);
    bytes32 private constant ALICE_DUO = keccak256("duolingo:alice");
    bytes32 private constant BOB_DUO = keccak256("duolingo:bob");

    MockUsdcRelease private token;
    LockInEscrow private escrow;

    function setUp() public {
        VM.warp(START - 1 hours);
        token = new MockUsdcRelease();
        escrow = new LockInEscrow(token, VM.addr(EVIDENCE_KEY), VM.addr(ACCESS_KEY));
        require(escrow.CONTRACT_SCHEMA_ID() == 1, "unexpected contract schema");
        require(
            escrow.creationPaused() && escrow.joiningPaused() && escrow.completionPaused(),
            "constructor not fail closed"
        );
        escrow.setCreationPaused(false);
        escrow.setJoiningPaused(false);
        escrow.setCompletionPaused(false);
        _fund(ALICE);
        _fund(BOB);
        _fund(CAROL);
    }

    function testAdmissionIsRequiredBoundAndSingleUse() public {
        LockInEscrow.AccessEvidence memory emptyAccess;
        uint256 beforeBalance = token.balanceOf(ALICE);
        VM.prank(ALICE);
        (bool missing,) = address(escrow)
            .call(
                abi.encodeCall(
                    escrow.createPact,
                    (
                        uint96(ONE_USDC),
                        1_000,
                        3,
                        2,
                        2,
                        4,
                        uint64(START),
                        uint8(1),
                        emptyAccess
                    )
                )
            );
        require(!missing && token.balanceOf(ALICE) == beforeBalance, "missing admission moved funds");

        LockInEscrow.AccessEvidence memory wrongAccount =
            _access(BOB, escrow.ACCESS_CREATE(), 0, keccak256("wrong-account"), ACCESS_KEY);
        VM.prank(ALICE);
        (bool impersonated,) = address(escrow)
            .call(
                abi.encodeCall(
                    escrow.createPact,
                    (
                        uint96(ONE_USDC),
                        1_000,
                        3,
                        2,
                        2,
                        4,
                        uint64(START),
                        uint8(1),
                        wrongAccount
                    )
                )
            );
        require(!impersonated, "admission was not wallet bound");

        LockInEscrow.AccessEvidence memory pass =
            _access(ALICE, escrow.ACCESS_CREATE(), 0, keccak256("single-use"), ACCESS_KEY);
        VM.prank(ALICE);
        escrow.createPact(uint96(ONE_USDC), 1_000, 3, 2, 2, 4, uint64(START), 1, pass);
        VM.prank(ALICE);
        (bool replayed,) = address(escrow)
            .call(
                abi.encodeCall(
                    escrow.createPact,
                    (uint96(ONE_USDC), 1_000, 3, 2, 2, 4, uint64(START), uint8(1), pass)
                )
            );
        require(!replayed, "admission nonce replayed");
    }

    function testWrongAccessSignerAndActionAreRejected() public {
        LockInEscrow.AccessEvidence memory wrongSigner =
            _access(ALICE, escrow.ACCESS_CREATE(), 0, keccak256("wrong-signer"), WRONG_KEY);
        VM.prank(ALICE);
        (bool signedWrong,) = address(escrow)
            .call(
                abi.encodeCall(
                    escrow.createPact,
                    (uint96(ONE_USDC), 1_000, 3, 2, 2, 4, uint64(START), uint8(1), wrongSigner)
                )
            );
        require(!signedWrong, "wrong access signer accepted");

        LockInEscrow.AccessEvidence memory joinPass =
            _access(ALICE, escrow.ACCESS_JOIN(), 0, keccak256("wrong-action"), ACCESS_KEY);
        VM.prank(ALICE);
        (bool wrongAction,) = address(escrow)
            .call(
                abi.encodeCall(
                    escrow.createPact,
                    (uint96(ONE_USDC), 1_000, 3, 2, 2, 4, uint64(START), uint8(1), joinPass)
                )
            );
        require(!wrongAction, "wrong access action accepted");
    }

    function testPactCapacityIsImmutableAndEnforced() public {
        uint256 pactId = _createStrava(2, keccak256("capacity-create"));
        _joinStrava(pactId, BOB, keccak256("capacity-bob"));
        LockInEscrow.AccessEvidence memory pass =
            _access(CAROL, escrow.ACCESS_JOIN(), pactId, keccak256("capacity-carol"), ACCESS_KEY);
        uint256 beforeBalance = token.balanceOf(CAROL);
        VM.prank(CAROL);
        (bool joinedFull,) = address(escrow).call(abi.encodeCall(escrow.joinPact, (pactId, pass)));
        require(!joinedFull && token.balanceOf(CAROL) == beforeBalance, "full pact accepted funds");
        LockInEscrow.Pact memory pact = escrow.getPact(pactId);
        require(pact.maxParticipants == 2 && pact.participantCount == 2, "capacity changed");
    }

    function testCompletionSucceedsAndGlobalNullifierCannotReplay() public {
        uint256 pactId = _createStrava(2, keccak256("hybrid-success-create"));
        _joinStrava(pactId, BOB, keccak256("hybrid-success-join"));
        VM.warp(START + 1 hours);
        LockInEscrow.CompletionEvidence memory evidence = _completionEvidence(
            escrow,
            pactId,
            ALICE,
            0,
            1,
            keccak256("strava:alice"),
            keccak256("hybrid-replay"),
            1_200,
            uint64(START + 1 hours),
            uint64(START + 1 hours),
            uint64(START + 1 hours + 5 minutes),
            EVIDENCE_KEY
        );
        VM.prank(ALICE);
        escrow.submitCompletion(pactId, 0, evidence);
        require(escrow.completionCount(pactId, ALICE) == 1, "completion was not accepted");

        VM.prank(BOB);
        (bool replayOk, bytes memory replayData) =
            address(escrow).call(abi.encodeCall(escrow.submitCompletion, (pactId, 0, evidence)));
        _requireSelector(replayOk, replayData, LockInEscrow.EventAlreadyUsed.selector);
    }

    /// @dev Documents the trust model this contract actually has, so nobody has to infer it from an absence.
    ///      Under STRAVA_OAUTH_V1 the backend reads the run from Strava's API and attests it: there is no
    ///      second, independent on-chain witness. The evidence signer's signature is therefore SUFFICIENT to
    ///      complete a day, and a compromised evidence key can mint completions. The zkTLS path this
    ///      replaced required both a witness proof and this signature, so neither alone was enough. That
    ///      property is gone, deliberately, and these assertions are what keeps the change visible.
    function testCompletionRestsOnTheBackendSignatureAlone() public {
        uint256 pactId = _createStrava(2, keccak256("signature-alone-create"));
        _joinStrava(pactId, BOB, keccak256("signature-alone-join"));
        VM.warp(START + 1 hours);

        // Nothing but a signed attestation: no proof bundle exists to accompany it any more.
        LockInEscrow.CompletionEvidence memory signed = _completionEvidence(
            escrow, pactId, ALICE, 0, 1, keccak256("strava:alice"), keccak256("signature-alone"), 1_200,
            uint64(START + 1 hours), uint64(START + 1 hours), uint64(START + 1 hours + 5 minutes), EVIDENCE_KEY
        );
        VM.prank(ALICE);
        escrow.submitCompletion(pactId, 0, signed);
        require(escrow.completionCount(pactId, ALICE) == 1, "a signed attestation alone must complete the day");

        // The signature is the ONLY thing standing between an attacker and a completion, so the contract
        // must reject anything not signed by the configured evidence signer.
        LockInEscrow.CompletionEvidence memory forged = _completionEvidence(
            escrow, pactId, BOB, 0, 1, keccak256("strava:bob"), keccak256("signature-alone-forged"), 1_200,
            uint64(START + 1 hours), uint64(START + 1 hours), uint64(START + 1 hours + 5 minutes), ACCESS_KEY
        );
        VM.prank(BOB);
        (bool ok, bytes memory data) =
            address(escrow).call(abi.encodeCall(escrow.submitCompletion, (pactId, 0, forged)));
        _requireSelector(ok, data, LockInEscrow.InvalidEvidenceSigner.selector);
        require(escrow.completionCount(pactId, BOB) == 0, "an unsigned attestation completed a day");
    }

    function testSharedStravaIdentitySettlesBothLocksButScoresOnlyFirstWallet() public {
        bytes32 sharedIdentity = keccak256("strava:shared-athlete");
        uint256 aliceLock =
            _createStravaTerms(uint96(ONE_USDC), 3, 1, 2, 2, uint64(START), keccak256("shared-identity-alice-lock"));
        uint256 bobLock =
            _createStravaTerms(uint96(ONE_USDC), 3, 1, 2, 2, uint64(START), keccak256("shared-identity-bob-lock"));
        _joinStrava(aliceLock, BOB, keccak256("shared-identity-alice-lock-join"));
        _joinStrava(bobLock, BOB, keccak256("shared-identity-bob-lock-join"));

        VM.warp(START + 1 hours);
        _submit(
            ALICE, aliceLock, 0, 1, sharedIdentity, keccak256("shared-identity-alice-activity"), 1_200, START + 1 hours
        );
        _submit(BOB, bobLock, 0, 1, sharedIdentity, keccak256("shared-identity-bob-activity"), 1_300, START + 1 hours);

        require(escrow.completionCount(aliceLock, ALICE) == 1, "first wallet completion was rejected");
        require(escrow.completionCount(bobLock, BOB) == 1, "second wallet completion was rejected");
        require(escrow.isFinisher(aliceLock, ALICE), "first wallet did not finish its Lock");
        require(escrow.isFinisher(bobLock, BOB), "second wallet did not finish its Lock");
        require(escrow.missionIdentityOwner(1, sharedIdentity) == ALICE, "identity owner was not first wallet");
        require(escrow.lockScore(ALICE) == 10 && escrow.verifiedDays(ALICE) == 1, "first wallet was not scored");
        require(escrow.missionVerifiedDays(ALICE, 1) == 1, "first wallet mission day was not scored");
        require(
            escrow.lockScore(BOB) == 0 && escrow.verifiedDays(BOB) == 0 && escrow.missionVerifiedDays(BOB, 1) == 0,
            "second wallet farmed the shared identity"
        );

        VM.warp(START + 4 days);
        escrow.finalizePact(aliceLock);
        escrow.finalizePact(bobLock);
        VM.prank(ALICE);
        require(escrow.claim(aliceLock) == 2 * ONE_USDC, "first Lock payout changed");
        VM.prank(BOB);
        require(escrow.claim(bobLock) == 2 * ONE_USDC, "second Lock payout changed");
    }

    function testPlayerHandlesAreOptionalCanonicalAndUnique() public {
        VM.prank(ALICE);
        escrow.setPlayerHandle("red_g");
        require(keccak256(bytes(escrow.playerHandle(ALICE))) == keccak256("red_g"), "handle not stored");
        require(escrow.handleOwner(keccak256("red_g")) == ALICE, "handle owner not stored");

        VM.prank(BOB);
        (bool duplicate, bytes memory duplicateData) =
            address(escrow).call(abi.encodeCall(escrow.setPlayerHandle, ("red_g")));
        _requireSelector(duplicate, duplicateData, LockInEscrow.HandleAlreadyUsed.selector);

        for (uint256 i; i < 3; ++i) {
            string memory invalid = i == 0 ? "ab" : i == 1 ? "RedG" : "red-g";
            VM.prank(BOB);
            (bool accepted, bytes memory data) = address(escrow).call(abi.encodeCall(escrow.setPlayerHandle, (invalid)));
            _requireSelector(accepted, data, LockInEscrow.InvalidHandle.selector);
        }

        VM.prank(ALICE);
        escrow.setPlayerHandle("redgnad");
        require(escrow.handleOwner(keccak256("red_g")) == address(0), "old handle was not released");
    }

    function testPlayerHandleCanBeClearedAndReused() public {
        bytes32 handleKey = keccak256("red_g");
        VM.prank(ALICE);
        escrow.setPlayerHandle("red_g");

        VM.prank(ALICE);
        escrow.clearPlayerHandle();
        require(bytes(escrow.playerHandle(ALICE)).length == 0, "cleared handle remained on player");
        require(escrow.handleOwner(handleKey) == address(0), "cleared handle remained reserved");

        VM.prank(BOB);
        escrow.setPlayerHandle("red_g");
        require(keccak256(bytes(escrow.playerHandle(BOB))) == handleKey, "released handle was not reusable");
        require(escrow.handleOwner(handleKey) == BOB, "reused handle has wrong owner");

        VM.prank(ALICE);
        escrow.clearPlayerHandle();
        require(escrow.handleOwner(handleKey) == BOB, "empty clear released another player's handle");
    }

    function testOnlyOwnerCanTogglePlayerProfileVisibility() public {
        VM.prank(ALICE);
        (bool outsider,) = address(escrow).call(abi.encodeCall(escrow.setPlayerProfileHidden, (BOB, true)));
        require(!outsider, "non-owner changed profile visibility");
        require(!escrow.playerProfileHidden(BOB), "failed outsider call changed visibility");

        escrow.setPlayerProfileHidden(BOB, true);
        require(escrow.playerProfileHidden(BOB), "owner did not hide profile");
        escrow.setPlayerProfileHidden(BOB, false);
        require(!escrow.playerProfileHidden(BOB), "owner did not unhide profile");

        (bool zeroAccount, bytes memory zeroData) =
            address(escrow).call(abi.encodeCall(escrow.setPlayerProfileHidden, (address(0), true)));
        _requireSelector(zeroAccount, zeroData, LockInEscrow.InvalidAddress.selector);
    }

    function testHighFivesRequireVerifiedCrewAndNeverChangeScore() public {
        uint256 pactId = _createStrava(2, keccak256("high-five-create"));
        _joinStrava(pactId, BOB, keccak256("high-five-join"));
        VM.warp(START + 1 hours);
        _submit(ALICE, pactId, 0, 1, keccak256("strava:alice"), keccak256("high-five-run"), 1_200, START + 1 hours);
        uint64 scoreBefore = escrow.lockScore(ALICE);
        VM.prank(BOB);
        escrow.highFive(pactId, ALICE, 0);
        require(escrow.lockScore(ALICE) == scoreBefore && escrow.lockScore(BOB) == 0, "reaction changed score");

        VM.prank(BOB);
        (bool repeated, bytes memory repeatedData) =
            address(escrow).call(abi.encodeCall(escrow.highFive, (pactId, ALICE, 0)));
        _requireSelector(repeated, repeatedData, LockInEscrow.HighFiveAlreadySent.selector);

        VM.prank(CAROL);
        (bool outsider, bytes memory outsiderData) =
            address(escrow).call(abi.encodeCall(escrow.highFive, (pactId, ALICE, 0)));
        _requireSelector(outsider, outsiderData, LockInEscrow.InvalidHighFive.selector);
    }

    function testStravaFinisherReceivesQuitterStake() public {
        uint256 pactId = _createStrava(2, keccak256("pvp-create"));
        _joinStrava(pactId, BOB, keccak256("pvp-join"));
        VM.warp(START + 1 hours);
        _submit(ALICE, pactId, 0, 1, keccak256("strava:alice"), keccak256("run-a-0"), 1_200, START + 1 hours);
        VM.warp(START + 1 days + 1 hours);
        _submit(ALICE, pactId, 1, 1, keccak256("strava:alice"), keccak256("run-a-1"), 1_300, START + 1 days + 1 hours);
        VM.warp(START + 4 days);
        escrow.finalizePact(pactId);
        VM.prank(ALICE);
        require(escrow.claim(pactId) == 2 * ONE_USDC, "winner did not receive pool");
        VM.prank(BOB);
        (bool quitterClaimed,) = address(escrow).call(abi.encodeCall(escrow.claim, (pactId)));
        require(!quitterClaimed, "quitter claimed");
    }

    function testUnderfilledPactRefundsAndPausesNeverBlockExit() public {
        uint256 pactId = _createStrava(2, keccak256("underfilled"));
        escrow.setCreationPaused(true);
        escrow.setJoiningPaused(true);
        escrow.setCompletionPaused(true);
        VM.warp(START);
        escrow.finalizePact(pactId);
        VM.prank(ALICE);
        require(escrow.claim(pactId) == ONE_USDC, "underfilled refund blocked");
    }

    function testAccessPassCommitsToEveryPactConfigurationField() public {
        LockInEscrow.AccessEvidence memory access =
            _access(ALICE, escrow.ACCESS_CREATE(), 0, keccak256("bound-config"), ACCESS_KEY);
        uint256 balanceBefore = token.balanceOf(ALICE);

        VM.prank(ALICE);
        (bool ok, bytes memory data) = address(escrow)
            .call(
                abi.encodeCall(
                    escrow.createPact,
                    (uint96(ONE_USDC), 1_000, 3, 2, 2, 5, uint64(START), uint8(1), access)
                )
            );
        _requireSelector(ok, data, LockInEscrow.InvalidConfigurationHash.selector);
        require(token.balanceOf(ALICE) == balanceBefore, "tampered configuration moved funds");
        require(!escrow.usedAccessNonces(access.nonce), "failed pass consumed nonce");
    }

    function testActivityDayIsStrictButSubmissionGetsFullGraceWindow() public {
        uint256 pactId = _createStrava(2, keccak256("grace-create"));
        _joinStrava(pactId, BOB, keccak256("grace-join"));

        VM.warp(START + 1 days);
        (bool boundaryOk, bytes memory boundaryData) = _trySubmit(
            ALICE, pactId, 0, 1, keccak256("strava:alice"), keccak256("activity-next-day"), 1_200, START + 1 days
        );
        _requireSelector(boundaryOk, boundaryData, LockInEscrow.CompletionOutsideDay.selector);

        _submit(ALICE, pactId, 0, 1, keccak256("strava:alice"), keccak256("submitted-in-grace"), 1_200, START + 1 hours);

        VM.warp(START + 2 days);
        (bool closedOk, bytes memory closedData) = _trySubmit(
            BOB, pactId, 0, 1, keccak256("strava:bob"), keccak256("grace-is-exclusive"), 1_200, START + 2 hours
        );
        _requireSelector(closedOk, closedData, LockInEscrow.CompletionOutsideDay.selector);

        VM.warp(START + 4 days - 1);
        (bool early, bytes memory earlyData) = address(escrow).call(abi.encodeCall(escrow.finalizePact, (pactId)));
        _requireSelector(early, earlyData, LockInEscrow.FinalizationTooEarly.selector);
        VM.warp(START + 4 days);
        escrow.finalizePact(pactId);
    }

    function testAttestationsHaveHardIssuanceAgeAndExpiryBounds() public {
        bytes32 configHash = escrow.hashPactConfiguration(uint96(ONE_USDC), 1_000, 3, 2, 2, 4, uint64(START), 1);
        LockInEscrow.AccessEvidence memory staleAccess = _accessAt(
            escrow,
            ALICE,
            escrow.ACCESS_CREATE(),
            0,
            configHash,
            keccak256("stale-access"),
            uint64(block.timestamp - 11 minutes),
            uint64(block.timestamp + 1 minutes),
            ACCESS_KEY
        );
        VM.prank(ALICE);
        (bool staleOk, bytes memory staleData) = address(escrow)
            .call(
                abi.encodeCall(
                    escrow.createPact,
                    (uint96(ONE_USDC), 1_000, 3, 2, 2, 4, uint64(START), uint8(1), staleAccess)
                )
            );
        _requireSelector(staleOk, staleData, LockInEscrow.InvalidAttestationWindow.selector);

        uint256 pactId = _createStrava(2, keccak256("fresh-create"));
        _joinStrava(pactId, BOB, keccak256("fresh-join"));
        VM.warp(START + 1 hours);
        LockInEscrow.CompletionEvidence memory expired = _completionEvidence(
            escrow,
            pactId,
            ALICE,
            0,
            1,
            keccak256("strava:alice"),
            keccak256("expired-proof"),
            1_200,
            uint64(block.timestamp),
            uint64(block.timestamp - 5 minutes),
            uint64(block.timestamp - 1),
            EVIDENCE_KEY
        );
        VM.prank(ALICE);
        (bool expiredOk, bytes memory expiredData) =
            address(escrow).call(abi.encodeCall(escrow.submitCompletion, (pactId, 0, expired)));
        _requireSelector(expiredOk, expiredData, LockInEscrow.AttestationExpired.selector);
    }

    function testOperatorCompletionPauseForcesEqualRefunds() public {
        uint256 pactId = _createStrava(2, keccak256("pause-refund-create"));
        _joinStrava(pactId, BOB, keccak256("pause-refund-join"));
        VM.warp(START + 1 hours);
        escrow.setCompletionPaused(true);
        escrow.setCompletionPaused(false);

        VM.warp(START + 4 days);
        escrow.finalizePact(pactId);
        LockInEscrow.Pact memory pact = escrow.getPact(pactId);
        require(pact.cancelled, "affected pact remained competitive");

        VM.prank(ALICE);
        uint256 aliceRefund = escrow.claim(pactId);
        VM.prank(BOB);
        uint256 bobRefund = escrow.claim(pactId);
        require(aliceRefund == ONE_USDC && bobRefund == ONE_USDC, "pause refund was unequal");
        require(token.balanceOf(address(escrow)) == 0, "pause refund stranded funds");
    }

    function testPreStartPauseDoesNotCondemnPactCreatedDuringPause() public {
        escrow.setCompletionPaused(true);
        uint256 pactId = _createStrava(2, keccak256("pre-start-pause-create"));
        _joinStrava(pactId, BOB, keccak256("pre-start-pause-join"));

        VM.warp(START - 1);
        escrow.setCompletionPaused(false);
        VM.warp(START + 1 hours);
        _submit(ALICE, pactId, 0, 1, keccak256("strava:alice"), keccak256("pre-start-pause-a0"), 1_200, START + 1 hours);
        VM.warp(START + 1 days + 1 hours);
        _submit(
            ALICE,
            pactId,
            1,
            1,
            keccak256("strava:alice"),
            keccak256("pre-start-pause-a1"),
            1_200,
            START + 1 days + 1 hours
        );

        VM.warp(START + 4 days);
        escrow.finalizePact(pactId);
        require(!escrow.getPact(pactId).cancelled, "pre-start-only pause forced refunds");
        VM.prank(ALICE);
        require(escrow.claim(pactId) == 2 * ONE_USDC, "competitive result was not preserved");
    }

    function testPauseAtSubmissionDeadlineCannotEraseAValidWinner() public {
        uint256 pactId = _createStrava(2, keccak256("late-pause-create"));
        _joinStrava(pactId, BOB, keccak256("late-pause-join"));
        VM.warp(START + 1 hours);
        _submit(ALICE, pactId, 0, 1, keccak256("strava:alice"), keccak256("late-pause-a0"), 1_200, START + 1 hours);
        VM.warp(START + 1 days + 1 hours);
        _submit(
            ALICE, pactId, 1, 1, keccak256("strava:alice"), keccak256("late-pause-a1"), 1_200, START + 1 days + 1 hours
        );

        VM.warp(START + 4 days);
        escrow.setCompletionPaused(true);
        escrow.finalizePact(pactId);
        require(!escrow.getPact(pactId).cancelled, "late pause rewrote settled outcome");
        VM.prank(ALICE);
        require(escrow.claim(pactId) == 2 * ONE_USDC, "valid winner lost pool");
    }

    function testMultiWinnerRoundingConservesEveryTokenUnit() public {
        uint96 oddStake = 100_001;
        uint256 pactId = _createStravaTerms(oddStake, 3, 2, 2, 3, uint64(START), keccak256("round-create"));
        _joinStrava(pactId, BOB, keccak256("round-bob"));
        _joinStrava(pactId, CAROL, keccak256("round-carol"));
        VM.warp(START + 1 hours);
        _submit(ALICE, pactId, 0, 1, keccak256("strava:alice"), keccak256("round-a0"), 1_200, START + 1 hours);
        _submit(BOB, pactId, 0, 1, keccak256("strava:bob"), keccak256("round-b0"), 1_200, START + 1 hours);
        VM.warp(START + 1 days + 1 hours);
        _submit(ALICE, pactId, 1, 1, keccak256("strava:alice"), keccak256("round-a1"), 1_200, START + 1 days + 1 hours);
        _submit(BOB, pactId, 1, 1, keccak256("strava:bob"), keccak256("round-b1"), 1_200, START + 1 days + 1 hours);

        VM.warp(START + 4 days);
        escrow.finalizePact(pactId);
        VM.prank(ALICE);
        uint256 first = escrow.claim(pactId);
        VM.prank(BOB);
        uint256 second = escrow.claim(pactId);
        require(first == 150_001 && second == 150_002, "rounding policy changed");
        require(first + second == uint256(oddStake) * 3, "payout conservation failed");
        require(token.balanceOf(address(escrow)) == 0, "rounding dust stranded");
    }

    function testCrossPactAndCrossDomainReplaysFail() public {
        uint256 firstPact = _createStrava(4, keccak256("replay-first"));
        uint256 secondPact = _createStrava(4, keccak256("replay-second"));
        LockInEscrow.AccessEvidence memory firstJoin =
            _access(BOB, escrow.ACCESS_JOIN(), firstPact, keccak256("cross-pact-join"), ACCESS_KEY);
        VM.prank(BOB);
        (bool joinOk, bytes memory joinData) =
            address(escrow).call(abi.encodeCall(escrow.joinPact, (secondPact, firstJoin)));
        _requireSelector(joinOk, joinData, LockInEscrow.InvalidAccessSigner.selector);
        VM.prank(BOB);
        escrow.joinPact(firstPact, firstJoin);
        _joinStrava(secondPact, BOB, keccak256("second-join"));

        VM.warp(START + 1 hours);
        LockInEscrow.CompletionEvidence memory firstProof = _completionEvidence(
            escrow,
            firstPact,
            ALICE,
            0,
            1,
            keccak256("strava:alice"),
            keccak256("cross-pact-proof"),
            1_200,
            uint64(block.timestamp),
            uint64(block.timestamp),
            uint64(block.timestamp + 5 minutes),
            EVIDENCE_KEY
        );
        VM.prank(ALICE);
        (bool proofOk, bytes memory proofData) =
            address(escrow).call(abi.encodeCall(escrow.submitCompletion, (secondPact, 0, firstProof)));
        _requireSelector(proofOk, proofData, LockInEscrow.InvalidEvidenceSigner.selector);

        LockInEscrow other =
            new LockInEscrow(token, VM.addr(EVIDENCE_KEY), VM.addr(ACCESS_KEY));
        other.setCreationPaused(false);
        bytes32 configHash =
            other.hashPactConfiguration(uint96(ONE_USDC), 1_000, 3, 2, 2, 4, uint64(START + 2 hours), 1);
        LockInEscrow.AccessEvidence memory wrongDomain = _accessAt(
            escrow,
            ALICE,
            escrow.ACCESS_CREATE(),
            0,
            configHash,
            keccak256("cross-domain"),
            uint64(block.timestamp),
            uint64(block.timestamp + 5 minutes),
            ACCESS_KEY
        );
        VM.prank(ALICE);
        token.approve(address(other), type(uint256).max);
        VM.prank(ALICE);
        (bool domainOk, bytes memory domainData) = address(other)
            .call(
                abi.encodeCall(
                    other.createPact,
                    (
                        uint96(ONE_USDC),
                        1_000,
                        3,
                        2,
                        2,
                        4,
                        uint64(START + 2 hours),
                        uint8(1),
                        wrongDomain
                    )
                )
            );
        _requireSelector(domainOk, domainData, LockInEscrow.InvalidAccessSigner.selector);
    }

    function testSignerRotationsInvalidateOutstandingAttestations() public {
        LockInEscrow.AccessEvidence memory access =
            _access(ALICE, escrow.ACCESS_CREATE(), 0, keccak256("rotate-access"), ACCESS_KEY);
        escrow.setAccessSigner(VM.addr(WRONG_KEY));
        VM.prank(ALICE);
        (bool accessOk, bytes memory accessData) = address(escrow)
            .call(
                abi.encodeCall(
                    escrow.createPact,
                    (uint96(ONE_USDC), 1_000, 3, 2, 2, 4, uint64(START), uint8(1), access)
                )
            );
        _requireSelector(accessOk, accessData, LockInEscrow.InvalidAccessSigner.selector);

        escrow.setAccessSigner(VM.addr(ACCESS_KEY));
        uint256 pactId = _createStrava(2, keccak256("rotate-proof-create"));
        _joinStrava(pactId, BOB, keccak256("rotate-proof-join"));
        VM.warp(START + 1 hours);
        LockInEscrow.CompletionEvidence memory proof = _completionEvidence(
            escrow,
            pactId,
            ALICE,
            0,
            1,
            keccak256("strava:alice"),
            keccak256("rotate-proof"),
            1_200,
            uint64(block.timestamp),
            uint64(block.timestamp),
            uint64(block.timestamp + 5 minutes),
            EVIDENCE_KEY
        );
        escrow.setEvidenceSigner(VM.addr(WRONG_KEY));
        VM.prank(ALICE);
        (bool proofOk, bytes memory proofData) =
            address(escrow).call(abi.encodeCall(escrow.submitCompletion, (pactId, 0, proof)));
        _requireSelector(proofOk, proofData, LockInEscrow.InvalidEvidenceSigner.selector);
    }

    function testFeeOnTransferStakeIsRejectedAtomically() public {
        FeeOnTransferUsdcRelease feeToken = new FeeOnTransferUsdcRelease();
        LockInEscrow feeEscrow =
            new LockInEscrow(feeToken, VM.addr(EVIDENCE_KEY), VM.addr(ACCESS_KEY));
        feeEscrow.setCreationPaused(false);
        feeToken.mint(ALICE, 2 * ONE_USDC);
        VM.prank(ALICE);
        feeToken.approve(address(feeEscrow), type(uint256).max);
        bytes32 configHash = feeEscrow.hashPactConfiguration(uint96(ONE_USDC), 1_000, 3, 2, 2, 4, uint64(START), 1);
        LockInEscrow.AccessEvidence memory access = _accessAt(
            feeEscrow,
            ALICE,
            feeEscrow.ACCESS_CREATE(),
            0,
            configHash,
            keccak256("fee-token"),
            uint64(block.timestamp),
            uint64(block.timestamp + 5 minutes),
            ACCESS_KEY
        );
        VM.prank(ALICE);
        (bool ok, bytes memory data) = address(feeEscrow)
            .call(
                abi.encodeCall(
                    feeEscrow.createPact,
                    (uint96(ONE_USDC), 1_000, 3, 2, 2, 4, uint64(START), uint8(1), access)
                )
            );
        _requireSelector(ok, data, LockInEscrow.UnsupportedStakeToken.selector);
        require(feeToken.balanceOf(ALICE) == 2 * ONE_USDC, "rejected transfer was not atomic");
        require(feeToken.balanceOf(address(feeEscrow)) == 0, "rejected transfer left funds");
    }

    function _createStrava(uint8 maxParticipants, bytes32 nonce) private returns (uint256 pactId) {
        return _createStravaTerms(uint96(ONE_USDC), 3, 2, 2, maxParticipants, uint64(START), nonce);
    }

    function _createStravaTerms(
        uint96 stake,
        uint8 durationDays,
        uint8 requiredCompletions,
        uint8 minParticipants,
        uint8 maxParticipants,
        uint64 startsAt,
        bytes32 nonce
    ) private returns (uint256 pactId) {
        LockInEscrow.AccessEvidence memory access = _accessWithConfig(
            ALICE,
            escrow.ACCESS_CREATE(),
            0,
            nonce,
            ACCESS_KEY,
            escrow.hashPactConfiguration(
                stake, 1_000, durationDays, requiredCompletions, minParticipants, maxParticipants, startsAt, 1
            )
        );
        VM.prank(ALICE);
        pactId = escrow.createPact(
            stake,
            1_000,
            durationDays,
            requiredCompletions,
            minParticipants,
            maxParticipants,
            startsAt,
            1,
            access
        );
    }

    function _joinStrava(uint256 pactId, address account, bytes32 nonce) private {
        LockInEscrow.AccessEvidence memory access = _access(account, escrow.ACCESS_JOIN(), pactId, nonce, ACCESS_KEY);
        VM.prank(account);
        escrow.joinPact(pactId, access);
    }

    function _access(address account, uint8 action, uint256 pactId, bytes32 nonce, uint256 signerKey)
        private
        returns (LockInEscrow.AccessEvidence memory access)
    {
        bytes32 configHash = pactId == 0
            ? escrow.hashPactConfiguration(uint96(ONE_USDC), 1_000, 3, 2, 2, 4, uint64(START), 1)
            : escrow.pactConfigHash(pactId);
        return _accessWithConfig(account, action, pactId, nonce, signerKey, configHash);
    }

    function _accessWithConfig(
        address account,
        uint8 action,
        uint256 pactId,
        bytes32 nonce,
        uint256 signerKey,
        bytes32 configHash
    ) private returns (LockInEscrow.AccessEvidence memory access) {
        return _accessAt(
            escrow,
            account,
            action,
            pactId,
            configHash,
            nonce,
            uint64(block.timestamp),
            uint64(block.timestamp + 5 minutes),
            signerKey
        );
    }

    function _accessAt(
        LockInEscrow target,
        address account,
        uint8 action,
        uint256 pactId,
        bytes32 configHash,
        bytes32 nonce,
        uint64 issuedAt,
        uint64 expiresAt,
        uint256 signerKey
    ) private returns (LockInEscrow.AccessEvidence memory access) {
        access.configHash = configHash;
        access.nonce = nonce;
        access.issuedAt = issuedAt;
        access.expiresAt = expiresAt;
        bytes32 structHash = keccak256(
            abi.encode(
                target.ACCESS_TYPEHASH(),
                account,
                action,
                pactId,
                access.configHash,
                nonce,
                access.issuedAt,
                access.expiresAt
            )
        );
        access.signature = _signFor(target, signerKey, structHash);
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
        (bool ok, bytes memory data) =
            _trySubmit(account, pactId, dayIndex, missionType, identity, nullifier, metric, occurredAt);
        if (!ok) assembly ("memory-safe") { revert(add(data, 32), mload(data)) }
    }

    function _trySubmit(
        address account,
        uint256 pactId,
        uint8 dayIndex,
        uint8 missionType,
        bytes32 identity,
        bytes32 nullifier,
        uint64 metric,
        uint256 occurredAt
    ) private returns (bool ok, bytes memory data) {
        uint64 issuedAt = uint64(VM.getBlockTimestamp());
        LockInEscrow.CompletionEvidence memory evidence = _completionEvidence(
            escrow,
            pactId,
            account,
            dayIndex,
            missionType,
            identity,
            nullifier,
            metric,
            uint64(occurredAt),
            issuedAt,
            issuedAt + uint64(5 minutes),
            EVIDENCE_KEY
        );
        VM.prank(account);
        (ok, data) =
            address(escrow).call(abi.encodeCall(escrow.submitCompletion, (pactId, dayIndex, evidence)));
    }

    function _completionEvidence(
        LockInEscrow target,
        uint256 pactId,
        address account,
        uint8 dayIndex,
        uint8 missionType,
        bytes32 identity,
        bytes32 nullifier,
        uint64 metric,
        uint64 occurredAt,
        uint64 issuedAt,
        uint64 expiresAt,
        uint256 signerKey
    )
        private
        returns (LockInEscrow.CompletionEvidence memory evidence)
    {
        evidence.missionType = missionType;
        evidence.policyHash = target.missionPolicyHash(missionType);
        evidence.identityHash = identity;
        evidence.metric = metric;
        evidence.occurredAt = occurredAt;
        evidence.oldestProofTimestamp = uint32(occurredAt);
        evidence.newestProofTimestamp = uint32(occurredAt);
        evidence.issuedAt = issuedAt;
        evidence.expiresAt = expiresAt;

        // Under STRAVA_OAUTH_V1 the backend reads the run from Strava's API and attests it. There is no
        // on-chain proof bundle to cross-check any more, so the evidence stands on its signature alone.
        string memory session = "strava-oauth-session";
        evidence.eventNullifier = nullifier;
        evidence.proofSetHash = keccak256(abi.encode("strava-activity", pactId, account, nullifier, metric));
        evidence.movingTimeSeconds = 600;
        evidence.elapsedTimeSeconds = 700;
        evidence.elevationGainMeters = 10;
        evidence.sessionIdHash = keccak256(bytes(session));
        bytes32 structHash = keccak256(
            abi.encode(
                target.COMPLETION_TYPEHASH(),
                pactId,
                account,
                dayIndex,
                evidence.missionType,
                evidence.policyHash,
                evidence.sessionIdHash,
                identity,
                evidence.eventNullifier,
                metric,
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
        evidence.signature = _signFor(target, signerKey, structHash);
    }

    function _sign(uint256 signerKey, bytes32 structHash) private returns (bytes memory) {
        return _signFor(escrow, signerKey, structHash);
    }

    function _signFor(LockInEscrow target, uint256 signerKey, bytes32 structHash) private returns (bytes memory) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Lock In"),
                keccak256("1"),
                block.chainid,
                address(target)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _requireSelector(bool ok, bytes memory data, bytes4 expected) private pure {
        require(!ok && data.length >= 4, "expected custom error");
        bytes4 actual;
        assembly ("memory-safe") {
            actual := mload(add(data, 32))
        }
        require(actual == expected, "unexpected custom error");
    }

    function _fund(address account) private {
        token.mint(account, 20 * ONE_USDC);
        VM.prank(account);
        token.approve(address(escrow), type(uint256).max);
    }
}
