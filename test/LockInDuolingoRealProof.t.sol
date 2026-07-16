// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Reclaim} from "@reclaimprotocol/solidity-sdk/contracts/Reclaim.sol";
import {Claims} from "@reclaimprotocol/solidity-sdk/contracts/lib/Claims.sol";
import {LockInReclaimVerifier} from "../contracts/verifiers/LockInReclaimVerifier.sol";

interface VmReal {
    function warp(uint256 timestamp) external;
    function projectRoot() external view returns (string memory);
    function readFile(string calldata path) external view returns (string memory);
    function isFile(string calldata path) external returns (bool);
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory);
    function skip(bool skipTest) external;
    function parseJsonString(string calldata json, string calldata key) external pure returns (string memory);
    function parseJsonBytes32(string calldata json, string calldata key) external pure returns (bytes32);
    function parseJsonAddress(string calldata json, string calldata key) external pure returns (address);
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
    function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
    function parseJsonBool(string calldata json, string calldata key) external pure returns (bool);
}

/// @dev Exposes the internal grammar so the REAL captured proof can be validated
///      without flipping the fail-closed production entry.
contract RealProofHarness is LockInReclaimVerifier {
    constructor(address pinnedWitness) LockInReclaimVerifier(pinnedWitness) {}

    function validateForTesting(
        Reclaim.Proof[] calldata proofs,
        address account,
        uint256 pactId,
        bool baseline,
        uint8 dayIndex,
        string calldata expectedSessionId
    ) external view returns (bytes32 identityHash, uint64 totalXp, bytes32 proofHash, uint32 timestampS) {
        return _validateDuolingoProofs(proofs, account, pactId, baseline, dayIndex, expectedSessionId);
    }
}

/// @notice Feeds the real, live-captured Duolingo 1.0.8 proof pair through the FINAL
///         on-chain verifier grammar. Passing this demonstrates the schema the deployed
///         verifier expects, so LIVE_SCHEMA_CONFIRMED can be flipped with evidence.
contract LockInDuolingoRealProofTest {
    VmReal private constant VM = VmReal(address(uint160(uint256(keccak256("hevm cheat code")))));
    // The pinned Reclaim witness the production verifier expects (EXPECTED_RECLAIM_WITNESS).
    address private constant REAL_WITNESS = 0x244897572368Eadf65bfBc5aec98D8e5443a9072;

    function _readProof(string memory json, uint256 i) private pure returns (Reclaim.Proof memory proof) {
        string memory p = string.concat(".proofs[", _u(i), "]");
        proof.claimInfo = Claims.ClaimInfo({
            provider: VM.parseJsonString(json, string.concat(p, ".provider")),
            parameters: VM.parseJsonString(json, string.concat(p, ".parameters")),
            context: VM.parseJsonString(json, string.concat(p, ".context"))
        });
        proof.signedClaim.claim = Claims.CompleteClaimData({
            identifier: VM.parseJsonBytes32(json, string.concat(p, ".identifier")),
            owner: VM.parseJsonAddress(json, string.concat(p, ".owner")),
            timestampS: uint32(VM.parseJsonUint(json, string.concat(p, ".timestampS"))),
            epoch: uint32(VM.parseJsonUint(json, string.concat(p, ".epoch")))
        });
        proof.signedClaim.signatures = new bytes[](1);
        proof.signedClaim.signatures[0] = VM.parseJsonBytes(json, string.concat(p, ".signature"));
    }

    function _u(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory b;
        while (v > 0) {
            b = abi.encodePacked(uint8(48 + (v % 10)), b);
            v /= 10;
        }
        return string(b);
    }

    /// @dev The REAL captured Duolingo 1.0.8 proof pair now passes the FINAL grammar:
    ///      identifier (canonical context from the app's toDirectProofBundle hashes to the
    ///      signed identifier), the pinned Reclaim witness signature, freshness, and the
    ///      cross-proof TEE group. The two proofs come from different enclave instances so
    ///      pcr0_t and tee_session_id differ; the group binds the shared invariants
    ///      (attestationNonce, attestation timestamp, pcr0_k) plus the witness. Passing this
    ///      is the evidence required before flipping LIVE_SCHEMA_CONFIRMED.
    /// @dev The real capture binds a personal wallet to a personal Duolingo profile, so it is NOT committed.
    ///      It lives in a gitignored private directory (override with LOCK_IN_PRIVATE_FIXTURES). When it is
    ///      absent, as in public CI, this test skips rather than fails: the grammar itself stays covered by
    ///      the synthetic suite in LockInReclaimVerifier.t.sol.
    function _fixture() private returns (string memory) {
        string memory dir = VM.envOr("LOCK_IN_PRIVATE_FIXTURES", string("private-fixtures"));
        string memory path = string.concat(VM.projectRoot(), "/", dir, "/duolingo-real-onchain.json");
        if (!VM.isFile(path)) {
            VM.skip(true);
            return "";
        }
        return VM.readFile(path);
    }

    function testRealCapturedDuolingoProofPassesFinalGrammar() public {
        string memory json = _fixture();

        Reclaim.Proof[] memory proofs = new Reclaim.Proof[](2);
        proofs[0] = _readProof(json, 0);
        proofs[1] = _readProof(json, 1);

        address account = VM.parseJsonAddress(json, ".account");
        string memory sessionId = VM.parseJsonString(json, ".sessionId");
        uint256 pactId = VM.parseJsonUint(json, ".pactId");
        bool baseline = VM.parseJsonBool(json, ".baseline");
        uint256 expectedXp = VM.parseJsonUint(json, ".totalXp");

        uint32 newest = proofs[1].signedClaim.claim.timestampS;
        if (proofs[0].signedClaim.claim.timestampS > newest) newest = proofs[0].signedClaim.claim.timestampS;
        VM.warp(uint256(newest) + 5);

        RealProofHarness verifier = new RealProofHarness(REAL_WITNESS);
        (bytes32 identityHash, uint64 totalXp,, uint32 timestampS) =
            verifier.validateForTesting(proofs, account, pactId, baseline, 0, sessionId);

        require(identityHash != bytes32(0), "identityHash empty");
        require(uint256(totalXp) == expectedXp, "totalXp mismatch");
        require(timestampS == proofs[1].signedClaim.claim.timestampS, "timestamp unexpected");
    }
}
