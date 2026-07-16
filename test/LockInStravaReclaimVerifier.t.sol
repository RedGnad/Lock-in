// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Reclaim} from "@reclaimprotocol/solidity-sdk/contracts/Reclaim.sol";
import {Claims} from "@reclaimprotocol/solidity-sdk/contracts/lib/Claims.sol";
import {
    LockInStravaClaimParser,
    LockInStravaReclaimVerifier
} from "../contracts/verifiers/LockInStravaReclaimVerifier.sol";
import {LockInProofTypes} from "../contracts/verifiers/LockInProofTypes.sol";

interface VmStravaVerifier {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 timestamp) external;
}

/// @dev Test-only adapter. This contract is defined under `test/`, is never a deployment target, and exposes only
///      the internal grammar needed by fixture tests.
contract LockInStravaReclaimVerifierHarness is LockInStravaReclaimVerifier {
    constructor(address pinnedWitness, address parser) LockInStravaReclaimVerifier(pinnedWitness, parser) {}

    function validateSyntheticStravaProofsForTesting(
        Reclaim.Proof[] calldata proofs,
        LockInProofTypes.StravaPolicy calldata policy
    ) external view returns (LockInProofTypes.StravaEvidence memory evidence) {
        return _validateStravaProofs(proofs, policy);
    }
}

