// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Reclaim} from "@reclaimprotocol/solidity-sdk/contracts/Reclaim.sol";
import {Claims} from "@reclaimprotocol/solidity-sdk/contracts/lib/Claims.sol";
import {LockInProofTypes} from "./LockInProofTypes.sol";

/// @notice Isolated verifier spike for the private Lock In Duolingo provider.
/// @dev This contract deliberately does not call Reclaim's upgradeable registry. It pins one witness forever.
/// @dev IMPORTANT: LIVE_SCHEMA_CONFIRMED remains false until a real 1.0.3 proof is captured and its
///      `parameters` and `context` bytes are compared with this canonical grammar. This spike must not be
///      connected to the escrow or described as release-ready before that gate is completed.
/// @dev Known SDK 5.8.2 gap: default `acceptTeeAttestation: true` adds `attestationNonce` and
///      `attestationNonceData` to context. This synthetic grammar intentionally rejects those currently-unverified
///      keys instead of accepting TEE metadata without validating its application/session/timestamp binding.
contract LockInReclaimVerifier {
    string public constant DUOLINGO_PROVIDER_ID = "cdf8cb3b-2976-4413-ab2d-693ae5028380";
    string public constant DUOLINGO_PROVIDER_VERSION = "1.0.3";
    string public constant DUOLINGO_PROVIDER_HASH =
        "0x3b307716fa21be0484af45041f9288da0cbf09aa41ca2aa21ec5b83d98a34b80";
    bool public constant LIVE_SCHEMA_CONFIRMED = false;

    uint256 private constant MONAD_CHAIN_ID = 143;
    uint256 private constant MAX_JSON_BYTES = 8_192;
    uint256 private constant MAX_JSON_DEPTH = 12;
    uint256 private constant MAX_PROOF_AGE_SECONDS = 10 minutes;
    uint256 private constant MAX_FUTURE_SKEW_SECONDS = 60;
    bytes32 private constant PROVIDER_KEY = keccak256("cdf8cb3b-2976-4413-ab2d-693ae5028380@1.0.3");
    // keccak256 of the canonical JSON arrays in providers/duolingo-owned-xp.json.
    bytes32 private constant RESPONSE_MATCHES_HASH = 0xb42d9e3e2374b5634081176a7ed0f70d1d395d82c671c36b0d479935ace0f121;
    bytes32 private constant RESPONSE_REDACTIONS_HASH =
        0x0df6d6f32041ded00c68c05c9ae5833712ac918ad62e26e7b119903e63f7ad5e;

    address public immutable WITNESS;

    error ZeroWitness();
    error InvalidProvider();
    error InvalidClaimIdentifier();
    error InvalidClaimOwner();
    error InvalidSignatureCount();
    error InvalidWitness();
    error InvalidProofTime();
    error JsonTooLarge();
    error InvalidJson();
    error UnknownJsonKey(bytes32 keyHash);
    error NonCanonicalJson();
    error InvalidDuolingoSchema();
    error InvalidContext();
    error InvalidDuolingoFields();
    error LiveSchemaUnconfirmed();

    struct DuolingoFields {
        string displayName;
        string inputUsername;
        string profileId;
        string totalXp;
        string username;
        uint8 mask;
    }

    struct ContextPolicy {
        address account;
        string message;
        string sessionId;
    }

    constructor(address pinnedWitness) {
        if (pinnedWitness == address(0)) revert ZeroWitness();
        WITNESS = pinnedWitness;
    }

    /// @notice Verifies a canonical Duolingo proof without consulting an upgradeable witness registry.
    /// @param baseline True for a baseline proof; false for a completion proof.
    /// @param dayIndex Zero-based completion day. Must be zero for a baseline and below 30 otherwise.
    /// @return evidence Canonical identity, XP, proof-set hash and witness timestamp.
    function validateDuolingoProof(
        Reclaim.Proof calldata proof,
        address account,
        uint256 pactId,
        bool baseline,
        uint8 dayIndex,
        string calldata expectedSessionId
    ) external view returns (LockInProofTypes.DuolingoEvidence memory evidence) {
        if (!LIVE_SCHEMA_CONFIRMED) revert LiveSchemaUnconfirmed();
        (evidence.identityHash, evidence.totalXp, evidence.proofSetHash, evidence.proofTimestamp) =
            _validateDuolingoProof(proof, account, pactId, baseline, dayIndex, expectedSessionId);
    }

    /// @dev Canonical grammar implementation. It is internal so synthetic fixtures can exercise it from a
    ///      test-only harness without making the production entry point usable before live-schema confirmation.
    function _validateDuolingoProof(
        Reclaim.Proof calldata proof,
        address account,
        uint256 pactId,
        bool baseline,
        uint8 dayIndex,
        string calldata expectedSessionId
    ) internal view returns (bytes32 identityHash, uint64 totalXp, bytes32 proofHash, uint32 timestampS) {
        if (account == address(0) || bytes(expectedSessionId).length == 0 || bytes(expectedSessionId).length > 128) {
            revert InvalidContext();
        }
        if ((baseline && dayIndex != 0) || (!baseline && dayIndex >= 30)) revert InvalidContext();
        _validateSafeToken(bytes(expectedSessionId));

        if (keccak256(bytes(proof.claimInfo.provider)) != keccak256("http")) revert InvalidProvider();

        Claims.ClaimInfo memory claimInfo = proof.claimInfo;
        bytes32 identifier = Claims.hashClaimInfo(claimInfo);
        if (proof.signedClaim.claim.identifier != identifier) revert InvalidClaimIdentifier();
        // Match the backend's canonical singleton proof-set hash:
        // keccak256(concat(identifier)). Returning the raw identifier here would
        // let the direct verifier and EIP-712 attestation bind different values.
        proofHash = keccak256(abi.encodePacked(identifier));
        if (proof.signedClaim.claim.owner != account) revert InvalidClaimOwner();
        if (proof.signedClaim.signatures.length != 1) revert InvalidSignatureCount();

        Claims.SignedClaim memory signedClaim = proof.signedClaim;
        address[] memory signers = Claims.recoverSignersOfSignedClaim(signedClaim);
        if (signers[0] != WITNESS) revert InvalidWitness();
        timestampS = proof.signedClaim.claim.timestampS;
        if (
            uint256(timestampS) > block.timestamp + MAX_FUTURE_SKEW_SECONDS
                || block.timestamp > uint256(timestampS) + MAX_PROOF_AGE_SECONDS
        ) revert InvalidProofTime();

        DuolingoFields memory parameterFields = _parseParameters(bytes(proof.claimInfo.parameters), expectedSessionId);
        string memory message =
            string.concat(_uintToString(pactId), baseline ? ":baseline" : string.concat(":", _uintToString(dayIndex)));
        ContextPolicy memory policy = ContextPolicy({account: account, message: message, sessionId: expectedSessionId});
        DuolingoFields memory extractedFields = _parseContext(bytes(proof.claimInfo.context), policy);

        _requireEqualFields(parameterFields, extractedFields);
        if (keccak256(bytes(parameterFields.inputUsername)) != keccak256(bytes(parameterFields.username))) {
            revert InvalidDuolingoFields();
        }
        if (!_validUsername(bytes(parameterFields.username))) revert InvalidDuolingoFields();

        string memory ownershipCode = _duolingoOwnershipCode(account);
        if (keccak256(bytes(parameterFields.displayName)) != keccak256(bytes(ownershipCode))) {
            revert InvalidDuolingoFields();
        }

        uint256 profileId = _parseCanonicalUint(bytes(parameterFields.profileId), 20, type(uint64).max);
        if (profileId == 0) revert InvalidDuolingoFields();
        uint256 parsedXp = _parseCanonicalUint(bytes(parameterFields.totalXp), 10, 2_000_000_000);
        identityHash = keccak256(abi.encode(PROVIDER_KEY, profileId));
        // forge-lint: disable-next-line(unsafe-typecast)
        totalXp = uint64(parsedXp);
    }

    function _parseParameters(bytes memory json, string memory expectedSessionId)
        private
        pure
        returns (DuolingoFields memory fields)
    {
        if (json.length > MAX_JSON_BYTES) revert JsonTooLarge();
        uint256 cursor = _expectByte(json, 0, "{");
        uint8 lastRank;
        uint16 mask;

        while (true) {
            if (cursor >= json.length || json[cursor] == "}") break;
            (bytes32 keyHash, uint256 afterKey) = _readKey(json, cursor);
            cursor = _expectByte(json, afterKey, ":");
            uint8 rank = _parameterRank(keyHash);
            if (rank <= lastRank) revert NonCanonicalJson();
            lastRank = rank;
            mask |= uint16(1) << rank;

            if (rank == 1) {
                (string memory body, uint256 afterValue) = _readSecurityString(json, cursor);
                if (bytes(body).length != 0) revert InvalidDuolingoSchema();
                cursor = afterValue;
            } else if (rank == 2) {
                if (cursor >= json.length || json[cursor] != "{") revert InvalidDuolingoSchema();
                cursor = _skipJsonValue(json, cursor, 0);
            } else if (rank == 3) {
                (string memory method, uint256 afterValue) = _readSecurityString(json, cursor);
                if (keccak256(bytes(method)) != keccak256("GET")) revert InvalidDuolingoSchema();
                cursor = afterValue;
            } else if (rank == 4) {
                (fields, cursor) = _parseFields(json, cursor, true);
            } else if (rank == 5 || rank == 8) {
                (string memory session, uint256 afterValue) = _readSecurityString(json, cursor);
                if (keccak256(bytes(session)) != keccak256(bytes(expectedSessionId))) revert InvalidContext();
                cursor = afterValue;
            } else if (rank == 6 || rank == 7) {
                uint256 valueStart = cursor;
                cursor = _skipJsonValue(json, cursor, 0);
                bytes32 actualHash = _hashSlice(json, valueStart, cursor);
                bytes32 expectedHash = rank == 6 ? RESPONSE_MATCHES_HASH : RESPONSE_REDACTIONS_HASH;
                if (actualHash != expectedHash) revert InvalidDuolingoSchema();
            } else {
                (string memory url, uint256 afterValue) = _readSecurityString(json, cursor);
                if (
                    keccak256(bytes(url))
                        != keccak256("https://www.duolingo.com/2017-06-30/users?username={{duolingo_username}}")
                ) revert InvalidDuolingoSchema();
                cursor = afterValue;
            }

            if (cursor >= json.length) revert InvalidJson();
            if (json[cursor] == ",") {
                ++cursor;
                if (cursor >= json.length || json[cursor] == "}") revert InvalidJson();
                continue;
            }
            if (json[cursor] != "}") revert InvalidJson();
            break;
        }

        cursor = _expectByte(json, cursor, "}");
        if (cursor != json.length) revert InvalidJson();
        // method, paramValues, responseMatches, responseRedactions and url are mandatory.
        uint16 required = (uint16(1) << 3) | (uint16(1) << 4) | (uint16(1) << 6) | (uint16(1) << 7) | (uint16(1) << 9);
        if ((mask & required) != required || fields.mask != 31) revert InvalidDuolingoSchema();
    }

    function _parseContext(bytes memory json, ContextPolicy memory policy)
        private
        pure
        returns (DuolingoFields memory fields)
    {
        if (json.length > MAX_JSON_BYTES) revert JsonTooLarge();
        uint256 cursor = _expectByte(json, 0, "{");
        uint8 lastRank;
        uint8 mask;

        while (true) {
            if (cursor >= json.length || json[cursor] == "}") break;
            (bytes32 keyHash, uint256 afterKey) = _readKey(json, cursor);
            cursor = _expectByte(json, afterKey, ":");
            uint8 rank = _contextRank(keyHash);
            if (rank <= lastRank) revert NonCanonicalJson();
            lastRank = rank;
            mask |= uint8(1) << rank;

            if (rank == 1) {
                (string memory account, uint256 afterValue) = _readSecurityString(json, cursor);
                if (keccak256(bytes(account)) != keccak256(bytes(_addressToLowerHex(policy.account)))) {
                    revert InvalidContext();
                }
                cursor = afterValue;
            } else if (rank == 2) {
                (string memory message, uint256 afterValue) = _readSecurityString(json, cursor);
                if (keccak256(bytes(message)) != keccak256(bytes(policy.message))) revert InvalidContext();
                cursor = afterValue;
            } else if (rank == 3) {
                (fields, cursor) = _parseFields(json, cursor, false);
            } else if (rank == 4) {
                (string memory providerHash, uint256 afterValue) = _readSecurityString(json, cursor);
                // Defence in depth only. The exact signed request schema above is still independently checked.
                if (keccak256(bytes(providerHash)) != keccak256(bytes(DUOLINGO_PROVIDER_HASH))) {
                    revert InvalidDuolingoSchema();
                }
                cursor = afterValue;
            } else {
                (string memory session, uint256 afterValue) = _readSecurityString(json, cursor);
                if (keccak256(bytes(session)) != keccak256(bytes(policy.sessionId))) revert InvalidContext();
                cursor = afterValue;
            }

            if (cursor >= json.length) revert InvalidJson();
            if (json[cursor] == ",") {
                ++cursor;
                if (cursor >= json.length || json[cursor] == "}") revert InvalidJson();
                continue;
            }
            if (json[cursor] != "}") revert InvalidJson();
            break;
        }

        cursor = _expectByte(json, cursor, "}");
        if (cursor != json.length) revert InvalidJson();
        if (mask != 62 || fields.mask != 30) revert InvalidContext();
    }

    function _parseFields(bytes memory json, uint256 cursor, bool includeInput)
        private
        pure
        returns (DuolingoFields memory fields, uint256)
    {
        cursor = _expectByte(json, cursor, "{");
        uint8 lastRank;

        while (true) {
            if (cursor >= json.length || json[cursor] == "}") break;
            (bytes32 keyHash, uint256 afterKey) = _readKey(json, cursor);
            cursor = _expectByte(json, afterKey, ":");
            uint8 rank = _fieldRank(keyHash);
            if ((!includeInput && rank == 1) || rank <= lastRank) revert NonCanonicalJson();
            lastRank = rank;
            fields.mask |= uint8(1) << (rank - 1);

            (string memory value, uint256 afterValue) = _readSecurityString(json, cursor);
            cursor = afterValue;
            if (rank == 1) fields.inputUsername = value;
            else if (rank == 2) fields.profileId = value;
            else if (rank == 3) fields.displayName = value;
            else if (rank == 4) fields.totalXp = value;
            else fields.username = value;

            if (cursor >= json.length) revert InvalidJson();
            if (json[cursor] == ",") {
                ++cursor;
                if (cursor >= json.length || json[cursor] == "}") revert InvalidJson();
                continue;
            }
            if (json[cursor] != "}") revert InvalidJson();
            break;
        }
        cursor = _expectByte(json, cursor, "}");
        return (fields, cursor);
    }

    function _parameterRank(bytes32 keyHash) private pure returns (uint8) {
        if (keyHash == keccak256("body")) return 1;
        if (keyHash == keccak256("headers")) return 2;
        if (keyHash == keccak256("method")) return 3;
        if (keyHash == keccak256("paramValues")) return 4;
        if (keyHash == keccak256("proxySessionId")) return 5;
        if (keyHash == keccak256("responseMatches")) return 6;
        if (keyHash == keccak256("responseRedactions")) return 7;
        if (keyHash == keccak256("sessionId")) return 8;
        if (keyHash == keccak256("url")) return 9;
        revert UnknownJsonKey(keyHash);
    }

    function _contextRank(bytes32 keyHash) private pure returns (uint8) {
        if (keyHash == keccak256("contextAddress")) return 1;
        if (keyHash == keccak256("contextMessage")) return 2;
        if (keyHash == keccak256("extractedParameters")) return 3;
        if (keyHash == keccak256("providerHash")) return 4;
        if (keyHash == keccak256("reclaimSessionId")) return 5;
        revert UnknownJsonKey(keyHash);
    }

    function _fieldRank(bytes32 keyHash) private pure returns (uint8) {
        if (keyHash == keccak256("duolingo_username")) return 1;
        if (keyHash == keccak256("id")) return 2;
        if (keyHash == keccak256("name")) return 3;
        if (keyHash == keccak256("totalXp")) return 4;
        if (keyHash == keccak256("username")) return 5;
        revert UnknownJsonKey(keyHash);
    }

    function _readKey(bytes memory json, uint256 cursor) private pure returns (bytes32 keyHash, uint256) {
        (uint256 start, uint256 end, uint256 next, bool escaped) = _readJsonString(json, cursor);
        if (escaped || end == start) revert NonCanonicalJson();
        return (_hashSlice(json, start, end), next);
    }

    function _readSecurityString(bytes memory json, uint256 cursor)
        private
        pure
        returns (string memory value, uint256)
    {
        (uint256 start, uint256 end, uint256 next, bool escaped) = _readJsonString(json, cursor);
        if (escaped) revert NonCanonicalJson();
        bytes memory output = new bytes(end - start);
        for (uint256 i; i < output.length; ++i) {
            output[i] = json[start + i];
        }
        return (string(output), next);
    }

    function _readJsonString(bytes memory json, uint256 cursor)
        private
        pure
        returns (uint256 start, uint256 end, uint256 next, bool escaped)
    {
        if (cursor >= json.length || json[cursor] != '"') revert InvalidJson();
        start = ++cursor;
        while (cursor < json.length) {
            bytes1 current = json[cursor];
            if (current == '"') return (start, cursor, cursor + 1, escaped);
            if (uint8(current) < 0x20) revert InvalidJson();
            if (current == "\\") {
                escaped = true;
                ++cursor;
                if (cursor >= json.length) revert InvalidJson();
                bytes1 escape = json[cursor];
                if (
                    escape != '"' && escape != "\\" && escape != "/" && escape != "b" && escape != "f" && escape != "n"
                        && escape != "r" && escape != "t" && escape != "u"
                ) revert InvalidJson();
                if (escape == "u") {
                    if (cursor + 4 >= json.length) revert InvalidJson();
                    for (uint256 i = 1; i <= 4; ++i) {
                        if (!_isHex(json[cursor + i])) revert InvalidJson();
                    }
                    cursor += 4;
                }
            }
            ++cursor;
        }
        revert InvalidJson();
    }

    function _skipJsonValue(bytes memory json, uint256 cursor, uint256 depth) private pure returns (uint256) {
        if (depth > MAX_JSON_DEPTH || cursor >= json.length) revert InvalidJson();
        bytes1 current = json[cursor];
        if (current == '"') {
            (,, uint256 next,) = _readJsonString(json, cursor);
            return next;
        }
        if (current == "{") {
            ++cursor;
            if (cursor < json.length && json[cursor] == "}") return cursor + 1;
            while (true) {
                (,, uint256 afterKey,) = _readJsonString(json, cursor);
                cursor = _expectByte(json, afterKey, ":");
                cursor = _skipJsonValue(json, cursor, depth + 1);
                if (cursor >= json.length) revert InvalidJson();
                if (json[cursor] == "}") return cursor + 1;
                cursor = _expectByte(json, cursor, ",");
            }
        }
        if (current == "[") {
            ++cursor;
            if (cursor < json.length && json[cursor] == "]") return cursor + 1;
            while (true) {
                cursor = _skipJsonValue(json, cursor, depth + 1);
                if (cursor >= json.length) revert InvalidJson();
                if (json[cursor] == "]") return cursor + 1;
                cursor = _expectByte(json, cursor, ",");
            }
        }
        if (_startsWith(json, cursor, "true")) return cursor + 4;
        if (_startsWith(json, cursor, "false")) return cursor + 5;
        if (_startsWith(json, cursor, "null")) return cursor + 4;
        return _skipJsonNumber(json, cursor);
    }

    function _skipJsonNumber(bytes memory json, uint256 cursor) private pure returns (uint256) {
        uint256 start = cursor;
        if (json[cursor] == "-") {
            ++cursor;
            if (cursor >= json.length) revert InvalidJson();
        }
        if (json[cursor] == "0") {
            ++cursor;
            if (cursor < json.length && json[cursor] >= "0" && json[cursor] <= "9") revert InvalidJson();
        } else {
            if (json[cursor] < "1" || json[cursor] > "9") revert InvalidJson();
            while (cursor < json.length && json[cursor] >= "0" && json[cursor] <= "9") ++cursor;
        }
        if (cursor < json.length && json[cursor] == ".") {
            ++cursor;
            uint256 fractionStart = cursor;
            while (cursor < json.length && json[cursor] >= "0" && json[cursor] <= "9") ++cursor;
            if (cursor == fractionStart) revert InvalidJson();
        }
        if (cursor < json.length && (json[cursor] == "e" || json[cursor] == "E")) {
            ++cursor;
            if (cursor < json.length && (json[cursor] == "+" || json[cursor] == "-")) ++cursor;
            uint256 exponentStart = cursor;
            while (cursor < json.length && json[cursor] >= "0" && json[cursor] <= "9") ++cursor;
            if (cursor == exponentStart) revert InvalidJson();
        }
        if (cursor == start) revert InvalidJson();
        return cursor;
    }

    function _startsWith(bytes memory data, uint256 cursor, string memory literal) private pure returns (bool) {
        bytes memory expected = bytes(literal);
        if (cursor + expected.length > data.length) return false;
        for (uint256 i; i < expected.length; ++i) {
            if (data[cursor + i] != expected[i]) return false;
        }
        return true;
    }

    function _expectByte(bytes memory data, uint256 cursor, bytes1 expected) private pure returns (uint256) {
        if (cursor >= data.length || data[cursor] != expected) revert InvalidJson();
        return cursor + 1;
    }

    function _hashSlice(bytes memory data, uint256 start, uint256 end) private pure returns (bytes32) {
        if (end < start || end > data.length) revert InvalidJson();
        bytes memory output = new bytes(end - start);
        for (uint256 i; i < output.length; ++i) {
            output[i] = data[start + i];
        }
        return keccak256(output);
    }

    function _requireEqualFields(DuolingoFields memory left, DuolingoFields memory right) private pure {
        if (
            keccak256(bytes(left.displayName)) != keccak256(bytes(right.displayName))
                || keccak256(bytes(left.profileId)) != keccak256(bytes(right.profileId))
                || keccak256(bytes(left.totalXp)) != keccak256(bytes(right.totalXp))
                || keccak256(bytes(left.username)) != keccak256(bytes(right.username))
        ) revert InvalidDuolingoFields();
    }

    function _parseCanonicalUint(bytes memory raw, uint256 maxDigits, uint256 maximum)
        private
        pure
        returns (uint256 value)
    {
        if (raw.length == 0 || raw.length > maxDigits || (raw.length > 1 && raw[0] == "0")) {
            revert InvalidDuolingoFields();
        }
        for (uint256 i; i < raw.length; ++i) {
            uint8 character = uint8(raw[i]);
            if (character < 48 || character > 57) revert InvalidDuolingoFields();
            value = value * 10 + character - 48;
        }
        if (value > maximum) revert InvalidDuolingoFields();
    }

    function _validUsername(bytes memory username) private pure returns (bool) {
        if (username.length == 0 || username.length > 64) return false;
        for (uint256 i; i < username.length; ++i) {
            uint8 c = uint8(username[i]);
            bool valid =
                (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 45 || c == 46 || c == 95;
            if (!valid) return false;
        }
        return true;
    }

    function _validateSafeToken(bytes memory token) private pure {
        for (uint256 i; i < token.length; ++i) {
            uint8 c = uint8(token[i]);
            bool valid = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 45 || c == 46
                || c == 58 || c == 95;
            if (!valid) revert InvalidContext();
        }
    }

    function _duolingoOwnershipCode(address account) private pure returns (string memory) {
        bytes32 digest = keccak256(abi.encode("LOCK_IN_DUOLINGO", MONAD_CHAIN_ID, account));
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

    function _addressToLowerHex(address account) private pure returns (string memory) {
        bytes20 value = bytes20(account);
        bytes16 alphabet = "0123456789abcdef";
        bytes memory output = new bytes(42);
        output[0] = "0";
        output[1] = "x";
        for (uint256 i; i < 20; ++i) {
            output[2 + i * 2] = alphabet[uint8(value[i]) >> 4];
            output[3 + i * 2] = alphabet[uint8(value[i]) & 0x0f];
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

    function _isHex(bytes1 character) private pure returns (bool) {
        return (character >= "0" && character <= "9") || (character >= "a" && character <= "f")
            || (character >= "A" && character <= "F");
    }
}
