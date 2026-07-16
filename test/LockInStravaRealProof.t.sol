// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Reclaim} from "@reclaimprotocol/solidity-sdk/contracts/Reclaim.sol";
import {Claims} from "@reclaimprotocol/solidity-sdk/contracts/lib/Claims.sol";
import {LockInProofTypes} from "../contracts/verifiers/LockInProofTypes.sol";
import {
    LockInStravaClaimParser,
    LockInStravaReclaimVerifier
} from "../contracts/verifiers/LockInStravaReclaimVerifier.sol";

interface VmStrava {
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
    function expectRevert(bytes4 revertData) external;
}

/// @dev Exposes the internal grammar so the REAL captured proof can be validated
///      without flipping the fail-closed production entry.
contract StravaRealProofHarness is LockInStravaReclaimVerifier {
    constructor(address pinnedWitness, address parser) LockInStravaReclaimVerifier(pinnedWitness, parser) {}

    function validateForTesting(Reclaim.Proof[] calldata proofs, LockInProofTypes.StravaPolicy calldata policy)
        external
        view
        returns (LockInProofTypes.StravaEvidence memory)
    {
        return _validateStravaProofs(proofs, policy);
    }
}

/// @notice Feeds the real, live-captured Strava 6.0.0 two-claim proof set through the FINAL on-chain
///         verifier grammar. The capture (session fa8968844e) already passes the production SDK barrier
///         verifyProof(6.0.0, allowedTags: [], teeAttestation) with isVerified and isTeeAttestationVerified
///         true. Passing this test proves the on-chain grammar accepts the same bytes, which is the
///         evidence required before LIVE_SCHEMA_CONFIRMED can be flipped.
contract LockInStravaRealProofTest {
    VmStrava private constant VM = VmStrava(address(uint160(uint256(keccak256("hevm cheat code")))));
    // The pinned Reclaim witness the production verifier expects.
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

    /// @dev The real capture binds a personal wallet to a personal Strava account, so it is NOT committed.
    ///      It lives in a gitignored private directory (override with LOCK_IN_PRIVATE_FIXTURES). When it is
    ///      absent, as in public CI, these tests skip rather than fail: the grammar itself stays covered by
    ///      the synthetic suite in LockInStravaReclaimVerifier.t.sol.
    /// @dev The filename carries the provider version on purpose. A 6.0.0 capture is not a 7.0.0 proof (it
    ///      still signs context_challenge), so it must never be silently replayed against this grammar.
    ///      These tests stay skipped until a real 7.0.0 capture exists.
    function _fixture() private returns (string memory) {
        string memory dir = VM.envOr("LOCK_IN_PRIVATE_FIXTURES", string("private-fixtures"));
        string memory path = string.concat(VM.projectRoot(), "/", dir, "/strava-real-onchain-7.0.0.json");
        if (!VM.isFile(path)) {
            VM.skip(true);
            return "";
        }
        return VM.readFile(path);
    }

    function _proofs(string memory json) private pure returns (Reclaim.Proof[] memory proofs) {
        proofs = new Reclaim.Proof[](2);
        proofs[0] = _readProof(json, 0);
        proofs[1] = _readProof(json, 1);
    }

    function _harness() private returns (StravaRealProofHarness) {
        LockInStravaClaimParser parser = new LockInStravaClaimParser();
        return new StravaRealProofHarness(REAL_WITNESS, address(parser));
    }

    /// @dev minDistanceMeters is 200 here because this capture is a 209 m diagnostic run. That is BELOW
    ///      LockInEscrow.MIN_STRAVA_DISTANCE_METERS (500), so this fixture proves the grammar, the
    ///      signature and the extraction, but it could never satisfy a real Lock: the escrow refuses any
    ///      dailyTarget under 500 m. The release capture must be a run of at least 500 m and be exercised
    ///      against a policy using the real target.
    function _policy(string memory json) private pure returns (LockInProofTypes.StravaPolicy memory policy) {
        uint256 startTime = 1784140730; // 2026-07-15T18:38:50+0000, the real run's start_time
        policy = LockInProofTypes.StravaPolicy({
            account: VM.parseJsonAddress(json, ".account"),
            pactId: 0,
            dayIndex: 0,
            expectedSessionId: VM.parseJsonString(json, ".sessionId"),
            startsAt: uint64(startTime - 1 hours),
            endsAt: uint64(startTime + 1 hours),
            minDistanceMeters: 200
        });
    }

    /// @dev The REAL captured Strava 6.0.0 pair passes the FINAL two-claim grammar: the canonical context
    ///      hashes to the signed identifier, the pinned witness signature recovers, the request is pinned
    ///      from claimData.parameters (url/method/body/matches/redactions/paramValues) rather than from a
    ///      context.providerHash (which 6.0.0 does not emit), and the claim binds to the account through
    ///      contextAddress/contextMessage/reclaimSessionId rather than the placeholder owner.
    function testRealCapturedStravaProofsPassFinalGrammar() public {
        string memory json = _fixture();
        Reclaim.Proof[] memory proofs = _proofs(json);

        uint32 newest = proofs[1].signedClaim.claim.timestampS;
        if (proofs[0].signedClaim.claim.timestampS > newest) newest = proofs[0].signedClaim.claim.timestampS;
        VM.warp(uint256(newest) + 5);

        LockInProofTypes.StravaEvidence memory evidence = _harness().validateForTesting(proofs, _policy(json));

        require(evidence.identityHash != bytes32(0), "identityHash empty");
        require(evidence.nullifier != bytes32(0), "nullifier empty");
        require(
            evidence.proofSetHash
                == keccak256(
                    abi.encodePacked(proofs[0].signedClaim.claim.identifier, proofs[1].signedClaim.claim.identifier)
                ),
            "proofSetHash mismatch"
        );
        // The real run: 209 m, 117 s moving, 147 s elapsed, 0 m elevation gain.
        require(evidence.distanceMeters == 209, "distance mismatch");
        require(evidence.movingTimeSeconds == 117, "moving mismatch");
        require(evidence.elapsedTimeSeconds == 147, "elapsed mismatch");
        require(evidence.elevationGainMeters == 0, "elevation mismatch");
        require(evidence.startTime == 1784140730, "startTime mismatch");
        require(evidence.oldestProofTimestamp == proofs[0].signedClaim.claim.timestampS, "oldest mismatch");
        require(evidence.newestProofTimestamp == proofs[1].signedClaim.claim.timestampS, "newest mismatch");
    }

    /// @dev The live context really does carry isAiProof/isPortalProof = true, and the parser reads them as
    ///      canonical booleans without gating on them. This asserts the flags the fixture records, so a
    ///      future capture that changes them is caught here rather than silently accepted.
    function testRealCapturedStravaContextFlagsAreParsedNotGated() public {
        string memory json = _fixture();
        Reclaim.Proof[] memory proofs = _proofs(json);
        LockInStravaClaimParser parser = new LockInStravaClaimParser();
        LockInProofTypes.StravaPolicy memory policy = _policy(json);

        LockInStravaClaimParser.ContextPolicy memory contextPolicy = LockInStravaClaimParser.ContextPolicy({
            account: policy.account, message: VM.parseJsonString(json, ".contextMessage"), sessionId: policy.expectedSessionId
        });

        LockInStravaClaimParser.ParsedFields memory marker =
            parser.parseProofData(proofs[0].claimInfo.parameters, proofs[0].claimInfo.context, 0, contextPolicy);
        LockInStravaClaimParser.ParsedFields memory activity =
            parser.parseProofData(proofs[1].claimInfo.parameters, proofs[1].claimInfo.context, 1, contextPolicy);

        require(marker.isAiProof == VM.parseJsonBool(json, ".isAiProof"), "marker isAiProof mismatch");
        require(marker.isPortalProof == VM.parseJsonBool(json, ".isPortalProof"), "marker isPortalProof mismatch");
        require(activity.isAiProof == VM.parseJsonBool(json, ".isAiProof"), "activity isAiProof mismatch");
        require(activity.isPortalProof == VM.parseJsonBool(json, ".isPortalProof"), "activity isPortalProof mismatch");
        // Both claims are attested in one session, so the folded TEE group and proxy egress must agree.
        require(marker.teeGroupHash == activity.teeGroupHash, "teeGroupHash mismatch");
        require(marker.geoHash == activity.geoHash, "geoHash mismatch");
        require(activity.latlng && !activity.trainer && !activity.flagged, "activity flags mismatch");
    }

    /// @dev The production entry stays fail-closed while the provenance items are open.
    function testProductionEntryStaysGated() public {
        string memory json = _fixture();
        Reclaim.Proof[] memory proofs = _proofs(json);
        StravaRealProofHarness harness = _harness();
        VM.warp(uint256(proofs[1].signedClaim.claim.timestampS) + 5);
        VM.expectRevert(LockInStravaReclaimVerifier.LiveSchemaUnconfirmed.selector);
        harness.validateStravaProofs(proofs, _policy(json));
    }

    /// @dev A proof set bound to another wallet must not validate: binding comes from the signed
    ///      contextAddress, and the placeholder owner cannot substitute for it.
    function testRealProofsRejectAnotherAccount() public {
        string memory json = _fixture();
        Reclaim.Proof[] memory proofs = _proofs(json);
        StravaRealProofHarness harness = _harness();
        VM.warp(uint256(proofs[1].signedClaim.claim.timestampS) + 5);

        LockInProofTypes.StravaPolicy memory policy = _policy(json);
        policy.account = address(0xBEEF);
        VM.expectRevert(LockInStravaClaimParser.InvalidContext.selector);
        harness.validateForTesting(proofs, policy);
    }
}
