// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Reclaim} from "@reclaimprotocol/solidity-sdk/contracts/Reclaim.sol";

/// @notice ABI types shared by the escrow and the two immutable direct-proof verifiers.
library LockInProofTypes {
    struct DirectProofBundle {
        string sessionId;
        Reclaim.Proof[] proofs;
    }

    struct DuolingoEvidence {
        bytes32 identityHash;
        bytes32 proofSetHash;
        uint64 totalXp;
        uint32 proofTimestamp;
    }

    struct StravaPolicy {
        address account;
        uint256 pactId;
        uint8 dayIndex;
        string expectedSessionId;
        string challenge;
        uint64 startsAt;
        uint64 endsAt;
        uint64 minDistanceMeters;
    }

    struct StravaEvidence {
        bytes32 identityHash;
        bytes32 nullifier;
        bytes32 proofSetHash;
        uint64 distanceMeters;
        uint64 startTime;
        uint64 movingTimeSeconds;
        uint64 elapsedTimeSeconds;
        uint64 elevationGainMeters;
        uint32 oldestProofTimestamp;
        uint32 newestProofTimestamp;
    }
}

interface ILockInDuolingoVerifier {
    function LIVE_SCHEMA_CONFIRMED() external view returns (bool);

    function validateDuolingoProofs(
        Reclaim.Proof[] calldata proofs,
        address account,
        uint256 pactId,
        bool baseline,
        uint8 dayIndex,
        string calldata expectedSessionId
    ) external view returns (LockInProofTypes.DuolingoEvidence memory evidence);
}

interface ILockInStravaVerifier {
    function LIVE_SCHEMA_CONFIRMED() external view returns (bool);

    function validateStravaProofs(Reclaim.Proof[] calldata proofs, LockInProofTypes.StravaPolicy calldata policy)
        external
        view
        returns (LockInProofTypes.StravaEvidence memory evidence);
}