/// @notice Synthetic fixtures for the two-claim Strava 6.0.0 grammar: role 0 is the athlete marker on
///         /athlete/training, role 1 is the combined activity claim. The fixtures reproduce the exact
///         published request envelope (the pinned responseMatches/responseRedactions byte slices come
///         verbatim from the real capture) but carry synthetic values and a synthetic witness, so the
///         behavioural rules can be exercised independently of the one real proof set.
/// @dev The real capture is covered separately by test/LockInStravaRealProof.t.sol.
contract LockInStravaReclaimVerifierTest {
    VmStravaVerifier private constant VM = VmStravaVerifier(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant WITNESS_KEY = 0xA11CE55;
    uint256 private constant WRONG_WITNESS_KEY = 0xBADBEEF;
    uint32 private constant PROOF_TIME = 1_784_102_500;
    address private constant ACCOUNT = address(uint160(0xA11C));
    uint256 private constant PACT_ID = 42;
    uint8 private constant DAY_INDEX = 0;
    uint64 private constant STARTS_AT = 1_784_073_600;
    uint64 private constant ACTIVITY_TIME = 1_784_102_400;
    uint64 private constant ENDS_AT = 1_784_160_000;

    string private constant SESSION = "session-123";
    string private constant CHALLENGE = "LI-ABCDEFGHIJKLMNOPD01";
    string private constant MARKER = "userId: 987654";
    string private constant ACTIVITY_ID = "19309163477";
    string private constant NONCE = "276acec29135bea3e1b85d54f9922444cf7fb114f8c1e9351169b1f940c2d36a";

    LockInStravaReclaimVerifierHarness private verifier;

    function setUp() public {
        VM.warp(uint256(PROOF_TIME) + 100);
        LockInStravaClaimParser parser = new LockInStravaClaimParser();
        verifier = new LockInStravaReclaimVerifierHarness(VM.addr(WITNESS_KEY), address(parser));
    }

    function testProductionEntryFailsClosedWhileSchemaIsUnconfirmed() public {
        LockInStravaClaimParser parser = new LockInStravaClaimParser();
        LockInStravaReclaimVerifier productionVerifier =
            new LockInStravaReclaimVerifier(VM.addr(WITNESS_KEY), address(parser));
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        LockInProofTypes.StravaPolicy memory policy = _policy();
        (bool ok, bytes memory reason) = address(productionVerifier)
            .staticcall(abi.encodeCall(productionVerifier.validateStravaProofs, (proofs, policy)));

        require(!ok, "unconfirmed production verifier accepted proofs");
        require(
            _revertSelector(reason) == LockInStravaReclaimVerifier.LiveSchemaUnconfirmed.selector,
            "unexpected production revert"
        );
    }

    function testValidCanonicalTwoProofSet() public {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        LockInProofTypes.StravaEvidence memory evidence =
            verifier.validateSyntheticStravaProofsForTesting(proofs, _policy());

        bytes32 providerKey = keccak256("f3ec8292-d8f3-487c-a79d-f53f482f88e2@6.0.0");
        require(evidence.identityHash == keccak256(abi.encode(providerKey, MARKER)), "wrong identity");
        require(
            evidence.nullifier == keccak256(abi.encode(providerKey, MARKER, uint256(19_309_163_477))), "wrong nullifier"
        );
        require(
            evidence.proofSetHash
                == keccak256(
                    abi.encodePacked(proofs[0].signedClaim.claim.identifier, proofs[1].signedClaim.claim.identifier)
                ),
            "wrong proof set hash"
        );
        require(evidence.distanceMeters == 5000, "wrong distance");
        require(evidence.startTime == ACTIVITY_TIME, "wrong start time");
        require(evidence.movingTimeSeconds == 1500, "wrong moving time");
        require(evidence.elapsedTimeSeconds == 1800, "wrong elapsed time");
        require(evidence.elevationGainMeters == 50, "wrong elevation");
        require(evidence.oldestProofTimestamp == PROOF_TIME, "wrong oldest proof");
        require(evidence.newestProofTimestamp == PROOF_TIME + 1, "wrong newest proof");
        require(!verifier.LIVE_SCHEMA_CONFIRMED(), "schema marked live before confirmation");
    }

    function testAcceptsEquivalentUtcOffsetTimestamp() public {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        proofs[1] = _changeEverywhere(proofs[1], "2026-07-15T08:00:00Z", "2026-07-15T10:00:00+0200", WITNESS_KEY);
        LockInProofTypes.StravaEvidence memory evidence =
            verifier.validateSyntheticStravaProofsForTesting(proofs, _policy());
        require(evidence.startTime == ACTIVITY_TIME, "offset timestamp changed instant");
    }

    function testRejectsIdentifierSignatureAndWitnessTampering() public {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        proofs[0].signedClaim.claim.identifier = bytes32(0);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WRONG_WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[1].signedClaim.signatures = new bytes[](0);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[1].signedClaim.claim.epoch = 2;
        proofs[1] = _resign(proofs[1], WITNESS_KEY);
        _assertRejected(proofs, _policy());
    }

    /// @dev `claimData.owner` is the legacy placeholder in live 6.0.0 proofs and carries no binding value,
    ///      so the verifier must ignore it entirely: changing it must not change the verdict either way.
    function testOwnerIsIgnoredAndBindingComesFromContext() public {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        proofs[0].signedClaim.claim.owner = address(0xB0B);
        proofs[0] = _resign(proofs[0], WITNESS_KEY);
        proofs[1].signedClaim.claim.owner = address(0xB0B);
        proofs[1] = _resign(proofs[1], WITNESS_KEY);
        LockInProofTypes.StravaEvidence memory evidence =
            verifier.validateSyntheticStravaProofsForTesting(proofs, _policy());
        require(evidence.distanceMeters == 5000, "owner change altered the verdict");

        // The account binding lives in the signed contextAddress, which must still be enforced.
        proofs = _validProofs(WITNESS_KEY);
        LockInProofTypes.StravaPolicy memory policy = _policy();
        policy.account = address(0xB0B);
        _assertRejected(proofs, policy);
    }

    function testRejectsProofOrderAndProofCount() public {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        Reclaim.Proof memory swap = proofs[0];
        proofs[0] = proofs[1];
        proofs[1] = swap;
        _assertRejected(proofs, _policy());

        Reclaim.Proof[] memory three = new Reclaim.Proof[](3);
        three[0] = _proof(0, WITNESS_KEY, PROOF_TIME);
        three[1] = _proof(1, WITNESS_KEY, PROOF_TIME + 1);
        three[2] = _proof(1, WITNESS_KEY, PROOF_TIME + 1);
        _assertRejected(three, _policy());

        Reclaim.Proof[] memory one = new Reclaim.Proof[](1);
        one[0] = _proof(0, WITNESS_KEY, PROOF_TIME);
        _assertRejected(one, _policy());
    }

    /// @dev The two claims must come from one attested session: the folded TEE group (attestationNonce +
    ///      attestation timestamp) and the proxy egress must agree across both proofs.
    function testRejectsCrossSessionTeeGroupAndGeoMismatch() public {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        proofs[1].claimInfo.context = _replaceOnce(
            proofs[1].claimInfo.context, NONCE, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        proofs[1] = _rebindAndSign(proofs[1], WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[1].claimInfo.context = _replaceOnce(proofs[1].claimInfo.context, "\"1784102500000\"", "\"1784102500001\"");
        proofs[1] = _rebindAndSign(proofs[1], WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[1].claimInfo.parameters =
            _replaceOnce(proofs[1].claimInfo.parameters, "\"geoLocation\":\"FR\"", "\"geoLocation\":\"US\"");
        proofs[1] = _rebindAndSign(proofs[1], WITNESS_KEY);
        _assertRejected(proofs, _policy());
    }

    function testRejectsForeignAttestationApplicationAndVersion() public {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        proofs[0].claimInfo.context = _replaceOnce(
            proofs[0].claimInfo.context,
            "0x15678cD04e54ccc2bC1c24cb455be3C60Eb11ADf",
            "0x0000000000000000000000000000000000000bad"
        );
        proofs[0] = _rebindAndSign(proofs[0], WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[0].claimInfo.context =
            _replaceOnce(proofs[0].claimInfo.context, "\"attestationVersion\":\"v3\"", "\"attestationVersion\":\"v2\"");
        proofs[0] = _rebindAndSign(proofs[0], WITNESS_KEY);
        _assertRejected(proofs, _policy());

        // The attestation must belong to the initiated Reclaim session.
        proofs = _validProofs(WITNESS_KEY);
        proofs[0].claimInfo.context = _replaceOnce(
            proofs[0].claimInfo.context,
            "\"sessionId\":\"session-123\"",
            "\"sessionId\":\"session-attacker\""
        );
        proofs[0] = _rebindAndSign(proofs[0], WITNESS_KEY);
        _assertRejected(proofs, _policy());
    }

    function testRejectsContextAccountPactDaySessionAndAthleteMutations() public {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        proofs[0].claimInfo.context = _replaceOnce(
            proofs[0].claimInfo.context,
            "0x000000000000000000000000000000000000a11c",
            "0x0000000000000000000000000000000000000b0b"
        );
        proofs[0] = _rebindAndSign(proofs[0], WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[1].claimInfo.context = _replaceOnce(proofs[1].claimInfo.context, "\"42:0\"", "\"43:0\"");
        proofs[1] = _rebindAndSign(proofs[1], WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[1].claimInfo.context =
            _replaceOnce(proofs[1].claimInfo.context, "\"reclaimSessionId\":\"session-123\"", "\"reclaimSessionId\":\"session-attacker\"");
        proofs[1] = _rebindAndSign(proofs[1], WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[1].claimInfo.parameters =
            _replaceOnce(proofs[1].claimInfo.parameters, "\"proxySessionId\":\"session-123\"", "\"proxySessionId\":\"session-attacker\"");
        proofs[1] = _rebindAndSign(proofs[1], WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[0] = _changeEverywhere(proofs[0], MARKER, "account: 987654", WITNESS_KEY);
        _assertRejected(proofs, _policy());
    }

    function testRejectsWrongRunGpsTrainerFlagAndChallenge() public {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        proofs[1] = _changeEverywhere(proofs[1], "\"type\":\"Run\"", "\"type\":\"Ride\"", WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[1] = _changeEverywhere(proofs[1], "\"flagged\":\"false\"", "\"flagged\":\"true\"", WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[1] = _changeEverywhere(proofs[1], "\"latlng\":\"true\"", "\"latlng\":\"false\"", WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[1] = _changeEverywhere(proofs[1], "\"trainer\":\"false\"", "\"trainer\":\"true\"", WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[1] = _changeEverywhere(
            proofs[1], string.concat("\"name\":\"", CHALLENGE, "\""), "\"name\":\"LI-ATTACKERATTACKERD01\"", WITNESS_KEY
        );
        _assertRejected(proofs, _policy());
    }

    /// @dev The activity URL keeps the literal {{context_challenge}} template, so the daily challenge binds
    ///      through the signed paramValues. A claim fetched for another day's challenge must not validate.
    function testRejectsForeignChallengeInParamValues() public {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        proofs[0] = _changeEverywhere(
            proofs[0],
            string.concat("\"context_challenge\":\"", CHALLENGE, "\""),
            "\"context_challenge\":\"LI-ABCDEFGHIJKLMNOPD02\"",
            WITNESS_KEY
        );
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[1] = _changeEverywhere(
            proofs[1],
            string.concat("\"context_challenge\":\"", CHALLENGE, "\""),
            "\"context_challenge\":\"LI-ABCDEFGHIJKLMNOPD02\"",
            WITNESS_KEY
        );
        _assertRejected(proofs, _policy());
    }

    function testRejectsDistanceSpeedPauseAndWindowViolations() public {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        proofs[1] = _changeEverywhere(proofs[1], "\"raw\":\"5000\"", "\"raw\":\"999\"", WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[1] = _changeEverywhere(proofs[1], "\"moving\":\"1500\"", "\"moving\":\"500\"", WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[1] = _changeEverywhere(proofs[1], "\"moving\":\"1500\"", "\"moving\":\"20000\"", WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[1] = _changeEverywhere(proofs[1], "\"elapsed\":\"1800\"", "\"elapsed\":\"7000\"", WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[1] = _changeEverywhere(proofs[1], "2026-07-15T08:00:00Z", "2026-07-16T08:00:00Z", WITNESS_KEY);
        _assertRejected(proofs, _policy());
    }

    function testRejectsStaleFutureAndInvalidPolicy() public {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        VM.warp(uint256(PROOF_TIME) + 601);
        _assertRejected(proofs, _policy());

        VM.warp(uint256(PROOF_TIME) - 61);
        _assertRejected(proofs, _policy());

        VM.warp(uint256(PROOF_TIME) + 100);
        proofs = _validProofs(WITNESS_KEY);
        proofs[1].signedClaim.claim.timestampS = PROOF_TIME + 121;
        proofs[1] = _resign(proofs[1], WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        LockInProofTypes.StravaPolicy memory policy = _policy();
        policy.account = address(0);
        _assertRejected(proofs, policy);

        policy = _policy();
        policy.challenge = "LI-TOOSHORTD01";
        _assertRejected(proofs, policy);

        policy = _policy();
        policy.dayIndex = 1;
        _assertRejected(proofs, policy);
    }

    /// @dev 6.0.0 emits no context.providerHash, so the request is pinned from claimData.parameters.
    ///      A rewritten URL or a redirected extraction template must be rejected on that basis alone.
    function testRequestIsPinnedFromParameters() public {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        proofs[1].claimInfo.parameters = _replaceOnce(
            proofs[1].claimInfo.parameters,
            "https://www.strava.com/athlete/training_activities?",
            "https://attacker.invalid/training_activities?"
        );
        proofs[1] = _rebindAndSign(proofs[1], WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[1].claimInfo.parameters = _replaceOnce(proofs[1].claimInfo.parameters, "{{elevation}}", "{{raw}}");
        proofs[1] = _rebindAndSign(proofs[1], WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[0].claimInfo.parameters =
            _replaceOnce(proofs[0].claimInfo.parameters, "\"method\":\"GET\"", "\"method\":\"POST\"");
        proofs[0] = _rebindAndSign(proofs[0], WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[0].claimInfo.parameters = _replaceOnce(proofs[0].claimInfo.parameters, "\"body\":\"\"", "\"body\":\"x\"");
        proofs[0] = _rebindAndSign(proofs[0], WITNESS_KEY);
        _assertRejected(proofs, _policy());
    }

    function testRejectsUnknownDuplicateReorderedAndEscapedSecurityJson() public {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        proofs[0].claimInfo.parameters =
            _replaceOnce(proofs[0].claimInfo.parameters, "{\"additionalClientOptions\"", "{\"alien\":{},\"additionalClientOptions\"");
        proofs[0] = _rebindAndSign(proofs[0], WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[0].claimInfo.parameters =
            _replaceOnce(proofs[0].claimInfo.parameters, "\"method\":\"GET\"", "\"method\":\"GET\",\"method\":\"GET\"");
        proofs[0] = _rebindAndSign(proofs[0], WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[0].claimInfo.context = _replaceOnce(
            proofs[0].claimInfo.context,
            "\"contextAddress\":\"0x000000000000000000000000000000000000a11c\",\"contextMessage\":\"42:0\"",
            "\"contextMessage\":\"42:0\",\"contextAddress\":\"0x000000000000000000000000000000000000a11c\""
        );
        proofs[0] = _rebindAndSign(proofs[0], WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[0].claimInfo.context = _replaceOnce(proofs[0].claimInfo.context, "\"reclaimSessionId\":\"session-123\"", "\"reclaimSessionId\":\"session\\u002d123\"");
        proofs[0] = _rebindAndSign(proofs[0], WITNESS_KEY);
        _assertRejected(proofs, _policy());
    }

    /// @dev The legacy 1.0.3 context shape (providerHash, no TEE attestation) must no longer validate.
    function testRejectsLegacyProviderHashContext() public {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        proofs[0].claimInfo.context = string.concat(
            "{\"contextAddress\":\"0x000000000000000000000000000000000000a11c\",\"contextMessage\":\"42:0\",\"extractedParameters\":",
            _fields(0),
            ",\"providerHash\":\"0xdbb40a205e1a2036ccd2b371eebc19d6e01ae3a9b2cfd414d4d7abfbd9d11f67\",\"reclaimSessionId\":\"",
            SESSION,
            "\"}"
        );
        proofs[0] = _rebindAndSign(proofs[0], WITNESS_KEY);
        _assertRejected(proofs, _policy());
    }

    /// @dev isAiProof/isPortalProof are read as canonical JSON booleans. They are not gated on, so both
    ///      values validate, but a missing or non-boolean flag breaks the pinned context shape.
    function testContextFlagsAreParsedButNotGated() public {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        proofs[0].claimInfo.context = _replaceOnce(proofs[0].claimInfo.context, "\"isAiProof\":true", "\"isAiProof\":false");
        proofs[0] = _rebindAndSign(proofs[0], WITNESS_KEY);
        proofs[1].claimInfo.context = _replaceOnce(proofs[1].claimInfo.context, "\"isAiProof\":true", "\"isAiProof\":false");
        proofs[1] = _rebindAndSign(proofs[1], WITNESS_KEY);
        LockInProofTypes.StravaEvidence memory evidence =
            verifier.validateSyntheticStravaProofsForTesting(proofs, _policy());
        require(evidence.distanceMeters == 5000, "isAiProof=false changed the verdict");

        proofs = _validProofs(WITNESS_KEY);
        proofs[0].claimInfo.context = _replaceOnce(proofs[0].claimInfo.context, "\"isAiProof\":true", "\"isAiProof\":\"true\"");
        proofs[0] = _rebindAndSign(proofs[0], WITNESS_KEY);
        _assertRejected(proofs, _policy());

        proofs = _validProofs(WITNESS_KEY);
        proofs[0].claimInfo.context = _replaceOnce(proofs[0].claimInfo.context, ",\"isPortalProof\":true", "");
        proofs[0] = _rebindAndSign(proofs[0], WITNESS_KEY);
        _assertRejected(proofs, _policy());
    }

    function _validProofs(uint256 signerKey) private returns (Reclaim.Proof[] memory proofs) {
        proofs = new Reclaim.Proof[](2);
        for (uint8 role; role < 2; ++role) {
            proofs[role] = _proof(role, signerKey, PROOF_TIME + role);
        }
    }

    function _proof(uint8 role, uint256 signerKey, uint32 timestampS) private returns (Reclaim.Proof memory proof) {
        proof.claimInfo = Claims.ClaimInfo({provider: "http", parameters: _parameters(role), context: _context(role)});
        proof.signedClaim.claim = Claims.CompleteClaimData({
            identifier: Claims.hashClaimInfo(proof.claimInfo),
            // The live provider returns this legacy placeholder for every claim.
            owner: 0x1234567890123456789012345678901234567890,
            timestampS: timestampS,
            epoch: 1
        });
        return _resign(proof, signerKey);
    }

    function _changeEverywhere(Reclaim.Proof memory proof, string memory from, string memory to, uint256 signerKey)
        private
        returns (Reclaim.Proof memory)
    {
        proof.claimInfo.parameters = _replaceOnce(proof.claimInfo.parameters, from, to);
        proof.claimInfo.context = _replaceOnce(proof.claimInfo.context, from, to);
        return _rebindAndSign(proof, signerKey);
    }

    function _rebindAndSign(Reclaim.Proof memory proof, uint256 signerKey) private returns (Reclaim.Proof memory) {
        proof.signedClaim.claim.identifier = Claims.hashClaimInfo(proof.claimInfo);
        return _resign(proof, signerKey);
    }

    function _resign(Reclaim.Proof memory proof, uint256 signerKey) private returns (Reclaim.Proof memory) {
        bytes memory serialised = Claims.serialise(proof.signedClaim.claim);
        bytes32 digest =
            keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n", _uintToString(serialised.length), serialised));
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(signerKey, digest);
        proof.signedClaim.signatures = new bytes[](1);
        proof.signedClaim.signatures[0] = abi.encodePacked(r, s, v);
        return proof;
    }

    function _policy() private pure returns (LockInProofTypes.StravaPolicy memory policy) {
        policy = LockInProofTypes.StravaPolicy({
            account: ACCOUNT,
            pactId: PACT_ID,
            dayIndex: DAY_INDEX,
            expectedSessionId: SESSION,
            challenge: CHALLENGE,
            startsAt: STARTS_AT,
            endsAt: ENDS_AT,
            minDistanceMeters: 1000
        });
    }

    function _parameters(uint8 role) private pure returns (string memory) {
        return string.concat(
            "{\"additionalClientOptions\":{},\"body\":\"\",\"geoLocation\":\"FR\",\"headers\":{\"accept\":\"application/json\",\"x-client\":\"lock-in\"},\"method\":\"GET\",\"paramValues\":",
            _fields(role),
            ",\"proxySessionId\":\"",
            SESSION,
            "\",\"responseMatches\":",
            _matches(role),
            ",\"responseRedactions\":",
            _redactions(role),
            ",\"url\":\"",
            _url(role),
            "\"}"
        );
    }

    function _context(uint8 role) private pure returns (string memory) {
        return string.concat(
            "{\"attestationNonce\":\"",
            NONCE,
            "\",\"attestationNonceData\":{\"applicationId\":\"0x15678cD04e54ccc2bC1c24cb455be3C60Eb11ADf\",\"attestationVersion\":\"v3\",\"sessionId\":\"",
            SESSION,
            "\",\"timestamp\":\"1784102500000\"},\"contextAddress\":\"0x000000000000000000000000000000000000a11c\",\"contextMessage\":\"42:0\",\"extractedParameters\":",
            _fields(role),
            ",\"isAiProof\":true,\"isPortalProof\":true,\"reclaimSessionId\":\"",
            SESSION,
            "\"}"
        );
    }

    function _fields(uint8 role) private pure returns (string memory) {
        if (role == 0) {
            return string.concat("{\"context_challenge\":\"", CHALLENGE, "\",\"marker\":\"", MARKER, "\"}");
        }
        return string.concat(
            "{\"context_challenge\":\"",
            CHALLENGE,
            "\",\"elapsed\":\"1800\",\"elevation\":\"50\",\"flagged\":\"false\",\"id\":\"",
            ACTIVITY_ID,
            "\",\"latlng\":\"true\",\"moving\":\"1500\",\"name\":\"",
            CHALLENGE,
            "\",\"raw\":\"5000\",\"time\":\"2026-07-15T08:00:00Z\",\"trainer\":\"false\",\"type\":\"Run\"}"
        );
    }

    function _url(uint8 role) private pure returns (string memory) {
        if (role == 0) return "https://www.strava.com/athlete/training";
        // 6.0.0 keeps the challenge as a template in the URL; it binds through paramValues.
        return
        "https://www.strava.com/athlete/training_activities?keywords={{context_challenge}}&sport_type=Run&tags=&commute=&private_activities=&trainer=false&gear=&new_activity_only=false";
    }

    /// @dev Byte-identical to the published 6.0.0 provider: these slices are what the parser pins.
    function _matches(uint8 role) private pure returns (string memory) {
        if (role == 0) return "[{\"type\":\"contains\",\"value\":\"\\\",\\n   {{marker}},\\n   \"}]";
        return "[{\"type\":\"contains\",\"value\":\"\\\"id\\\":{{id}}\"},{\"type\":\"contains\",\"value\":\"\\\"name\\\":\\\"{{name}}\\\"\"},{\"type\":\"contains\",\"value\":\"\\\"sport_type\\\":\\\"{{type}}\\\"\"},{\"type\":\"contains\",\"value\":\"\\\"start_time\\\":\\\"{{time}}\\\"\"},{\"type\":\"contains\",\"value\":\"\\\"distance_raw\\\":{{raw}}\"},{\"type\":\"contains\",\"value\":\"\\\"flagged\\\":{{flagged}}\"},{\"type\":\"contains\",\"value\":\"\\\"moving_time_raw\\\":{{moving}}\"},{\"type\":\"contains\",\"value\":\"\\\"elapsed_time_raw\\\":{{elapsed}}\"},{\"type\":\"contains\",\"value\":\"\\\"elevation_gain_raw\\\":{{elevation}}\"},{\"type\":\"contains\",\"value\":\"\\\"has_latlng\\\":{{latlng}}\"},{\"type\":\"contains\",\"value\":\"\\\"trainer\\\":{{trainer}}\"}]";
    }

    function _redactions(uint8 role) private pure returns (string memory) {
        if (role == 0) {
            return
            "[{\"jsonPath\":\"\",\"regex\":\"\\\",\\\\s*(?<marker>[^\\\"<>\\\\n]+),\\\\s*\",\"xPath\":\"/html[1]/head[1]/script[5]\"}]";
        }
        return "[{\"jsonPath\":\"$.models[0].id\",\"regex\":\"\\\"id\\\":(?<id>\\\\d+)\",\"xPath\":\"\"},{\"jsonPath\":\"$.models[0].name\",\"regex\":\"\\\"name\\\":\\\"(?<name>[^\\\"<>\\\\n]+)\\\"\",\"xPath\":\"\"},{\"jsonPath\":\"$.models[0].sport_type\",\"regex\":\"\\\"sport_type\\\":\\\"(?<type>[A-Za-z0-9_-]+)\\\"\",\"xPath\":\"\"},{\"jsonPath\":\"$.models[0].start_time\",\"regex\":\"\\\"start_time\\\":\\\"(?<time>[^\\\"<>\\\\n]+)\\\"\",\"xPath\":\"\"},{\"jsonPath\":\"$.models[0].distance_raw\",\"regex\":\"\\\"distance_raw\\\":(?<raw>\\\\d+)\",\"xPath\":\"\"},{\"jsonPath\":\"$.models[0].flagged\",\"regex\":\"\\\"flagged\\\":(?<flagged>true|false)\",\"xPath\":\"\"},{\"jsonPath\":\"$.models[0].moving_time_raw\",\"regex\":\"\\\"moving_time_raw\\\":(?<moving>\\\\d+)\",\"xPath\":\"\"},{\"jsonPath\":\"$.models[0].elapsed_time_raw\",\"regex\":\"\\\"elapsed_time_raw\\\":(?<elapsed>\\\\d+)\",\"xPath\":\"\"},{\"jsonPath\":\"$.models[0].elevation_gain_raw\",\"regex\":\"\\\"elevation_gain_raw\\\":(?<elevation>\\\\d+)\",\"xPath\":\"\"},{\"jsonPath\":\"$.models[0].has_latlng\",\"regex\":\"\\\"has_latlng\\\":(?<latlng>true|false)\",\"xPath\":\"\"},{\"jsonPath\":\"$.models[0].trainer\",\"regex\":\"\\\"trainer\\\":(?<trainer>true|false)\",\"xPath\":\"\"}]";
    }

    function _assertRejected(Reclaim.Proof[] memory proofs, LockInProofTypes.StravaPolicy memory policy) private view {
        (bool ok,) = address(verifier)
            .staticcall(abi.encodeCall(verifier.validateSyntheticStravaProofsForTesting, (proofs, policy)));
        require(!ok, "mutation unexpectedly accepted");
    }

    function _revertSelector(bytes memory reason) private pure returns (bytes4 selector) {
        if (reason.length < 4) return bytes4(0);
        assembly {
            selector := mload(add(reason, 32))
        }
    }

    function _replaceOnce(string memory input, string memory needle, string memory replacement)
        private
        pure
        returns (string memory)
    {
        bytes memory source = bytes(input);
        bytes memory target = bytes(needle);
        bytes memory value = bytes(replacement);
        require(target.length != 0 && target.length <= source.length, "invalid replacement");
        uint256 found = type(uint256).max;
        for (uint256 i; i + target.length <= source.length; ++i) {
            bool matches = true;
            for (uint256 j; j < target.length; ++j) {
                if (source[i + j] != target[j]) {
                    matches = false;
                    break;
                }
            }
            if (matches) {
                found = i;
                break;
            }
        }
        require(found != type(uint256).max, "needle not found");
        bytes memory output = new bytes(source.length - target.length + value.length);
        uint256 cursor;
        for (uint256 i; i < found; ++i) {
            output[cursor++] = source[i];
        }
        for (uint256 i; i < value.length; ++i) {
            output[cursor++] = value[i];
        }
        for (uint256 i = found + target.length; i < source.length; ++i) {
            output[cursor++] = source[i];
        }
        return string(output);
    }

    function _uintToString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        uint256 cursor = value;
        while (cursor != 0) {
            ++digits;
            cursor /= 10;
        }
        bytes memory output = new bytes(digits);
        while (value != 0) {
            output[--digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(output);
    }
}
