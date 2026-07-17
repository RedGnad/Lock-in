// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title  LockInDuolingoEscrow (Beta)
/// @notice Fixed-stake USDC Locks settled on a cumulative Duolingo XP delta, proved by Reclaim zkTLS.
/// @dev    DUOLINGO_ZKTLS_DELTA_V1. Two proofs per Lock: a BASELINE at create/join and one FINAL. A wallet
///         finishes when the backend attests it earned at least the Lock's target XP between the two, and
///         only the backend evidence signer is trusted: a compromised key can mint completions that never
///         happened, exactly as documented for STRAVA_OAUTH_V1 on the Strava escrow. This is a SEPARATE
///         contract; it shares no storage with the Strava escrow, holds no social layer, and never calls
///         it. It emits normalised events so an off-chain indexer can unify the two, and never publishes a
///         raw Duolingo profile id: identities are HMAC pseudonyms computed off-chain.
contract LockInDuolingoEscrow is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint256 public constant CONTRACT_SCHEMA_ID = 1;
    bytes32 public constant DUOLINGO_XP_SCHEME = keccak256("DUOLINGO_ZKTLS_DELTA_V1");
    bytes32 public constant POLICY_TYPEHASH = keccak256("MissionPolicy(uint256 chainId,bytes32 scheme)");
    bytes32 public constant BASELINE_TYPEHASH = keccak256(
        "Baseline(address account,bytes32 configHash,bytes32 identityHash,bytes32 nullifier,uint64 issuedAt,uint64 expiresAt)"
    );
    bytes32 public constant FINAL_TYPEHASH = keccak256(
        "Final(uint256 pactId,address account,bytes32 identityHash,uint32 earnedXp,uint32 targetXp,bytes32 nullifier,uint64 occurredAt,uint64 issuedAt,uint64 expiresAt)"
    );

    uint8 public constant MIN_PARTICIPANTS = 2;
    uint8 public constant MAX_PARTICIPANTS = 100;
    uint32 public constant MIN_TARGET_XP = 10;
    uint32 public constant MAX_TARGET_XP = 1_000_000;
    uint32 public constant MIN_DURATION_SECONDS = 30 minutes;
    uint32 public constant MAX_DURATION_SECONDS = 30 days;
    uint256 public constant MIN_STAKE = 100_000;
    uint256 public constant MAX_STAKE = 1_000_000;
    uint256 public constant MAX_ATTESTATION_AGE = 10 minutes;
    uint256 public constant MAX_CLOCK_SKEW = 1 minutes;
    uint256 public constant MAX_START_DELAY = 24 hours;
    uint256 public constant SUBMISSION_GRACE_PERIOD = 1 hours;

    struct DuoPact {
        address creator;
        uint64 startsAt;
        uint32 durationSeconds;
        uint96 stake;
        uint32 targetXp;
        uint32 participantCount;
        uint32 finisherCount;
        uint32 claimsRemaining;
        uint8 minParticipants;
        uint8 maxParticipants;
        uint64 completionPauseGenerationAtCreation;
        bytes32 missionPolicyHash;
        uint256 remainingPool;
        bool finalized;
        bool cancelled;
    }

    /// @dev The baseline attestation, presented at create and at join. `configHash` binds the exact Lock
    ///      terms (at create) or the existing Lock's terms (at join), so a baseline for one Lock cannot be
    ///      replayed into another. `identityHash` is the HMAC pseudonym, never the raw profile id.
    struct BaselineEvidence {
        bytes32 configHash;
        bytes32 identityHash;
        bytes32 nullifier;
        uint64 issuedAt;
        uint64 expiresAt;
        bytes signature;
    }

    /// @dev The final attestation. `earnedXp` is the delta the backend computed between the immutable
    ///      baseline and the final proof; the contract only checks it clears the Lock's target.
    struct FinalEvidence {
        bytes32 identityHash;
        uint32 earnedXp;
        uint32 targetXp;
        bytes32 nullifier;
        uint64 occurredAt;
        uint64 issuedAt;
        uint64 expiresAt;
        bytes signature;
    }

    IERC20 public immutable stakeToken;
    address public evidenceSigner;
    uint256 public nextPactId = 1;
    uint64 public completionPauseGeneration = 1;

    bool public creationPaused;
    bool public joiningPaused;
    bool public completionPaused;

    mapping(uint256 => DuoPact) public pacts;
    mapping(uint256 => mapping(address => bool)) public joined;
    mapping(uint256 => mapping(address => bool)) public completed;
    mapping(uint256 => mapping(address => bytes32)) public participantIdentity;
    mapping(uint256 => mapping(bytes32 => address)) public identityOwner;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(bytes32 => bool) public usedNullifiers;
    mapping(uint64 => uint64) public completionPauseStartedAt;
    mapping(uint64 => uint64) public completionPauseEndedAt;

    event PactCreated(
        uint256 indexed pactId,
        address indexed creator,
        uint96 stake,
        uint32 targetXp,
        uint32 durationSeconds,
        uint8 minParticipants,
        uint8 maxParticipants,
        uint64 startsAt,
        bytes32 missionPolicyHash
    );
    event PactJoined(uint256 indexed pactId, address indexed account);
    event IdentityBound(uint256 indexed pactId, address indexed account, bytes32 indexed identityHash);
    event CompletionVerified(uint256 indexed pactId, address indexed account, uint32 targetXp, uint64 occurredAt);
    event PactCancelled(uint256 indexed pactId);
    event PactFinalized(uint256 indexed pactId, uint256 pool, uint32 eligibleClaimants, uint32 finisherCount, bool cancelled);
    event PayoutClaimed(uint256 indexed pactId, address indexed account, uint256 amount);
    event EvidenceSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event CreationPauseUpdated(bool paused);
    event JoiningPauseUpdated(bool paused);
    event CompletionPauseUpdated(bool paused);
    event PactRefundedForCompletionPause(uint256 indexed pactId, uint64 indexed pauseGeneration, uint64 pauseStartedAt);

    error InvalidAddress();
    error InvalidTokenDecimals();
    error InvalidStake();
    error InvalidGoal();
    error InvalidSchedule();
    error PactNotFound();
    error CreationIsPaused();
    error JoiningIsPaused();
    error CompletionIsPaused();
    error JoinClosed();
    error AlreadyJoined();
    error PactFull();
    error NotParticipant();
    error AlreadyCompleted();
    error OutsideChallengeWindow();
    error UnderfilledPact();
    error TargetNotMet();
    error NullifierAlreadyUsed();
    error InvalidEvidenceSigner();
    error AttestationExpired();
    error InvalidAttestationWindow();
    error InvalidProofHash();
    error InvalidMissionPolicy();
    error InvalidConfigurationHash();
    error UnsupportedStakeToken();
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

    constructor(IERC20 stakeToken_, address evidenceSigner_) EIP712("Lock In Duolingo", "1") {
        if (address(stakeToken_) == address(0) || evidenceSigner_ == address(0)) revert InvalidAddress();
        if (IERC20Metadata(address(stakeToken_)).decimals() != 6) revert InvalidTokenDecimals();
        stakeToken = stakeToken_;
        evidenceSigner = evidenceSigner_;
        creationPaused = true;
        joiningPaused = true;
        completionPaused = true;
        completionPauseStartedAt[1] = uint64(block.timestamp);
    }

    /// @notice Creates a Lock and atomically joins it, in one transaction with the stake and the baseline.
    ///         A baseline is never recorded without its stake, and a stake is never accepted without a
    ///         valid baseline: both happen here or neither does.
    function createPact(
        uint96 stake,
        uint32 targetXp,
        uint32 durationSeconds,
        uint8 minParticipants,
        uint8 maxParticipants,
        uint64 startsAt,
        BaselineEvidence calldata baseline
    ) external nonReentrant returns (uint256 pactId) {
        if (creationPaused) revert CreationIsPaused();
        _validateConfiguration(stake, targetXp, durationSeconds, minParticipants, maxParticipants, startsAt);
        bytes32 configHash =
            _hashConfiguration(stake, targetXp, durationSeconds, minParticipants, maxParticipants, startsAt);
        _consumeBaseline(msg.sender, configHash, baseline);

        pactId = nextPactId++;
        DuoPact storage pact = pacts[pactId];
        pact.creator = msg.sender;
        pact.startsAt = startsAt;
        pact.durationSeconds = durationSeconds;
        pact.stake = stake;
        pact.targetXp = targetXp;
        pact.participantCount = 1;
        pact.minParticipants = minParticipants;
        pact.maxParticipants = maxParticipants;
        pact.missionPolicyHash = _missionPolicyHash();
        pact.completionPauseGenerationAtCreation = completionPauseGeneration;

        joined[pactId][msg.sender] = true;
        _bindIdentity(pactId, msg.sender, baseline.identityHash);
        _pullStake(msg.sender, stake);

        emit PactCreated(
            pactId, msg.sender, stake, targetXp, durationSeconds, minParticipants, maxParticipants, startsAt, pact.missionPolicyHash
        );
        emit PactJoined(pactId, msg.sender);
    }

    /// @notice Joins before the published start, with the stake and a fresh baseline in one transaction.
    function joinPact(uint256 pactId, BaselineEvidence calldata baseline) external nonReentrant {
        if (joiningPaused) revert JoiningIsPaused();
        DuoPact storage pact = _pact(pactId);
        if (pact.cancelled || pact.finalized || block.timestamp >= pact.startsAt) revert JoinClosed();
        if (joined[pactId][msg.sender]) revert AlreadyJoined();
        if (pact.participantCount >= pact.maxParticipants) revert PactFull();
        _consumeBaseline(msg.sender, _pactConfigHash(pact), baseline);

        joined[pactId][msg.sender] = true;
        ++pact.participantCount;
        _bindIdentity(pactId, msg.sender, baseline.identityHash);
        _pullStake(msg.sender, pact.stake);
        emit PactJoined(pactId, msg.sender);
    }

    /// @notice Records the single completion for a participant: the backend-attested XP delta cleared the
    ///         Lock's target. A short final does not complete; a new final proof can be tried until the
    ///         submission deadline.
    function submitFinal(uint256 pactId, FinalEvidence calldata evidence) external nonReentrant {
        if (completionPaused) revert CompletionIsPaused();
        DuoPact storage pact = _pact(pactId);
        if (pact.cancelled || pact.finalized) revert OutsideChallengeWindow();
        if (pact.participantCount < pact.minParticipants) revert UnderfilledPact();
        if (!joined[pactId][msg.sender]) revert NotParticipant();
        if (completed[pactId][msg.sender]) revert AlreadyCompleted();

        uint256 startsAt = pact.startsAt;
        uint256 endsAt = startsAt + uint256(pact.durationSeconds);
        // The final must have been observed inside the challenge, and submitted inside the challenge plus
        // the grace period. Baselines are taken before startsAt, so this also keeps the final after it.
        if (evidence.occurredAt < startsAt || evidence.occurredAt > endsAt) revert OutsideChallengeWindow();
        if (evidence.occurredAt > block.timestamp + MAX_CLOCK_SKEW) revert OutsideChallengeWindow();
        if (block.timestamp < startsAt || block.timestamp >= endsAt + SUBMISSION_GRACE_PERIOD) {
            revert OutsideChallengeWindow();
        }
        if (evidence.nullifier == bytes32(0)) revert InvalidProofHash();
        if (usedNullifiers[evidence.nullifier]) revert NullifierAlreadyUsed();
        // The target on the evidence must be the Lock's target: the objective is immutable.
        if (evidence.targetXp != pact.targetXp) revert InvalidMissionPolicy();
        if (evidence.earnedXp < pact.targetXp) revert TargetNotMet();

        // Same identity as the baseline bound this wallet to. A final on another account is refused.
        bytes32 bound = participantIdentity[pactId][msg.sender];
        if (evidence.identityHash != bound) revert IdentityMismatch();

        _verifyFinalSignature(pactId, msg.sender, evidence);

        usedNullifiers[evidence.nullifier] = true;
        completed[pactId][msg.sender] = true;
        ++pact.finisherCount;

        emit CompletionVerified(pactId, msg.sender, evidence.targetXp, evidence.occurredAt);
    }

    function cancelPact(uint256 pactId) external {
        DuoPact storage pact = _pact(pactId);
        if (msg.sender != pact.creator) revert NotCreator();
        if (pact.finalized) revert AlreadyFinalized();
        if (pact.cancelled) revert AlreadyCancelled();
        if (block.timestamp >= pact.startsAt) revert CancellationClosed();
        pact.cancelled = true;
        emit PactCancelled(pactId);
    }

    function cancelPactByOwner(uint256 pactId) external onlyOwner {
        DuoPact storage pact = _pact(pactId);
        if (pact.finalized) revert AlreadyFinalized();
        if (pact.cancelled) revert AlreadyCancelled();
        pact.cancelled = true;
        emit PactCancelled(pactId);
    }

    /// @notice Permissionless finalization. Pause flags never block settlement or claims.
    function finalizePact(uint256 pactId) public {
        DuoPact storage pact = _pact(pactId);
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
        DuoPact storage pact = _pact(pactId);
        if (!pact.finalized) revert NotFinalized();
        if (!joined[pactId][msg.sender]) revert NotParticipant();
        if (claimed[pactId][msg.sender]) revert AlreadyClaimed();
        if (!pact.cancelled && pact.finisherCount != 0 && !completed[pactId][msg.sender]) revert NotEligible();

        claimed[pactId][msg.sender] = true;
        amount = pact.remainingPool / pact.claimsRemaining;
        pact.remainingPool -= amount;
        --pact.claimsRemaining;
        _pushPayout(msg.sender, amount);
        emit PayoutClaimed(pactId, msg.sender, amount);
    }

    // --- views -----------------------------------------------------------------------------------------

    function pactEndsAt(uint256 pactId) external view returns (uint256) {
        DuoPact storage pact = _pact(pactId);
        return uint256(pact.startsAt) + uint256(pact.durationSeconds);
    }

    function pactSubmissionDeadline(uint256 pactId) external view returns (uint256) {
        return _submissionDeadline(_pact(pactId));
    }

    function pactConfigHash(uint256 pactId) external view returns (bytes32) {
        return _pactConfigHash(_pact(pactId));
    }

    function hashConfiguration(
        uint96 stake,
        uint32 targetXp,
        uint32 durationSeconds,
        uint8 minParticipants,
        uint8 maxParticipants,
        uint64 startsAt
    ) external view returns (bytes32) {
        return _hashConfiguration(stake, targetXp, durationSeconds, minParticipants, maxParticipants, startsAt);
    }

    function missionPolicyHash() external view returns (bytes32) {
        return _missionPolicyHash();
    }

    function isFinisher(uint256 pactId, address account) external view returns (bool) {
        return joined[pactId][account] && completed[pactId][account];
    }

    function getPact(uint256 pactId) external view returns (DuoPact memory) {
        return _pact(pactId);
    }

    // --- owner ------------------------------------------------------------------------------------------

    function setEvidenceSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert InvalidAddress();
        emit EvidenceSignerUpdated(evidenceSigner, newSigner);
        evidenceSigner = newSigner;
    }

    function setCreationPaused(bool paused) external onlyOwner {
        creationPaused = paused;
        emit CreationPauseUpdated(paused);
    }

    function setJoiningPaused(bool paused) external onlyOwner {
        joiningPaused = paused;
        emit JoiningPauseUpdated(paused);
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

    // --- internals --------------------------------------------------------------------------------------

    function _consumeBaseline(address account, bytes32 expectedConfigHash, BaselineEvidence calldata baseline) private {
        if (baseline.nullifier == bytes32(0) || baseline.identityHash == bytes32(0)) revert InvalidProofHash();
        if (baseline.configHash != expectedConfigHash) revert InvalidConfigurationHash();
        _validateAttestationWindow(baseline.issuedAt, baseline.expiresAt);
        if (usedNullifiers[baseline.nullifier]) revert NullifierAlreadyUsed();
        bytes32 structHash = keccak256(
            abi.encode(
                BASELINE_TYPEHASH, account, baseline.configHash, baseline.identityHash, baseline.nullifier, baseline.issuedAt, baseline.expiresAt
            )
        );
        if (ECDSA.recover(_hashTypedDataV4(structHash), baseline.signature) != evidenceSigner) {
            revert InvalidEvidenceSigner();
        }
        usedNullifiers[baseline.nullifier] = true;
    }

    function _verifyFinalSignature(uint256 pactId, address account, FinalEvidence calldata evidence) private view {
        _validateAttestationWindow(evidence.issuedAt, evidence.expiresAt);
        bytes32 structHash = keccak256(
            abi.encode(
                FINAL_TYPEHASH,
                pactId,
                account,
                evidence.identityHash,
                evidence.earnedXp,
                evidence.targetXp,
                evidence.nullifier,
                evidence.occurredAt,
                evidence.issuedAt,
                evidence.expiresAt
            )
        );
        if (ECDSA.recover(_hashTypedDataV4(structHash), evidence.signature) != evidenceSigner) {
            revert InvalidEvidenceSigner();
        }
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
        uint32 targetXp,
        uint32 durationSeconds,
        uint8 minParticipants,
        uint8 maxParticipants,
        uint64 startsAt
    ) private view {
        if (stake < MIN_STAKE || stake > MAX_STAKE) revert InvalidStake();
        if (
            targetXp < MIN_TARGET_XP || targetXp > MAX_TARGET_XP || durationSeconds < MIN_DURATION_SECONDS
                || durationSeconds > MAX_DURATION_SECONDS || minParticipants < MIN_PARTICIPANTS
                || minParticipants > maxParticipants || maxParticipants > MAX_PARTICIPANTS
        ) revert InvalidGoal();
        if (startsAt <= block.timestamp || uint256(startsAt) > block.timestamp + MAX_START_DELAY) {
            revert InvalidSchedule();
        }
    }

    function _missionPolicyHash() private view returns (bytes32) {
        return keccak256(abi.encode(POLICY_TYPEHASH, block.chainid, DUOLINGO_XP_SCHEME));
    }

    function _hashConfiguration(
        uint96 stake,
        uint32 targetXp,
        uint32 durationSeconds,
        uint8 minParticipants,
        uint8 maxParticipants,
        uint64 startsAt
    ) private view returns (bytes32) {
        return keccak256(
            abi.encode(stake, targetXp, durationSeconds, minParticipants, maxParticipants, startsAt, _missionPolicyHash())
        );
    }

    function _pactConfigHash(DuoPact storage pact) private view returns (bytes32) {
        return _hashConfiguration(
            pact.stake, pact.targetXp, pact.durationSeconds, pact.minParticipants, pact.maxParticipants, pact.startsAt
        );
    }

    function _pact(uint256 pactId) private view returns (DuoPact storage pact) {
        pact = pacts[pactId];
        if (pact.creator == address(0)) revert PactNotFound();
    }

    function _submissionDeadline(DuoPact storage pact) private view returns (uint256) {
        return uint256(pact.startsAt) + uint256(pact.durationSeconds) + SUBMISSION_GRACE_PERIOD;
    }

    function _completionPauseAffected(DuoPact storage pact)
        private
        view
        returns (bool affected, uint64 pauseGeneration, uint64 pauseStartedAt)
    {
        uint256 startsAt = pact.startsAt;
        uint256 deadline = _submissionDeadline(pact);
        uint64 closedCount = completionPaused ? completionPauseGeneration - 1 : completionPauseGeneration;

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
        if (completionPaused) {
            pauseGeneration = completionPauseGeneration;
            pauseStartedAt = completionPauseStartedAt[pauseGeneration];
            if (pauseStartedAt < deadline) return (true, pauseGeneration, pauseStartedAt);
        }
        return (false, 0, 0);
    }
}
