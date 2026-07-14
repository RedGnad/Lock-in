// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Reclaim} from "@reclaimprotocol/solidity-sdk/contracts/Reclaim.sol";

interface IReclaimVerifier {
    function verifyProof(Reclaim.Proof calldata proof) external returns (bool);
    function extractFieldFromContext(
        string calldata data,
        string calldata target
    ) external pure returns (string memory);
}

/// @notice Scheduled stable-token commitments settled from four direct Reclaim proofs.
/// @dev The four provider hashes pin the exact private Strava provider v1.0.2.
contract LockInEscrow is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant STRAVA_PROVIDER_KEY =
        keccak256("f3ec8292-d8f3-487c-a79d-f53f482f88e2@1.0.2");
    bytes32 public constant STRAVA_IDENTITY_HASH =
        0xdbb40a205e1a2036ccd2b371eebc19d6e01ae3a9b2cfd414d4d7abfbd9d11f67;
    bytes32 public constant STRAVA_CORE_HASH =
        0x2ef5ed61f33aa62f83c1ebf18c191b1b897db0d4a959368a365fff0c036dab2b;
    bytes32 public constant STRAVA_GPS_HASH =
        0x0bf30795f8148a6ec4d8609a71b7b6f7962f265169f6626e5b36b1f842460e27;
    bytes32 public constant STRAVA_TRAINER_HASH =
        0x26f22ca533a47f4af000231fd0a4de10b055985f2a32126bf2407de878a22040;
    bytes32 public constant COMPLETION_TYPEHASH = keccak256(
        "Completion(uint256 pactId,address account,uint8 dayIndex,bytes32 activityNullifier,bytes32 proofSetHash,uint64 expiresAt)"
    );

    uint256 public constant MAX_PARTICIPANTS = 100;
    uint256 public constant MAX_DAYS = 30;
    uint256 public constant VERSION = 3;
    uint256 public constant MAX_CLAIM_WINDOW = 1 days;
    uint256 public constant MAX_PROOF_AGE = 10 minutes;

    struct Pact {
        address creator;
        uint64 startsAt;
        uint64 claimDeadline;
        uint96 stake;
        uint32 minDistanceMeters;
        uint32 participantCount;
        uint32 finisherCount;
        uint32 claimedCount;
        uint8 durationDays;
        uint8 requiredCompletions;
        uint8 minParticipants;
        bytes32 challengeHash;
        bytes32 providerKey;
        uint256 remainingPool;
        bool finalized;
        bool cancelled;
    }

    struct StravaFields {
        string athleteMarker;
        string activityId;
        string activityName;
        string sportType;
        string startTime;
        string distanceRaw;
        string flagged;
        string movingTimeRaw;
        string elapsedTimeRaw;
        string elevationGainRaw;
        string hasLatLng;
        string trainer;
    }

    IERC20 public immutable stakeToken;
    IReclaimVerifier public immutable reclaim;
    uint256 public immutable maxStake;
    address public evidenceSigner;
    uint256 public nextPactId = 1;

    mapping(uint256 => Pact) public pacts;
    mapping(uint256 => string) public pactChallenges;
    mapping(uint256 => mapping(address => bool)) public joined;
    mapping(uint256 => mapping(address => uint256)) public completionBitmap;
    mapping(uint256 => mapping(address => uint8)) public completionCount;
    mapping(uint256 => mapping(address => bytes32)) public participantIdentity;
    mapping(uint256 => mapping(bytes32 => address)) public identityOwner;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(bytes32 => bool) public usedActivityNullifiers;

    event PactCreated(
        uint256 indexed pactId,
        address indexed creator,
        uint256 stake,
        uint32 minDistanceMeters,
        uint8 durationDays,
        uint8 requiredCompletions,
        uint8 minParticipants,
        uint64 startsAt,
        uint64 claimDeadline,
        bytes32 providerKey,
        string challenge
    );
    event PactJoined(uint256 indexed pactId, address indexed account);
    event DayProved(
        uint256 indexed pactId,
        address indexed account,
        uint8 indexed dayIndex,
        bytes32 activityNullifier,
        uint256 distanceMeters,
        uint256 activityTimestamp
    );
    event PactFinalized(uint256 indexed pactId, uint256 pool, uint256 finishers, bool cancelled);
    event PayoutClaimed(uint256 indexed pactId, address indexed account, uint256 amount);
    event PactCancelled(uint256 indexed pactId);
    event EvidenceSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event IdentityBound(uint256 indexed pactId, address indexed account, bytes32 indexed identityHash);

    error InvalidAddress();
    error InvalidStake();
    error InvalidSchedule();
    error InvalidChallenge();
    error InvalidGoal();
    error PactNotFound();
    error JoinClosed();
    error AlreadyJoined();
    error PactFull();
    error NotParticipant();
    error InvalidDay();
    error DayAlreadyProved();
    error InvalidProofContext();
    error InvalidProviderHash();
    error StaleProof();
    error InvalidStravaEvidence();
    error ActivityOutsideDay();
    error DistanceTooShort();
    error ActivityAlreadyUsed();
    error AttestationExpired();
    error InvalidEvidenceSigner();
    error SubmissionClosed();
    error PactNotStarted();
    error UnderfilledPact();
    error TargetAlreadyMet();
    error IdentityAlreadyUsed();
    error IdentityMismatch();
    error FinalizationTooEarly();
    error AlreadyFinalized();
    error NotFinalized();
    error NotEligible();
    error AlreadyClaimed();

    constructor(
        IERC20 stakeToken_,
        IReclaimVerifier reclaim_,
        address evidenceSigner_,
        uint256 maxStake_
    ) EIP712("Lock In", "3") {
        if (address(stakeToken_) == address(0) || address(reclaim_) == address(0) || evidenceSigner_ == address(0)) {
            revert InvalidAddress();
        }
        if (maxStake_ == 0 || maxStake_ > type(uint96).max) revert InvalidStake();
        stakeToken = stakeToken_;
        reclaim = reclaim_;
        evidenceSigner = evidenceSigner_;
        maxStake = maxStake_;
    }

    function createPact(
        uint96 stake,
        uint32 minDistanceMeters,
        uint8 durationDays,
        uint8 requiredCompletions,
        uint8 minParticipants,
        uint64 startsAt,
        uint64 claimDeadline,
        string calldata challenge
    ) external nonReentrant returns (uint256 pactId) {
        if (stake == 0 || stake > maxStake) revert InvalidStake();
        if (
            minDistanceMeters == 0 ||
            durationDays == 0 ||
            durationDays > MAX_DAYS ||
            requiredCompletions == 0 ||
            requiredCompletions > durationDays ||
            minParticipants == 0 ||
            (durationDays > 1 && minParticipants < 2) ||
            minParticipants > MAX_PARTICIPANTS
        ) {
            revert InvalidGoal();
        }
        uint256 endsAt = uint256(startsAt) + uint256(durationDays) * 1 days;
        if (
            startsAt < block.timestamp ||
            claimDeadline < endsAt ||
            claimDeadline > endsAt + MAX_CLAIM_WINDOW
        ) revert InvalidSchedule();
        if (!_isValidChallenge(challenge)) revert InvalidChallenge();

        pactId = nextPactId++;
        Pact storage pact = pacts[pactId];
        pact.creator = msg.sender;
        pact.startsAt = startsAt;
        pact.claimDeadline = claimDeadline;
        pact.stake = stake;
        pact.minDistanceMeters = minDistanceMeters;
        pact.participantCount = 1;
        pact.durationDays = durationDays;
        pact.requiredCompletions = requiredCompletions;
        pact.minParticipants = minParticipants;
        pact.challengeHash = keccak256(bytes(challenge));
        pact.providerKey = STRAVA_PROVIDER_KEY;
        pactChallenges[pactId] = challenge;

        joined[pactId][msg.sender] = true;
        stakeToken.safeTransferFrom(msg.sender, address(this), stake);
        emit PactCreated(
            pactId,
            msg.sender,
            stake,
            minDistanceMeters,
            durationDays,
            requiredCompletions,
            minParticipants,
            startsAt,
            claimDeadline,
            STRAVA_PROVIDER_KEY,
            challenge
        );
        emit PactJoined(pactId, msg.sender);
    }

    function joinPact(uint256 pactId) external nonReentrant {
        Pact storage pact = _pact(pactId);
        if (block.timestamp >= pact.startsAt || pact.cancelled) revert JoinClosed();
        if (joined[pactId][msg.sender]) revert AlreadyJoined();
        if (pact.participantCount >= MAX_PARTICIPANTS) revert PactFull();
        joined[pactId][msg.sender] = true;
        ++pact.participantCount;
        stakeToken.safeTransferFrom(msg.sender, address(this), pact.stake);
        emit PactJoined(pactId, msg.sender);
    }

    function submitStravaProofs(
        uint256 pactId,
        uint8 dayIndex,
        string calldata challenge,
        Reclaim.Proof[4] calldata proofs,
        uint64 expiresAt,
        bytes calldata validatorSignature
    ) external nonReentrant returns (bytes32 activityNullifier) {
        Pact storage pact = _pact(pactId);
        if (pact.finalized || pact.cancelled || block.timestamp > pact.claimDeadline) {
            revert SubmissionClosed();
        }
        if (block.timestamp < pact.startsAt) revert PactNotStarted();
        if (pact.participantCount < pact.minParticipants) revert UnderfilledPact();
        if (!joined[pactId][msg.sender]) revert NotParticipant();
        if (completionCount[pactId][msg.sender] >= pact.requiredCompletions) revert TargetAlreadyMet();
        if (dayIndex >= pact.durationDays) revert InvalidDay();
        uint256 dayMask = uint256(1) << dayIndex;
        uint256 previousBitmap = completionBitmap[pactId][msg.sender];
        if (previousBitmap & dayMask != 0) revert DayAlreadyProved();
        if (keccak256(bytes(challenge)) != pact.challengeHash) revert InvalidChallenge();

        _verifyProofSet(pactId, dayIndex, proofs);
        StravaFields memory fields = _extractStravaFields(proofs);
        uint256 distance;
        uint256 activityTime;
        (activityNullifier, distance, activityTime) = _validateStravaFields(
            pact,
            dayIndex,
            challenge,
            fields
        );
        if (block.timestamp > expiresAt || expiresAt > pact.claimDeadline) revert AttestationExpired();
        bytes32 setHash = keccak256(abi.encode(
            proofs[0].signedClaim.claim.identifier,
            proofs[1].signedClaim.claim.identifier,
            proofs[2].signedClaim.claim.identifier,
            proofs[3].signedClaim.claim.identifier
        ));
        if (
            ECDSA.recover(
                completionDigest(pactId, msg.sender, dayIndex, activityNullifier, setHash, expiresAt),
                validatorSignature
            ) != evidenceSigner
        ) revert InvalidEvidenceSigner();
        if (usedActivityNullifiers[activityNullifier]) revert ActivityAlreadyUsed();
        bytes32 identityHash = keccak256(abi.encode(STRAVA_PROVIDER_KEY, fields.athleteMarker));
        bytes32 boundIdentity = participantIdentity[pactId][msg.sender];
        if (boundIdentity == bytes32(0)) {
            address boundOwner = identityOwner[pactId][identityHash];
            if (boundOwner != address(0) && boundOwner != msg.sender) revert IdentityAlreadyUsed();
            participantIdentity[pactId][msg.sender] = identityHash;
            identityOwner[pactId][identityHash] = msg.sender;
            emit IdentityBound(pactId, msg.sender, identityHash);
        } else if (boundIdentity != identityHash) {
            revert IdentityMismatch();
        }
        usedActivityNullifiers[activityNullifier] = true;

        uint256 updatedBitmap = previousBitmap | dayMask;
        completionBitmap[pactId][msg.sender] = updatedBitmap;
        uint8 updatedCount = completionCount[pactId][msg.sender] + 1;
        completionCount[pactId][msg.sender] = updatedCount;
        if (updatedCount == pact.requiredCompletions) ++pact.finisherCount;
        emit DayProved(pactId, msg.sender, dayIndex, activityNullifier, distance, activityTime);
    }

    function _verifyProofSet(
        uint256 pactId,
        uint8 dayIndex,
        Reclaim.Proof[4] calldata proofs
    ) private {
        string memory expectedAddress = _addressToLowerHex(msg.sender);
        string memory expectedMessage = string.concat(_uintToString(pactId), ":", _uintToString(dayIndex));
        for (uint256 i; i < proofs.length; ++i) {
            reclaim.verifyProof(proofs[i]);
            string calldata context = proofs[i].claimInfo.context;
            if (
                !_equal(_extract(context, '"contextAddress":"'), expectedAddress) ||
                !_equal(_extract(context, '"contextMessage":"'), expectedMessage)
            ) revert InvalidProofContext();
            if (_hexStringToBytes32(_extract(context, '"providerHash":"')) != _expectedProviderHash(i)) {
                revert InvalidProviderHash();
            }
            uint256 timestamp = proofs[i].signedClaim.claim.timestampS;
            if (timestamp > block.timestamp + 60 || block.timestamp > timestamp + MAX_PROOF_AGE) {
                revert StaleProof();
            }
        }
    }

    function _extractStravaFields(
        Reclaim.Proof[4] calldata proofs
    ) private view returns (StravaFields memory fields) {
        fields.athleteMarker = _extract(proofs[0].claimInfo.context, '"marker":"');
        fields.activityId = _extract(proofs[1].claimInfo.context, '"id":"');
        fields.activityName = _extract(proofs[1].claimInfo.context, '"name":"');
        fields.sportType = _extract(proofs[1].claimInfo.context, '"type":"');
        fields.startTime = _extract(proofs[1].claimInfo.context, '"time":"');
        fields.distanceRaw = _extract(proofs[1].claimInfo.context, '"raw":"');
        fields.flagged = _extract(proofs[1].claimInfo.context, '"flagged":"');
        fields.movingTimeRaw = _extract(proofs[1].claimInfo.context, '"moving":"');
        fields.elapsedTimeRaw = _extract(proofs[1].claimInfo.context, '"elapsed":"');
        fields.elevationGainRaw = _extract(proofs[1].claimInfo.context, '"elevation":"');
        fields.hasLatLng = _extract(proofs[2].claimInfo.context, '"latlng":"');
        fields.trainer = _extract(proofs[3].claimInfo.context, '"trainer":"');
    }

    function _validateStravaFields(
        Pact storage pact,
        uint8 dayIndex,
        string calldata challenge,
        StravaFields memory fields
    ) private view returns (bytes32 nullifier, uint256 distance, uint256 activityTime) {
        if (
            !_startsWith(fields.athleteMarker, "userId: ") ||
            !_equal(fields.sportType, "Run") ||
            !_equal(fields.hasLatLng, "true") ||
            !_equal(fields.trainer, "false") ||
            !_equal(fields.flagged, "false") ||
            !_equal(fields.activityName, _dailyProofCode(challenge, dayIndex))
        ) revert InvalidStravaEvidence();

        uint256 activityId = _parseUint(fields.activityId);
        if (activityId == 0) revert InvalidStravaEvidence();
        distance = _parseUint(fields.distanceRaw);
        if (distance < pact.minDistanceMeters) revert DistanceTooShort();
        if (
            bytes(fields.movingTimeRaw).length == 0 ||
            bytes(fields.elapsedTimeRaw).length == 0 ||
            bytes(fields.elevationGainRaw).length == 0
        ) revert InvalidStravaEvidence();
        uint256 movingTime = _parseUint(fields.movingTimeRaw);
        uint256 elapsedTime = _parseUint(fields.elapsedTimeRaw);
        _parseUint(fields.elevationGainRaw);
        if (
            movingTime == 0 ||
            elapsedTime < movingTime ||
            distance > movingTime * 9 ||
            distance * 2 < movingTime ||
            elapsedTime > movingTime * 4 + 15 minutes
        ) revert InvalidStravaEvidence();
        activityTime = _parseStravaTimestamp(fields.startTime);
        uint256 dayStart = uint256(pact.startsAt) + uint256(dayIndex) * 1 days;
        if (activityTime < dayStart || activityTime >= dayStart + 1 days) {
            revert ActivityOutsideDay();
        }
        nullifier = keccak256(abi.encode(STRAVA_PROVIDER_KEY, fields.athleteMarker, activityId));
    }

    function finalizePact(uint256 pactId) public {
        Pact storage pact = _pact(pactId);
        if (pact.finalized) revert AlreadyFinalized();
        if (!pact.cancelled && block.timestamp >= pact.startsAt && pact.participantCount < pact.minParticipants) {
            pact.cancelled = true;
            emit PactCancelled(pactId);
        }
        if (!pact.cancelled && block.timestamp <= pact.claimDeadline) revert FinalizationTooEarly();
        pact.finalized = true;
        pact.remainingPool = uint256(pact.stake) * pact.participantCount;
        emit PactFinalized(pactId, pact.remainingPool, pact.finisherCount, pact.cancelled);
    }

    function claim(uint256 pactId) external nonReentrant returns (uint256 amount) {
        Pact storage pact = _pact(pactId);
        if (!pact.finalized) revert NotFinalized();
        if (claimed[pactId][msg.sender]) revert AlreadyClaimed();
        if (!joined[pactId][msg.sender]) revert NotParticipant();

        uint256 eligibleCount;
        if (pact.cancelled || pact.finisherCount == 0) {
            eligibleCount = pact.participantCount;
        } else {
            if (completionCount[pactId][msg.sender] < pact.requiredCompletions) revert NotEligible();
            eligibleCount = pact.finisherCount;
        }

        claimed[pactId][msg.sender] = true;
        ++pact.claimedCount;
        uint256 remainingClaims = eligibleCount - (pact.claimedCount - 1);
        amount = pact.remainingPool / remainingClaims;
        pact.remainingPool -= amount;
        stakeToken.safeTransfer(msg.sender, amount);
        emit PayoutClaimed(pactId, msg.sender, amount);
    }

    function cancelPact(uint256 pactId) external onlyOwner {
        Pact storage pact = _pact(pactId);
        if (pact.finalized) revert AlreadyFinalized();
        pact.cancelled = true;
        emit PactCancelled(pactId);
    }

    function completionDigest(
        uint256 pactId,
        address account,
        uint8 dayIndex,
        bytes32 activityNullifier,
        bytes32 setHash,
        uint64 expiresAt
    ) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            COMPLETION_TYPEHASH,
            pactId,
            account,
            dayIndex,
            activityNullifier,
            setHash,
            expiresAt
        )));
    }

    function setEvidenceSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert InvalidAddress();
        address previous = evidenceSigner;
        evidenceSigner = newSigner;
        emit EvidenceSignerUpdated(previous, newSigner);
    }

    function pactEndsAt(uint256 pactId) external view returns (uint256) {
        Pact storage pact = _pact(pactId);
        return uint256(pact.startsAt) + uint256(pact.durationDays) * 1 days;
    }

    function _expectedProviderHash(uint256 index) private pure returns (bytes32) {
        if (index == 0) return STRAVA_IDENTITY_HASH;
        if (index == 1) return STRAVA_CORE_HASH;
        if (index == 2) return STRAVA_GPS_HASH;
        return STRAVA_TRAINER_HASH;
    }

    function _extract(string calldata context, string memory target) private view returns (string memory) {
        return reclaim.extractFieldFromContext(context, target);
    }

    function _pact(uint256 pactId) private view returns (Pact storage pact) {
        pact = pacts[pactId];
        if (pact.creator == address(0)) revert PactNotFound();
    }

    function _isValidChallenge(string calldata challenge) private pure returns (bool) {
        bytes calldata value = bytes(challenge);
        if (value.length < 19 || value.length > 31 || value[0] != "L" || value[1] != "I" || value[2] != "-") {
            return false;
        }
        for (uint256 i = 3; i < value.length; ++i) {
            bytes1 c = value[i];
            if (!((c >= "A" && c <= "Z") || (c >= "0" && c <= "9"))) return false;
        }
        return true;
    }

    function _dailyProofCode(string calldata challenge, uint8 dayIndex) private pure returns (string memory) {
        uint256 dayNumber = uint256(dayIndex) + 1;
        return dayNumber < 10
            ? string.concat(challenge, "D0", _uintToString(dayNumber))
            : string.concat(challenge, "D", _uintToString(dayNumber));
    }

    function _parseStravaTimestamp(string memory value) private pure returns (uint256) {
        bytes memory data = bytes(value);
        bool utcZ = data.length == 20 && data[19] == "Z";
        bool utcOffset = data.length == 24 && data[19] == "+" && data[20] == "0" && data[21] == "0" && data[22] == "0" && data[23] == "0";
        if (!utcZ && !utcOffset) revert InvalidStravaEvidence();
        if (data[4] != "-" || data[7] != "-" || data[10] != "T" || data[13] != ":" || data[16] != ":") {
            revert InvalidStravaEvidence();
        }
        uint256 year = _digits(data, 0, 4);
        uint256 month = _digits(data, 5, 2);
        uint256 day = _digits(data, 8, 2);
        uint256 hour = _digits(data, 11, 2);
        uint256 minute = _digits(data, 14, 2);
        uint256 second = _digits(data, 17, 2);
        if (year < 1970 || month == 0 || month > 12 || day == 0 || day > _daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
            revert InvalidStravaEvidence();
        }
        return _daysFromDate(year, month, day) * 1 days + hour * 1 hours + minute * 1 minutes + second;
    }

    function _daysFromDate(uint256 year, uint256 month, uint256 day) private pure returns (uint256) {
        int256 y = int256(year);
        int256 m = int256(month);
        int256 d = int256(day);
        int256 daysValue = d - 32075 + (1461 * (y + 4800 + (m - 14) / 12)) / 4
            + (367 * (m - 2 - ((m - 14) / 12) * 12)) / 12
            - (3 * ((y + 4900 + (m - 14) / 12) / 100)) / 4 - 2440588;
        if (daysValue < 0) revert InvalidStravaEvidence();
        return uint256(daysValue);
    }

    function _daysInMonth(uint256 year, uint256 month) private pure returns (uint256) {
        if (month == 2) return (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) ? 29 : 28;
        return (month == 4 || month == 6 || month == 9 || month == 11) ? 30 : 31;
    }

    function _digits(bytes memory data, uint256 start, uint256 length) private pure returns (uint256 value) {
        for (uint256 i; i < length; ++i) {
            uint8 c = uint8(data[start + i]);
            if (c < 48 || c > 57) revert InvalidStravaEvidence();
            value = value * 10 + c - 48;
        }
    }

    function _parseUint(string memory value) private pure returns (uint256 result) {
        bytes memory data = bytes(value);
        if (data.length == 0) revert InvalidStravaEvidence();
        for (uint256 i; i < data.length; ++i) {
            uint8 c = uint8(data[i]);
            if (c < 48 || c > 57) revert InvalidStravaEvidence();
            result = result * 10 + c - 48;
        }
    }

    function _hexStringToBytes32(string memory value) private pure returns (bytes32 result) {
        bytes memory data = bytes(value);
        if (data.length != 66 || data[0] != "0" || data[1] != "x") revert InvalidProviderHash();
        uint256 parsed;
        for (uint256 i = 2; i < 66; ++i) {
            uint8 c = uint8(data[i]);
            uint8 nibble;
            if (c >= 48 && c <= 57) nibble = c - 48;
            else if (c >= 97 && c <= 102) nibble = c - 87;
            else if (c >= 65 && c <= 70) nibble = c - 55;
            else revert InvalidProviderHash();
            parsed = (parsed << 4) | nibble;
        }
        result = bytes32(parsed);
    }

    function _startsWith(string memory value, string memory prefix) private pure returns (bool) {
        bytes memory a = bytes(value);
        bytes memory b = bytes(prefix);
        if (b.length > a.length) return false;
        for (uint256 i; i < b.length; ++i) if (a[i] != b[i]) return false;
        return true;
    }

    function _equal(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _addressToLowerHex(address account) private pure returns (string memory) {
        bytes20 value = bytes20(account);
        bytes16 alphabet = "0123456789abcdef";
        bytes memory result = new bytes(42);
        result[0] = "0";
        result[1] = "x";
        for (uint256 i; i < 20; ++i) {
            result[2 + i * 2] = alphabet[uint8(value[i] >> 4)];
            result[3 + i * 2] = alphabet[uint8(value[i] & 0x0f)];
        }
        return string(result);
    }

    function _uintToString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        uint256 cursor = value;
        while (cursor != 0) { ++digits; cursor /= 10; }
        bytes memory output = new bytes(digits);
        while (value != 0) { --digits; output[digits] = bytes1(uint8(48 + value % 10)); value /= 10; }
        return string(output);
    }
}
