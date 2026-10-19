// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RewardPool} from "./RewardPool.sol";
import {SavingsVault} from "./SavingsVault.sol";
import {IYieldAdapter} from "./interfaces/IYieldAdapter.sol";

/// @notice Size-isolated deployer used exclusively by its immutable VaultFactory.
/// @dev Splitting creation bytecode keeps both contracts below the EVM runtime
/// size limit without introducing an owner, upgrade path, or withdrawal power.
contract SavingsVaultDeployer {
    error FactoryOnly();

    address public immutable factory;

    constructor() {
        factory = msg.sender;
    }

    function deployVault(
        IERC20 asset,
        RewardPool rewardPool,
        uint64 maturity,
        bool isGroup,
        address earlyExitMarket,
        SavingsVault.VaultMode mode,
        IYieldAdapter yieldAdapter,
        address[] memory members,
        uint256[] memory targets,
        uint16[] memory emergencyBps
    ) external returns (address vault) {
        if (msg.sender != factory) revert FactoryOnly();
        vault = address(
            new SavingsVault(
                asset,
                rewardPool,
                maturity,
                isGroup,
                earlyExitMarket,
                mode,
                yieldAdapter,
                members,
                targets,
                emergencyBps
            )
        );
    }
}
