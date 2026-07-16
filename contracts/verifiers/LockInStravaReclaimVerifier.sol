// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Reclaim} from "@reclaimprotocol/solidity-sdk/contracts/Reclaim.sol";
import {Claims} from "@reclaimprotocol/solidity-sdk/contracts/lib/Claims.sol";
import {LockInProofTypes} from "./LockInProofTypes.sol";

/// @notice Strict, stateless parser for the two canonical Lock In Strava 6.0.0 request schemas.
/// @dev Kept separate so both this parser and its witness-verifying caller fit EIP-170 independently.
/// @dev 6.0.0 merges the former core/GPS/trainer requests into ONE combined activity claim. The 4-claim
///      1.0.3 set was too heavy for Reclaim's hosted browser lifecycle and never reached submission.
/// @dev The request is pinned from the signed `claimData.parameters` (url, method, body, responseMatches,
///      responseRedactions, paramValues), NOT from a `context.providerHash`: the live 6.0.0 context carries
///      no providerHash at all. The proof is bound to the caller through the signed context
///      (contextAddress / contextMessage / reclaimSessionId), never through `claimData.owner`, which the
///      live capture returns as the legacy placeholder 0x1234...7890.
contract LockInStravaClaimParser {
    string public constant STRAVA_PROVIDER_ID = "f3ec8292-d8f3-487c-a79d-f53f482f88e2";
    string public constant STRAVA_PROVIDER_VERSION = "6.0.0";
    bool public constant LIVE_SCHEMA_CONFIRMED = false;
    bytes32 public constant SCHEMA_ID =
        keccak256("lock-in:strava:f3ec8292-d8f3-487c-a79d-f53f482f88e2:6.0.0:two-claim");

    uint8 internal constant ROLE_MARKER = 0;
    uint8 internal constant ROLE_ACTIVITY = 1;

    uint256 private constant MAX_JSON_BYTES = 16_384;
    uint256 private constant MAX_JSON_DEPTH = 12;
    string private constant TEE_APPLICATION_ID = "0x15678cD04e54ccc2bC1c24cb455be3C60Eb11ADf";

    // keccak256 of the exact signed `responseMatches` / `responseRedactions` byte slices of the
    // published 6.0.0 provider, derived from the real captured proof set (session fa8968844e).
    bytes32 private constant MARKER_MATCHES_HASH = 0x50c9958ba1f7380373760eec627126eb1498058f65fcaa00b3653fcfb7aac000;
    bytes32 private constant MARKER_REDACTIONS_HASH =
        0x4b7281e7975402537afd79fe785e44f44f269f86538a681dc2e96701abb7b16a;
    bytes32 private constant ACTIVITY_MATCHES_HASH =
        0x3c79c61040bd099467dfa869da4c5a6683909e3f5c2ed5da11a81af84b32150d;
    bytes32 private constant ACTIVITY_REDACTIONS_HASH =
        0x3310274e2d06c8e19ceffb22908fce62af08b7c05da6638857d80ce411e04b9e;

    // Field bits are (rank - 1) over the canonical (lexicographic) paramValues key order.
    uint16 private constant MARKER_FIELDS = (uint16(1) << 0) | (uint16(1) << 6);
    uint16 private constant ACTIVITY_FIELDS = uint16(0x1FFF) ^ (uint16(1) << 6);

    error JsonTooLarge();
    error InvalidJson();
    error UnknownJsonKey(bytes32 keyHash);
    error NonCanonicalJson();
    error InvalidStravaSchema();
    error InvalidContext();
    error InvalidStravaFields();

    struct ParsedFields {
        string marker;
        bytes32 nameHash;
        bytes32 typeHash;
        bytes32 teeGroupHash;
        bytes32 geoHash;
        uint64 activityId;
        uint64 distanceMeters;
        uint64 startTime;
        uint64 movingTimeSeconds;
        uint64 elapsedTimeSeconds;
        uint64 elevationGainMeters;
        bool flagged;
        bool latlng;
        bool trainer;
        bool isAiProof;
        bool isPortalProof;
    }

    struct StravaFields {
        string challenge;
        string elapsed;
        string elevation;
        string flagged;
        string activityId;
        string latlng;
        string marker;
        string moving;
        string name;
        string raw;
        string time;
        string trainer;
        string activityType;
        uint16 mask;
    }

    struct ContextPolicy {
        address account;
        string message;
        string sessionId;
    }

    struct ContextResult {
        StravaFields fields;
        bytes32 teeGroupHash;
        bool isAiProof;
        bool isPortalProof;
    }

    function parseProofData(
        string calldata parameters,
        string calldata context,
        uint8 role,
        string calldata challenge,
        ContextPolicy memory contextPolicy
    ) external pure returns (ParsedFields memory parsed) {
        (StravaFields memory parameterFields, bytes32 geoHash) =
            _parseParameters(bytes(parameters), role, contextPolicy.sessionId);
        ContextResult memory context_ = _parseContext(bytes(context), role, contextPolicy);
        _requireEqualFields(parameterFields, context_.fields, role);

        // The activity URL keeps the literal {{context_challenge}} template, so the daily challenge
        // binds through the signed paramValues rather than through the request line.
        if (keccak256(bytes(parameterFields.challenge)) != keccak256(bytes(challenge))) revert InvalidContext();

        parsed.geoHash = geoHash;
        parsed.teeGroupHash = context_.teeGroupHash;
        // Parsed and surfaced, never gated on: `isAiProof`/`isPortalProof` are portal-orchestration
        // flags. The executed session is a clean deterministic 6.0.0 (PROOF_SUBMITTED, no -ai tag),
        // so the schema decides trust here; these two only have to be present and canonical booleans.
        parsed.isAiProof = context_.isAiProof;
        parsed.isPortalProof = context_.isPortalProof;

        if (role == ROLE_MARKER) {
            parsed.marker = parameterFields.marker;
            return parsed;
        }

        parsed.activityId = uint64(_parseCanonicalUint(bytes(parameterFields.activityId), 20, type(uint64).max));
        parsed.nameHash = keccak256(bytes(parameterFields.name));
        parsed.typeHash = keccak256(bytes(parameterFields.activityType));
        parsed.distanceMeters = uint64(_parseCanonicalUint(bytes(parameterFields.raw), 10, 1_000_000_000));
        parsed.movingTimeSeconds = uint64(_parseCanonicalUint(bytes(parameterFields.moving), 10, 1_000_000_000));
        parsed.elapsedTimeSeconds = uint64(_parseCanonicalUint(bytes(parameterFields.elapsed), 10, 1_000_000_000));
        parsed.elevationGainMeters = uint64(_parseCanonicalUint(bytes(parameterFields.elevation), 10, 1_000_000_000));
        parsed.startTime = _parseUtcTimestamp(bytes(parameterFields.time));
        parsed.flagged = _parseCanonicalBool(bytes(parameterFields.flagged));
        parsed.latlng = _parseCanonicalBool(bytes(parameterFields.latlng));
        parsed.trainer = _parseCanonicalBool(bytes(parameterFields.trainer));
    }

    function _parseParameters(bytes memory json, uint8 role, string memory sessionId)
        private
        pure
        returns (StravaFields memory fields, bytes32 geoHash)
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
                // additionalClientOptions: not part of the pinned request semantics, but must stay
                // canonical JSON so no unchecked bytes can hide inside the signed parameters.
                cursor = _skipJsonValue(json, cursor, 0);
            } else if (rank == 2) {
                (string memory body, uint256 afterValue) = _readSecurityString(json, cursor);
                if (bytes(body).length != 0) revert InvalidStravaSchema();
                cursor = afterValue;
            } else if (rank == 3) {
                (string memory geo, uint256 afterValue) = _readSecurityString(json, cursor);
                if (!_validGeo(bytes(geo))) revert InvalidStravaSchema();
                geoHash = keccak256(bytes(geo));
                cursor = afterValue;
            } else if (rank == 4) {
                if (cursor + 1 >= json.length || json[cursor] != "{" || json[cursor + 1] == "}") {
                    revert InvalidStravaSchema();
                }
                cursor = _skipJsonValue(json, cursor, 0);
            } else if (rank == 5) {
                (string memory method, uint256 afterValue) = _readSecurityString(json, cursor);
                if (keccak256(bytes(method)) != keccak256("GET")) revert InvalidStravaSchema();
                cursor = afterValue;
            } else if (rank == 6) {
                (fields, cursor) = _parseFields(json, cursor, role);
            } else if (rank == 7) {
                (string memory actualSession, uint256 afterValue) = _readSecurityString(json, cursor);
                if (keccak256(bytes(actualSession)) != keccak256(bytes(sessionId))) revert InvalidContext();
                cursor = afterValue;
            } else if (rank == 8 || rank == 9) {
                uint256 valueStart = cursor;
                cursor = _skipJsonValue(json, cursor, 0);
                bytes32 actual = _hashSlice(json, valueStart, cursor);
                bytes32 expected = rank == 8 ? _matchesHash(role) : _redactionsHash(role);
                if (actual != expected) revert InvalidStravaSchema();
            } else {
                (string memory url, uint256 afterValue) = _readSecurityString(json, cursor);
                if (keccak256(bytes(url)) != keccak256(bytes(_expectedUrl(role)))) revert InvalidStravaSchema();
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
        // Every key of the published 6.0.0 request must be present: ranks 1..10.
        if (mask != 2046 || fields.mask != _fieldMask(role)) revert InvalidStravaSchema();
    }

    function _parseContext(bytes memory json, uint8 role, ContextPolicy memory policy)
        private
        pure
        returns (ContextResult memory result)
    {
        if (json.length > MAX_JSON_BYTES) revert JsonTooLarge();
        uint256 cursor = _expectByte(json, 0, "{");
        uint8 lastRank;
        uint16 mask;
        while (true) {
            if (cursor >= json.length || json[cursor] == "}") break;
            (bytes32 keyHash, uint256 afterKey) = _readKey(json, cursor);
            cursor = _expectByte(json, afterKey, ":");
            uint8 rank = _contextRank(keyHash);
            if (rank <= lastRank) revert NonCanonicalJson();
            lastRank = rank;
            mask |= uint16(1) << rank;

            if (rank == 1) {
                (string memory nonce, uint256 afterValue) = _readSecurityString(json, cursor);
                if (!_validLowerHex(bytes(nonce), 64)) revert InvalidContext();
                result.teeGroupHash = keccak256(bytes(nonce));
                cursor = afterValue;
            } else if (rank == 2) {
                (uint64 timestampMs, uint256 afterValue) = _parseAttestationData(json, cursor, policy.sessionId);
                result.teeGroupHash = keccak256(abi.encode(result.teeGroupHash, timestampMs));
                cursor = afterValue;
            } else if (rank == 3) {
                (string memory account, uint256 afterValue) = _readSecurityString(json, cursor);
                if (keccak256(bytes(account)) != keccak256(bytes(_addressToLowerHex(policy.account)))) {
                    revert InvalidContext();
                }
                cursor = afterValue;
            } else if (rank == 4) {
                (string memory message, uint256 afterValue) = _readSecurityString(json, cursor);
                if (keccak256(bytes(message)) != keccak256(bytes(policy.message))) revert InvalidContext();
                cursor = afterValue;
            } else if (rank == 5) {
                (result.fields, cursor) = _parseFields(json, cursor, role);
            } else if (rank == 6) {
                (result.isAiProof, cursor) = _readCanonicalBool(json, cursor);
            } else if (rank == 7) {
                (result.isPortalProof, cursor) = _readCanonicalBool(json, cursor);
            } else {
                (string memory actualSession, uint256 afterValue) = _readSecurityString(json, cursor);
                if (keccak256(bytes(actualSession)) != keccak256(bytes(policy.sessionId))) revert InvalidContext();
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
        // The live 6.0.0 context has EXACTLY these 8 keys (ranks 1..8). There is no providerHash and
        // no pcr0_k/pcr0_t/tee_session_id, so the Duolingo cross-enclave pcr0_t relaxation has no
        // analogue here: the two claims are bound by attestationNonce + attestation timestamp.
        if (mask != 510 || result.fields.mask != _fieldMask(role)) revert InvalidContext();
    }

    function _parseAttestationData(bytes memory json, uint256 cursor, string memory expectedSessionId)
        private
        pure
        returns (uint64 timestampMs, uint256)
    {
        cursor = _expectByte(json, cursor, "{");
        uint8 lastRank;
        uint8 mask;
        while (true) {
            if (cursor >= json.length || json[cursor] == "}") break;
            (bytes32 keyHash, uint256 afterKey) = _readKey(json, cursor);
            cursor = _expectByte(json, afterKey, ":");
            uint8 rank = _attestationRank(keyHash);
            if (rank <= lastRank) revert NonCanonicalJson();
            lastRank = rank;
            mask |= uint8(1) << rank;
            (string memory value, uint256 afterValue) = _readSecurityString(json, cursor);
            cursor = afterValue;
            if (rank == 1) {
                if (keccak256(bytes(value)) != keccak256(bytes(TEE_APPLICATION_ID))) revert InvalidContext();
            } else if (rank == 2) {
                if (keccak256(bytes(value)) != keccak256("v3")) revert InvalidContext();
            } else if (rank == 3) {
                if (keccak256(bytes(value)) != keccak256(bytes(expectedSessionId))) revert InvalidContext();
            } else {
                bytes memory rawTimestamp = bytes(value);
                if (rawTimestamp.length != 13) revert InvalidContext();
                // forge-lint: disable-next-line(unsafe-typecast)
                timestampMs = uint64(_parseCanonicalUint(rawTimestamp, 13, 9_999_999_999_999));
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
        if (mask != 30) revert InvalidContext();
        return (timestampMs, cursor);
    }

    function _parseFields(bytes memory json, uint256 cursor, uint8 role)
        private
        pure
        returns (StravaFields memory fields, uint256)
    {
        cursor = _expectByte(json, cursor, "{");
        uint8 lastRank;
        uint16 allowed = _fieldMask(role);
        while (true) {
            if (cursor >= json.length || json[cursor] == "}") break;
            (bytes32 keyHash, uint256 afterKey) = _readKey(json, cursor);
            cursor = _expectByte(json, afterKey, ":");
            uint8 rank = _fieldRank(keyHash);
            uint16 bit = uint16(1) << (rank - 1);
            if (rank <= lastRank || (allowed & bit) == 0) revert NonCanonicalJson();
            lastRank = rank;
            fields.mask |= bit;
            (string memory value, uint256 afterValue) = _readSecurityString(json, cursor);
            cursor = afterValue;
            if (rank == 1) fields.challenge = value;
            else if (rank == 2) fields.elapsed = value;
            else if (rank == 3) fields.elevation = value;
            else if (rank == 4) fields.flagged = value;
            else if (rank == 5) fields.activityId = value;
            else if (rank == 6) fields.latlng = value;
            else if (rank == 7) fields.marker = value;
            else if (rank == 8) fields.moving = value;
            else if (rank == 9) fields.name = value;
            else if (rank == 10) fields.raw = value;
            else if (rank == 11) fields.time = value;
            else if (rank == 12) fields.trainer = value;
            else fields.activityType = value;

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

    /// @dev Canonical (lexicographic) key order of the signed 6.0.0 `parameters` object.
    function _parameterRank(bytes32 keyHash) private pure returns (uint8) {
        if (keyHash == keccak256("additionalClientOptions")) return 1;
        if (keyHash == keccak256("body")) return 2;
        if (keyHash == keccak256("geoLocation")) return 3;
        if (keyHash == keccak256("headers")) return 4;
        if (keyHash == keccak256("method")) return 5;
        if (keyHash == keccak256("paramValues")) return 6;
        if (keyHash == keccak256("proxySessionId")) return 7;
        if (keyHash == keccak256("responseMatches")) return 8;
        if (keyHash == keccak256("responseRedactions")) return 9;
        if (keyHash == keccak256("url")) return 10;
        revert UnknownJsonKey(keyHash);
    }

    function _contextRank(bytes32 keyHash) private pure returns (uint8) {
        if (keyHash == keccak256("attestationNonce")) return 1;
        if (keyHash == keccak256("attestationNonceData")) return 2;
        if (keyHash == keccak256("contextAddress")) return 3;
        if (keyHash == keccak256("contextMessage")) return 4;
        if (keyHash == keccak256("extractedParameters")) return 5;
        if (keyHash == keccak256("isAiProof")) return 6;
        if (keyHash == keccak256("isPortalProof")) return 7;
        if (keyHash == keccak256("reclaimSessionId")) return 8;
        revert UnknownJsonKey(keyHash);
    }

    function _attestationRank(bytes32 keyHash) private pure returns (uint8) {
        if (keyHash == keccak256("applicationId")) return 1;
        if (keyHash == keccak256("attestationVersion")) return 2;
        if (keyHash == keccak256("sessionId")) return 3;
        if (keyHash == keccak256("timestamp")) return 4;
        revert UnknownJsonKey(keyHash);
    }

    function _fieldRank(bytes32 keyHash) private pure returns (uint8) {
        if (keyHash == keccak256("context_challenge")) return 1;
        if (keyHash == keccak256("elapsed")) return 2;
        if (keyHash == keccak256("elevation")) return 3;
        if (keyHash == keccak256("flagged")) return 4;
        if (keyHash == keccak256("id")) return 5;
        if (keyHash == keccak256("latlng")) return 6;
        if (keyHash == keccak256("marker")) return 7;
        if (keyHash == keccak256("moving")) return 8;
        if (keyHash == keccak256("name")) return 9;
        if (keyHash == keccak256("raw")) return 10;
        if (keyHash == keccak256("time")) return 11;
        if (keyHash == keccak256("trainer")) return 12;
        if (keyHash == keccak256("type")) return 13;
        revert UnknownJsonKey(keyHash);
    }

    function _fieldMask(uint8 role) private pure returns (uint16) {
        if (role == ROLE_MARKER) return MARKER_FIELDS;
        if (role == ROLE_ACTIVITY) return ACTIVITY_FIELDS;
        revert InvalidStravaSchema();
    }

    function _matchesHash(uint8 role) private pure returns (bytes32) {
        if (role == ROLE_MARKER) return MARKER_MATCHES_HASH;
        if (role == ROLE_ACTIVITY) return ACTIVITY_MATCHES_HASH;
        revert InvalidStravaSchema();
    }

    function _redactionsHash(uint8 role) private pure returns (bytes32) {
        if (role == ROLE_MARKER) return MARKER_REDACTIONS_HASH;
        if (role == ROLE_ACTIVITY) return ACTIVITY_REDACTIONS_HASH;
        revert InvalidStravaSchema();
    }

    function _expectedUrl(uint8 role) private pure returns (string memory) {
        if (role == ROLE_MARKER) return "https://www.strava.com/athlete/training";
        if (role == ROLE_ACTIVITY) {
            return
            "https://www.strava.com/athlete/training_activities?keywords={{context_challenge}}&sport_type=Run&tags=&commute=&private_activities=&trainer=false&gear=&new_activity_only=false";
        }
        revert InvalidStravaSchema();
    }

    function _requireEqualFields(StravaFields memory left, StravaFields memory right, uint8 role) private pure {
        if (left.mask != right.mask || left.mask != _fieldMask(role)) revert InvalidStravaFields();
        if (keccak256(bytes(left.challenge)) != keccak256(bytes(right.challenge))) revert InvalidStravaFields();
        if (role == ROLE_MARKER) {
            if (keccak256(bytes(left.marker)) != keccak256(bytes(right.marker))) revert InvalidStravaFields();
            return;
        }
        if (
            keccak256(bytes(left.activityId)) != keccak256(bytes(right.activityId))
                || keccak256(bytes(left.elevation)) != keccak256(bytes(right.elevation))
                || keccak256(bytes(left.elapsed)) != keccak256(bytes(right.elapsed))
                || keccak256(bytes(left.flagged)) != keccak256(bytes(right.flagged))
                || keccak256(bytes(left.latlng)) != keccak256(bytes(right.latlng))
                || keccak256(bytes(left.moving)) != keccak256(bytes(right.moving))
                || keccak256(bytes(left.name)) != keccak256(bytes(right.name))
                || keccak256(bytes(left.raw)) != keccak256(bytes(right.raw))
                || keccak256(bytes(left.time)) != keccak256(bytes(right.time))
                || keccak256(bytes(left.trainer)) != keccak256(bytes(right.trainer))
                || keccak256(bytes(left.activityType)) != keccak256(bytes(right.activityType))
        ) revert InvalidStravaFields();
    }

    function _parseUtcTimestamp(bytes memory value) private pure returns (uint64) {
        if (value.length != 20 && value.length != 24) revert InvalidStravaFields();
        if (value[4] != "-" || value[7] != "-" || value[10] != "T" || value[13] != ":" || value[16] != ":") {
            revert InvalidStravaFields();
        }
        uint256 year = _digits(value, 0, 4);
        uint256 month = _digits(value, 5, 2);
        uint256 day = _digits(value, 8, 2);
        uint256 hour = _digits(value, 11, 2);
        uint256 minute = _digits(value, 14, 2);
        uint256 second = _digits(value, 17, 2);
        if (
            year < 1970 || month == 0 || month > 12 || day == 0 || day > _daysInMonth(year, month) || hour > 23
                || minute > 59 || second > 59
        ) revert InvalidStravaFields();
        uint256 daysSinceEpoch = 365 * (year - 1970) + _leapsBefore(year) - _leapsBefore(1970);
        for (uint256 m = 1; m < month; ++m) {
            daysSinceEpoch += _daysInMonth(year, m);
        }
        daysSinceEpoch += day - 1;
        int256 timestamp = int256(daysSinceEpoch * 1 days + hour * 1 hours + minute * 1 minutes + second);
        if (value.length == 20) {
            if (value[19] != "Z") revert InvalidStravaFields();
        } else {
            bytes1 sign = value[19];
            if ((sign != "+" && sign != "-") || value.length != 24) revert InvalidStravaFields();
            uint256 offsetHours = _digits(value, 20, 2);
            uint256 offsetMinutes = _digits(value, 22, 2);
            if (offsetHours > 23 || offsetMinutes > 59) revert InvalidStravaFields();
            int256 offset = int256(offsetHours * 1 hours + offsetMinutes * 1 minutes);
            timestamp = sign == "+" ? timestamp - offset : timestamp + offset;
        }
        if (timestamp < 0 || uint256(timestamp) > type(uint64).max) revert InvalidStravaFields();
        return uint64(uint256(timestamp));
    }

    function _leapsBefore(uint256 year) private pure returns (uint256) {
        uint256 y = year - 1;
        return y / 4 - y / 100 + y / 400;
    }

    function _daysInMonth(uint256 year, uint256 month) private pure returns (uint256) {
        if (month == 2) return (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) ? 29 : 28;
        return (month == 4 || month == 6 || month == 9 || month == 11) ? 30 : 31;
    }

    function _digits(bytes memory value, uint256 start, uint256 length) private pure returns (uint256 output) {
        for (uint256 i; i < length; ++i) {
            uint8 c = uint8(value[start + i]);
            if (c < 48 || c > 57) revert InvalidStravaFields();
            output = output * 10 + c - 48;
        }
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

    /// @dev isAiProof / isPortalProof are JSON booleans, not strings: read the bare literal.
    function _readCanonicalBool(bytes memory json, uint256 cursor) private pure returns (bool, uint256) {
        if (_startsWith(json, cursor, "true")) return (true, cursor + 4);
        if (_startsWith(json, cursor, "false")) return (false, cursor + 5);
        revert InvalidContext();
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
            bytes memory previousKey;
            while (true) {
                (string memory key, uint256 afterKey) = _readSecurityString(json, cursor);
                bytes memory keyBytes = bytes(key);
                if (previousKey.length != 0 && !_lexicographicallyGreater(keyBytes, previousKey)) {
                    revert NonCanonicalJson();
                }
                previousKey = keyBytes;
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
        return _skipCanonicalInteger(json, cursor);
    }

    function _skipCanonicalInteger(bytes memory json, uint256 cursor) private pure returns (uint256) {
        if (json[cursor] == "-") {
            ++cursor;
            if (cursor >= json.length || json[cursor] == "0") revert NonCanonicalJson();
        }
        if (json[cursor] == "0") return cursor + 1;
        if (json[cursor] < "1" || json[cursor] > "9") revert InvalidJson();
        while (cursor < json.length && json[cursor] >= "0" && json[cursor] <= "9") ++cursor;
        return cursor;
    }

    function _lexicographicallyGreater(bytes memory current, bytes memory previous) private pure returns (bool) {
        uint256 shared = current.length < previous.length ? current.length : previous.length;
        for (uint256 i; i < shared; ++i) {
            if (current[i] > previous[i]) return true;
            if (current[i] < previous[i]) return false;
        }
        return current.length > previous.length;
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
            revert InvalidStravaFields();
        }
        for (uint256 i; i < raw.length; ++i) {
            uint8 c = uint8(raw[i]);
            if (c < 48 || c > 57) revert InvalidStravaFields();
            value = value * 10 + c - 48;
        }
        if (value > maximum) revert InvalidStravaFields();
    }

    function _parseCanonicalBool(bytes memory raw) private pure returns (bool) {
        if (keccak256(raw) == keccak256("true")) return true;
        if (keccak256(raw) == keccak256("false")) return false;
        revert InvalidStravaFields();
    }

    function _validGeo(bytes memory geo) private pure returns (bool) {
        if (geo.length > 8) return false;
        for (uint256 i; i < geo.length; ++i) {
            if (geo[i] < "A" || geo[i] > "Z") return false;
        }
        return true;
    }

    function _validLowerHex(bytes memory value, uint256 expectedLength) private pure returns (bool) {
        if (value.length != expectedLength) return false;
        for (uint256 i; i < value.length; ++i) {
            bytes1 c = value[i];
            if (!((c >= "0" && c <= "9") || (c >= "a" && c <= "f"))) return false;
        }
        return true;
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

    function _isHex(bytes1 character) private pure returns (bool) {
        return (character >= "0" && character <= "9") || (character >= "a" && character <= "f")
            || (character >= "A" && character <= "F");
    }
}

/// @notice Isolated direct verifier for the private Lock In Strava provider, version 6.0.0.
/// @dev Pins one witness and one stateless parser; it never consults Reclaim's upgradeable registry.
/// @dev LIVE_SCHEMA_CONFIRMED intentionally remains false. The two 6.0.0 claim schemas are pinned from a
///      REAL captured proof set that passes the SDK+TEE barrier (session fa8968844e), and
///      test/LockInStravaRealProof.t.sol drives that capture through this grammar. The gate stays closed
///      until the remaining provenance items are settled (live dashboard verificationType == WITNESS) and
///      the full on-chain flow is exercised on a deployed escrow.
contract LockInStravaReclaimVerifier {
    string public constant STRAVA_PROVIDER_ID = "f3ec8292-d8f3-487c-a79d-f53f482f88e2";
    string public constant STRAVA_PROVIDER_VERSION = "6.0.0";
    bool public constant LIVE_SCHEMA_CONFIRMED = false;

    uint8 private constant ROLE_MARKER = 0;
    uint8 private constant ROLE_ACTIVITY = 1;
    uint256 private constant MAX_PROOF_AGE_SECONDS = 10 minutes;
    uint256 private constant MAX_FUTURE_SKEW_SECONDS = 60;
    uint256 private constant MAX_PROOF_SET_SPAN_SECONDS = 2 minutes;
    bytes32 private constant PROVIDER_KEY = keccak256("f3ec8292-d8f3-487c-a79d-f53f482f88e2@6.0.0");
    bytes32 private constant EXPECTED_SCHEMA_ID =
        keccak256("lock-in:strava:f3ec8292-d8f3-487c-a79d-f53f482f88e2:6.0.0:two-claim");

    address public immutable WITNESS;
    LockInStravaClaimParser public immutable PARSER;

    error ZeroAddress();
    error InvalidParser();
    error InvalidProvider();
    error InvalidClaimIdentifier();
    error InvalidSignatureCount();
    error InvalidWitness();
    error InvalidProofTime();
    error InvalidStravaSchema();
    error InvalidStravaFields();
    error InvalidContext();
    error InvalidPolicy();
    error ActivityOutsideWindow();
    error DistanceTooShort();
    error ImplausibleMotion();
    error LiveSchemaUnconfirmed();
    error InvalidProofCount();

    struct ParsedProof {
        LockInStravaClaimParser.ParsedFields fields;
        bytes32 identifier;
        uint32 timestampS;
    }

    constructor(address pinnedWitness, address parser) {
        if (pinnedWitness == address(0) || parser == address(0)) revert ZeroAddress();
        if (parser.code.length == 0 || LockInStravaClaimParser(parser).SCHEMA_ID() != EXPECTED_SCHEMA_ID) {
            revert InvalidParser();
        }
        WITNESS = pinnedWitness;
        PARSER = LockInStravaClaimParser(parser);
    }

    /// @notice Validates the athlete marker claim and the combined activity claim, in provider order.
    /// @dev `proofSetHash` is keccak256(identifier[0] || identifier[1]), matching backend order.
    function validateStravaProofs(Reclaim.Proof[] calldata proofs, LockInProofTypes.StravaPolicy calldata policy)
        external
        view
        returns (LockInProofTypes.StravaEvidence memory evidence)
    {
        if (!LIVE_SCHEMA_CONFIRMED) revert LiveSchemaUnconfirmed();
        return _validateStravaProofs(proofs, policy);
    }

    /// @dev Canonical grammar implementation. It is internal so the real capture and synthetic fixtures can
    ///      exercise it from a test-only harness without making the production entry point usable before
    ///      live-schema confirmation.
    function _validateStravaProofs(Reclaim.Proof[] calldata proofs, LockInProofTypes.StravaPolicy calldata policy)
        internal
        view
        returns (LockInProofTypes.StravaEvidence memory evidence)
    {
        if (proofs.length != 2) revert InvalidProofCount();
        _validatePolicy(policy);
        string memory contextMessage = string.concat(_uintToString(policy.pactId), ":", _uintToString(policy.dayIndex));
        LockInStravaClaimParser.ContextPolicy memory contextPolicy = LockInStravaClaimParser.ContextPolicy({
            account: policy.account, message: contextMessage, sessionId: policy.expectedSessionId
        });

        ParsedProof memory marker = _validateProof(proofs[0], ROLE_MARKER, policy.challenge, contextPolicy);
        ParsedProof memory activity = _validateProof(proofs[1], ROLE_ACTIVITY, policy.challenge, contextPolicy);

        // Both claims must come from the same attested session: same attestationNonce, same attestation
        // timestamp, same proxy egress. The Strava context carries no pcr0, so there is nothing else to fold.
        if (marker.fields.teeGroupHash != activity.fields.teeGroupHash || marker.fields.geoHash != activity.fields.geoHash)
        {
            revert InvalidContext();
        }
        if (
            activity.fields.nameHash != keccak256(bytes(policy.challenge)) || activity.fields.typeHash != keccak256("Run")
                || activity.fields.flagged || !activity.fields.latlng || activity.fields.trainer
        ) revert InvalidStravaFields();
        _validateMarker(bytes(marker.fields.marker));

        uint256 distance = activity.fields.distanceMeters;
        uint256 moving = activity.fields.movingTimeSeconds;
        uint256 elapsed = activity.fields.elapsedTimeSeconds;
        if (distance < policy.minDistanceMeters) revert DistanceTooShort();
        if (
            moving == 0 || elapsed < moving || distance > moving * 9 || distance * 2 < moving
                || elapsed > moving * 4 + 900
        ) revert ImplausibleMotion();
        if (activity.fields.startTime < policy.startsAt || activity.fields.startTime >= policy.endsAt) {
            revert ActivityOutsideWindow();
        }

        evidence.identityHash = keccak256(abi.encode(PROVIDER_KEY, marker.fields.marker));
        evidence.nullifier = keccak256(abi.encode(PROVIDER_KEY, marker.fields.marker, activity.fields.activityId));
        evidence.proofSetHash = keccak256(abi.encodePacked(marker.identifier, activity.identifier));
        evidence.distanceMeters = activity.fields.distanceMeters;
        evidence.startTime = activity.fields.startTime;
        evidence.movingTimeSeconds = activity.fields.movingTimeSeconds;
        evidence.elapsedTimeSeconds = activity.fields.elapsedTimeSeconds;
        evidence.elevationGainMeters = activity.fields.elevationGainMeters;

        evidence.oldestProofTimestamp = marker.timestampS;
        evidence.newestProofTimestamp = marker.timestampS;
        _includeTimestamp(evidence, activity.timestampS);
        if (evidence.newestProofTimestamp - evidence.oldestProofTimestamp > MAX_PROOF_SET_SPAN_SECONDS) {
            revert InvalidProofTime();
        }
    }

    function _validateProof(
        Reclaim.Proof calldata proof,
        uint8 role,
        string calldata challenge,
        LockInStravaClaimParser.ContextPolicy memory contextPolicy
    ) private view returns (ParsedProof memory parsed) {
        if (keccak256(bytes(proof.claimInfo.provider)) != keccak256("http")) revert InvalidProvider();
        Claims.ClaimInfo memory claimInfo = proof.claimInfo;
        parsed.identifier = Claims.hashClaimInfo(claimInfo);
        if (proof.signedClaim.claim.identifier != parsed.identifier) revert InvalidClaimIdentifier();
        // `claimData.owner` is deliberately NOT checked: the live 6.0.0 capture returns the legacy
        // placeholder 0x1234...7890 for every proof, so it carries no binding value. The claim is bound to
        // the caller by the signed context (contextAddress + contextMessage + reclaimSessionId), which the
        // parser enforces against this policy.
        if (proof.signedClaim.claim.epoch != 1) revert InvalidStravaSchema();
        if (proof.signedClaim.signatures.length != 1) revert InvalidSignatureCount();

        Claims.SignedClaim memory signedClaim = proof.signedClaim;
        address[] memory signers = Claims.recoverSignersOfSignedClaim(signedClaim);
        if (signers[0] != WITNESS) revert InvalidWitness();

        parsed.timestampS = proof.signedClaim.claim.timestampS;
        if (
            uint256(parsed.timestampS) > block.timestamp + MAX_FUTURE_SKEW_SECONDS
                || block.timestamp > uint256(parsed.timestampS) + MAX_PROOF_AGE_SECONDS
        ) revert InvalidProofTime();
        parsed.fields =
            PARSER.parseProofData(proof.claimInfo.parameters, proof.claimInfo.context, role, challenge, contextPolicy);
    }

    function _validatePolicy(LockInProofTypes.StravaPolicy calldata policy) private pure {
        if (
            policy.account == address(0) || policy.dayIndex >= 30 || policy.startsAt >= policy.endsAt
                || policy.minDistanceMeters == 0 || bytes(policy.expectedSessionId).length == 0
                || bytes(policy.expectedSessionId).length > 128
        ) revert InvalidPolicy();
        _validateSafeToken(bytes(policy.expectedSessionId));
        if (!_validChallenge(bytes(policy.challenge), policy.dayIndex)) revert InvalidPolicy();
    }

    function _validChallenge(bytes memory challenge, uint8 dayIndex) private pure returns (bool) {
        if (
            challenge.length < 22 || challenge.length > 34 || challenge[0] != "L" || challenge[1] != "I"
                || challenge[2] != "-"
        ) return false;
        uint256 suffix = challenge.length - 3;
        if (challenge[suffix] != "D") return false;
        uint8 expectedDay = dayIndex + 1;
        if (challenge[suffix + 1] != bytes1(uint8(48 + expectedDay / 10))) return false;
        if (challenge[suffix + 2] != bytes1(uint8(48 + expectedDay % 10))) return false;
        for (uint256 i = 3; i < suffix; ++i) {
            uint8 c = uint8(challenge[i]);
            if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90))) return false;
        }
        return true;
    }

    function _validateMarker(bytes memory marker) private pure {
        bytes memory prefix = bytes("userId: ");
        if (marker.length <= prefix.length || marker.length > prefix.length + 20) revert InvalidStravaFields();
        for (uint256 i; i < prefix.length; ++i) {
            if (marker[i] != prefix[i]) revert InvalidStravaFields();
        }
        if (marker.length > prefix.length + 1 && marker[prefix.length] == "0") revert InvalidStravaFields();
        for (uint256 i = prefix.length; i < marker.length; ++i) {
            if (marker[i] < "0" || marker[i] > "9") revert InvalidStravaFields();
        }
    }

    function _includeTimestamp(LockInProofTypes.StravaEvidence memory evidence, uint32 timestampS) private pure {
        if (timestampS < evidence.oldestProofTimestamp) evidence.oldestProofTimestamp = timestampS;
        if (timestampS > evidence.newestProofTimestamp) evidence.newestProofTimestamp = timestampS;
    }

    function _validateSafeToken(bytes memory token) private pure {
        for (uint256 i; i < token.length; ++i) {
            uint8 c = uint8(token[i]);
            bool valid = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 45 || c == 46
                || c == 58 || c == 95;
            if (!valid) revert InvalidPolicy();
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
