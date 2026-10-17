// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RewardPool} from "./RewardPool.sol";

contract SavingsVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MIN_EMERGENCY_BPS = 1_000;
    uint16 public constant MAX_EMERGENCY_BPS = 1_500;

    struct Position {
        address member;
        uint256 target;
        uint256 deposited;
        uint256 emergencyBalance;
        uint256 lockedBalance;
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

    IERC20 public immutable asset;
    RewardPool public immutable rewardPool;
    uint64 public immutable maturity;
    bool public immutable isGroup;
    address public immutable earlyExitMarket;

    Position[] private _positions;
    mapping(address member => uint256 positionIdPlusOne) private _memberPosition;
    mapping(uint256 positionId => address owner) public positionOwner;

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

    constructor(
        IERC20 asset_,
        RewardPool rewardPool_,
        uint64 maturity_,
        bool isGroup_,
        address earlyExitMarket_,
        address[] memory members_,
        uint256[] memory targets_,
        uint16[] memory emergencyBps_
    ) {
        uint256 count = members_.length;
        if (
            address(asset_) == address(0) || address(rewardPool_) == address(0) ||
            maturity_ <= block.timestamp || count == 0 || count != targets_.length ||
            count != emergencyBps_.length
        ) revert InvalidConfiguration();

        asset = asset_;
        rewardPool = rewardPool_;
        maturity = maturity_;
        isGroup = isGroup_;
        earlyExitMarket = earlyExitMarket_;

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

        uint256 emergencyAmount = amount * stored.emergencyBps / 10_000;
        uint256 lockedAmount = amount - emergencyAmount;
        stored.deposited += amount;
        stored.emergencyBalance += emergencyAmount;
        stored.lockedBalance += lockedAmount;

        asset.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(positionId, msg.sender, amount, emergencyAmount, lockedAmount);
    }

    function withdrawEmergency(uint256 positionId, uint256 amount) external nonReentrant {
        Position storage stored = _position(positionId);
        if (msg.sender != stored.member) revert MemberOnly();
        if (amount == 0) revert InvalidAmount();
        if (amount > stored.emergencyBalance) revert InsufficientEmergencyBalance();

        stored.emergencyBalance -= amount;
        asset.safeTransfer(msg.sender, amount);
        emit EmergencyWithdrawn(positionId, msg.sender, amount);
    }

    function withdrawLocked(uint256 positionId) external nonReentrant {
        Position storage stored = _position(positionId);
        if (msg.sender != positionOwner[positionId]) revert PositionOwnerOnly();
        if (block.timestamp < maturity) revert NotMatured();

        uint256 amount = stored.lockedBalance;
        if (amount == 0 || stored.lockedWithdrawn) revert NothingToWithdraw();
        stored.lockedBalance = 0;
        stored.lockedWithdrawn = true;

        asset.safeTransfer(msg.sender, amount);
        emit LockedWithdrawn(positionId, msg.sender, amount);
    }

    function transferPosition(uint256 positionId, address expectedOwner, address newOwner) external nonReentrant {
        if (msg.sender != earlyExitMarket || earlyExitMarket == address(0)) revert MarketOnly();
        Position storage stored = _position(positionId);
        if (newOwner == address(0)) revert InvalidConfiguration();
        if (positionOwner[positionId] != expectedOwner) revert PositionOwnerOnly();
        if (stored.lockedWithdrawn) revert NothingToWithdraw();

        positionOwner[positionId] = newOwner;
        emit PositionTransferred(positionId, expectedOwner, newOwner);
    }

    function goalComplete(uint256 positionId) public view returns (bool) {
        Position storage stored = _position(positionId);
        return stored.deposited >= stored.target;
    }

    function rewardsReady() public view returns (bool) {
        uint256 count = _positions.length;
        for (uint256 i; i < count; ++i) {
            if (!goalComplete(i)) return false;
        }
        return true;
    }

    function activateRewards() external {
        if (!rewardsReady()) revert RewardsNotReady();
        rewardPool.activateRewards();
    }

    function _position(uint256 positionId) internal view returns (Position storage stored) {
        if (positionId >= _positions.length) revert UnknownPosition();
        return _positions[positionId];
    }
}
