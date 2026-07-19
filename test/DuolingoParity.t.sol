// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {LockInDuolingoEscrow} from "../contracts/LockInDuolingoEscrow.sol";

interface VmParity {
    function addr(uint256 privateKey) external returns (address);
    function chainId(uint256 newChainId) external;
}

contract MockUsdcParity is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/// @dev The Solidity half of the EIP-712 parity pin. The SAME hex is asserted in
///      test/duolingo-attestation.test.ts. If either the contract or the TypeScript formula drifts, its
///      side fails, which is exactly the guard the Strava config-hash bug lacked. chainId is forced to 143,
///      the deployed chain, so the mission policy and config hashes are the production values.
contract LockInDuolingoParityTest {
    VmParity private constant VM = VmParity(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 private constant PIN_SCHEME = 0xd62e6c7e75cd26ab2580957b7b625c3001b336738da6de4d1065b51885d00a6a;
    bytes32 private constant PIN_POLICY = 0xf0d329a0efb712f1b2a10ba741f1e5b798a1af0a2df26b841e6189f7f2d96031;
    bytes32 private constant PIN_NONCE = 0x02996131f59c2ed6027ae65cb865a53a83bafa76c7c153a62659c29633b9eeb3;
    bytes32 private constant PIN_CONFIG = 0xd39ff3c0c85051052a830c8ef34df949c8cbace5d602fff7940aa4dc68d6f884;
    bytes32 private constant PIN_BASELINE_TH = 0xadfa0bea0f85d7560d7483cd6d56c4b46a1607cf4612d9f590e7807a3242b135;
    bytes32 private constant PIN_FINAL_TH = 0xb8e1333e6eab8d6a2a3cfcc5894a8ec6c7711c2efb3ff8ea055eadc836e4a6c3;

    LockInDuolingoEscrow private escrow;

    function setUp() public {
        VM.chainId(143);
        escrow = new LockInDuolingoEscrow(new MockUsdcParity(), VM.addr(1));
    }

    function testMissionPolicyAndSchemeMatchTheTypeScriptPin() public {
        require(escrow.DUOLINGO_XP_SCHEME() == PIN_SCHEME, "scheme drift");
        require(escrow.missionPolicyHash() == PIN_POLICY, "policy drift");
    }

    function testConfigHashMatchesTheTypeScriptPin() public {
        require(keccak256("LOCK_IN_DUOLINGO_PARITY_NONCE") == PIN_NONCE, "nonce drift");
        require(escrow.hashConfiguration(100000, 50, 3600, 2, 2, 1800000000, PIN_NONCE) == PIN_CONFIG, "config drift");
    }

    function testTypehashesMatchTheTypeScriptPin() public view {
        require(escrow.BASELINE_TYPEHASH() == PIN_BASELINE_TH, "baseline typehash drift");
        require(escrow.FINAL_TYPEHASH() == PIN_FINAL_TH, "final typehash drift");
    }
}
