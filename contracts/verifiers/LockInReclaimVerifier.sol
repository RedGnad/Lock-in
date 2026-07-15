// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Reclaim} from "@reclaimprotocol/solidity-sdk/contracts/Reclaim.sol";
import {Claims} from "@reclaimprotocol/solidity-sdk/contracts/lib/Claims.sol";
import {LockInProofTypes} from "./LockInProofTypes.sol";

/// @notice Immutable direct verifier for the private Lock In Duolingo provider.
/// @dev The provider requires two claims in order: a self-only ownership request and an XP snapshot request.
/// @dev LIVE_SCHEMA_CONFIRMED stays false until a real app-created 1.0.4 TEE proof is compared byte-for-byte
///      with this grammar. Synthetic and local MCP proofs are necessary but do not satisfy that release gate.
contract LockInReclaimVerifier {
    string public constant DUOLINGO_PROVIDER_ID = "cdf8cb3b-2976-4413-ab2d-693ae5028380";
    string public constant DUOLINGO_PROVIDER_VERSION = "1.0.4";
    string public constant DUOLINGO_OWNERSHIP_REQUEST_HASH =
        "0xea3ca9aeaa60e89d8f4a9134f5b314a78295e7e164f75eddb6d89f911a83766e";
    string public constant DUOLINGO_XP_REQUEST_HASH =
        "0x1e2b7c4c1dbfe8694e49eee2c1e92ccac09ef048be735e5c54af7c006509b2ac";
    bool public constant LIVE_SCHEMA_CONFIRMED = false;

    uint8 private constant ROLE_OWNERSHIP = 1;
    uint8 private constant ROLE_XP = 2;
    uint256 private constant MAX_JSON_BYTES = 8_192;
    uint256 private constant MAX_JSON_DEPTH = 12;
    uint256 private constant MAX_PROOF_AGE_SECONDS = 10 minutes;
    uint256 private constant MAX_FUTURE_SKEW_SECONDS = 60;
    bytes32 private constant PROVIDER_KEY = keccak256("cdf8cb3b-2976-4413-ab2d-693ae5028380@1.0.4");

    bytes32 private constant OWNERSHIP_MATCHES_HASH =
        0x989b96df035ef014c6d1c47de287b47064a396965075e770910b6fbc3d8e4ca2;
    bytes32 private constant OWNERSHIP_REDACTIONS_HASH =
        0x9738060805623c6fd93f975b64d3c24a1e015102c8c591d44e0d10b4759b3db7;
    bytes32 private constant XP_MATCHES_HASH = 0x6453f3944f2bae492c7a76627f0e3e9d8bbc919a9d8244a3d2c1363df7b71430;
    bytes32 private constant XP_REDACTIONS_HASH = 0x43df424c446d73cb7fb98b8c23ebe70bf3e8530ceecf71cd2f55c92633e2f725;

    address public immutable WITNESS;

    error ZeroWitness();
    error InvalidProvider();
    error InvalidClaimIdentifier();
    error InvalidClaimOwner();
    error InvalidSignatureCount();
    error InvalidWitness();
    error InvalidProofTime();
    error InvalidProofCount();
    error JsonTooLarge();
    error InvalidJson();
    error UnknownJsonKey(bytes32 keyHash);
    error NonCanonicalJson();
    error InvalidDuolingoSchema();
    error InvalidContext();
    error InvalidDuolingoFields();
    error LiveSchemaUnconfirmed();

    struct DuolingoFields {
        string inputProfileId;
        string profileId;
        string marker;
        string username;
        string totalXp;
        uint8 mask;
    }

    struct ContextPolicy {
        address account;
        string message;
        string providerHash;
        string sessionId;
    }

    struct CheckedProof {
        bytes32 identifier;
        uint32 timestampS;
        DuolingoFields fields;
    }

    constructor(address pinnedWitness) {
        if (pinnedWitness == address(0)) revert ZeroWitness();
        WITNESS = pinnedWitness;
    }

    function validateDuolingoProofs(
        Reclaim.Proof[] calldata proofs,
        address account,
        uint256 pactId,
        bool baseline,
        uint8 dayIndex,
        string calldata expectedSessionId
    ) external view returns (LockInProofTypes.DuolingoEvidence memory evidence) {
        if (!LIVE_SCHEMA_CONFIRMED) revert LiveSchemaUnconfirmed();
        (evidence.identityHash, evidence.totalXp, evidence.proofSetHash, evidence.proofTimestamp) =
            _validateDuolingoProofs(proofs, account, pactId, baseline, dayIndex, expectedSessionId);
    }

    /// @dev Internal for the synthetic test harness. Production remains fail-closed until the live schema gate.
    function _validateDuolingoProofs(
        Reclaim.Proof[] calldata proofs,
        address account,
        uint256 pactId,
        bool baseline,
        uint8 dayIndex,
        string calldata expectedSessionId
    ) internal view returns (bytes32 identityHash, uint64 totalXp, bytes32 proofHash, uint32 timestampS) {
        if (proofs.length != 2) revert InvalidProofCount();
        if (account == address(0) || bytes(expectedSessionId).length == 0 || bytes(expectedSessionId).length > 128) {
            revert InvalidContext();
        }
        if ((baseline && dayIndex != 0) || (!baseline && dayIndex >= 30)) revert InvalidContext();
        _validateSafeToken(bytes(expectedSessionId));

        string memory message =
            string.concat(_uintToString(pactId), baseline ? ":baseline" : string.concat(":", _uintToString(dayIndex)));
        CheckedProof memory ownership = _validateOne(
            proofs[0], account, message, expectedSessionId, ROLE_OWNERSHIP, DUOLINGO_OWNERSHIP_REQUEST_HASH
        );
        CheckedProof memory xp =
            _validateOne(proofs[1], account, message, expectedSessionId, ROLE_XP, DUOLINGO_XP_REQUEST_HASH);

        if (keccak256(bytes(ownership.fields.marker)) != keccak256("disable_social")) {
            revert InvalidDuolingoFields();
        }
        if (
            keccak256(bytes(ownership.fields.inputProfileId)) != keccak256(bytes(xp.fields.inputProfileId))
                || keccak256(bytes(xp.fields.inputProfileId)) != keccak256(bytes(xp.fields.profileId))
        ) revert InvalidDuolingoFields();
        if (!_validUsername(bytes(xp.fields.username))) revert InvalidDuolingoFields();

        uint256 profileId = _parseCanonicalUint(bytes(xp.fields.profileId), 20, type(uint64).max);
        if (profileId == 0) revert InvalidDuolingoFields();
        uint256 parsedXp = _parseCanonicalUint(bytes(xp.fields.totalXp), 10, 2_000_000_000);
        identityHash = keccak256(abi.encode(PROVIDER_KEY, profileId));
        proofHash = keccak256(abi.encodePacked(ownership.identifier, xp.identifier));
        timestampS = xp.timestampS;
        // forge-lint: disable-next-line(unsafe-typecast)
        totalXp = uint64(parsedXp);
    }

    function _validateOne(
        Reclaim.Proof calldata proof,
        address account,
        string memory message,
        string calldata expectedSessionId,
        uint8 role,
        string memory providerHash
    ) private view returns (CheckedProof memory output) {
        if (keccak256(bytes(proof.claimInfo.provider)) != keccak256("http")) {
            revert InvalidProvider();
        }
        Claims.ClaimInfo memory claimInfo = proof.claimInfo;
        output.identifier = Claims.hashClaimInfo(claimInfo);
        if (proof.signedClaim.claim.identifier != output.identifier) revert InvalidClaimIdentifier();
        if (proof.signedClaim.claim.owner != account) revert InvalidClaimOwner();
        if (proof.signedClaim.signatures.length != 1) revert InvalidSignatureCount();
        Claims.SignedClaim memory signedClaim = proof.signedClaim;
        address[] memory signers = Claims.recoverSignersOfSignedClaim(signedClaim);
        if (signers[0] != WITNESS) revert InvalidWitness();
        output.timestampS = proof.signedClaim.claim.timestampS;
        if (
            uint256(output.timestampS) > block.timestamp + MAX_FUTURE_SKEW_SECONDS
                || block.timestamp > uint256(output.timestampS) + MAX_PROOF_AGE_SECONDS
        ) revert InvalidProofTime();

        DuolingoFields memory parameterFields =
            _parseParameters(bytes(proof.claimInfo.parameters), expectedSessionId, role);
        ContextPolicy memory policy = ContextPolicy({
            account: account, message: message, providerHash: providerHash, sessionId: expectedSessionId
        });
        DuolingoFields memory extractedFields = _parseContext(bytes(proof.claimInfo.context), policy, role);
        _requireEqualFields(parameterFields, extractedFields, role);
        output.fields = parameterFields;
    }

    function _parseParameters(bytes memory json, string memory expectedSessionId, uint8 role)
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
                (fields, cursor) = _parseFields(json, cursor, true, role);
            } else if (rank == 5 || rank == 8) {
                (string memory session, uint256 afterValue) = _readSecurityString(json, cursor);
                if (keccak256(bytes(session)) != keccak256(bytes(expectedSessionId))) revert InvalidContext();
                cursor = afterValue;
            } else if (rank == 6 || rank == 7) {
                uint256 valueStart = cursor;
                cursor = _skipJsonValue(json, cursor, 0);
                bytes32 actualHash = _hashSlice(json, valueStart, cursor);
                bytes32 expectedHash = role == ROLE_OWNERSHIP
                    ? (rank == 6 ? OWNERSHIP_MATCHES_HASH : OWNERSHIP_REDACTIONS_HASH)
                    : (rank == 6 ? XP_MATCHES_HASH : XP_REDACTIONS_HASH);
                if (actualHash != expectedHash) revert InvalidDuolingoSchema();
            } else {
                (string memory url, uint256 afterValue) = _readSecurityString(json, cursor);
                string memory expectedUrl = role == ROLE_OWNERSHIP
                    ? "https://www.duolingo.com/2023-05-23/users/{{duolingo_user_id}}/privacy-settings"
                    : "https://www.duolingo.com/2023-05-23/users/{{duolingo_user_id}}?fields=id,totalXp,username";
                if (keccak256(bytes(url)) != keccak256(bytes(expectedUrl))) revert InvalidDuolingoSchema();
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
        uint16 required = (uint16(1) << 3) | (uint16(1) << 4) | (uint16(1) << 6) | (uint16(1) << 7) | (uint16(1) << 9);
        uint8 expectedFields = role == ROLE_OWNERSHIP ? 5 : 27;
        if ((mask & required) != required || fields.mask != expectedFields) revert InvalidDuolingoSchema();
    }

    function _parseContext(bytes memory json, ContextPolicy memory policy, uint8 role)
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
                (string memory value, uint256 afterValue) = _readSecurityString(json, cursor);
                if (keccak256(bytes(value)) != keccak256(bytes(policy.message))) revert InvalidContext();
                cursor = afterValue;
            } else if (rank == 3) {
                (fields, cursor) = _parseFields(json, cursor, false, role);
            } else if (rank == 4) {
                (string memory value, uint256 afterValue) = _readSecurityString(json, cursor);
                if (keccak256(bytes(value)) != keccak256(bytes(policy.providerHash))) revert InvalidDuolingoSchema();
                cursor = afterValue;
            } else {
                (string memory value, uint256 afterValue) = _readSecurityString(json, cursor);
                if (keccak256(bytes(value)) != keccak256(bytes(policy.sessionId))) revert InvalidContext();
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
        uint8 expectedFields = role == ROLE_OWNERSHIP ? 4 : 26;
        if (mask != 62 || fields.mask != expectedFields) revert InvalidContext();
    }

    function _parseFields(bytes memory json, uint256 cursor, bool includeInput, uint8 role)
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
            if (role == ROLE_OWNERSHIP && rank != 1 && rank != 3) revert InvalidDuolingoFields();
            if (role == ROLE_XP && rank != 1 && rank != 2 && rank != 4 && rank != 5) {
                revert InvalidDuolingoFields();
            }
            lastRank = rank;
            fields.mask |= uint8(1) << (rank - 1);
            (string memory value, uint256 afterValue) = _readSecurityString(json, cursor);
            cursor = afterValue;
            if (rank == 1) fields.inputProfileId = value;
            else if (rank == 2) fields.profileId = value;
            else if (rank == 3) fields.marker = value;
            else if (rank == 4) fields.username = value;
            else fields.totalXp = value;

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
        if (keyHash == keccak256("duolingo_user_id")) return 1;
        if (keyHash == keccak256("id")) return 2;
        if (keyHash == keccak256("marker")) return 3;
        if (keyHash == keccak256("username")) return 4;
        if (keyHash == keccak256("xp")) return 5;
        revert UnknownJsonKey(keyHash);
    }

    function _requireEqualFields(DuolingoFields memory parameters, DuolingoFields memory extracted, uint8 role)
        private
        pure
    {
        if (role == ROLE_OWNERSHIP) {
            if (keccak256(bytes(parameters.marker)) != keccak256(bytes(extracted.marker))) {
                revert InvalidDuolingoFields();
            }
            return;
        }
        if (
            keccak256(bytes(parameters.profileId)) != keccak256(bytes(extracted.profileId))
                || keccak256(bytes(parameters.username)) != keccak256(bytes(extracted.username))
                || keccak256(bytes(parameters.totalXp)) != keccak256(bytes(extracted.totalXp))
        ) revert InvalidDuolingoFields();
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
