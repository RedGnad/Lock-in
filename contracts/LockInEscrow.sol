// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ILockInDuolingoVerifier, ILockInStravaVerifier, LockInProofTypes} from "./verifiers/LockInProofTypes.sol";

/// @notice Fixed-stake social pacts settled only when a direct Reclaim proof and a short-lived
///         mission-specific backend attestation independently agree on every settlement field.
contract LockInEscrow is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint8 public constant MISSION_STRAVA_RUN = 1;
    uint8 public constant MISSION_DUOLINGO_XP = 2;
    bytes32 public constant POLICY_TYPEHASH =
        keccak256("MissionPolicy(uint256 chainId,uint8 missionType,address verifier,bytes32 verifierCodeHash)");
    bytes32 public constant BASELINE_TYPEHASH = keccak256(
        "Baseline(uint256 pactId,address account,uint8 missionType,bytes32 policyHash,bytes32 sessionIdHash,bytes32 identityHash,uint64 metric,bytes32 proofSetHash,uint64 observedAt,uint64 issuedAt,uint64 expiresAt)"
    );
    bytes32 public constant COMPLETION_TYPEHASH = keccak256(
        "Completion(uint256 pactId,address account,uint8 dayIndex,uint8 missionType,bytes32 policyHash,bytes32 sessionIdHash,bytes32 identityHash,bytes32 eventNullifier,uint64 metric,bytes32 proofSetHash,uint64 occurredAt,uint32 oldestProofTimestamp,uint32 newestProofTimestamp,uint64 movingTimeSeconds,uint64 elapsedTimeSeconds,uint64 elevationGainMeters,uint64 issuedAt,uint64 expiresAt)"
    );
    bytes32 public constant ACCESS_TYPEHASH = keccak256(
        "Access(address account,uint8 action,uint256 pactId,bytes32 configHash,bytes32 nonce,uint64 issuedAt,uint64 expiresAt)"
    );
    uint8 public constant ACCESS_CREATE = 1;
    uint8 public constant ACCESS_JOIN = 2;

    uint8 public constant MIN_DURATION_DAYS = 3;
    uint8 public constant MAX_DURATION_DAYS = 30;
    uint8 public constant MIN_PARTICIPANTS = 2;
    uint8 public constant MAX_PARTICIPANTS = 100;
    uint32 public constant MIN_STRAVA_DISTANCE_METERS = 500;
    uint32 public constant MAX_STRAVA_DISTANCE_METERS = 20_000;
    uint32 public constant MIN_DUOLINGO_XP = 5;
    uint32 public constant MAX_DUOLINGO_XP = 200;
    uint256 public constant MIN_STAKE = 100_000;
    uint256 public constant MAX_STAKE = 1_000_000;
    uint256 public constant MAX_ATTESTATION_AGE = 10 minutes;
    uint256 public constant MAX_CLOCK_SKEW = 1 minutes;
    uint256 public constant MAX_START_DELAY = 3 hours;
    uint256 public constant SUBMISSION_GRACE_PERIOD = 1 days;
    uint256 public constant CONTRACT_SCHEMA_ID = 1;
    uint64 public constant LOCK_SCORE_PER_DAY = 10;
    uint8 public constant MIN_HANDLE_LENGTH = 3;
    uint8 public constant MAX_HANDLE_LENGTH = 16;

    struct Pact {
        address creator;
        uint64 startsAt;
        uint96 stake;
        uint32 dailyTarget;
        uint32 participantCount;
        uint32 finisherCount;
        uint32 claimsRemaining;
        uint8 durationDays;
        uint8 requiredCompletions;
        uint8 minParticipants;
        uint8 maxParticipants;
        uint8 missionType;
        uint64 completionPauseGenerationAtCreation;
        bytes32 missionPolicyHash;
        uint256 remainingPool;
        bool finalized;
        bool cancelled;
    }

    struct BaselineEvidence {
        uint8 missionType;
        bytes32 policyHash;
        bytes32 sessionIdHash;
        bytes32 identityHash;
        uint64 metric;
        bytes32 proofSetHash;
        uint64 observedAt;
        uint64 issuedAt;
        uint64 expiresAt;
        bytes signature;
    }

    struct CompletionEvidence {
        uint8 missionType;
        bytes32 policyHash;
        bytes32 sessionIdHash;
        bytes32 identityHash;
        bytes32 eventNullifier;
        uint64 metric;
        bytes32 proofSetHash;
        uint64 occurredAt;
        uint32 oldestProofTimestamp;
        uint32 newestProofTimestamp;
        uint64 movingTimeSeconds;
        uint64 elapsedTimeSeconds;
        uint64 elevationGainMeters;
        uint64 issuedAt;
        uint64 expiresAt;
        bytes signature;
    }

    struct AccessEvidence {
        bytes32 configHash;
        bytes32 nonce;
        uint64 issuedAt;
        uint64 expiresAt;
        bytes signature;
    }

    IERC20 public immutable stakeToken;
    ILockInStravaVerifier public immutable stravaVerifier;
    ILockInDuolingoVerifier public immutable duolingoVerifier;
    address public evidenceSigner;
    address public accessSigner;
    uint256 public nextPactId = 1;
    uint64 public completionPauseGeneration = 1;

    bool public creationPaused;
    bool public joiningPaused;
    bool public baselinePaused;
    bool public completionPaused;

    mapping(uint256 => Pact) public pacts;
    mapping(uint256 => mapping(address => bool)) public joined;
    mapping(uint256 => mapping(address => uint256)) public completionBitmap;
    mapping(uint256 => mapping(address => uint8)) public completionCount;
    mapping(uint256 => mapping(address => bytes32)) public participantIdentity;
    mapping(uint256 => mapping(bytes32 => address)) public identityOwner;
    mapping(uint256 => mapping(address => uint64)) public lastMetric;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(bytes32 => uint64) public consumedDuolingoMetric;
    mapping(bytes32 => bool) public usedEventNullifiers;
    mapping(bytes32 => bool) public usedAccessNonces;
    mapping(address => string) public playerHandle;
    mapping(bytes32 => address) public handleOwner;
    mapping(address => bool) public playerProfileHidden;
    mapping(address => uint64) public lockScore;
    mapping(address => uint32) public verifiedDays;
    mapping(address => mapping(uint8 => uint32)) public missionVerifiedDays;
    mapping(address => mapping(uint64 => bool)) public scoredUtcDay;
    mapping(address => mapping(uint8 => mapping(uint64 => bool))) public missionDayScored;
    mapping(uint8 => mapping(bytes32 => address)) public missionIdentityOwner;
    mapping(bytes32 => bool) public usedHighFives;
    mapping(uint64 => uint64) public completionPauseStartedAt;
    mapping(uint64 => uint64) public completionPauseEndedAt;
    /// @dev `duolingoIdentityLockedUntil` is authoritative; this id remains as the last lock after expiry.
    mapping(bytes32 => uint256) public activeDuolingoPact;
    mapping(bytes32 => uint64) public duolingoIdentityLockedUntil;

    event PactCreated(
        uint256 indexed pactId,
        address indexed creator,
        uint8 indexed missionType,
        uint256 stake,
        uint32 dailyTarget,
        uint8 durationDays,
        uint8 requiredCompletions,
        uint8 minParticipants,
        uint8 maxParticipants,
        uint64 startsAt,
        bytes32 missionPolicyHash
    );
    event PactJoined(uint256 indexed pactId, address indexed account);
    event IdentityBound(uint256 indexed pactId, address indexed account, bytes32 indexed identityHash);
    event BaselineAccepted(
        uint256 indexed pactId, address indexed account, bytes32 indexed identityHash, uint64 totalMetric
    );
    event CompletionAccepted(
        uint256 indexed pactId,
        address indexed account,
        uint8 indexed dayIndex,
        uint8 missionType,
        bytes32 eventNullifier,
        uint64 metric,
        uint64 occurredAt
    );
    event PactCancelled(uint256 indexed pactId);
    event PactFinalized(
        uint256 indexed pactId, uint256 pool, uint256 eligibleClaimants, uint256 finishers, bool cancelled
    );
    event PayoutClaimed(uint256 indexed pactId, address indexed account, uint256 amount);
    event EvidenceSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event AccessSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event CreationPauseUpdated(bool paused);
    event JoiningPauseUpdated(bool paused);
    event BaselinePauseUpdated(bool paused);
    event CompletionPauseUpdated(bool paused);
    event PactRefundedForCompletionPause(uint256 indexed pactId, uint64 indexed pauseGeneration, uint64 pauseStartedAt);
    event DuolingoIdentityReleased(uint256 indexed pactId, address indexed account, bytes32 indexed identityHash);
    event PlayerHandleSet(address indexed account, string handle);
    event PlayerProfileVisibilityUpdated(address indexed account, bool hidden);
    event MissionDayVerified(
        address indexed account, uint8 indexed missionType, uint64 indexed utcDay, uint32 missionVerifiedDays
    );
    event LockScoreAwarded(
        address indexed account, uint64 indexed utcDay, uint64 scoreAwarded, uint64 totalScore, uint32 verifiedDays
    );
    event MissionIdentityBound(uint8 indexed missionType, bytes32 indexed identityHash, address indexed account);
    event HighFiveSent(uint256 indexed pactId, address indexed from, address indexed to, uint8 dayIndex);

    error InvalidAddress();
    error LiveSchemaUnconfirmed();
    error InvalidTokenDecimals();
    error InvalidStake();
    error InvalidGoal();
    error InvalidSchedule();
    error UnsupportedMission();
    error PactNotFound();
    error CreationIsPaused();
    error JoiningIsPaused();
    error BaselineIsPaused();
    error CompletionIsPaused();
    error JoinClosed();
    error AlreadyJoined();
    error PactFull();
    error NotParticipant();
    error InvalidDay();
    error CompletionOutsideDay();
    error DayAlreadyCompleted();
    error TargetAlreadyMet();
    error UnderfilledPact();
    error SubmissionClosed();
    error EventAlreadyUsed();
    error InvalidEvidenceSigner();
    error InvalidAccessSigner();
    error AccessAlreadyUsed();
    error AttestationExpired();
    error StaleEvidence();
    error InvalidAttestationWindow();
    error InvalidProofHash();
    error InvalidProofBundle();
    error DirectProofMismatch();
    error InvalidMissionPolicy();
    error InvalidMetric();
    error InvalidConfigurationHash();
    error DuolingoIdentityInActivePact();
    error PactStillActive();
    error UnsupportedStakeToken();
    error BaselineRequired();
    error IdentityAlreadyUsed();
    error IdentityMismatch();
    error NotCreator();
    error CancellationClosed();
    error AlreadyCancelled();
    error FinalizationTooEarly();
    error AlreadyFinalized();
    error NotFinalized();
    error NotEligible();
    error AlreadyClaimed();
    error InvalidHandle();
    error HandleAlreadyUsed();
    error InvalidHighFive();
    error HighFiveAlreadySent();

    constructor(
        IERC20 stakeToken_,
        address evidenceSigner_,
        address accessSigner_,
        ILockInStravaVerifier stravaVerifier_,
        ILockInDuolingoVerifier duolingoVerifier_
    ) EIP712("Lock In", "1") {
        if (
            address(stakeToken_) == address(0) || evidenceSigner_ == address(0) || accessSigner_ == address(0)
                || address(stravaVerifier_) == address(0) || address(duolingoVerifier_) == address(0)
        ) {
            revert InvalidAddress();
        }
        if (address(stravaVerifier_).code.length == 0 || address(duolingoVerifier_).code.length == 0) {
            revert InvalidAddress();
        }
        if (!stravaVerifier_.LIVE_SCHEMA_CONFIRMED() || !duolingoVerifier_.LIVE_SCHEMA_CONFIRMED()) {
            revert LiveSchemaUnconfirmed();
        }
        if (IERC20Metadata(address(stakeToken_)).decimals() != 6) revert InvalidTokenDecimals();
        stakeToken = stakeToken_;
        stravaVerifier = stravaVerifier_;
        duolingoVerifier = duolingoVerifier_;
        evidenceSigner = evidenceSigner_;
        accessSigner = accessSigner_;
        creationPaused = true;
        joiningPaused = true;
        baselinePaused = true;
        completionPaused = true;
        completionPauseStartedAt[1] = uint64(block.timestamp);
    }

    /// @notice Creates and atomically joins a pact. Duolingo creation requires a fresh XP baseline.
    function createPact(
        uint96 stake,
        uint32 dailyTarget,
        uint8 durationDays,
        uint8 requiredCompletions,
        uint8 minParticipants,
        uint8 maxParticipants,
        uint64 startsAt,
        uint8 missionType,
        BaselineEvidence calldata baseline,
        LockInProofTypes.DirectProofBundle calldata directProof,
        AccessEvidence calldata access
    ) external nonReentrant returns (uint256 pactId) {
        if (creationPaused) revert CreationIsPaused();
        _validateConfiguration(
            stake,
            dailyTarget,
            durationDays,
            requiredCompletions,
            minParticipants,
            maxParticipants,
            startsAt,
            missionType
        );
        bytes32 configHash = _hashPactConfiguration(
            stake,
            dailyTarget,
            durationDays,
            requiredCompletions,
            minParticipants,
            maxParticipants,
            startsAt,
            missionType,
            _missionPolicyHash(missionType)
        );
        _consumeAccess(msg.sender, ACCESS_CREATE, 0, configHash, access);

        pactId = nextPactId++;
        Pact storage pact = pacts[pactId];
        pact.creator = msg.sender;
        pact.startsAt = startsAt;
        pact.stake = stake;
        pact.dailyTarget = dailyTarget;
        pact.participantCount = 1;
        pact.durationDays = durationDays;
        pact.requiredCompletions = requiredCompletions;
        pact.minParticipants = minParticipants;
        pact.maxParticipants = maxParticipants;
        pact.missionType = missionType;
        pact.missionPolicyHash = _missionPolicyHash(missionType);
        pact.completionPauseGenerationAtCreation = completionPauseGeneration;

        joined[pactId][msg.sender] = true;
        if (missionType == MISSION_DUOLINGO_XP) {
            _acceptBaseline(pactId, 0, msg.sender, baseline, directProof);
        } else {
            _requireEmptyDirectProof(directProof);
        }
        _pullStake(msg.sender, stake);

        emit PactCreated(
            pactId,
            msg.sender,
            missionType,
            stake,
            dailyTarget,
            durationDays,
            requiredCompletions,
            minParticipants,
            maxParticipants,
            startsAt,
            pact.missionPolicyHash
        );
        emit PactJoined(pactId, msg.sender);
    }

    /// @notice Joins before the published start. Duolingo joining and baseline acceptance are atomic.
    function joinPact(
        uint256 pactId,
        BaselineEvidence calldata baseline,
        LockInProofTypes.DirectProofBundle calldata directProof,
        AccessEvidence calldata access
    ) external nonReentrant {
        if (joiningPaused) revert JoiningIsPaused();
        Pact storage pact = _pact(pactId);
        if (pact.cancelled || pact.finalized || block.timestamp >= pact.startsAt) revert JoinClosed();
        if (joined[pactId][msg.sender]) revert AlreadyJoined();
        if (pact.participantCount >= pact.maxParticipants) revert PactFull();
        _consumeAccess(msg.sender, ACCESS_JOIN, pactId, _pactConfigHash(pact), access);

        joined[pactId][msg.sender] = true;
        ++pact.participantCount;
        if (pact.missionType == MISSION_DUOLINGO_XP) {
            _acceptBaseline(pactId, pactId, msg.sender, baseline, directProof);
        } else {
            _requireEmptyDirectProof(directProof);
        }
        _pullStake(msg.sender, pact.stake);
        emit PactJoined(pactId, msg.sender);
    }

    /// @notice Accepts one policy-checked mission completion for a pact day.
    function submitCompletion(
        uint256 pactId,
        uint8 dayIndex,
        CompletionEvidence calldata evidence,
        LockInProofTypes.DirectProofBundle calldata directProof
    ) external nonReentrant {
        if (completionPaused) revert CompletionIsPaused();
        Pact storage pact = _pact(pactId);
        if (pact.cancelled || pact.finalized) revert SubmissionClosed();
        if (pact.participantCount < pact.minParticipants) revert UnderfilledPact();
        if (!joined[pactId][msg.sender]) revert NotParticipant();
        if (completionCount[pactId][msg.sender] >= pact.requiredCompletions) revert TargetAlreadyMet();
        if (dayIndex >= pact.durationDays) revert InvalidDay();

        uint256 dayStart = uint256(pact.startsAt) + uint256(dayIndex) * 1 days;
        if (evidence.occurredAt < dayStart || evidence.occurredAt >= dayStart + 1 days) revert CompletionOutsideDay();
        if (evidence.occurredAt > block.timestamp + MAX_CLOCK_SKEW) revert StaleEvidence();
        if (block.timestamp < dayStart || block.timestamp >= dayStart + 1 days + SUBMISSION_GRACE_PERIOD) {
            revert CompletionOutsideDay();
        }

        uint256 dayMask = uint256(1) << dayIndex;
        uint256 previousBitmap = completionBitmap[pactId][msg.sender];
        if (previousBitmap & dayMask != 0) revert DayAlreadyCompleted();
        if (evidence.proofSetHash == bytes32(0) || evidence.eventNullifier == bytes32(0)) revert InvalidProofHash();
        if (usedEventNullifiers[evidence.eventNullifier]) revert EventAlreadyUsed();

        _verifyDirectCompletion(pactId, msg.sender, dayIndex, pact, evidence, directProof);
        _verifyCompletionSignature(pactId, msg.sender, dayIndex, evidence);
        _bindIdentity(pactId, msg.sender, evidence.identityHash);

        if (pact.missionType == MISSION_STRAVA_RUN) {
            if (evidence.metric < pact.dailyTarget) revert InvalidMetric();
        } else {
            uint64 previousMetric = lastMetric[pactId][msg.sender];
            uint64 globallyConsumed = consumedDuolingoMetric[evidence.identityHash];
            if (globallyConsumed > previousMetric) previousMetric = globallyConsumed;
            if (evidence.metric < previousMetric || uint256(evidence.metric) - previousMetric < pact.dailyTarget) {
                revert InvalidMetric();
            }
            lastMetric[pactId][msg.sender] = evidence.metric;
            consumedDuolingoMetric[evidence.identityHash] = evidence.metric;
        }

        usedEventNullifiers[evidence.eventNullifier] = true;
        completionBitmap[pactId][msg.sender] = previousBitmap | dayMask;
        uint8 updatedCount = completionCount[pactId][msg.sender] + 1;
        completionCount[pactId][msg.sender] = updatedCount;
        if (updatedCount == pact.requiredCompletions) ++pact.finisherCount;

        _recordVerifiedDay(msg.sender, pact.missionType, evidence.identityHash, evidence.occurredAt);

        emit CompletionAccepted(
            pactId,
            msg.sender,
            dayIndex,
            pact.missionType,
            evidence.eventNullifier,
            evidence.metric,
            evidence.occurredAt
        );
    }

    function cancelPact(uint256 pactId) external {
        Pact storage pact = _pact(pactId);
        if (msg.sender != pact.creator) revert NotCreator();
        if (pact.finalized) revert AlreadyFinalized();
        if (pact.cancelled) revert AlreadyCancelled();
        if (block.timestamp >= pact.startsAt) revert CancellationClosed();
        pact.cancelled = true;
        emit PactCancelled(pactId);
    }

    /// @notice Emergency action can only move an unsettled pact into participant refunds.
    function cancelPactByOwner(uint256 pactId) external onlyOwner {
        Pact storage pact = _pact(pactId);
        if (pact.finalized) revert AlreadyFinalized();
        if (pact.cancelled) revert AlreadyCancelled();
        pact.cancelled = true;
        emit PactCancelled(pactId);
    }

    /// @notice Permissionless finalization. Pause flags never block settlement or claims.
    function finalizePact(uint256 pactId) public {
        Pact storage pact = _pact(pactId);
        if (pact.finalized) revert AlreadyFinalized();

        if (!pact.cancelled && block.timestamp >= pact.startsAt && pact.participantCount < pact.minParticipants) {
            pact.cancelled = true;
            emit PactCancelled(pactId);
        }
        if (!pact.cancelled && block.timestamp < _submissionDeadline(pact)) revert FinalizationTooEarly();

        if (!pact.cancelled) {
            (bool affected, uint64 pauseGeneration, uint64 pauseStartedAt) = _completionPauseAffected(pact);
            if (affected) {
                pact.cancelled = true;
                emit PactRefundedForCompletionPause(pactId, pauseGeneration, pauseStartedAt);
                emit PactCancelled(pactId);
            }
        }

        uint32 eligibleClaimants =
            pact.cancelled || pact.finisherCount == 0 ? pact.participantCount : pact.finisherCount;
        pact.finalized = true;
        pact.claimsRemaining = eligibleClaimants;
        pact.remainingPool = uint256(pact.stake) * pact.participantCount;
        emit PactFinalized(pactId, pact.remainingPool, eligibleClaimants, pact.finisherCount, pact.cancelled);
    }

    function claim(uint256 pactId) external nonReentrant returns (uint256 amount) {
        Pact storage pact = _pact(pactId);
        if (!pact.finalized) revert NotFinalized();
        if (!joined[pactId][msg.sender]) revert NotParticipant();
        if (claimed[pactId][msg.sender]) revert AlreadyClaimed();
        if (
            !pact.cancelled && pact.finisherCount != 0 && completionCount[pactId][msg.sender] < pact.requiredCompletions
        ) revert NotEligible();

        claimed[pactId][msg.sender] = true;
        amount = pact.remainingPool / pact.claimsRemaining;
        pact.remainingPool -= amount;
        --pact.claimsRemaining;
        _pushPayout(msg.sender, amount);
        emit PayoutClaimed(pactId, msg.sender, amount);
    }

    function pactEndsAt(uint256 pactId) external view returns (uint256) {
        return _endsAt(_pact(pactId));
    }

    function pactSubmissionDeadline(uint256 pactId) external view returns (uint256) {
        return _submissionDeadline(_pact(pactId));
    }

    function pactConfigHash(uint256 pactId) external view returns (bytes32) {
        return _pactConfigHash(_pact(pactId));
    }

    function hashPactConfiguration(
        uint96 stake,
        uint32 dailyTarget,
        uint8 durationDays,
        uint8 requiredCompletions,
        uint8 minParticipants,
        uint8 maxParticipants,
        uint64 startsAt,
        uint8 missionType
    ) external view returns (bytes32) {
        return _hashPactConfiguration(
            stake,
            dailyTarget,
            durationDays,
            requiredCompletions,
            minParticipants,
            maxParticipants,
            startsAt,
            missionType,
            _missionPolicyHash(missionType)
        );
    }

    function missionPolicyHash(uint8 missionType) external view returns (bytes32) {
        return _missionPolicyHash(missionType);
    }

    /// @notice Deterministic, pact-bound activity title required by the Strava provider for a given day.
    function stravaChallenge(uint256 pactId, address account, uint8 dayIndex) public view returns (string memory) {
        if (account == address(0) || dayIndex >= MAX_DURATION_DAYS) revert InvalidDay();
        bytes32 seed = keccak256(
            abi.encode(keccak256("LOCK_IN_STRAVA_CHALLENGE"), block.chainid, address(this), pactId, account, dayIndex)
        );
        bytes memory output = new bytes(22);
        output[0] = "L";
        output[1] = "I";
        output[2] = "-";
        bytes16 alphabet = "0123456789ABCDEF";
        for (uint256 i; i < 16; ++i) {
            output[3 + i] = alphabet[uint8(seed[i / 2]) >> (i % 2 == 0 ? 4 : 0) & 0x0f];
        }
        output[19] = "D";
        uint8 day = dayIndex + 1;
        output[20] = bytes1(uint8(48 + day / 10));
        output[21] = bytes1(uint8(48 + day % 10));
        return string(output);
    }

    function getPact(uint256 pactId) external view returns (Pact memory) {
        return _pact(pactId);
    }

    function isFinisher(uint256 pactId, address account) external view returns (bool) {
        Pact storage pact = _pact(pactId);
        return joined[pactId][account] && completionCount[pactId][account] >= pact.requiredCompletions;
    }

    /// @notice Clears the caller's Duolingo lock once its pact can no longer accept completions.
    /// @dev A stale pact can never clear a lock that has already moved to a newer pact.
    function releaseDuolingoIdentity(uint256 pactId) external returns (bool released) {
        Pact storage pact = _pact(pactId);
        if (!pact.cancelled && !pact.finalized) revert PactStillActive();
        if (pact.missionType != MISSION_DUOLINGO_XP || !joined[pactId][msg.sender]) revert NotParticipant();

        bytes32 identityHash = participantIdentity[pactId][msg.sender];
        if (identityHash == bytes32(0)) revert BaselineRequired();
        if (activeDuolingoPact[identityHash] != pactId) return false;

        delete activeDuolingoPact[identityHash];
        delete duolingoIdentityLockedUntil[identityHash];
        emit DuolingoIdentityReleased(pactId, msg.sender, identityHash);
        return true;
    }

    /// @notice Sets an optional Lock In handle. External service names are never changed or reused here.
    /// @dev Handles are canonical lowercase ASCII so uniqueness is deterministic across every client.
    function setPlayerHandle(string calldata handle) external {
        bytes memory value = bytes(handle);
        if (!_validHandle(value)) revert InvalidHandle();
        bytes32 key = keccak256(value);
        address existingOwner = handleOwner[key];
        if (existingOwner != address(0) && existingOwner != msg.sender) revert HandleAlreadyUsed();

        bytes memory previous = bytes(playerHandle[msg.sender]);
        if (previous.length != 0) {
            bytes32 previousKey = keccak256(previous);
            if (previousKey == key) return;
            delete handleOwner[previousKey];
        }
        playerHandle[msg.sender] = handle;
        handleOwner[key] = msg.sender;
        emit PlayerHandleSet(msg.sender, handle);
    }

    /// @notice Clears the current handle from active app surfaces; historical events remain public onchain.
    function clearPlayerHandle() external {
        bytes memory previous = bytes(playerHandle[msg.sender]);
        if (previous.length == 0) return;
        delete handleOwner[keccak256(previous)];
        delete playerHandle[msg.sender];
        emit PlayerHandleSet(msg.sender, "");
    }

    /// @notice Sends one reaction to a crewmate's verified day. Reactions never affect score or payout.
    function highFive(uint256 pactId, address to, uint8 dayIndex) external {
        Pact storage pact = _pact(pactId);
        if (
            to == address(0) || to == msg.sender || dayIndex >= pact.durationDays || !joined[pactId][msg.sender]
                || !joined[pactId][to] || completionBitmap[pactId][to] & (uint256(1) << dayIndex) == 0
        ) revert InvalidHighFive();
        bytes32 key = keccak256(abi.encode(pactId, msg.sender, to, dayIndex));
        if (usedHighFives[key]) revert HighFiveAlreadySent();
        usedHighFives[key] = true;
        emit HighFiveSent(pactId, msg.sender, to, dayIndex);
    }

    function setEvidenceSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert InvalidAddress();
        address previous = evidenceSigner;
        evidenceSigner = newSigner;
        emit EvidenceSignerUpdated(previous, newSigner);
    }

    function setAccessSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert InvalidAddress();
        address previous = accessSigner;
        accessSigner = newSigner;
        emit AccessSignerUpdated(previous, newSigner);
    }

    /// @notice Lets the operator hide an abusive handle without suppressing the player's verified score.
    function setPlayerProfileHidden(address account, bool hidden) external onlyOwner {
        if (account == address(0)) revert InvalidAddress();
        playerProfileHidden[account] = hidden;
        emit PlayerProfileVisibilityUpdated(account, hidden);
    }

    function setCreationPaused(bool paused) external onlyOwner {
        creationPaused = paused;
        emit CreationPauseUpdated(paused);
    }

    function setJoiningPaused(bool paused) external onlyOwner {
        joiningPaused = paused;
        emit JoiningPauseUpdated(paused);
    }

    function setBaselinePaused(bool paused) external onlyOwner {
        baselinePaused = paused;
        emit BaselinePauseUpdated(paused);
    }

    function setCompletionPaused(bool paused) external onlyOwner {
        if (paused && !completionPaused) {
            ++completionPauseGeneration;
            completionPauseStartedAt[completionPauseGeneration] = uint64(block.timestamp);
        } else if (!paused && completionPaused) {
            completionPauseEndedAt[completionPauseGeneration] = uint64(block.timestamp);
        }
        completionPaused = paused;
        emit CompletionPauseUpdated(paused);
    }

    function _acceptBaseline(
        uint256 pactId,
        uint256 signedPactId,
        address account,
        BaselineEvidence calldata evidence,
        LockInProofTypes.DirectProofBundle calldata directProof
    ) private {
        if (baselinePaused) revert BaselineIsPaused();
        Pact storage pact = pacts[pactId];
        if (directProof.proofs.length != 2 || bytes(directProof.sessionId).length == 0) revert InvalidProofBundle();
        if (evidence.identityHash == bytes32(0) || evidence.proofSetHash == bytes32(0)) revert InvalidProofHash();
        if (
            evidence.missionType != MISSION_DUOLINGO_XP || evidence.policyHash != pact.missionPolicyHash
                || evidence.policyHash != _missionPolicyHash(MISSION_DUOLINGO_XP)
                || evidence.sessionIdHash != keccak256(bytes(directProof.sessionId))
        ) revert InvalidMissionPolicy();

        LockInProofTypes.DuolingoEvidence memory direct = duolingoVerifier.validateDuolingoProofs(
            directProof.proofs, account, signedPactId, true, 0, directProof.sessionId
        );
        if (
            direct.identityHash != evidence.identityHash || direct.totalXp != evidence.metric
                || direct.proofSetHash != evidence.proofSetHash || direct.proofTimestamp != evidence.observedAt
        ) revert DirectProofMismatch();

        _validateAttestationWindow(evidence.issuedAt, evidence.expiresAt);
        if (
            evidence.observedAt > block.timestamp + MAX_CLOCK_SKEW
                || uint256(evidence.observedAt) + MAX_ATTESTATION_AGE < block.timestamp
                || evidence.observedAt >= pacts[pactId].startsAt
        ) revert StaleEvidence();

        bytes32 structHash = keccak256(
            abi.encode(
                BASELINE_TYPEHASH,
                signedPactId,
                account,
                evidence.missionType,
                evidence.policyHash,
                evidence.sessionIdHash,
                evidence.identityHash,
                evidence.metric,
                evidence.proofSetHash,
                evidence.observedAt,
                evidence.issuedAt,
                evidence.expiresAt
            )
        );
        if (ECDSA.recover(_hashTypedDataV4(structHash), evidence.signature) != evidenceSigner) {
            revert InvalidEvidenceSigner();
        }

        _bindIdentity(pactId, account, evidence.identityHash);
        _lockDuolingoIdentity(pactId, evidence.identityHash);
        if (evidence.metric < consumedDuolingoMetric[evidence.identityHash]) revert InvalidMetric();
        lastMetric[pactId][account] = evidence.metric;
        consumedDuolingoMetric[evidence.identityHash] = evidence.metric;
        emit BaselineAccepted(pactId, account, evidence.identityHash, evidence.metric);
    }

    function _verifyDirectCompletion(
        uint256 pactId,
        address account,
        uint8 dayIndex,
        Pact storage pact,
        CompletionEvidence calldata evidence,
        LockInProofTypes.DirectProofBundle calldata directProof
    ) private view {
        if (
            evidence.missionType != pact.missionType || evidence.policyHash != pact.missionPolicyHash
                || evidence.policyHash != _missionPolicyHash(pact.missionType)
        ) revert InvalidMissionPolicy();

        if (pact.missionType == MISSION_STRAVA_RUN) {
            if (directProof.proofs.length != 4 || bytes(directProof.sessionId).length == 0) {
                revert InvalidProofBundle();
            }
            if (evidence.sessionIdHash != keccak256(bytes(directProof.sessionId))) revert InvalidMissionPolicy();
            uint64 startsAt = uint64(uint256(pact.startsAt) + uint256(dayIndex) * 1 days);
            LockInProofTypes.StravaPolicy memory policy = LockInProofTypes.StravaPolicy({
                account: account,
                pactId: pactId,
                dayIndex: dayIndex,
                expectedSessionId: directProof.sessionId,
                challenge: stravaChallenge(pactId, account, dayIndex),
                startsAt: startsAt,
                endsAt: startsAt + uint64(1 days),
                minDistanceMeters: pact.dailyTarget
            });
            LockInProofTypes.StravaEvidence memory direct =
                stravaVerifier.validateStravaProofs(directProof.proofs, policy);
            if (
                direct.identityHash != evidence.identityHash || direct.nullifier != evidence.eventNullifier
                    || direct.proofSetHash != evidence.proofSetHash || direct.distanceMeters != evidence.metric
                    || direct.startTime != evidence.occurredAt
                    || direct.oldestProofTimestamp != evidence.oldestProofTimestamp
                    || direct.newestProofTimestamp != evidence.newestProofTimestamp
                    || direct.movingTimeSeconds != evidence.movingTimeSeconds
                    || direct.elapsedTimeSeconds != evidence.elapsedTimeSeconds
                    || direct.elevationGainMeters != evidence.elevationGainMeters
            ) revert DirectProofMismatch();
        } else if (pact.missionType == MISSION_DUOLINGO_XP) {
            if (directProof.proofs.length != 2 || bytes(directProof.sessionId).length == 0) {
                revert InvalidProofBundle();
            }
            if (evidence.sessionIdHash != keccak256(bytes(directProof.sessionId))) revert InvalidMissionPolicy();
            LockInProofTypes.DuolingoEvidence memory direct = duolingoVerifier.validateDuolingoProofs(
                directProof.proofs, account, pactId, false, dayIndex, directProof.sessionId
            );
            bytes32 nullifier = keccak256(
                abi.encode(
                    keccak256("LOCK_IN_DUOLINGO_COMPLETION"), direct.identityHash, direct.totalXp, direct.proofSetHash
                )
            );
            if (
                direct.identityHash != evidence.identityHash || nullifier != evidence.eventNullifier
                    || direct.proofSetHash != evidence.proofSetHash || direct.totalXp != evidence.metric
                    || direct.proofTimestamp != evidence.occurredAt
                    || direct.proofTimestamp != evidence.oldestProofTimestamp
                    || direct.proofTimestamp != evidence.newestProofTimestamp || evidence.movingTimeSeconds != 0
                    || evidence.elapsedTimeSeconds != 0 || evidence.elevationGainMeters != 0
            ) revert DirectProofMismatch();
        } else {
            revert UnsupportedMission();
        }
    }

    function _verifyCompletionSignature(
        uint256 pactId,
        address account,
        uint8 dayIndex,
        CompletionEvidence calldata evidence
    ) private view {
        _validateAttestationWindow(evidence.issuedAt, evidence.expiresAt);
        bytes32 structHash = keccak256(
            abi.encode(
                COMPLETION_TYPEHASH,
                pactId,
                account,
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
        if (ECDSA.recover(_hashTypedDataV4(structHash), evidence.signature) != evidenceSigner) {
            revert InvalidEvidenceSigner();
        }
    }

    function _recordVerifiedDay(address account, uint8 missionType, bytes32 identityHash, uint64 occurredAt) private {
        address socialOwner = missionIdentityOwner[missionType][identityHash];
        if (socialOwner == address(0)) {
            missionIdentityOwner[missionType][identityHash] = account;
            emit MissionIdentityBound(missionType, identityHash, account);
        } else if (socialOwner != account) {
            // Social identity is global even though a verified completion can still settle its Lock.
            // This keeps scoring from changing payout rules while preventing one service account
            // from creating several leaderboard profiles through multiple wallets.
            return;
        }
        uint64 utcDay = occurredAt / uint64(1 days);
        if (!missionDayScored[account][missionType][utcDay]) {
            missionDayScored[account][missionType][utcDay] = true;
            uint32 missionDays = missionVerifiedDays[account][missionType] + 1;
            missionVerifiedDays[account][missionType] = missionDays;
            emit MissionDayVerified(account, missionType, utcDay, missionDays);
        }
        if (!scoredUtcDay[account][utcDay]) {
            scoredUtcDay[account][utcDay] = true;
            uint32 daysVerified = verifiedDays[account] + 1;
            uint64 score = lockScore[account] + LOCK_SCORE_PER_DAY;
            verifiedDays[account] = daysVerified;
            lockScore[account] = score;
            emit LockScoreAwarded(account, utcDay, LOCK_SCORE_PER_DAY, score, daysVerified);
        }
    }

    function _validHandle(bytes memory value) private pure returns (bool) {
        if (value.length < MIN_HANDLE_LENGTH || value.length > MAX_HANDLE_LENGTH) return false;
        if (value[0] < "a" || value[0] > "z") return false;
        for (uint256 i = 1; i < value.length; ++i) {
            bytes1 character = value[i];
            if ((character < "a" || character > "z") && (character < "0" || character > "9") && character != "_") {
                return false;
            }
        }
        return true;
    }

    function _requireEmptyDirectProof(LockInProofTypes.DirectProofBundle calldata directProof) private pure {
        if (directProof.proofs.length != 0 || bytes(directProof.sessionId).length != 0) revert InvalidProofBundle();
    }

    function _consumeAccess(
        address account,
        uint8 action,
        uint256 pactId,
        bytes32 expectedConfigHash,
        AccessEvidence calldata access
    ) private {
        if (access.nonce == bytes32(0)) revert InvalidProofHash();
        if (access.configHash != expectedConfigHash) revert InvalidConfigurationHash();
        _validateAttestationWindow(access.issuedAt, access.expiresAt);
        if (usedAccessNonces[access.nonce]) revert AccessAlreadyUsed();
        bytes32 structHash = keccak256(
            abi.encode(
                ACCESS_TYPEHASH,
                account,
                action,
                pactId,
                access.configHash,
                access.nonce,
                access.issuedAt,
                access.expiresAt
            )
        );
        if (ECDSA.recover(_hashTypedDataV4(structHash), access.signature) != accessSigner) {
            revert InvalidAccessSigner();
        }
        usedAccessNonces[access.nonce] = true;
    }

    function _bindIdentity(uint256 pactId, address account, bytes32 identityHash) private {
        if (identityHash == bytes32(0)) revert InvalidProofHash();
        bytes32 existing = participantIdentity[pactId][account];
        if (existing != bytes32(0) && existing != identityHash) revert IdentityMismatch();
        address owner = identityOwner[pactId][identityHash];
        if (owner != address(0) && owner != account) revert IdentityAlreadyUsed();
        if (existing == bytes32(0)) {
            participantIdentity[pactId][account] = identityHash;
            identityOwner[pactId][identityHash] = account;
            emit IdentityBound(pactId, account, identityHash);
        }
    }

    function _lockDuolingoIdentity(uint256 pactId, bytes32 identityHash) private {
        // XP totals are global counters. Forbidding overlapping pacts prevents one XP increase
        // from satisfying multiple stakes; XP above a daily target is deliberately not banked.
        uint256 lockedPact = activeDuolingoPact[identityHash];
        if (duolingoIdentityLockedUntil[identityHash] > block.timestamp && lockedPact != pactId) {
            revert DuolingoIdentityInActivePact();
        }
        activeDuolingoPact[identityHash] = pactId;
        duolingoIdentityLockedUntil[identityHash] = uint64(_submissionDeadline(pacts[pactId]));
    }

    function _validateAttestationWindow(uint64 issuedAt, uint64 expiresAt) private view {
        if (expiresAt < block.timestamp) revert AttestationExpired();
        if (
            issuedAt > block.timestamp + MAX_CLOCK_SKEW || issuedAt > expiresAt
                || uint256(issuedAt) + MAX_ATTESTATION_AGE < block.timestamp
                || uint256(expiresAt) > uint256(issuedAt) + MAX_ATTESTATION_AGE
        ) revert InvalidAttestationWindow();
    }

    function _pullStake(address account, uint256 amount) private {
        uint256 balanceBefore = stakeToken.balanceOf(address(this));
        stakeToken.safeTransferFrom(account, address(this), amount);
        if (stakeToken.balanceOf(address(this)) != balanceBefore + amount) revert UnsupportedStakeToken();
    }

    function _pushPayout(address account, uint256 amount) private {
        uint256 balanceBefore = stakeToken.balanceOf(account);
        stakeToken.safeTransfer(account, amount);
        if (stakeToken.balanceOf(account) != balanceBefore + amount) revert UnsupportedStakeToken();
    }

    function _validateConfiguration(
        uint96 stake,
        uint32 dailyTarget,
        uint8 durationDays,
        uint8 requiredCompletions,
        uint8 minParticipants,
        uint8 maxParticipants,
        uint64 startsAt,
        uint8 missionType
    ) private view {
        if (stake < MIN_STAKE || stake > MAX_STAKE) revert InvalidStake();
        if (
            durationDays < MIN_DURATION_DAYS || durationDays > MAX_DURATION_DAYS || requiredCompletions == 0
                || requiredCompletions > durationDays || minParticipants < MIN_PARTICIPANTS
                || minParticipants > maxParticipants || maxParticipants > MAX_PARTICIPANTS
        ) revert InvalidGoal();
        if (startsAt <= block.timestamp || uint256(startsAt) > block.timestamp + MAX_START_DELAY) {
            revert InvalidSchedule();
        }
        if (missionType == MISSION_STRAVA_RUN) {
            if (dailyTarget < MIN_STRAVA_DISTANCE_METERS || dailyTarget > MAX_STRAVA_DISTANCE_METERS) {
                revert InvalidGoal();
            }
        } else if (missionType == MISSION_DUOLINGO_XP) {
            if (dailyTarget < MIN_DUOLINGO_XP || dailyTarget > MAX_DUOLINGO_XP) revert InvalidGoal();
        } else {
            revert UnsupportedMission();
        }
    }

    function _missionPolicyHash(uint8 missionType) private view returns (bytes32) {
        address verifier;
        if (missionType == MISSION_STRAVA_RUN) verifier = address(stravaVerifier);
        else if (missionType == MISSION_DUOLINGO_XP) verifier = address(duolingoVerifier);
        else revert UnsupportedMission();
        return keccak256(abi.encode(POLICY_TYPEHASH, block.chainid, missionType, verifier, verifier.codehash));
    }

    function _hashPactConfiguration(
        uint96 stake,
        uint32 dailyTarget,
        uint8 durationDays,
        uint8 requiredCompletions,
        uint8 minParticipants,
        uint8 maxParticipants,
        uint64 startsAt,
        uint8 missionType,
        bytes32 missionPolicyHash_
    ) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                stake,
                dailyTarget,
                durationDays,
                requiredCompletions,
                minParticipants,
                maxParticipants,
                startsAt,
                missionType,
                missionPolicyHash_
            )
        );
    }

    function _pactConfigHash(Pact storage pact) private view returns (bytes32) {
        return _hashPactConfiguration(
            pact.stake,
            pact.dailyTarget,
            pact.durationDays,
            pact.requiredCompletions,
            pact.minParticipants,
            pact.maxParticipants,
            pact.startsAt,
            pact.missionType,
            pact.missionPolicyHash
        );
    }

    function _pact(uint256 pactId) private view returns (Pact storage pact) {
        pact = pacts[pactId];
        if (pact.creator == address(0)) revert PactNotFound();
    }

    function _endsAt(Pact storage pact) private view returns (uint256) {
        return uint256(pact.startsAt) + uint256(pact.durationDays) * 1 days;
    }

    function _submissionDeadline(Pact storage pact) private view returns (uint256) {
        return _endsAt(pact) + SUBMISSION_GRACE_PERIOD;
    }

    function _completionPauseAffected(Pact storage pact)
        private
        view
        returns (bool affected, uint64 pauseGeneration, uint64 pauseStartedAt)
    {
        uint256 startsAt = pact.startsAt;
        uint256 deadline = _submissionDeadline(pact);
        uint64 closedCount = completionPaused ? completionPauseGeneration - 1 : completionPauseGeneration;

        // Pause ends are monotonic. Binary search finds the first closed interval whose end is
        // strictly after pact start, then one start comparison proves whether the intervals overlap.
        uint64 low = 1;
        uint64 high = closedCount + 1;
        while (low < high) {
            uint64 middle = low + (high - low) / 2;
            if (completionPauseEndedAt[middle] > startsAt) high = middle;
            else low = middle + 1;
        }
        if (low <= closedCount) {
            pauseStartedAt = completionPauseStartedAt[low];
            if (pauseStartedAt < deadline) return (true, low, pauseStartedAt);
        }

        // The only unclosed interval is the current one. At the exclusive deadline a newly-started
        // pause cannot rewrite the already completed outcome.
        if (completionPaused) {
            pauseGeneration = completionPauseGeneration;
            pauseStartedAt = completionPauseStartedAt[pauseGeneration];
            if (pauseStartedAt < deadline) return (true, pauseGeneration, pauseStartedAt);
        }
        return (false, 0, 0);
    }
}
