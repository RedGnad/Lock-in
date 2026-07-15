// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Reclaim} from "@reclaimprotocol/solidity-sdk/contracts/Reclaim.sol";
import {Claims} from "@reclaimprotocol/solidity-sdk/contracts/lib/Claims.sol";
import {LockInReclaimVerifier} from "../contracts/verifiers/LockInReclaimVerifier.sol";

interface VmReclaimVerifier {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 timestamp) external;
}

/// @dev Test-only adapter for the synthetic schema. The production entry remains fail-closed.
contract LockInReclaimVerifierHarness is LockInReclaimVerifier {
    constructor(address pinnedWitness) LockInReclaimVerifier(pinnedWitness) {}

    function validateSyntheticDuolingoProofsForTesting(
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

contract LockInReclaimVerifierTest {
    VmReclaimVerifier private constant VM = VmReclaimVerifier(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant WITNESS_KEY = 0xA11CE55;
    uint256 private constant WRONG_WITNESS_KEY = 0xBADBEEF;
    uint32 private constant OWNERSHIP_PROOF_TIME = 1_784_000_000;
    uint32 private constant XP_PROOF_TIME = OWNERSHIP_PROOF_TIME + 1;
    address private constant ACCOUNT = address(uint160(0xA11C));
    string private constant SESSION = "session-123";
    string private constant PROFILE_ID = "123456";
    string private constant XP = "1000";
    string private constant NONCE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    string private constant PCR_K = "snp-app:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    string private constant PCR_T = "snp-app:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    string private constant OWNERSHIP_TEE_SESSION = "11111111-1111-4111-8111-111111111111";
    string private constant XP_TEE_SESSION = "22222222-2222-4222-8222-222222222222";
    string private constant ATTESTATION_TIMESTAMP = "1783999900000";
    string private constant OWNERSHIP_REQUEST_HASH =
        "0xea3ca9aeaa60e89d8f4a9134f5b314a78295e7e164f75eddb6d89f911a83766e";
    string private constant XP_REQUEST_HASH = "0x92d80894f1f9e2f3574b840e846e41a49ae7491b587da9bd96cbcccbe001c8ed";

    LockInReclaimVerifierHarness private verifier;

    function setUp() public {
        VM.warp(uint256(XP_PROOF_TIME) + 100);
        verifier = new LockInReclaimVerifierHarness(VM.addr(WITNESS_KEY));
    }

    function testProductionEntryFailsClosedWhileSchemaIsUnconfirmed() public {
        LockInReclaimVerifier productionVerifier = new LockInReclaimVerifier(VM.addr(WITNESS_KEY));
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        (bool ok, bytes memory reason) = address(productionVerifier)
            .staticcall(
                abi.encodeCall(productionVerifier.validateDuolingoProofs, (proofs, ACCOUNT, 42, true, 0, SESSION))
            );

        require(!ok, "unconfirmed production verifier accepted proofs");
        require(
            _revertSelector(reason) == LockInReclaimVerifier.LiveSchemaUnconfirmed.selector,
            "unexpected production revert"
        );
    }

    function testValidCanonicalBaselineProofPairAndOrderedHash() public {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        (bytes32 identityHash, uint64 totalXp, bytes32 proofHash, uint32 timestampS) =
            verifier.validateSyntheticDuolingoProofsForTesting(proofs, ACCOUNT, 42, true, 0, SESSION);

        bytes32 providerKey = keccak256("cdf8cb3b-2976-4413-ab2d-693ae5028380@1.0.8");
        bytes32 expectedProofHash =
            keccak256(abi.encodePacked(proofs[0].signedClaim.claim.identifier, proofs[1].signedClaim.claim.identifier));
        require(identityHash == keccak256(abi.encode(providerKey, uint256(123456))), "wrong identity");
        require(totalXp == 1000, "wrong XP");
        require(proofHash == expectedProofHash, "wrong ordered proof-set hash");
        require(timestampS == XP_PROOF_TIME, "XP proof timestamp not selected");
        require(!verifier.LIVE_SCHEMA_CONFIRMED(), "synthetic fixture claimed live confirmation");
    }

    function testValidCanonicalCompletionAndDynamicGeo() public {
        string memory ownershipParameters =
            _replaceOnce(_ownershipParameters(), "\"geoLocation\":\"FR\"", "\"geoLocation\":\"US\"");
        string memory xpParameters = _replaceOnce(_xpParameters(), "\"geoLocation\":\"FR\"", "\"geoLocation\":\"US\"");
        Reclaim.Proof[] memory proofs =
            _proofPair(ownershipParameters, _ownershipContext("42:7"), xpParameters, _xpContext("42:7"), WITNESS_KEY);

        (, uint64 totalXp,,) =
            verifier.validateSyntheticDuolingoProofsForTesting(proofs, ACCOUNT, 42, false, 7, SESSION);
        require(totalXp == 1000, "optional transport fields changed result");
    }

    function testRejectsWrongProofCountAndRoleOrder() public {
        Reclaim.Proof[] memory valid = _validProofs(WITNESS_KEY);
        Reclaim.Proof[] memory one = new Reclaim.Proof[](1);
        one[0] = valid[0];
        _assertRejected(one, ACCOUNT, 42, true, 0, SESSION);

        Reclaim.Proof[] memory three = new Reclaim.Proof[](3);
        three[0] = valid[0];
        three[1] = valid[1];
        three[2] = valid[1];
        _assertRejected(three, ACCOUNT, 42, true, 0, SESSION);

        Reclaim.Proof memory first = valid[0];
        valid[0] = valid[1];
        valid[1] = first;
        _assertRejected(valid, ACCOUNT, 42, true, 0, SESSION);
    }

    function testRejectsClaimTamperingWrongWitnessProviderAndOwner() public {
        Reclaim.Proof[] memory tampered = _validProofs(WITNESS_KEY);
        tampered[1].signedClaim.claim.identifier = bytes32(0);
        _assertRejected(tampered, ACCOUNT, 42, true, 0, SESSION);

        _assertRejected(_validProofs(WRONG_WITNESS_KEY), ACCOUNT, 42, true, 0, SESSION);

        Reclaim.Proof[] memory wrongProvider = _validProofs(WITNESS_KEY);
        wrongProvider[0] = _proof(
            "https", _ownershipParameters(), _ownershipContext("42:baseline"), WITNESS_KEY, OWNERSHIP_PROOF_TIME
        );
        _assertRejected(wrongProvider, ACCOUNT, 42, true, 0, SESSION);

        Reclaim.Proof[] memory zeroOwner = _validProofs(WITNESS_KEY);
        zeroOwner[0].signedClaim.claim.owner = address(0);
        zeroOwner[0] = _resign(zeroOwner[0], WITNESS_KEY);
        _assertRejected(zeroOwner, ACCOUNT, 42, true, 0, SESSION);
    }

    function testRejectsStaleAndFutureTimestampInEitherRole() public {
        Reclaim.Proof[] memory stale = _validProofs(WITNESS_KEY);
        stale[0].signedClaim.claim.timestampS = uint32(block.timestamp - 601);
        stale[0] = _resign(stale[0], WITNESS_KEY);
        _assertRejected(stale, ACCOUNT, 42, true, 0, SESSION);

        Reclaim.Proof[] memory future = _validProofs(WITNESS_KEY);
        future[1].signedClaim.claim.timestampS = uint32(block.timestamp + 61);
        future[1] = _resign(future[1], WITNESS_KEY);
        _assertRejected(future, ACCOUNT, 42, true, 0, SESSION);
    }

    function testRejectsPinnedHashWithWrongOwnershipOrXpRequest() public {
        string memory wrongOwnership = _replaceOnce(
            _ownershipParameters(),
            "https://www.duolingo.com/2023-05-23/users/{{duolingo_user_id}}/privacy-settings",
            "https://attacker.invalid/ownership"
        );
        _assertRoleParametersRejected(0, wrongOwnership);

        string memory wrongXp = _replaceOnce(
            _xpParameters(),
            "https://www.duolingo.com/2023-05-23/users/{{duolingo_user_id}}?fields=id,totalXp",
            "https://attacker.invalid/xp"
        );
        _assertRoleParametersRejected(1, wrongXp);
    }

    function testRejectsMethodMatchesRedactionsAndCanonicalOrderMutations() public {
        _assertRoleParametersRejected(
            0, _replaceOnce(_ownershipParameters(), "\"method\":\"GET\"", "\"method\":\"POST\"")
        );
        _assertRoleParametersRejected(0, _replaceOnce(_ownershipParameters(), "{{marker}}", "{{xp}}"));
        _assertRoleParametersRejected(
            0, _replaceOnce(_ownershipParameters(), "$.privacySettings[10].id", "$.privacySettings[9].id")
        );
        _assertRoleParametersRejected(1, _replaceOnce(_xpParameters(), "{{xp}}", "{{id}}"));
        _assertRoleParametersRejected(1, _replaceOnce(_xpParameters(), "$.totalXp", "$.wrongXp"));

        string memory reordered = _replaceOnce(
            _xpParameters(),
            "\"url\":\"https://www.duolingo.com/2023-05-23/users/{{duolingo_user_id}}?fields=id,totalXp\",\"method\":\"GET\"",
            "\"method\":\"GET\",\"url\":\"https://www.duolingo.com/2023-05-23/users/{{duolingo_user_id}}?fields=id,totalXp\""
        );
        _assertRoleParametersRejected(1, reordered);
    }

    function testRejectsWalletPactSessionAndProviderContextMutations() public {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        _assertRejected(proofs, address(0xB0B), 42, true, 0, SESSION);
        _assertRejected(proofs, ACCOUNT, 43, true, 0, SESSION);
        _assertRejected(proofs, ACCOUNT, 42, true, 0, "session-attacker");

        string memory wrongOwnershipHash =
            _replaceOnce(_ownershipContext("42:baseline"), OWNERSHIP_REQUEST_HASH, XP_REQUEST_HASH);
        _assertRejected(
            _proofPair(
                _ownershipParameters(), wrongOwnershipHash, _xpParameters(), _xpContext("42:baseline"), WITNESS_KEY
            ),
            ACCOUNT,
            42,
            true,
            0,
            SESSION
        );

        string memory wrongXpSession = _replaceOnce(_xpContext("42:baseline"), SESSION, "session-attacker");
        _assertRejected(
            _proofPair(
                _ownershipParameters(), _ownershipContext("42:baseline"), _xpParameters(), wrongXpSession, WITNESS_KEY
            ),
            ACCOUNT,
            42,
            true,
            0,
            SESSION
        );
    }

    function testRejectsMarkerAndCrossProofProfileMismatches() public {
        string memory wrongMarkerParameters = _replaceOnce(_ownershipParameters(), "disable_social", "disable_messages");
        string memory wrongMarkerContext =
            _replaceOnce(_ownershipContext("42:baseline"), "disable_social", "disable_messages");
        _assertRejected(
            _proofPair(
                wrongMarkerParameters, wrongMarkerContext, _xpParameters(), _xpContext("42:baseline"), WITNESS_KEY
            ),
            ACCOUNT,
            42,
            true,
            0,
            SESSION
        );

        string memory otherOwnershipProfile = _replaceOnce(_ownershipParameters(), PROFILE_ID, "654321");
        _assertRejected(
            _proofPair(
                otherOwnershipProfile,
                _ownershipContext("42:baseline"),
                _xpParameters(),
                _xpContext("42:baseline"),
                WITNESS_KEY
            ),
            ACCOUNT,
            42,
            true,
            0,
            SESSION
        );

        string memory mismatchedXpResponse = _replaceOnce(_xpParameters(), "\"id\":\"123456\"", "\"id\":\"654321\"");
        string memory mismatchedXpContext = _replaceOnce(_xpContext("42:baseline"), PROFILE_ID, "654321");
        _assertRejected(
            _proofPair(
                _ownershipParameters(),
                _ownershipContext("42:baseline"),
                mismatchedXpResponse,
                mismatchedXpContext,
                WITNESS_KEY
            ),
            ACCOUNT,
            42,
            true,
            0,
            SESSION
        );
    }

    function testRejectsParameterContextMismatchAndNonCanonicalNumbers() public {
        string memory changedXpContext = _replaceOnce(_xpContext("42:baseline"), "\"xp\":\"1000\"", "\"xp\":\"1001\"");
        _assertRejected(
            _proofPair(
                _ownershipParameters(), _ownershipContext("42:baseline"), _xpParameters(), changedXpContext, WITNESS_KEY
            ),
            ACCOUNT,
            42,
            true,
            0,
            SESSION
        );

        string memory paddedParameters = _replaceOnce(_xpParameters(), "\"xp\":\"1000\"", "\"xp\":\"01000\"");
        string memory paddedContext = _replaceOnce(_xpContext("42:baseline"), "\"xp\":\"1000\"", "\"xp\":\"01000\"");
        _assertRejected(
            _proofPair(
                _ownershipParameters(), _ownershipContext("42:baseline"), paddedParameters, paddedContext, WITNESS_KEY
            ),
            ACCOUNT,
            42,
            true,
            0,
            SESSION
        );
    }

    function testRejectsInvalidTeeContextAndUnknownKeys() public {
        string memory teeContext = _replaceOnce(_xpContext("42:baseline"), NONCE, "ABCDEF");
        _assertRejected(
            _proofPair(
                _ownershipParameters(), _ownershipContext("42:baseline"), _xpParameters(), teeContext, WITNESS_KEY
            ),
            ACCOUNT,
            42,
            true,
            0,
            SESSION
        );

        string memory wrongApplication = _replaceOnce(
            _xpContext("42:baseline"),
            "0x15678cD04e54ccc2bC1c24cb455be3C60Eb11ADf",
            "0x0000000000000000000000000000000000000001"
        );
        _assertRejected(
            _proofPair(
                _ownershipParameters(), _ownershipContext("42:baseline"), _xpParameters(), wrongApplication, WITNESS_KEY
            ),
            ACCOUNT,
            42,
            true,
            0,
            SESSION
        );

        _assertRoleParametersRejected(0, _replaceOnce(_ownershipParameters(), "{\"url\"", "{\"alien\":{},\"url\""));
    }

    function _assertRoleParametersRejected(uint256 role, string memory parameters) private {
        Reclaim.Proof[] memory proofs = _validProofs(WITNESS_KEY);
        if (role == 0) {
            proofs[0] = _proof("http", parameters, _ownershipContext("42:baseline"), WITNESS_KEY, OWNERSHIP_PROOF_TIME);
        } else {
            proofs[1] = _proof("http", parameters, _xpContext("42:baseline"), WITNESS_KEY, XP_PROOF_TIME);
        }
        _assertRejected(proofs, ACCOUNT, 42, true, 0, SESSION);
    }

    function _assertRejected(
        Reclaim.Proof[] memory proofs,
        address account,
        uint256 pactId,
        bool baseline,
        uint8 dayIndex,
        string memory session
    ) private view {
        (bool ok,) = address(verifier)
            .staticcall(
                abi.encodeCall(
                    verifier.validateSyntheticDuolingoProofsForTesting,
                    (proofs, account, pactId, baseline, dayIndex, session)
                )
            );
        require(!ok, "mutation unexpectedly accepted");
    }

    function _validProofs(uint256 signerKey) private returns (Reclaim.Proof[] memory) {
        return _proofPair(
            _ownershipParameters(),
            _ownershipContext("42:baseline"),
            _xpParameters(),
            _xpContext("42:baseline"),
            signerKey
        );
    }

    function _proofPair(
        string memory ownershipParameters,
        string memory ownershipContext,
        string memory xpParameters,
        string memory xpContext,
        uint256 signerKey
    ) private returns (Reclaim.Proof[] memory proofs) {
        proofs = new Reclaim.Proof[](2);
        proofs[0] = _proof("http", ownershipParameters, ownershipContext, signerKey, OWNERSHIP_PROOF_TIME);
        proofs[1] = _proof("http", xpParameters, xpContext, signerKey, XP_PROOF_TIME);
    }

    function _proof(
        string memory provider,
        string memory parameters,
        string memory context,
        uint256 signerKey,
        uint32 timestampS
    ) private returns (Reclaim.Proof memory proof) {
        proof.claimInfo = Claims.ClaimInfo({provider: provider, parameters: parameters, context: context});
        proof.signedClaim.claim = Claims.CompleteClaimData({
            identifier: Claims.hashClaimInfo(proof.claimInfo),
            owner: timestampS == OWNERSHIP_PROOF_TIME ? address(0x1111) : address(0x2222),
            timestampS: timestampS,
            epoch: 1
        });
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

    function _ownershipParameters() private pure returns (string memory) {
        string memory matches = "[{\"value\":\"\\\"id\\\":\\\"{{marker}}\\\"\",\"type\":\"contains\"}]";
        string memory redactions =
            "[{\"regex\":\"\\\"id\\\":\\\"(?\\u003cmarker\\u003e[A-Za-z0-9_-]+)\\\"\",\"jsonPath\":\"$.privacySettings[10].id\"}]";
        return string.concat(
            "{\"url\":\"https://www.duolingo.com/2023-05-23/users/{{duolingo_user_id}}/privacy-settings\",\"method\":\"GET\",\"geoLocation\":\"FR\",\"paramValues\":{\"duolingo_user_id\":\"",
            PROFILE_ID,
            "\",\"marker\":\"disable_social\"},\"responseMatches\":",
            matches,
            ",\"responseRedactions\":",
            redactions,
            "}"
        );
    }

    function _xpParameters() private pure returns (string memory) {
        string memory matches =
            "[{\"value\":\"\\\"id\\\":{{id}}\",\"type\":\"contains\"},{\"value\":\"\\\"totalXp\\\":{{xp}}\",\"type\":\"contains\"}]";
        string memory redactions =
            "[{\"regex\":\"\\\"id\\\":(?\\u003cid\\u003e\\\\d+)\",\"jsonPath\":\"$.id\"},{\"regex\":\"\\\"totalXp\\\":(?\\u003cxp\\u003e\\\\d+)\",\"jsonPath\":\"$.totalXp\"}]";
        return string.concat(
            "{\"url\":\"https://www.duolingo.com/2023-05-23/users/{{duolingo_user_id}}?fields=id,totalXp\",\"method\":\"GET\",\"geoLocation\":\"FR\",\"paramValues\":{\"duolingo_user_id\":\"",
            PROFILE_ID,
            "\",\"id\":\"",
            PROFILE_ID,
            "\",\"xp\":\"",
            XP,
            "\"},\"responseMatches\":",
            matches,
            ",\"responseRedactions\":",
            redactions,
            "}"
        );
    }

    function _ownershipContext(string memory message) private pure returns (string memory) {
        return string.concat(
            "{\"attestationNonce\":\"",
            NONCE,
            "\",\"attestationNonceData\":{\"applicationId\":\"0x15678cD04e54ccc2bC1c24cb455be3C60Eb11ADf\",\"attestationVersion\":\"v3\",\"sessionId\":\"",
            SESSION,
            "\",\"timestamp\":\"",
            ATTESTATION_TIMESTAMP,
            "\"},\"contextAddress\":\"0x000000000000000000000000000000000000a11c\",\"contextMessage\":\"",
            message,
            "\",\"extractedParameters\":{\"duolingo_user_id\":\"",
            PROFILE_ID,
            "\",\"marker\":\"disable_social\"},\"pcr0_k\":\"",
            PCR_K,
            "\",\"pcr0_t\":\"",
            PCR_T,
            "\",\"providerHash\":\"",
            OWNERSHIP_REQUEST_HASH,
            "\",\"reclaimSessionId\":\"",
            SESSION,
            "\",\"tee_session_id\":\"",
            OWNERSHIP_TEE_SESSION,
            "\"}"
        );
    }

    function _xpContext(string memory message) private pure returns (string memory) {
        return string.concat(
            "{\"attestationNonce\":\"",
            NONCE,
            "\",\"attestationNonceData\":{\"applicationId\":\"0x15678cD04e54ccc2bC1c24cb455be3C60Eb11ADf\",\"attestationVersion\":\"v3\",\"sessionId\":\"",
            SESSION,
            "\",\"timestamp\":\"",
            ATTESTATION_TIMESTAMP,
            "\"},\"contextAddress\":\"0x000000000000000000000000000000000000a11c\",\"contextMessage\":\"",
            message,
            "\",\"extractedParameters\":{\"duolingo_user_id\":\"",
            PROFILE_ID,
            "\",\"id\":\"",
            PROFILE_ID,
            "\",\"xp\":\"",
            XP,
            "\"},\"pcr0_k\":\"",
            PCR_K,
            "\",\"pcr0_t\":\"",
            PCR_T,
            "\",\"providerHash\":\"",
            XP_REQUEST_HASH,
            "\",\"reclaimSessionId\":\"",
            SESSION,
            "\",\"tee_session_id\":\"",
            XP_TEE_SESSION,
            "\"}"
        );
    }

    function _replaceOnce(string memory source, string memory needle, string memory replacement)
        private
        pure
        returns (string memory)
    {
        bytes memory input = bytes(source);
        bytes memory find = bytes(needle);
        bytes memory replace = bytes(replacement);
        require(find.length != 0 && find.length <= input.length, "bad test replacement");

        uint256 index = type(uint256).max;
        for (uint256 i; i + find.length <= input.length; ++i) {
            bool matchFound = true;
            for (uint256 j; j < find.length; ++j) {
                if (input[i + j] != find[j]) {
                    matchFound = false;
                    break;
                }
            }
            if (matchFound) {
                index = i;
                break;
            }
        }
        require(index != type(uint256).max, "test needle missing");

        bytes memory output = new bytes(input.length - find.length + replace.length);
        uint256 cursor;
        for (uint256 i; i < index; ++i) {
            output[cursor++] = input[i];
        }
        for (uint256 i; i < replace.length; ++i) {
            output[cursor++] = replace[i];
        }
        for (uint256 i = index + find.length; i < input.length; ++i) {
            output[cursor++] = input[i];
        }
        return string(output);
    }

    function _revertSelector(bytes memory reason) private pure returns (bytes4 selector) {
        if (reason.length < 4) return bytes4(0);
        assembly {
            selector := mload(add(reason, 32))
        }
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
