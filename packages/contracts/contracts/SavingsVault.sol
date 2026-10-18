// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RewardPool} from "./RewardPool.sol";
import {IYieldAdapter} from "./interfaces/IYieldAdapter.sol";

interface IEarlyExitMarketStatus {
    function isPositionListed(address vault, uint256 positionId) external view returns (bool);
}

/// @notice Non-upgradeable savings vault separating emergency ownership from a transferable locked claim.
/// @dev Safe mode holds locked assets locally; Earn mode represents them with adapter shares.
contract SavingsVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MIN_EMERGENCY_BPS = 1_000;
    uint16 public constant MAX_EMERGENCY_BPS = 1_500;

    enum VaultMode { Safe, Earn }

    struct Position {
        address member;
        uint256 target;
        uint256 deposited;
        uint256 emergencyBalance;
        uint256 lockedBalance;
        uint256 lockedShares;
        uint16 emergencyBps;
        bool lockedWithdrawn;
    }

    error InvalidConfiguration();
    error UnknownPosition();
    error MemberOnly();
    error PositionOwnerOnly();
    error MarketOnly();
    error InvalidAmount();
    error DepositsClosed();
    error InsufficientEmergencyBalance();
    error NotMatured();
    error NothingToWithdraw();
    error RewardsNotReady();
    error PositionListed();
    error TokenAccountingMismatch();
    error Insolvent();

    IERC20 public immutable asset;
    RewardPool public immutable rewardPool;
    uint64 public immutable maturity;
    uint64 public immutable createdAt;
    bool public immutable isGroup;
    address public immutable earlyExitMarket;
    VaultMode public immutable mode;
    IYieldAdapter public immutable yieldAdapter;

    Position[] private _positions;
    mapping(address member => uint256 positionIdPlusOne) private _memberPosition;
    mapping(uint256 positionId => address owner) public positionOwner;
    mapping(uint256 positionId => uint32 count) public depositCount;
    mapping(uint256 positionId => uint64 timestamp) public firstDepositAt;
    mapping(uint256 positionId => uint64 timestamp) public lastDepositAt;
    mapping(uint256 positionId => bool disqualified) public rewardDisqualified;
    uint256 public totalEmergencyLiability;
    uint256 public totalLockedLiability;
    uint256 public totalLockedShares;

    event Deposited(
        uint256 indexed positionId,
        address indexed member,
        uint256 amount,
        uint256 emergencyAmount,
        uint256 lockedAmount
    );
    event EmergencyWithdrawn(uint256 indexed positionId, address indexed member, uint256 amount);
    event LockedWithdrawn(uint256 indexed positionId, address indexed owner, uint256 amount);
    event PositionTransferred(uint256 indexed positionId, address indexed previousOwner, address indexed newOwner);
    event RewardEligibilityRevoked(uint256 indexed positionId, address indexed member);

    constructor(
        IERC20 asset_,
        RewardPool rewardPool_,
        uint64 maturity_,
        bool isGroup_,
        address earlyExitMarket_,
        VaultMode mode_,
        IYieldAdapter yieldAdapter_,
        address[] memory members_,
        uint256[] memory targets_,
        uint16[] memory emergencyBps_
    ) {
        uint256 count = members_.length;
        if (
            address(asset_) == address(0) || address(rewardPool_) == address(0) ||
            maturity_ <= block.timestamp || count == 0 || count != targets_.length ||
            count != emergencyBps_.length ||
            (mode_ == VaultMode.Safe && address(yieldAdapter_) != address(0)) ||
            (mode_ == VaultMode.Earn && address(yieldAdapter_) == address(0))
        ) revert InvalidConfiguration();

        asset = asset_;
        rewardPool = rewardPool_;
        maturity = maturity_;
        createdAt = uint64(block.timestamp);
        isGroup = isGroup_;
        earlyExitMarket = earlyExitMarket_;
        mode = mode_;
        yieldAdapter = yieldAdapter_;

        for (uint256 i; i < count; ++i) {
            if (
                members_[i] == address(0) || targets_[i] == 0 ||
                emergencyBps_[i] < MIN_EMERGENCY_BPS || emergencyBps_[i] > MAX_EMERGENCY_BPS ||
                _memberPosition[members_[i]] != 0
            ) revert InvalidConfiguration();

            _positions.push(Position({
                member: members_[i],
                target: targets_[i],
                deposited: 0,
                emergencyBalance: 0,
                lockedBalance: 0,
                lockedShares: 0,
                emergencyBps: emergencyBps_[i],
                lockedWithdrawn: false
            }));
            _memberPosition[members_[i]] = i + 1;
            positionOwner[i] = members_[i];
        }
    }

    function memberCount() external view returns (uint256) {
        return _positions.length;
    }

    function memberAt(uint256 positionId) external view returns (address) {
        return _position(positionId).member;
    }

    function position(uint256 positionId) external view returns (Position memory) {
        return _position(positionId);
    }

    function positionOf(address member) external view returns (uint256) {
        uint256 value = _memberPosition[member];
        if (value == 0) revert UnknownPosition();
        return value - 1;
    }

    function deposit(uint256 positionId, uint256 amount) external nonReentrant {
        Position storage stored = _position(positionId);
        if (msg.sender != stored.member || positionOwner[positionId] != msg.sender) revert MemberOnly();
        if (amount == 0) revert InvalidAmount();
        if (block.timestamp >= maturity) revert DepositsClosed();
        if (IEarlyExitMarketStatus(earlyExitMarket).isPositionListed(address(this), positionId)) {
            revert PositionListed();
        }

        // Integer rounding intentionally benefits the locked portion: emergency receives the
        // truncated basis-point amount and every remaining unit is counted as locked principal.
        uint256 emergencyAmount = amount * stored.emergencyBps / 10_000;
        uint256 lockedAmount = amount - emergencyAmount;
        uint256 balanceBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        if (asset.balanceOf(address(this)) != balanceBefore + amount) revert TokenAccountingMismatch();

        uint256 shares;
        if (mode == VaultMode.Earn) {
            // The external adapter call happens before local shares are committed. Any Aave or
            // token failure reverts this transaction, including the inbound member transfer.
            asset.forceApprove(address(yieldAdapter), lockedAmount);
            shares = yieldAdapter.deposit(lockedAmount);
            asset.forceApprove(address(yieldAdapter), 0);
            stored.lockedShares += shares;
            totalLockedShares += shares;
        }
        stored.deposited += amount;
        stored.emergencyBalance += emergencyAmount;
        stored.lockedBalance += lockedAmount;
        totalEmergencyLiability += emergencyAmount;
        totalLockedLiability += lockedAmount;
        if (depositCount[positionId] == 0) firstDepositAt[positionId] = uint64(block.timestamp);
        depositCount[positionId] += 1;
        lastDepositAt[positionId] = uint64(block.timestamp);
        _assertSolvent();
        emit Deposited(positionId, msg.sender, amount, emergencyAmount, lockedAmount);
    }

    function withdrawEmergency(uint256 positionId, uint256 amount) external nonReentrant {
        Position storage stored = _position(positionId);
        if (msg.sender != stored.member) revert MemberOnly();
        if (amount == 0) revert InvalidAmount();
        if (amount > stored.emergencyBalance) revert InsufficientEmergencyBalance();

        stored.emergencyBalance -= amount;
        totalEmergencyLiability -= amount;
        _transferOutExact(msg.sender, amount);
        _assertSolvent();
        emit EmergencyWithdrawn(positionId, msg.sender, amount);
    }

    function withdrawLocked(uint256 positionId) external nonReentrant {
        Position storage stored = _position(positionId);
        if (msg.sender != positionOwner[positionId]) revert PositionOwnerOnly();
        if (block.timestamp < maturity) revert NotMatured();

        uint256 principal = stored.lockedBalance;
        if (principal == 0 || stored.lockedWithdrawn) revert NothingToWithdraw();
        uint256 amount;
        if (mode == VaultMode.Earn) {
            // The adapter burns shares only after exact redemption. We clear the position only
            // after that call succeeds, so temporary Aave failures remain safely retryable.
            uint256 shares = stored.lockedShares;
            amount = yieldAdapter.withdraw(shares, msg.sender);
            stored.lockedShares = 0;
            totalLockedShares -= shares;
        } else {
            amount = principal;
            _transferOutExact(msg.sender, amount);
        }
        stored.lockedBalance = 0;
        stored.lockedWithdrawn = true;
        totalLockedLiability -= principal;
        _assertSolvent();
        emit LockedWithdrawn(positionId, msg.sender, amount);
    }

    function transferPosition(uint256 positionId, address expectedOwner, address newOwner) external nonReentrant {
        if (msg.sender != earlyExitMarket || earlyExitMarket == address(0)) revert MarketOnly();
        Position storage stored = _position(positionId);
        if (newOwner == address(0)) revert InvalidConfiguration();
        if (positionOwner[positionId] != expectedOwner) revert PositionOwnerOnly();
        if (stored.lockedWithdrawn) revert NothingToWithdraw();

        // Only the locked claim changes hands. `stored.member` remains the emergency owner and
        // the original reward identity, which is simultaneously disqualified from rewards.
        positionOwner[positionId] = newOwner;
        rewardDisqualified[positionId] = true;
        emit PositionTransferred(positionId, expectedOwner, newOwner);
        emit RewardEligibilityRevoked(positionId, stored.member);
    }

    function goalComplete(uint256 positionId) public view returns (bool) {
        Position storage stored = _position(positionId);
        return stored.deposited >= stored.target;
    }

    function positionValue(uint256 positionId) public view returns (uint256) {
        Position storage stored = _position(positionId);
        if (stored.lockedWithdrawn) return 0;
        if (mode == VaultMode.Safe) return stored.lockedBalance;
        return yieldAdapter.convertToAssets(stored.lockedShares);
    }

    function accruedYield(uint256 positionId) external view returns (uint256) {
        Position storage stored = _position(positionId);
        uint256 current = positionValue(positionId);
        return current > stored.lockedBalance ? current - stored.lockedBalance : 0;
    }

    function currentLiquidityRate() external view returns (uint256) {
        return mode == VaultMode.Earn ? yieldAdapter.currentLiquidityRate() : 0;
    }

    function rewardsReady() public view returns (bool) {
        if (block.timestamp < maturity) return false;
        uint256 count = _positions.length;
        bool hasEligibleMember;
        for (uint256 i; i < count; ++i) {
            if (rewardDisqualified[i]) continue;
            hasEligibleMember = true;
            if (!goalComplete(i)) return false;
        }
        return hasEligibleMember;
    }

    function rewardEligibleCount() external view returns (uint256 eligible) {
        uint256 count = _positions.length;
        for (uint256 i; i < count; ++i) {
            if (!rewardDisqualified[i]) ++eligible;
        }
    }

    function rewardRecipientAt(uint256 eligibleIndex) external view returns (address) {
        uint256 count = _positions.length;
        uint256 current;
        for (uint256 i; i < count; ++i) {
            if (rewardDisqualified[i]) continue;
            if (current == eligibleIndex) return _positions[i].member;
            ++current;
        }
        revert UnknownPosition();
    }

    function marketPositionData(uint256 positionId)
        external
        view
        returns (
            address member,
            uint256 target,
            uint256 deposited,
            uint256 emergencyBalance,
            uint256 currentPositionValue,
            bool lockedWithdrawn,
            uint32 deposits
        )
    {
        Position storage stored = _position(positionId);
        return (
            stored.member,
            stored.target,
            stored.deposited,
            stored.emergencyBalance,
            positionValue(positionId),
            stored.lockedWithdrawn,
            depositCount[positionId]
        );
    }

    function activateRewards() external {
        if (!rewardsReady()) revert RewardsNotReady();
        rewardPool.activateRewards();
    }

    function totalPrincipalLiability() external view returns (uint256) {
        return totalEmergencyLiability + totalLockedLiability;
    }

    function isSolvent() external view returns (bool) {
        if (mode == VaultMode.Safe) {
            return asset.balanceOf(address(this)) >= totalEmergencyLiability + totalLockedLiability;
        }
        return asset.balanceOf(address(this)) >= totalEmergencyLiability
            && yieldAdapter.totalShares() == totalLockedShares;
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
        uint256 requiredVaultBalance = mode == VaultMode.Safe
            ? totalEmergencyLiability + totalLockedLiability
            : totalEmergencyLiability;
        if (
            asset.balanceOf(address(this)) < requiredVaultBalance ||
            (mode == VaultMode.Earn && yieldAdapter.totalShares() != totalLockedShares)
        ) {
            revert Insolvent();
        }
    }

    function _position(uint256 positionId) internal view returns (Position storage stored) {
        if (positionId >= _positions.length) revert UnknownPosition();
        return _positions[positionId];
    }
}
