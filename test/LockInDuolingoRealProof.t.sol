// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Reclaim} from "@reclaimprotocol/solidity-sdk/contracts/Reclaim.sol";
import {Claims} from "@reclaimprotocol/solidity-sdk/contracts/lib/Claims.sol";
import {LockInReclaimVerifier} from "../contracts/verifiers/LockInReclaimVerifier.sol";

interface VmReal {
    function warp(uint256 timestamp) external;
    function projectRoot() external view returns (string memory);
    function readFile(string calldata path) external view returns (string memory);
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

    /// @dev Documents the confirmed release gap: the REAL captured Duolingo 1.0.8 proof
    ///      pair passes the identifier, witness signature and freshness checks (the canonical
    ///      context reconstructed by the app's toDirectProofBundle hashes to the signed
    ///      identifier, and the pinned Reclaim witness recovers), but the final grammar
    ///      REVERTS with InvalidContext at the TEE-group equality check
    ///      (`ownership.teeGroupHash != xp.teeGroupHash`). Root cause, verified off-chain:
    ///      Reclaim generated the two requests in DIFFERENT enclaves, so pcr0_t and
    ///      tee_session_id differ between the ownership and XP proofs, while the verifier
    ///      requires both proofs to share an identical TEE group. LIVE_SCHEMA_CONFIRMED must
    ///      stay false until the verifier's cross-proof TEE binding is reconciled with real
    ///      Reclaim behaviour. Flip this assertion to expect success once that is fixed.
    function testRealCapturedDuolingoProofIsRejectedByCurrentTeeGrouping() public {
        string memory json = VM.readFile(string.concat(VM.projectRoot(), "/test/fixtures/duolingo-real-onchain.json"));

        Reclaim.Proof[] memory proofs = new Reclaim.Proof[](2);
        proofs[0] = _readProof(json, 0);
        proofs[1] = _readProof(json, 1);

        address account = VM.parseJsonAddress(json, ".account");
        string memory sessionId = VM.parseJsonString(json, ".sessionId");
        uint256 pactId = VM.parseJsonUint(json, ".pactId");
        bool baseline = VM.parseJsonBool(json, ".baseline");

        uint32 newest = proofs[1].signedClaim.claim.timestampS;
        if (proofs[0].signedClaim.claim.timestampS > newest) newest = proofs[0].signedClaim.claim.timestampS;
        VM.warp(uint256(newest) + 5);

        RealProofHarness verifier = new RealProofHarness(REAL_WITNESS);
        (bool ok, bytes memory reason) = address(verifier).staticcall(
            abi.encodeCall(RealProofHarness.validateForTesting, (proofs, account, pactId, baseline, 0, sessionId))
        );
        require(!ok, "real proof unexpectedly accepted; revisit the gap analysis");
        require(reason.length >= 4, "no revert selector");
        bytes4 sel = bytes4(reason);
        // InvalidContext() selector.
        require(sel == bytes4(keccak256("InvalidContext()")), "unexpected revert reason");
    }
}
