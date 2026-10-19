// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IRewardVault {
    function isGroup() external view returns (bool);
    function maturity() external view returns (uint64);
    function createdAt() external view returns (uint64);
    function rewardEligibleCount() external view returns (uint256);
    function rewardRecipientAt(uint256 eligibleIndex) external view returns (address);
    function rewardTargetAt(uint256 eligibleIndex) external view returns (uint256);
    function rewardsReady() external view returns (bool);
}

/// @notice Holds sponsored reward campaigns and deterministic protocol-revenue epochs.
/// @dev No privileged caller selects recipients. Vault state and immutable epoch rules do so.
contract RewardPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Epoch {
        uint256 revenue;
        uint256 finalizedRevenue;
        uint256 totalWeight;
        uint256 distributed;
        uint32 registeredGroups;
        uint32 allocatedGroups;
        bool finalized;
        bool complete;
    }

    struct GroupRegistration {
        uint256 weight;
        uint32 memberCount;
        bool allocated;
    }

    error FactoryOnly();
    error VaultNotRegistered();
    error RewardsAlreadyActivated();
    error RewardsNotReady();
    error InvalidAmount();
    error InvalidConfiguration();
    error UnequalRewardFunding();
    error NothingToClaim();
    error TokenAccountingMismatch();
    error Insolvent();
    error GroupOnly();
    error GroupAlreadyRegistered();
    error RegistrationClosed();
    error MinimumQualificationNotMet();
    error EpochOutOfOrder();
    error EpochNotReady();
    error EpochAlreadyFinalized();
    error EpochNotFinalized();
    error GroupNotRegistered();
    error GroupAlreadyAllocated();

    IERC20 public immutable asset;
    address public immutable factory;
    uint64 public immutable epochDuration;
    uint64 public immutable registrationGrace;
    uint64 public immutable minimumSavingDuration;
    uint256 public immutable minimumRewardTarget;
    uint256 public immutable firstEpoch;

    mapping(address vault => bool) public registeredVault;
    mapping(address vault => uint256) public vaultBudget;
    mapping(address vault => bool) public rewardsActivated;
    mapping(address vault => mapping(address recipient => bool)) public rewardEligible;
    mapping(address recipient => uint256) public claimable;
    mapping(uint256 epochId => Epoch) public epochs;
    mapping(uint256 epochId => mapping(address vault => GroupRegistration))
        public groupRegistration;
    mapping(uint256 epochId => address[] vaults) private _epochGroups;
    mapping(uint256 epochId => mapping(address vault => address[] recipients))
        private _groupRecipients;

    uint256 public nextEpochToFinalize;
    uint256 public protocolRevenue;
    uint256 public totalVaultBudgets;
    uint256 public totalClaimable;

    event VaultRegistered(address indexed vault);
    event VaultFunded(address indexed vault, address indexed funder, uint256 amount);
    event RewardsActivated(address indexed vault, uint256 memberCount, uint256 rewardEach);
    event RewardClaimed(address indexed recipient, uint256 amount);
    event ProtocolRevenueReceived(address indexed payer, uint256 indexed epochId, uint256 amount);
    event ProtocolGroupRegistered(
        uint256 indexed epochId,
        address indexed vault,
        uint256 weight,
        uint256 memberCount
    );
    event ProtocolEpochFinalized(
        uint256 indexed epochId,
        uint256 revenue,
        uint256 totalWeight,
        uint256 groupCount
    );
    event ProtocolGroupAllocated(
        uint256 indexed epochId,
        address indexed vault,
        uint256 grossAllocation,
        uint256 rewardEach,
        uint256 distributed
    );
    event ProtocolRevenueRolledForward(
        uint256 indexed fromEpochId,
        uint256 indexed toEpochId,
        uint256 amount
    );

    constructor(
        IERC20 asset_,
        address factory_,
        uint64 epochDuration_,
        uint64 registrationGrace_,
        uint256 minimumRewardTarget_,
        uint64 minimumSavingDuration_
    ) {
        if (
            address(asset_) == address(0) || factory_ == address(0) ||
            epochDuration_ == 0 || registrationGrace_ == 0 ||
            minimumRewardTarget_ == 0 || minimumSavingDuration_ == 0
        ) revert InvalidConfiguration();
        asset = asset_;
        factory = factory_;
        epochDuration = epochDuration_;
        registrationGrace = registrationGrace_;
        minimumRewardTarget = minimumRewardTarget_;
        minimumSavingDuration = minimumSavingDuration_;
        firstEpoch = block.timestamp / epochDuration_;
        nextEpochToFinalize = firstEpoch;
    }

    function registerVault(address vault) external {
        if (msg.sender != factory) revert FactoryOnly();
        if (vault == address(0) || registeredVault[vault]) revert InvalidConfiguration();
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
        uint256 epochId = currentEpoch();
        epochs[epochId].revenue += amount;
        protocolRevenue += amount;
        _pullExact(msg.sender, amount);
        _assertSolvent();
        emit ProtocolRevenueReceived(msg.sender, epochId, amount);
    }

    /// @notice Snapshots a qualifying group's immutable completion recipients and weight.
    function registerCompletedGroup(address vault) external {
        if (!registeredVault[vault]) revert VaultNotRegistered();
        IRewardVault rewardVault = IRewardVault(vault);
        if (!rewardVault.isGroup()) revert GroupOnly();

        uint64 vaultMaturity = rewardVault.maturity();
        uint64 vaultCreatedAt = rewardVault.createdAt();
        uint256 epochId = uint256(vaultMaturity) / epochDuration;
        if (groupRegistration[epochId][vault].weight != 0) revert GroupAlreadyRegistered();
        if (block.timestamp >= epochEnd(epochId) + registrationGrace) revert RegistrationClosed();
        if (
            block.timestamp < vaultMaturity || vaultMaturity < vaultCreatedAt ||
            vaultMaturity - vaultCreatedAt < minimumSavingDuration ||
            !rewardVault.rewardsReady()
        ) revert MinimumQualificationNotMet();

        uint256 count = rewardVault.rewardEligibleCount();
        if (count < 4 || count > type(uint32).max) revert MinimumQualificationNotMet();
        uint256 weight;
        for (uint256 index; index < count; ++index) {
            address recipient = rewardVault.rewardRecipientAt(index);
            uint256 target = rewardVault.rewardTargetAt(index);
            if (recipient == address(0) || target < minimumRewardTarget) {
                revert MinimumQualificationNotMet();
            }
            weight += target;
            _groupRecipients[epochId][vault].push(recipient);
        }
        if (weight == 0) revert MinimumQualificationNotMet();

        groupRegistration[epochId][vault] = GroupRegistration({
            weight: weight,
            memberCount: uint32(count),
            allocated: false
        });
        _epochGroups[epochId].push(vault);
        Epoch storage epoch = epochs[epochId];
        epoch.totalWeight += weight;
        ++epoch.registeredGroups;
        emit ProtocolGroupRegistered(epochId, vault, weight, count);
    }

    /// @notice Freezes one epoch after its registration grace; no privileged caller is needed.
    function finalizeEpoch(uint256 epochId) external {
        if (epochId != nextEpochToFinalize) revert EpochOutOfOrder();
        if (block.timestamp < epochEnd(epochId) + registrationGrace) revert EpochNotReady();
        Epoch storage epoch = epochs[epochId];
        if (epoch.finalized) revert EpochAlreadyFinalized();
        epoch.finalized = true;
        epoch.finalizedRevenue = epoch.revenue;
        epoch.revenue = 0;
        emit ProtocolEpochFinalized(
            epochId,
            epoch.finalizedRevenue,
            epoch.totalWeight,
            epoch.registeredGroups
        );

        if (epoch.registeredGroups == 0 || epoch.totalWeight == 0) {
            _completeEpoch(epochId, epoch, epoch.finalizedRevenue);
        }
    }

    /// @notice Allocates one snapshotted group; anyone may advance this bounded step.
    function allocateEpochGroup(uint256 epochId, address vault) external {
        if (epochId != nextEpochToFinalize) revert EpochOutOfOrder();
        Epoch storage epoch = epochs[epochId];
        if (!epoch.finalized || epoch.complete) revert EpochNotFinalized();
        GroupRegistration storage registration = groupRegistration[epochId][vault];
        if (registration.weight == 0) revert GroupNotRegistered();
        if (registration.allocated) revert GroupAlreadyAllocated();

        uint256 grossAllocation = Math.mulDiv(
            epoch.finalizedRevenue,
            registration.weight,
            epoch.totalWeight
        );
        uint256 rewardEach = grossAllocation / registration.memberCount;
        uint256 distributed = rewardEach * registration.memberCount;
        registration.allocated = true;
        ++epoch.allocatedGroups;
        epoch.distributed += distributed;

        if (distributed != 0) {
            protocolRevenue -= distributed;
            totalClaimable += distributed;
            address[] storage recipients = _groupRecipients[epochId][vault];
            for (uint256 index; index < recipients.length; ++index) {
                address recipient = recipients[index];
                rewardEligible[vault][recipient] = true;
                claimable[recipient] += rewardEach;
            }
        }
        emit ProtocolGroupAllocated(
            epochId,
            vault,
            grossAllocation,
            rewardEach,
            distributed
        );

        if (epoch.allocatedGroups == epoch.registeredGroups) {
            _completeEpoch(epochId, epoch, epoch.finalizedRevenue - epoch.distributed);
        }
        _assertSolvent();
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

    function currentEpoch() public view returns (uint256) {
        return block.timestamp / epochDuration;
    }

    function epochEnd(uint256 epochId) public view returns (uint256) {
        return (epochId + 1) * epochDuration;
    }

    function epochGroupCount(uint256 epochId) external view returns (uint256) {
        return _epochGroups[epochId].length;
    }

    function epochGroupAt(uint256 epochId, uint256 index) external view returns (address) {
        return _epochGroups[epochId][index];
    }

    function protocolRecipientCount(uint256 epochId, address vault) external view returns (uint256) {
        return _groupRecipients[epochId][vault].length;
    }

    function protocolRecipientAt(uint256 epochId, address vault, uint256 index)
        external
        view
        returns (address)
    {
        return _groupRecipients[epochId][vault][index];
    }

    function totalLiability() public view returns (uint256) {
        return totalVaultBudgets + totalClaimable + protocolRevenue;
    }

    function isSolvent() external view returns (bool) {
        return asset.balanceOf(address(this)) >= totalLiability();
    }

    function _completeEpoch(uint256 epochId, Epoch storage epoch, uint256 rollover) internal {
        epoch.complete = true;
        if (rollover != 0) {
            epochs[epochId + 1].revenue += rollover;
            emit ProtocolRevenueRolledForward(epochId, epochId + 1, rollover);
        }
        nextEpochToFinalize = epochId + 1;
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
