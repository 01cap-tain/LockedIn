// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IRewardVault {
    function rewardEligibleCount() external view returns (uint256);
    function rewardRecipientAt(uint256 eligibleIndex) external view returns (address);
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
    error TokenAccountingMismatch();
    error Insolvent();

    IERC20 public immutable asset;
    address public immutable factory;

    mapping(address vault => bool) public registeredVault;
    mapping(address vault => uint256) public vaultBudget;
    mapping(address vault => bool) public rewardsActivated;
    mapping(address vault => mapping(address recipient => bool)) public rewardEligible;
    mapping(address recipient => uint256) public claimable;
    uint256 public protocolRevenue;
    uint256 public totalVaultBudgets;
    uint256 public totalClaimable;

    event VaultRegistered(address indexed vault);
    event VaultFunded(address indexed vault, address indexed funder, uint256 amount);
    event RewardsActivated(address indexed vault, uint256 memberCount, uint256 rewardEach);
    event RewardClaimed(address indexed recipient, uint256 amount);
    event ProtocolRevenueReceived(address indexed payer, uint256 amount);

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
        totalVaultBudgets += amount;
        _pullExact(msg.sender, amount);
        _assertSolvent();
        emit VaultFunded(vault, msg.sender, amount);
    }

    function receiveProtocolRevenue(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        protocolRevenue += amount;
        _pullExact(msg.sender, amount);
        _assertSolvent();
        emit ProtocolRevenueReceived(msg.sender, amount);
    }

    function activateRewards() external {
        if (!registeredVault[msg.sender]) revert VaultNotRegistered();
        if (rewardsActivated[msg.sender]) revert RewardsAlreadyActivated();
        if (!IRewardVault(msg.sender).rewardsReady()) revert RewardsNotReady();
        _assertSolvent();

        uint256 count = IRewardVault(msg.sender).rewardEligibleCount();
        if (count == 0) revert RewardsNotReady();
        uint256 budget = vaultBudget[msg.sender];
        if (budget == 0) revert InvalidAmount();
        if (budget % count != 0) revert UnequalRewardFunding();

        uint256 rewardEach = budget / count;
        rewardsActivated[msg.sender] = true;
        vaultBudget[msg.sender] = 0;
        totalVaultBudgets -= budget;
        totalClaimable += budget;

        for (uint256 eligibleIndex; eligibleIndex < count; ++eligibleIndex) {
            address recipient = IRewardVault(msg.sender).rewardRecipientAt(eligibleIndex);
            rewardEligible[msg.sender][recipient] = true;
            claimable[recipient] += rewardEach;
        }
        emit RewardsActivated(msg.sender, count, rewardEach);
    }

    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        _transferOutExact(msg.sender, amount);
        _assertSolvent();
        emit RewardClaimed(msg.sender, amount);
    }

    function totalLiability() public view returns (uint256) {
        return totalVaultBudgets + totalClaimable + protocolRevenue;
    }

    function isSolvent() external view returns (bool) {
        return asset.balanceOf(address(this)) >= totalLiability();
    }

    function _pullExact(address payer, uint256 amount) internal {
        uint256 balanceBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(payer, address(this), amount);
        if (asset.balanceOf(address(this)) != balanceBefore + amount) revert TokenAccountingMismatch();
    }

    function _transferOutExact(address recipient, uint256 amount) internal {
        uint256 senderBefore = asset.balanceOf(address(this));
        uint256 recipientBefore = asset.balanceOf(recipient);
        asset.safeTransfer(recipient, amount);
        uint256 senderAfter = asset.balanceOf(address(this));
        uint256 recipientAfter = asset.balanceOf(recipient);
        if (
            senderBefore < senderAfter || senderBefore - senderAfter != amount ||
            recipientAfter < recipientBefore || recipientAfter - recipientBefore != amount
        ) revert TokenAccountingMismatch();
    }

    function _assertSolvent() internal view {
        if (asset.balanceOf(address(this)) < totalLiability()) revert Insolvent();
    }
}
