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
    uint64 public constant GROUP_EXIT_REQUEST_LIFETIME = 7 days;
    uint256 public constant MIN_ACTIVE_GROUP_MEMBERS = 4;

    enum VaultMode { Safe, Earn }
    enum MemberStatus { Active, CooperativeExit, MarketExit, Matured }
    enum GroupExitRequestStatus { None, Pending, Authorized, Cancelled, Expired, Completed }

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

    struct GroupExitRequest {
        uint256 positionId;
        address requester;
        uint64 createdAt;
        uint64 expiresAt;
        uint32 requiredApprovals;
        uint32 completedApprovals;
        GroupExitRequestStatus status;
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
    error GroupOnly();
    error GroupEarlyUnlockDisabled();
    error GroupExitUnavailable();
    error GroupExitUnresolved();
    error GroupExitExpiredRequest();
    error GroupExitNotAuthorized();
    error GroupGoalsIncomplete();
    error SelfApproval();
    error ApprovalUnavailable();
    error DuplicateApproval();
    error ApprovalMissing();
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
    mapping(uint256 positionId => MemberStatus status) public memberStatus;
    mapping(uint256 requestId => GroupExitRequest request) public groupExitRequests;
    mapping(uint256 positionId => uint256 requestIdPlusOne) public currentGroupExitRequest;
    mapping(uint256 requestId => mapping(address member => bool approved)) public groupExitApproval;
    uint256 public nextGroupExitRequestId;
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
    event GroupExitRequested(
        uint256 indexed requestId,
        uint256 indexed positionId,
        address indexed requester,
        uint64 expiresAt
    );
    event GroupExitApproved(uint256 indexed requestId, address indexed approver);
    event GroupExitApprovalRevoked(uint256 indexed requestId, address indexed approver);
    event GroupExitCancelled(uint256 indexed requestId, address indexed requester);
    event GroupExitExpired(uint256 indexed requestId);
    event GroupExitAuthorized(
        uint256 indexed requestId,
        uint32 requiredApprovals,
        uint32 completedApprovals
    );
    event GroupExitCompleted(
        uint256 indexed requestId,
        uint256 indexed positionId,
        address indexed requester,
        uint256 amount
    );
    event GroupMemberStatusChanged(
        uint256 indexed positionId,
        address indexed member,
        MemberStatus previousStatus,
        MemberStatus newStatus
    );

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

    /// @notice Opens a seven-day cooperative exit request for the caller's own group position.
    function requestGroupExit() external returns (uint256 requestId) {
        if (!isGroup) revert GroupOnly();
        if (block.timestamp >= maturity) revert DepositsClosed();
        if (activeMemberCount() < MIN_ACTIVE_GROUP_MEMBERS) revert GroupEarlyUnlockDisabled();

        uint256 positionId = _positionIdForMember(msg.sender);
        Position storage stored = _position(positionId);
        if (
            memberStatus[positionId] != MemberStatus.Active || stored.lockedWithdrawn ||
            positionOwner[positionId] != msg.sender || stored.lockedBalance == 0
        ) revert GroupExitUnavailable();
        if (IEarlyExitMarketStatus(earlyExitMarket).isPositionListed(address(this), positionId)) {
            revert PositionListed();
        }

        uint256 previousIdPlusOne = currentGroupExitRequest[positionId];
        if (previousIdPlusOne != 0) {
            GroupExitRequest storage previous = groupExitRequests[previousIdPlusOne - 1];
            if (
                previous.status == GroupExitRequestStatus.Pending &&
                previous.expiresAt <= block.timestamp
            ) {
                previous.status = GroupExitRequestStatus.Expired;
                emit GroupExitExpired(previousIdPlusOne - 1);
            } else if (
                previous.status == GroupExitRequestStatus.Pending ||
                previous.status == GroupExitRequestStatus.Authorized
            ) {
                revert GroupExitUnresolved();
            }
        }

        requestId = nextGroupExitRequestId++;
        uint64 expiresAt = uint64(block.timestamp) + GROUP_EXIT_REQUEST_LIFETIME;
        groupExitRequests[requestId] = GroupExitRequest({
            positionId: positionId,
            requester: msg.sender,
            createdAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            requiredApprovals: 0,
            completedApprovals: 0,
            status: GroupExitRequestStatus.Pending
        });
        currentGroupExitRequest[positionId] = requestId + 1;
        emit GroupExitRequested(requestId, positionId, msg.sender, expiresAt);
    }

    /// @notice Approves another active member's pending request with the caller's EVM account.
    function approveGroupExit(uint256 requestId) external {
        GroupExitRequest storage request = _pendingGroupExitRequest(requestId);
        if (msg.sender == request.requester) revert SelfApproval();
        uint256 approverPosition = _positionIdForMember(msg.sender);
        if (memberStatus[approverPosition] != MemberStatus.Active) revert ApprovalUnavailable();
        if (groupExitApproval[requestId][msg.sender]) revert DuplicateApproval();

        groupExitApproval[requestId][msg.sender] = true;
        emit GroupExitApproved(requestId, msg.sender);

        (uint32 required, uint32 completed, bool unanimous) = _approvalProgress(requestId);
        if (unanimous) {
            request.requiredApprovals = required;
            request.completedApprovals = completed;
            request.status = GroupExitRequestStatus.Authorized;
            emit GroupExitAuthorized(requestId, required, completed);
        }
    }

    /// @notice Revokes an approval only while the request remains unresolved.
    function revokeGroupExitApproval(uint256 requestId) external {
        _pendingGroupExitRequest(requestId);
        uint256 approverPosition = _positionIdForMember(msg.sender);
        if (memberStatus[approverPosition] != MemberStatus.Active) revert ApprovalUnavailable();
        if (!groupExitApproval[requestId][msg.sender]) revert ApprovalMissing();
        groupExitApproval[requestId][msg.sender] = false;
        emit GroupExitApprovalRevoked(requestId, msg.sender);
    }

    function cancelGroupExit(uint256 requestId) external {
        GroupExitRequest storage request = _pendingGroupExitRequest(requestId);
        if (msg.sender != request.requester) revert MemberOnly();
        request.status = GroupExitRequestStatus.Cancelled;
        emit GroupExitCancelled(requestId, msg.sender);
    }

    /// @notice Materializes an expired status for event indexers; anyone may call it.
    function expireGroupExit(uint256 requestId) external {
        GroupExitRequest storage request = groupExitRequests[requestId];
        if (
            request.status != GroupExitRequestStatus.Pending ||
            request.expiresAt > block.timestamp
        ) revert GroupExitUnavailable();
        request.status = GroupExitRequestStatus.Expired;
        emit GroupExitExpired(requestId);
    }

    /// @notice Pays only the requester's locked claim after final unanimous authorization.
    function completeGroupExit(uint256 requestId) external nonReentrant {
        GroupExitRequest storage request = groupExitRequests[requestId];
        if (request.status != GroupExitRequestStatus.Authorized) revert GroupExitNotAuthorized();
        if (msg.sender != request.requester) revert MemberOnly();
        if (block.timestamp >= maturity) revert NotMatured();
        if (activeMemberCount() < MIN_ACTIVE_GROUP_MEMBERS) revert GroupEarlyUnlockDisabled();
        if (!_allActiveGoalsComplete()) revert GroupGoalsIncomplete();

        uint256 positionId = request.positionId;
        Position storage stored = _position(positionId);
        if (
            memberStatus[positionId] != MemberStatus.Active || stored.lockedWithdrawn ||
            positionOwner[positionId] != msg.sender
        ) revert GroupExitUnavailable();

        uint256 principal = stored.lockedBalance;
        uint256 shares = stored.lockedShares;
        stored.lockedBalance = 0;
        stored.lockedWithdrawn = true;
        totalLockedLiability -= principal;
        if (mode == VaultMode.Earn) {
            stored.lockedShares = 0;
            totalLockedShares -= shares;
        }
        rewardDisqualified[positionId] = true;
        request.status = GroupExitRequestStatus.Completed;
        _setMemberStatus(positionId, MemberStatus.CooperativeExit);

        // All accounting effects precede the external interaction. Any adapter
        // or token failure reverts the entire transaction and preserves retryability.
        uint256 amount;
        if (mode == VaultMode.Earn) {
            amount = yieldAdapter.withdraw(shares, msg.sender);
        } else {
            amount = principal;
            _transferOutExact(msg.sender, amount);
        }
        _assertSolvent();

        emit RewardEligibilityRevoked(positionId, stored.member);
        emit LockedWithdrawn(positionId, msg.sender, amount);
        emit GroupExitCompleted(requestId, positionId, msg.sender, amount);
    }

    function groupExitApprovalProgress(uint256 requestId)
        external
        view
        returns (uint32 required, uint32 completed)
    {
        GroupExitRequest storage request = groupExitRequests[requestId];
        if (
            request.status == GroupExitRequestStatus.Authorized ||
            request.status == GroupExitRequestStatus.Completed
        ) return (request.requiredApprovals, request.completedApprovals);
        (required, completed,) = _approvalProgress(requestId);
    }

    function activeMemberCount() public view returns (uint256 active) {
        uint256 count = _positions.length;
        for (uint256 i; i < count; ++i) {
            if (memberStatus[i] == MemberStatus.Active) ++active;
        }
    }

    function hasBlockingGroupExitRequest(uint256 positionId) public view returns (bool) {
        uint256 requestIdPlusOne = currentGroupExitRequest[positionId];
        if (requestIdPlusOne == 0) return false;
        GroupExitRequest storage request = groupExitRequests[requestIdPlusOne - 1];
        return request.status == GroupExitRequestStatus.Authorized ||
            (request.status == GroupExitRequestStatus.Pending && request.expiresAt > block.timestamp);
    }

    /// @dev Called by the immutable market before listing. It records lazy expiry on-chain.
    function prepareMarketListing(uint256 positionId) external {
        if (msg.sender != earlyExitMarket) revert MarketOnly();
        if (!isGroup) return;
        uint256 requestIdPlusOne = currentGroupExitRequest[positionId];
        if (requestIdPlusOne == 0) return;
        GroupExitRequest storage request = groupExitRequests[requestIdPlusOne - 1];
        if (
            request.status == GroupExitRequestStatus.Pending &&
            request.expiresAt <= block.timestamp
        ) {
            request.status = GroupExitRequestStatus.Expired;
            emit GroupExitExpired(requestIdPlusOne - 1);
            return;
        }
        if (
            request.status == GroupExitRequestStatus.Pending ||
            request.status == GroupExitRequestStatus.Authorized
        ) revert GroupExitUnresolved();
    }

    function deposit(uint256 positionId, uint256 amount) external nonReentrant {
        Position storage stored = _position(positionId);
        if (
            msg.sender != stored.member || positionOwner[positionId] != msg.sender ||
            memberStatus[positionId] != MemberStatus.Active
        ) revert MemberOnly();
        if (amount == 0) revert InvalidAmount();
        if (block.timestamp >= maturity) revert DepositsClosed();
        if (hasBlockingGroupExitRequest(positionId)) revert GroupExitUnresolved();
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
        uint256 shares = stored.lockedShares;
        stored.lockedBalance = 0;
        stored.lockedWithdrawn = true;
        totalLockedLiability -= principal;
        if (mode == VaultMode.Earn) {
            stored.lockedShares = 0;
            totalLockedShares -= shares;
        }
        if (memberStatus[positionId] == MemberStatus.Active) {
            _setMemberStatus(positionId, MemberStatus.Matured);
        }

        // Reverts roll these effects back if redemption or transfer fails.
        uint256 amount;
        if (mode == VaultMode.Earn) {
            amount = yieldAdapter.withdraw(shares, msg.sender);
        } else {
            amount = principal;
            _transferOutExact(msg.sender, amount);
        }
        _assertSolvent();
        emit LockedWithdrawn(positionId, msg.sender, amount);
    }

    function transferPosition(uint256 positionId, address expectedOwner, address newOwner) external nonReentrant {
        if (msg.sender != earlyExitMarket || earlyExitMarket == address(0)) revert MarketOnly();
        Position storage stored = _position(positionId);
        if (newOwner == address(0)) revert InvalidConfiguration();
        if (positionOwner[positionId] != expectedOwner) revert PositionOwnerOnly();
        if (stored.lockedWithdrawn) revert NothingToWithdraw();
        if (hasBlockingGroupExitRequest(positionId)) revert GroupExitUnresolved();

        // Only the locked claim changes hands. `stored.member` remains the emergency owner and
        // the original reward identity, which is simultaneously disqualified from rewards.
        positionOwner[positionId] = newOwner;
        rewardDisqualified[positionId] = true;
        _setMemberStatus(positionId, MemberStatus.MarketExit);
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
        if (isGroup && _rewardEligibleCount() < MIN_ACTIVE_GROUP_MEMBERS) return false;
        uint256 count = _positions.length;
        bool hasEligibleMember;
        for (uint256 i; i < count; ++i) {
            if (!_rewardEligible(i)) continue;
            hasEligibleMember = true;
            if (!goalComplete(i)) return false;
        }
        return hasEligibleMember;
    }

    function rewardEligibleCount() external view returns (uint256 eligible) {
        return _rewardEligibleCount();
    }

    function rewardRecipientAt(uint256 eligibleIndex) external view returns (address) {
        uint256 count = _positions.length;
        uint256 current;
        for (uint256 i; i < count; ++i) {
            if (!_rewardEligible(i)) continue;
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

    function _pendingGroupExitRequest(uint256 requestId)
        internal
        view
        returns (GroupExitRequest storage request)
    {
        request = groupExitRequests[requestId];
        if (request.status != GroupExitRequestStatus.Pending) revert GroupExitUnavailable();
        if (request.expiresAt <= block.timestamp) revert GroupExitExpiredRequest();
        if (activeMemberCount() < MIN_ACTIVE_GROUP_MEMBERS) revert GroupEarlyUnlockDisabled();
        if (memberStatus[request.positionId] != MemberStatus.Active) revert GroupExitUnavailable();
    }

    function _approvalProgress(uint256 requestId)
        internal
        view
        returns (uint32 required, uint32 completed, bool unanimous)
    {
        GroupExitRequest storage request = groupExitRequests[requestId];
        if (request.status == GroupExitRequestStatus.None) revert GroupExitUnavailable();
        uint256 count = _positions.length;
        for (uint256 i; i < count; ++i) {
            if (memberStatus[i] != MemberStatus.Active) continue;
            address member = _positions[i].member;
            if (member == request.requester) continue;
            ++required;
            if (groupExitApproval[requestId][member]) ++completed;
        }
        unanimous = required != 0 && completed == required;
    }

    function _allActiveGoalsComplete() internal view returns (bool) {
        uint256 count = _positions.length;
        for (uint256 i; i < count; ++i) {
            if (memberStatus[i] == MemberStatus.Active && !goalComplete(i)) return false;
        }
        return true;
    }

    function _rewardEligibleCount() internal view returns (uint256 eligible) {
        uint256 count = _positions.length;
        for (uint256 i; i < count; ++i) {
            if (_rewardEligible(i)) ++eligible;
        }
    }

    function _rewardEligible(uint256 positionId) internal view returns (bool) {
        MemberStatus status = memberStatus[positionId];
        return !rewardDisqualified[positionId] &&
            (status == MemberStatus.Active || status == MemberStatus.Matured);
    }

    function _setMemberStatus(uint256 positionId, MemberStatus nextStatus) internal {
        MemberStatus previousStatus = memberStatus[positionId];
        if (previousStatus == nextStatus) return;
        memberStatus[positionId] = nextStatus;
        if (isGroup) {
            emit GroupMemberStatusChanged(
                positionId,
                _positions[positionId].member,
                previousStatus,
                nextStatus
            );
        }
    }

    function _positionIdForMember(address member) internal view returns (uint256) {
        uint256 value = _memberPosition[member];
        if (value == 0) revert MemberOnly();
        return value - 1;
    }

    function _position(uint256 positionId) internal view returns (Position storage stored) {
        if (positionId >= _positions.length) revert UnknownPosition();
        return _positions[positionId];
    }
}
