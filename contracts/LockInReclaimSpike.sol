// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {Reclaim} from "@reclaimprotocol/solidity-sdk/contracts/Reclaim.sol";

/// @notice Minimal end-to-end spike. This is not the final Lock In pact contract.
contract LockInReclaimSpike {
    Reclaim public immutable reclaim;

    event ProofAccepted(
        address indexed account,
        uint256 indexed pactId,
        bytes32 indexed claimIdentifier,
        string provider,
        string parameters
    );

    error InvalidContextAddress();
    error InvalidPactId();

    constructor(address reclaimAddress) {
        reclaim = Reclaim(reclaimAddress);
    }

    function verifyProof(
        uint256 pactId,
        Reclaim.Proof calldata proof
    ) external returns (bool) {
        reclaim.verifyProof(proof);

        string memory contextAddress = reclaim.extractFieldFromContext(
            proof.claimInfo.context,
            '"contextAddress":"'
        );
        string memory contextMessage = reclaim.extractFieldFromContext(
            proof.claimInfo.context,
            '"contextMessage":"'
        );

        if (
            keccak256(bytes(contextAddress)) !=
            keccak256(bytes(_addressToLowerHex(msg.sender)))
        ) revert InvalidContextAddress();

        if (
            keccak256(bytes(contextMessage)) !=
            keccak256(bytes(_uintToString(pactId)))
        ) revert InvalidPactId();

        emit ProofAccepted(
            msg.sender,
            pactId,
            proof.signedClaim.claim.identifier,
            proof.claimInfo.provider,
            proof.claimInfo.parameters
        );
        return true;
    }

    function _addressToLowerHex(
        address account
    ) internal pure returns (string memory) {
        bytes20 value = bytes20(account);
        bytes16 alphabet = "0123456789abcdef";
        bytes memory result = new bytes(42);
        result[0] = "0";
        result[1] = "x";

        for (uint256 i; i < 20; ++i) {
            result[2 + i * 2] = alphabet[uint8(value[i] >> 4)];
            result[3 + i * 2] = alphabet[uint8(value[i] & 0x0f)];
        }
        return string(result);
    }

    function _uintToString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        uint256 cursor = value;
        while (cursor != 0) {
            ++digits;
            cursor /= 10;
        }
        bytes memory output = new bytes(digits);
        while (value != 0) {
            --digits;
            output[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(output);
    }
}
