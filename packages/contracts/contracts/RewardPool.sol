// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IRewardVault {
    function memberCount() external view returns (uint256);
    function memberAt(uint256 positionId) external view returns (address);
    function rewardsReady() external view returns (bool);
}

contract RewardPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error FactoryOnly();
    error VaultNotRegistered();
    error RewardsAlreadyActivated();
    error RewardsNotReady();
    error InvalidAmount();
    error UnequalRewardFunding();
    error NothingToClaim();

    IERC20 public immutable asset;
    address public immutable factory;

    mapping(address vault => bool) public registeredVault;
    mapping(address vault => uint256) public vaultBudget;
    mapping(address vault => bool) public rewardsActivated;
    mapping(address vault => mapping(address recipient => bool)) public rewardEligible;
    mapping(address recipient => uint256) public claimable;

    event VaultRegistered(address indexed vault);
    event VaultFunded(address indexed vault, address indexed funder, uint256 amount);
    event RewardsActivated(address indexed vault, uint256 memberCount, uint256 rewardEach);
    event RewardClaimed(address indexed recipient, uint256 amount);

    constructor(IERC20 asset_, address factory_) {
        asset = asset_;
        factory = factory_;
    }

    function registerVault(address vault) external {
        if (msg.sender != factory) revert FactoryOnly();
        registeredVault[vault] = true;
        emit VaultRegistered(vault);
    }

    function fundVault(address vault, uint256 amount) external nonReentrant {
        if (!registeredVault[vault]) revert VaultNotRegistered();
        if (rewardsActivated[vault]) revert RewardsAlreadyActivated();
        if (amount == 0) revert InvalidAmount();
        vaultBudget[vault] += amount;
        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit VaultFunded(vault, msg.sender, amount);
    }

    function activateRewards() external {
        if (!registeredVault[msg.sender]) revert VaultNotRegistered();
        if (rewardsActivated[msg.sender]) revert RewardsAlreadyActivated();
        if (!IRewardVault(msg.sender).rewardsReady()) revert RewardsNotReady();

        uint256 count = IRewardVault(msg.sender).memberCount();
        uint256 budget = vaultBudget[msg.sender];
        if (budget == 0) revert InvalidAmount();
        if (budget % count != 0) revert UnequalRewardFunding();

        uint256 rewardEach = budget / count;
        rewardsActivated[msg.sender] = true;
        vaultBudget[msg.sender] = 0;

        for (uint256 positionId; positionId < count; ++positionId) {
            address recipient = IRewardVault(msg.sender).memberAt(positionId);
            rewardEligible[msg.sender][recipient] = true;
            claimable[recipient] += rewardEach;
        }
        emit RewardsActivated(msg.sender, count, rewardEach);
    }

    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        asset.safeTransfer(msg.sender, amount);
        emit RewardClaimed(msg.sender, amount);
    }
}
