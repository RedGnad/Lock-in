// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/// @notice Social commitment escrow with mission-specific, privacy-minimal completion rules.
/// @dev V4 deliberately supports only a native Monad check-in. Future mission types should
///      add a verifier path while keeping raw third-party data out of contract storage/events.
contract LockInEscrowV4 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant MISSION_MONAD_CHECK_IN = 1;
    bytes32 public constant MONAD_CHECK_IN_MISSION_KEY = keccak256("LOCK_IN_MONAD_CHECK_IN@1");
    uint8 public constant MIN_DURATION_DAYS = 3;
    uint8 public constant MAX_DURATION_DAYS = 30;
    uint8 public constant MIN_PARTICIPANTS = 2;
    uint8 public constant MAX_PARTICIPANTS = 100;
    uint256 public constant MAX_STAKE = 1_000_000;
    uint256 public constant VERSION = 4;

    struct Pact {
        address creator;
        uint64 startsAt;
        uint96 stake;
        uint32 participantCount;
        uint32 finisherCount;
        uint32 claimsRemaining;
        uint8 durationDays;
        uint8 requiredCompletions;
        uint8 minParticipants;
        uint8 missionType;
        bytes32 missionKey;
        bytes32 missionConfigHash;
        uint256 remainingPool;
        bool finalized;
        bool cancelled;
    }

    IERC20 public immutable stakeToken;
    uint256 public nextPactId = 1;

    bool public creationPaused;
    bool public joiningPaused;
    bool public checkInsPaused;

    mapping(uint256 => Pact) public pacts;
    mapping(uint256 => mapping(address => bool)) public joined;
    mapping(uint256 => mapping(address => uint256)) public completionBitmap;
    mapping(uint256 => mapping(address => uint8)) public completionCount;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(bytes32 => bool) public usedEventNullifiers;

    event PactCreated(
        uint256 indexed pactId,
        address indexed creator,
        uint8 indexed missionType,
        uint256 stake,
        uint8 durationDays,
        uint8 requiredCompletions,
        uint8 minParticipants,
        uint64 startsAt,
        bytes32 missionKey,
        bytes32 missionConfigHash
    );
    event PactJoined(uint256 indexed pactId, address indexed account);
    event CheckedIn(
        uint256 indexed pactId,
        address indexed account,
        uint8 indexed dayIndex,
        bytes32 eventNullifier,
        uint64 occurredAt
    );
    event PactCancelled(uint256 indexed pactId);
    event PactFinalized(
        uint256 indexed pactId, uint256 pool, uint256 eligibleClaimants, uint256 finishers, bool cancelled
    );
    event PayoutClaimed(uint256 indexed pactId, address indexed account, uint256 amount);
    event CreationPauseUpdated(bool paused);
    event JoiningPauseUpdated(bool paused);
    event CheckInsPauseUpdated(bool paused);

    error InvalidAddress();
    error InvalidTokenDecimals();
    error InvalidStake();
    error InvalidGoal();
    error InvalidSchedule();
    error UnsupportedMission();
    error PactNotFound();
    error CreationIsPaused();
    error JoiningIsPaused();
    error CheckInsArePaused();
    error JoinClosed();
    error AlreadyJoined();
    error PactFull();
    error NotParticipant();
    error InvalidDay();
    error CheckInOutsideDay();
    error DayAlreadyCompleted();
    error TargetAlreadyMet();
    error UnderfilledPact();
    error SubmissionClosed();
    error EventAlreadyUsed();
    error NotCreator();
    error CancellationClosed();
    error AlreadyCancelled();
    error FinalizationTooEarly();
    error AlreadyFinalized();
    error NotFinalized();
    error NotEligible();
    error AlreadyClaimed();

    constructor(IERC20 stakeToken_) {
        if (address(stakeToken_) == address(0)) revert InvalidAddress();
        if (IERC20Metadata(address(stakeToken_)).decimals() != 6) revert InvalidTokenDecimals();
        stakeToken = stakeToken_;
    }

    /// @notice Creates and joins a fixed-stake pact. Registration remains open until `startsAt`.
    /// @param missionConfigHash Commitment to optional offchain display metadata; no raw data is stored.
    function createPact(
        uint96 stake,
        uint8 durationDays,
        uint8 requiredCompletions,
        uint8 minParticipants,
        uint64 startsAt,
        uint8 missionType,
        bytes32 missionConfigHash
    ) external nonReentrant returns (uint256 pactId) {
        if (creationPaused) revert CreationIsPaused();
        if (stake == 0 || stake > MAX_STAKE) revert InvalidStake();
        if (
            durationDays < MIN_DURATION_DAYS || durationDays > MAX_DURATION_DAYS || requiredCompletions == 0
                || requiredCompletions > durationDays || minParticipants < MIN_PARTICIPANTS
                || minParticipants > MAX_PARTICIPANTS
        ) revert InvalidGoal();
        if (startsAt <= block.timestamp) revert InvalidSchedule();
        if (missionType != MISSION_MONAD_CHECK_IN) revert UnsupportedMission();

        pactId = nextPactId++;
        Pact storage pact = pacts[pactId];
        pact.creator = msg.sender;
        pact.startsAt = startsAt;
        pact.stake = stake;
        pact.participantCount = 1;
        pact.durationDays = durationDays;
        pact.requiredCompletions = requiredCompletions;
        pact.minParticipants = minParticipants;
        pact.missionType = missionType;
        pact.missionKey = MONAD_CHECK_IN_MISSION_KEY;
        pact.missionConfigHash = missionConfigHash;

        joined[pactId][msg.sender] = true;
        stakeToken.safeTransferFrom(msg.sender, address(this), stake);

        emit PactCreated(
            pactId,
            msg.sender,
            missionType,
            stake,
            durationDays,
            requiredCompletions,
            minParticipants,
            startsAt,
            MONAD_CHECK_IN_MISSION_KEY,
            missionConfigHash
        );
        emit PactJoined(pactId, msg.sender);
    }

    function joinPact(uint256 pactId) external nonReentrant {
        if (joiningPaused) revert JoiningIsPaused();
        Pact storage pact = _pact(pactId);
        if (pact.cancelled || pact.finalized || block.timestamp >= pact.startsAt) revert JoinClosed();
        if (joined[pactId][msg.sender]) revert AlreadyJoined();
        if (pact.participantCount >= MAX_PARTICIPANTS) revert PactFull();

        joined[pactId][msg.sender] = true;
        ++pact.participantCount;
        stakeToken.safeTransferFrom(msg.sender, address(this), pact.stake);
        emit PactJoined(pactId, msg.sender);
    }

    /// @notice Records one native check-in for the exact pact day containing the current timestamp.
    function checkIn(uint256 pactId, uint8 dayIndex) external nonReentrant returns (bytes32 eventNullifier) {
        if (checkInsPaused) revert CheckInsArePaused();
        Pact storage pact = _pact(pactId);
        if (pact.cancelled || pact.finalized) revert SubmissionClosed();
        if (pact.missionType != MISSION_MONAD_CHECK_IN) revert UnsupportedMission();
        if (pact.participantCount < pact.minParticipants) revert UnderfilledPact();
        if (!joined[pactId][msg.sender]) revert NotParticipant();
        if (completionCount[pactId][msg.sender] >= pact.requiredCompletions) revert TargetAlreadyMet();
        if (dayIndex >= pact.durationDays) revert InvalidDay();

        uint256 dayStart = uint256(pact.startsAt) + uint256(dayIndex) * 1 days;
        if (block.timestamp < dayStart || block.timestamp >= dayStart + 1 days) {
            revert CheckInOutsideDay();
        }

        uint256 dayMask = uint256(1) << dayIndex;
        uint256 previousBitmap = completionBitmap[pactId][msg.sender];
        if (previousBitmap & dayMask != 0) revert DayAlreadyCompleted();

        eventNullifier = checkInNullifier(pactId, msg.sender, dayIndex);
        if (usedEventNullifiers[eventNullifier]) revert EventAlreadyUsed();
        usedEventNullifiers[eventNullifier] = true;
        completionBitmap[pactId][msg.sender] = previousBitmap | dayMask;

        uint8 updatedCount = completionCount[pactId][msg.sender] + 1;
        completionCount[pactId][msg.sender] = updatedCount;
        if (updatedCount == pact.requiredCompletions) ++pact.finisherCount;

        emit CheckedIn(pactId, msg.sender, dayIndex, eventNullifier, uint64(block.timestamp));
    }

    /// @notice The creator may cancel only during registration. Every participant is then refunded.
    function cancelPact(uint256 pactId) external {
        Pact storage pact = _pact(pactId);
        if (msg.sender != pact.creator) revert NotCreator();
        if (pact.finalized) revert AlreadyFinalized();
        if (pact.cancelled) revert AlreadyCancelled();
        if (block.timestamp >= pact.startsAt) revert CancellationClosed();
        pact.cancelled = true;
        emit PactCancelled(pactId);
    }

    /// @notice Emergency circuit breaker. It can only convert an unsettled pact into full refunds.
    /// @dev The owner cannot redirect funds; participants still claim their own stake permissionlessly.
    function cancelPactByOwner(uint256 pactId) external onlyOwner {
        Pact storage pact = _pact(pactId);
        if (pact.finalized) revert AlreadyFinalized();
        if (pact.cancelled) revert AlreadyCancelled();
        pact.cancelled = true;
        emit PactCancelled(pactId);
    }

    /// @notice Permissionless finalization. Pause flags never block settlement.
    function finalizePact(uint256 pactId) public {
        Pact storage pact = _pact(pactId);
        if (pact.finalized) revert AlreadyFinalized();

        if (!pact.cancelled && block.timestamp >= pact.startsAt && pact.participantCount < pact.minParticipants) {
            pact.cancelled = true;
            emit PactCancelled(pactId);
        }

        if (!pact.cancelled && block.timestamp < _endsAt(pact)) revert FinalizationTooEarly();

        uint32 eligibleClaimants =
            pact.cancelled || pact.finisherCount == 0 ? pact.participantCount : pact.finisherCount;
        pact.finalized = true;
        pact.claimsRemaining = eligibleClaimants;
        pact.remainingPool = uint256(pact.stake) * pact.participantCount;

        emit PactFinalized(pactId, pact.remainingPool, eligibleClaimants, pact.finisherCount, pact.cancelled);
    }

    /// @notice Claims an exact share. The last eligible claimant receives any integer-division dust.
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

        stakeToken.safeTransfer(msg.sender, amount);
        emit PayoutClaimed(pactId, msg.sender, amount);
    }

    function checkInNullifier(uint256 pactId, address account, uint8 dayIndex) public view returns (bytes32) {
        return
            keccak256(abi.encode(block.chainid, address(this), MONAD_CHECK_IN_MISSION_KEY, pactId, account, dayIndex));
    }

    function pactEndsAt(uint256 pactId) external view returns (uint256) {
        return _endsAt(_pact(pactId));
    }

    /// @notice Returns the Pact tuple in the struct declaration order above.
    function getPact(uint256 pactId) external view returns (Pact memory) {
        return _pact(pactId);
    }

    function isFinisher(uint256 pactId, address account) external view returns (bool) {
        Pact storage pact = _pact(pactId);
        return joined[pactId][account] && completionCount[pactId][account] >= pact.requiredCompletions;
    }

    function setCreationPaused(bool paused) external onlyOwner {
        creationPaused = paused;
        emit CreationPauseUpdated(paused);
    }

    function setJoiningPaused(bool paused) external onlyOwner {
        joiningPaused = paused;
        emit JoiningPauseUpdated(paused);
    }

    function setCheckInsPaused(bool paused) external onlyOwner {
        checkInsPaused = paused;
        emit CheckInsPauseUpdated(paused);
    }

    function _pact(uint256 pactId) private view returns (Pact storage pact) {
        pact = pacts[pactId];
        if (pact.creator == address(0)) revert PactNotFound();
    }

    function _endsAt(Pact storage pact) private view returns (uint256) {
        return uint256(pact.startsAt) + uint256(pact.durationDays) * 1 days;
    }
}
