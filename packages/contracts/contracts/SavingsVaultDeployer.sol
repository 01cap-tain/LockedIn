// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SavingsVault} from "./SavingsVault.sol";
import {SafetyController} from "./SafetyController.sol";

/// @notice Size-isolated deployer used exclusively by its immutable VaultFactory.
/// @dev Splitting creation bytecode keeps both contracts below the EVM runtime
/// size limit without introducing an owner, upgrade path, or withdrawal power.
contract SavingsVaultDeployer {
    error FactoryOnly();

    address public immutable factory;

    constructor(address factory_) {
        if (factory_ == address(0)) revert FactoryOnly();
        factory = factory_;
    }

    function deployVault(
        IERC20 asset,
        uint64 maturity,
        bool isGroup,
        address groupCreator,
        address earlyExitMarket,
        SafetyController safetyController,
        SavingsVault.VaultMode mode,
        address[] memory members,
        uint256[] memory targets,
        uint16[] memory emergencyBps,
        address factoryAddress,
        bool publicJoining,
        uint32 maxMemberCount,
        uint256 publicMemberTarget,
        uint16 publicEmergencyBps,
        bool openEnrollment,
        uint64 enrollmentDeadline
    ) external returns (address vault) {
        if (msg.sender != factory) revert FactoryOnly();
        vault = address(
            new SavingsVault(
                asset,
                maturity,
                isGroup,
                groupCreator,
                earlyExitMarket,
                safetyController,
                mode,
                members,
                targets,
                emergencyBps,
                factoryAddress,
                publicJoining,
                maxMemberCount,
                publicMemberTarget,
                publicEmergencyBps,
                openEnrollment,
                enrollmentDeadline
            )
        );
    }
}
