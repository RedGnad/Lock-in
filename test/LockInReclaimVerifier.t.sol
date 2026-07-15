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

/// @dev Test-only adapter. This contract is defined under `test/`, is never a deployment target, and exposes only
///      the internal synthetic-schema grammar needed by fixture tests.
contract LockInReclaimVerifierHarness is LockInReclaimVerifier {
    constructor(address pinnedWitness) LockInReclaimVerifier(pinnedWitness) {}

    function validateSyntheticDuolingoProofForTesting(
        Reclaim.Proof calldata proof,
        address account,
        uint256 pactId,
        bool baseline,
        uint8 dayIndex,
        string calldata expectedSessionId
    ) external view returns (bytes32 identityHash, uint64 totalXp, bytes32 proofHash, uint32 timestampS) {
        return _validateDuolingoProof(proof, account, pactId, baseline, dayIndex, expectedSessionId);
    }
}

contract LockInReclaimVerifierTest {
    VmReclaimVerifier private constant VM = VmReclaimVerifier(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant WITNESS_KEY = 0xA11CE55;
    uint256 private constant WRONG_WITNESS_KEY = 0xBADBEEF;
    uint32 private constant PROOF_TIME = 1_784_000_000;
    address private constant ACCOUNT = address(uint160(0xA11C));
    string private constant SESSION = "session-123";
    string private constant USERNAME = "alice.test";
    string private constant PROFILE_ID = "123456";
    string private constant XP = "1000";

    LockInReclaimVerifierHarness private verifier;

    function setUp() public {
        VM.warp(uint256(PROOF_TIME) + 100);
        verifier = new LockInReclaimVerifierHarness(VM.addr(WITNESS_KEY));
    }

    function testProductionEntryFailsClosedWhileSchemaIsUnconfirmed() public {
        LockInReclaimVerifier productionVerifier = new LockInReclaimVerifier(VM.addr(WITNESS_KEY));
        Reclaim.Proof memory proof = _validProof(WITNESS_KEY);
        (bool ok, bytes memory reason) = address(productionVerifier)
            .staticcall(
                abi.encodeCall(productionVerifier.validateDuolingoProof, (proof, ACCOUNT, 42, true, 0, SESSION))
            );

        require(!ok, "unconfirmed production verifier accepted a proof");
        require(
            _revertSelector(reason) == LockInReclaimVerifier.LiveSchemaUnconfirmed.selector,
            "unexpected production revert"
        );
    }

    function testValidCanonicalBaselineProof() public {
        Reclaim.Proof memory proof = _validProof(WITNESS_KEY);
        (bytes32 identityHash, uint64 totalXp, bytes32 proofHash, uint32 timestampS) =
            verifier.validateSyntheticDuolingoProofForTesting(proof, ACCOUNT, 42, true, 0, SESSION);

        bytes32 providerKey = keccak256("cdf8cb3b-2976-4413-ab2d-693ae5028380@1.0.3");
        require(identityHash == keccak256(abi.encode(providerKey, uint256(123456))), "wrong identity");
        require(totalXp == 1000, "wrong XP");
        require(proofHash == keccak256(abi.encodePacked(proof.signedClaim.claim.identifier)), "wrong proof-set hash");
        require(timestampS == PROOF_TIME, "wrong proof time");
        require(!verifier.LIVE_SCHEMA_CONFIRMED(), "spike claimed live confirmation");
    }

    function testValidCanonicalCompletionWithOptionalTransportFields() public {
        string memory parameters = _parameters();
        parameters = _replaceOnce(
            parameters,
            "\"body\":\"\",\"method\"",
            "\"headers\":{\"accept\":\"application/json\",\"nested\":{\"ok\":true}},\"method\""
        );
        parameters = _replaceOnce(parameters, "\"paramValues\":", string.concat("\"paramValues\":"));
        parameters = _replaceOnce(
            parameters,
            "\"responseMatches\":",
            string.concat("\"proxySessionId\":\"", SESSION, "\",\"responseMatches\":")
        );
        parameters = _replaceOnce(parameters, "],\"url\":", string.concat("],\"sessionId\":\"", SESSION, "\",\"url\":"));
        Reclaim.Proof memory proof = _proof("http", parameters, _context("42:7"), WITNESS_KEY);

        (, uint64 totalXp,,) = verifier.validateSyntheticDuolingoProofForTesting(proof, ACCOUNT, 42, false, 7, SESSION);
        require(totalXp == 1000, "optional transport fields changed result");
    }

    function testRejectsClaimInfoTamperingAndWrongWitness() public {
        Reclaim.Proof memory tampered = _validProof(WITNESS_KEY);
        tampered.signedClaim.claim.identifier = bytes32(0);
        _assertRejected(tampered, ACCOUNT, 42, true, 0, SESSION);

        Reclaim.Proof memory wrongWitness = _validProof(WRONG_WITNESS_KEY);
        _assertRejected(wrongWitness, ACCOUNT, 42, true, 0, SESSION);

        Reclaim.Proof memory wrongProvider = _proof("https", _parameters(), _context("42:baseline"), WITNESS_KEY);
        _assertRejected(wrongProvider, ACCOUNT, 42, true, 0, SESSION);

        Reclaim.Proof memory wrongOwner = _validProof(WITNESS_KEY);
        wrongOwner.signedClaim.claim.owner = address(0xB0B);
        wrongOwner = _resign(wrongOwner, WITNESS_KEY);
        _assertRejected(wrongOwner, ACCOUNT, 42, true, 0, SESSION);
    }

    function testRejectsStaleAndFutureProofTimestamps() public {
        Reclaim.Proof memory stale = _validProof(WITNESS_KEY);
        stale.signedClaim.claim.timestampS = uint32(block.timestamp - 601);
        stale = _resign(stale, WITNESS_KEY);
        _assertRejected(stale, ACCOUNT, 42, true, 0, SESSION);

        Reclaim.Proof memory future = _validProof(WITNESS_KEY);
        future.signedClaim.claim.timestampS = uint32(block.timestamp + 61);
        future = _resign(future, WITNESS_KEY);
        _assertRejected(future, ACCOUNT, 42, true, 0, SESSION);
    }

    function testPinnedProviderHashAloneCannotBlessAnotherRequest() public {
        string memory parameters = _replaceOnce(
            _parameters(),
            "https://www.duolingo.com/2017-06-30/users?username={{duolingo_username}}",
            "https://attacker.invalid/users?username={{duolingo_username}}"
        );
        // The signed context deliberately keeps the pinned providerHash. Exact request parsing must still reject it.
        Reclaim.Proof memory proof = _proof("http", parameters, _context("42:baseline"), WITNESS_KEY);
        _assertRejected(proof, ACCOUNT, 42, true, 0, SESSION);
    }

    function testRejectsUnknownDuplicateAndNonCanonicalTopLevelKeys() public {
        string memory unknown = _replaceOnce(_parameters(), "{\"body\"", "{\"alien\":{},\"body\"");
        _assertParametersRejected(unknown);

        string memory duplicate = _replaceOnce(_parameters(), "\"method\":\"GET\"", "\"method\":\"GET\",\"body\":\"\"");
        _assertParametersRejected(duplicate);

        string memory reordered =
            _replaceOnce(_parameters(), "\"body\":\"\",\"method\":\"GET\"", "\"method\":\"GET\",\"body\":\"\"");
        _assertParametersRejected(reordered);
    }

    function testRejectsUnknownDuplicateAndEscapedSecurityFields() public {
        string memory unknown = _replaceOnce(
            _parameters(), "\"totalXp\":\"1000\",\"username\"", "\"totalXp\":\"1000\",\"unknown\":\"x\",\"username\""
        );
        _assertParametersRejected(unknown);

        string memory duplicate = _replaceOnce(
            _parameters(),
            "\"username\":\"alice.test\"},\"responseMatches\"",
            "\"username\":\"alice.test\",\"username\":\"alice.test\"},\"responseMatches\""
        );
        _assertParametersRejected(duplicate);

        string memory escaped = _replaceOnce(
            _parameters(), "\"duolingo_username\":\"alice.test\"", "\"duolingo_username\":\"alice\\u002etest\""
        );
        _assertParametersRejected(escaped);
    }

    function testRejectsMethodBodyMatchesAndRedactionsMutations() public {
        _assertParametersRejected(_replaceOnce(_parameters(), "\"method\":\"GET\"", "\"method\":\"POST\""));
        _assertParametersRejected(_replaceOnce(_parameters(), "\"body\":\"\"", "\"body\":\"x\""));
        _assertParametersRejected(_replaceOnce(_parameters(), "{{totalXp}}", "{{id}}"));
        _assertParametersRejected(_replaceOnce(_parameters(), "$.users[0].totalXp", "$.users[1].totalXp"));

        string memory malformedHeaders = _replaceOnce(
            _parameters(), "\"body\":\"\",\"method\"", "\"body\":\"\",\"headers\":{\"accept\":[\"json\"},\"method\""
        );
        _assertParametersRejected(malformedHeaders);

        string memory wrongProxySession = _replaceOnce(
            _parameters(), "\"responseMatches\":", "\"proxySessionId\":\"session-attacker\",\"responseMatches\":"
        );
        _assertParametersRejected(wrongProxySession);
    }

    function testRejectsWalletPactSessionAndExtractedFieldMutations() public {
        Reclaim.Proof memory proof = _validProof(WITNESS_KEY);
        _assertRejected(proof, address(0xB0B), 42, true, 0, SESSION);
        _assertRejected(proof, ACCOUNT, 43, true, 0, SESSION);
        _assertRejected(proof, ACCOUNT, 42, true, 0, "session-attacker");

        string memory changedXp = _replaceOnce(_context("42:baseline"), "\"totalXp\":\"1000\"", "\"totalXp\":\"1001\"");
        _assertRejected(_proof("http", _parameters(), changedXp, WITNESS_KEY), ACCOUNT, 42, true, 0, SESSION);
    }

    function testRejectsWrongOwnershipCodeAndNonCanonicalNumbers() public {
        string memory wrongNameParameters =
            _replaceOnce(_parameters(), _ownershipCode(ACCOUNT), "LOCK-00000-00000");
        string memory wrongNameContext =
            _replaceOnce(_context("42:baseline"), _ownershipCode(ACCOUNT), "LOCK-00000-00000");
        _assertRejected(_proof("http", wrongNameParameters, wrongNameContext, WITNESS_KEY), ACCOUNT, 42, true, 0, SESSION);

        string memory zeroPaddedParameters =
            _replaceOnce(_parameters(), "\"totalXp\":\"1000\"", "\"totalXp\":\"01000\"");
        string memory zeroPaddedContext =
            _replaceOnce(_context("42:baseline"), "\"totalXp\":\"1000\"", "\"totalXp\":\"01000\"");
        _assertRejected(
            _proof("http", zeroPaddedParameters, zeroPaddedContext, WITNESS_KEY), ACCOUNT, 42, true, 0, SESSION
        );
    }

    function testRejectsUnknownOrReorderedContextKeys() public {
        string memory unknown =
            _replaceOnce(_context("42:baseline"), "{\"contextAddress\"", "{\"alien\":\"x\",\"contextAddress\"");
        _assertRejected(_proof("http", _parameters(), unknown, WITNESS_KEY), ACCOUNT, 42, true, 0, SESSION);

        string memory reordered = _replaceOnce(
            _context("42:baseline"),
            "\"contextAddress\":\"0x000000000000000000000000000000000000a11c\",\"contextMessage\":\"42:baseline\"",
            "\"contextMessage\":\"42:baseline\",\"contextAddress\":\"0x000000000000000000000000000000000000a11c\""
        );
        _assertRejected(_proof("http", _parameters(), reordered, WITNESS_KEY), ACCOUNT, 42, true, 0, SESSION);
    }

    function testSyntheticSpikeRejectsUnvalidatedSdkTeeContext() public {
        string memory teeContext = _replaceOnce(
            _context("42:baseline"),
            "{\"contextAddress\"",
            "{\"attestationNonce\":\"0x1234\",\"attestationNonceData\":{\"applicationId\":\"0xapp\",\"sessionId\":\"session-123\",\"timestamp\":\"1784000000000\"},\"contextAddress\""
        );
        _assertRejected(_proof("http", _parameters(), teeContext, WITNESS_KEY), ACCOUNT, 42, true, 0, SESSION);
    }

    function _assertParametersRejected(string memory parameters) private {
        Reclaim.Proof memory proof = _proof("http", parameters, _context("42:baseline"), WITNESS_KEY);
        _assertRejected(proof, ACCOUNT, 42, true, 0, SESSION);
    }

    function _assertRejected(
        Reclaim.Proof memory proof,
        address account,
        uint256 pactId,
        bool baseline,
        uint8 dayIndex,
        string memory session
    ) private view {
        (bool ok,) = address(verifier)
            .staticcall(
                abi.encodeCall(
                    verifier.validateSyntheticDuolingoProofForTesting,
                    (proof, account, pactId, baseline, dayIndex, session)
                )
            );
        require(!ok, "mutation unexpectedly accepted");
    }

    function _revertSelector(bytes memory reason) private pure returns (bytes4 selector) {
        if (reason.length < 4) return bytes4(0);
        assembly {
            selector := mload(add(reason, 32))
        }
    }

    function _validProof(uint256 signerKey) private returns (Reclaim.Proof memory) {
        return _proof("http", _parameters(), _context("42:baseline"), signerKey);
    }

    function _proof(string memory provider, string memory parameters, string memory context, uint256 signerKey)
        private
        returns (Reclaim.Proof memory proof)
    {
        proof.claimInfo = Claims.ClaimInfo({provider: provider, parameters: parameters, context: context});
        proof.signedClaim.claim = Claims.CompleteClaimData({
            identifier: Claims.hashClaimInfo(proof.claimInfo), owner: ACCOUNT, timestampS: PROOF_TIME, epoch: 1
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

    function _parameters() private pure returns (string memory) {
        string memory prefix = string.concat(
            "{\"body\":\"\",\"method\":\"GET\",\"paramValues\":{\"duolingo_username\":\"",
            USERNAME,
            "\",\"id\":\"",
            PROFILE_ID,
            "\",\"name\":\"",
            _ownershipCode(ACCOUNT),
            "\",\"totalXp\":\"",
            XP,
            "\",\"username\":\"",
            USERNAME,
            "\"},\"responseMatches\":"
        );
        string memory matches =
            "[{\"value\":\"\\\"id\\\":{{id}}\",\"type\":\"contains\",\"isOptional\":false,\"order\":0,\"invert\":false},{\"value\":\"\\\"name\\\":\\\"{{name}}\\\"\",\"type\":\"contains\",\"isOptional\":false,\"order\":1,\"invert\":false},{\"value\":\"\\\"username\\\":\\\"{{username}}\\\"\",\"type\":\"contains\",\"isOptional\":false,\"order\":2,\"invert\":false},{\"value\":\"\\\"totalXp\\\":{{totalXp}}\",\"type\":\"contains\",\"isOptional\":false,\"order\":3,\"invert\":false}]";
        string memory redactions =
            "[{\"order\":0,\"jsonPath\":\"$.users[0].id\",\"regex\":\"\\\"id\\\":(?<id>\\\\d+)\"},{\"order\":1,\"jsonPath\":\"$.users[0].name\",\"regex\":\"\\\"name\\\":\\\"(?<name>LOCK-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{5}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{5})\\\"\"},{\"order\":2,\"jsonPath\":\"$.users[0].username\",\"regex\":\"\\\"username\\\":\\\"(?<username>[A-Za-z0-9._-]+)\\\"\"},{\"order\":3,\"jsonPath\":\"$.users[0].totalXp\",\"regex\":\"\\\"totalXp\\\":(?<totalXp>\\\\d+)\"}]";
        return string.concat(
            prefix,
            matches,
            ",\"responseRedactions\":",
            redactions,
            ",\"url\":\"https://www.duolingo.com/2017-06-30/users?username={{duolingo_username}}\"}"
        );
    }

    function _context(string memory message) private pure returns (string memory) {
        return string.concat(
            "{\"contextAddress\":\"0x000000000000000000000000000000000000a11c\",\"contextMessage\":\"",
            message,
            "\",\"extractedParameters\":{\"id\":\"",
            PROFILE_ID,
            "\",\"name\":\"",
            _ownershipCode(ACCOUNT),
            "\",\"totalXp\":\"",
            XP,
            "\",\"username\":\"",
            USERNAME,
            "\"},\"providerHash\":\"0x3b307716fa21be0484af45041f9288da0cbf09aa41ca2aa21ec5b83d98a34b80\",\"reclaimSessionId\":\"",
            SESSION,
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

    function _ownershipCode(address account) private pure returns (string memory) {
        bytes32 digest = keccak256(abi.encode("LOCK_IN_DUOLINGO", uint256(143), account));
        bytes32 alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        bytes memory output = new bytes(16);
        output[0] = "L";
        output[1] = "O";
        output[2] = "C";
        output[3] = "K";
        output[4] = "-";
        output[10] = "-";
        uint256 value = uint256(digest) >> 206;
        for (uint256 i; i < 10; ++i) {
            uint256 shift = (9 - i) * 5;
            output[i < 5 ? 5 + i : 6 + i] = alphabet[(value >> shift) & 31];
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
