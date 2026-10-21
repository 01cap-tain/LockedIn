// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {RewardPool} from "./RewardPool.sol";
import {IYieldAdapter} from "./interfaces/IYieldAdapter.sol";
import {SafetyController} from "./SafetyController.sol";

interface IEarlyExitMarketStatus {
    function isPositionListed(address vault, uint256 positionId) external view returns (bool);
}

interface IPublicGroupFactory {
    function recordPublicGroupJoin(address member) external;
}

/// @notice Non-upgradeable savings vault separating emergency ownership from a transferable locked claim.
/// @dev Safe mode holds locked assets locally; Earn mode represents them with adapter shares.
contract SavingsVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MIN_EMERGENCY_BPS = 1_000;
    uint16 public constant MAX_EMERGENCY_BPS = 1_500;
    uint64 public constant GROUP_EXIT_REQUEST_LIFETIME = 24 hours;
    uint64 public constant GROUP_EXIT_AUTHORIZATION_LIFETIME = 24 hours;
    uint64 public constant GROUP_INVITATION_LIFETIME = 72 hours;
    uint16 public constant MIN_GROUP_EXIT_APPROVAL_PROGRESS_BPS = 2_500;
    uint256 public constant MIN_GROUP_SIZE = 4;

    enum VaultMode { Safe, Earn }
    enum MemberStatus { Active, CooperativeExit, MarketExit, Matured }
    enum GroupExitRequestStatus { None, Pending, Authorized, Cancelled, Expired, Completed }
    enum GroupLifecycle { NotApplicable, Pending, Active, Declined, Expired, Cancelled }

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
        uint64 authorizationExpiresAt;
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
    error TargetExceeded();
    error DepositsClosed();
    error InsufficientEmergencyBalance();
    error NotMatured();
    error NothingToWithdraw();
    error RewardsNotReady();
    error PositionListed();
    error GroupOnly();
    error GroupNotActive();
    error InvitationUnavailable();
    error InvitationExpired();
    error InvitationAlreadyAnswered();
    error CreatorOnly();
    error GroupEarlyUnlockDisabled();
    error GroupExitUnavailable();
    error GroupExitUnresolved();
    error GroupExitExpiredRequest();
    error GroupExitAuthorizationWindowExpired();
    error GroupExitNotAuthorized();
    error GroupGoalsIncomplete();
    error SelfApproval();
    error ApprovalUnavailable();
    error InsufficientApprovalProgress();
    error DuplicateApproval();
    error ApprovalMissing();
    error TokenAccountingMismatch();
    error Insolvent();
    error PublicJoiningUnavailable();

    IERC20 public immutable asset;
    RewardPool public immutable rewardPool;
    uint64 public immutable maturity;
    uint64 public immutable createdAt;
    bool public immutable isGroup;
    address public immutable groupCreator;
    uint64 public immutable invitationExpiresAt;
    address public immutable earlyExitMarket;
    VaultMode public immutable mode;
    IYieldAdapter public immutable yieldAdapter;
    SafetyController public immutable safetyController;
    address public immutable factory;
    bool public immutable publicJoining;
    uint32 public immutable maxMemberCount;
    bool public publicJoinClosed;
    GroupLifecycle public groupLifecycle;
    uint32 public acceptedMemberCount;

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
    mapping(uint256 requestId => mapping(address member => bool required)) public groupExitRequiredApprover;
    mapping(address member => bool accepted) public groupInvitationAccepted;
    mapping(address member => bool declined) public groupInvitationDeclined;
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
        uint32 completedApprovals,
        uint64 authorizationExpiresAt
    );
    event GroupExitAuthorizationExpired(uint256 indexed requestId);
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
    event GroupInvitationCreated(address indexed member, uint64 expiresAt);
    event GroupInvitationAccepted(address indexed member, uint32 acceptedCount, uint32 requiredCount);
    event GroupInvitationDeclined(address indexed member);
    event GroupActivated(uint64 activatedAt);
    event GroupInvitationExpired(uint64 expiredAt);
    event UnactivatedGroupCancelled(address indexed creator);
    event PublicGroupJoined(address indexed member, uint256 indexed positionId, uint32 memberCount);
    event PublicGroupJoiningClosed(uint32 finalMemberCount);

    constructor(
        IERC20 asset_,
        RewardPool rewardPool_,
        uint64 maturity_,
        bool isGroup_,
        address groupCreator_,
        address earlyExitMarket_,
        SafetyController safetyController_,
        VaultMode mode_,
        IYieldAdapter yieldAdapter_,
        address[] memory members_,
        uint256[] memory targets_,
        uint16[] memory emergencyBps_,
        address factory_,
        bool publicJoining_,
        uint32 maxMemberCount_,
        uint256 publicMemberTarget_,
        uint16 publicEmergencyBps_
    ) {
        uint256 count = members_.length;
        if (
            address(asset_) == address(0) || address(rewardPool_) == address(0) ||
            groupCreator_ == address(0) || address(safetyController_) == address(0) || factory_ == address(0) ||
            maturity_ <= block.timestamp || count == 0 || count != targets_.length ||
            count != emergencyBps_.length ||
            (isGroup_ && !publicJoining_ && (count < MIN_GROUP_SIZE || maturity_ <= block.timestamp + GROUP_INVITATION_LIFETIME)) ||
            (publicJoining_ && (!isGroup_ || count != 1 || maxMemberCount_ < MIN_GROUP_SIZE ||
                maxMemberCount_ < count || publicMemberTarget_ != targets_[0] ||
                publicEmergencyBps_ != emergencyBps_[0])) ||
            (mode_ == VaultMode.Safe && address(yieldAdapter_) != address(0)) ||
            (mode_ == VaultMode.Earn && address(yieldAdapter_) == address(0))
        ) revert InvalidConfiguration();

        asset = asset_;
        rewardPool = rewardPool_;
        maturity = maturity_;
        createdAt = uint64(block.timestamp);
        isGroup = isGroup_;
        groupCreator = groupCreator_;
        invitationExpiresAt = isGroup_
            ? uint64(block.timestamp) + GROUP_INVITATION_LIFETIME
            : 0;
        earlyExitMarket = earlyExitMarket_;
        safetyController = safetyController_;
        mode = mode_;
        yieldAdapter = yieldAdapter_;
        factory = factory_;
        publicJoining = publicJoining_;
        maxMemberCount = publicJoining_ ? maxMemberCount_ : uint32(count);

        bool creatorIncluded;
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
            if (members_[i] == groupCreator_) creatorIncluded = true;
        }

        if (isGroup_ && publicJoining_) {
            if (!creatorIncluded) revert InvalidConfiguration();
            groupLifecycle = GroupLifecycle.Active;
            groupInvitationAccepted[groupCreator_] = true;
            acceptedMemberCount = 1;
            emit GroupActivated(uint64(block.timestamp));
        } else if (isGroup_) {
            if (!creatorIncluded) revert InvalidConfiguration();
            groupLifecycle = GroupLifecycle.Pending;
            groupInvitationAccepted[groupCreator_] = true;
            acceptedMemberCount = 1;
            emit GroupInvitationAccepted(groupCreator_, 1, uint32(count));
            for (uint256 i; i < count; ++i) {
                if (members_[i] != groupCreator_) {
                    emit GroupInvitationCreated(members_[i], invitationExpiresAt);
                }
            }
        } else {
            groupLifecycle = GroupLifecycle.NotApplicable;
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

    /// @notice Joins a bounded public circle before savings activity begins.
    /// @dev Membership freezes on the first deposit so reward and exit sets cannot change mid-plan.
    function joinPublicGroup() external {
        if (
            !publicJoining || publicJoinClosed || groupLifecycle != GroupLifecycle.Active ||
            block.timestamp >= maturity || _positions.length >= maxMemberCount ||
            _memberPosition[msg.sender] != 0
        ) revert PublicJoiningUnavailable();
        uint256 positionId = _positions.length;
        _positions.push(Position({
            member: msg.sender,
            target: _positions[0].target,
            deposited: 0,
            emergencyBalance: 0,
            lockedBalance: 0,
            lockedShares: 0,
            emergencyBps: _positions[0].emergencyBps,
            lockedWithdrawn: false
        }));
        _memberPosition[msg.sender] = positionId + 1;
        positionOwner[positionId] = msg.sender;
        groupInvitationAccepted[msg.sender] = true;
        ++acceptedMemberCount;
        IPublicGroupFactory(factory).recordPublicGroupJoin(msg.sender);
        emit PublicGroupJoined(msg.sender, positionId, uint32(_positions.length));
    }

    /// @notice Accepts the complete immutable group terms presented by this vault.
    function acceptGroupInvitation() external {
        if (!isGroup) revert GroupOnly();
        if (groupLifecycle != GroupLifecycle.Pending) revert InvitationUnavailable();
        if (block.timestamp >= invitationExpiresAt) revert InvitationExpired();
        _positionIdForMember(msg.sender);
        if (groupInvitationAccepted[msg.sender] || groupInvitationDeclined[msg.sender]) {
            revert InvitationAlreadyAnswered();
        }

        // Earlier acceptances may be recorded while paused, but the final
        // acceptance cannot activate a new savings group until unpaused.
        if (acceptedMemberCount + 1 == _positions.length) {
            safetyController.requireNotPaused();
        }

        groupInvitationAccepted[msg.sender] = true;
        ++acceptedMemberCount;
        emit GroupInvitationAccepted(msg.sender, acceptedMemberCount, uint32(_positions.length));
        if (acceptedMemberCount == _positions.length) {
            groupLifecycle = GroupLifecycle.Active;
            emit GroupActivated(uint64(block.timestamp));
        }
    }

    /// @notice Permanently prevents activation when an invited wallet rejects the terms.
    function declineGroupInvitation() external {
        if (!isGroup) revert GroupOnly();
        if (groupLifecycle != GroupLifecycle.Pending) revert InvitationUnavailable();
        if (block.timestamp >= invitationExpiresAt) revert InvitationExpired();
        _positionIdForMember(msg.sender);
        if (msg.sender == groupCreator || groupInvitationAccepted[msg.sender]) {
            revert InvitationAlreadyAnswered();
        }
        groupInvitationDeclined[msg.sender] = true;
        groupLifecycle = GroupLifecycle.Declined;
        emit GroupInvitationDeclined(msg.sender);
    }

    /// @notice Materializes an unanswered invitation's expiry for indexers.
    function expireGroupInvitation() external {
        if (
            !isGroup || groupLifecycle != GroupLifecycle.Pending ||
            block.timestamp < invitationExpiresAt
        ) revert InvitationUnavailable();
        groupLifecycle = GroupLifecycle.Expired;
        emit GroupInvitationExpired(uint64(block.timestamp));
    }

    /// @notice Lets only the creator close a declined or expired, never-funded group.
    function cancelUnactivatedGroup() external {
        if (msg.sender != groupCreator) revert CreatorOnly();
        if (!isGroup) revert GroupOnly();
        if (
            groupLifecycle == GroupLifecycle.Pending &&
            block.timestamp >= invitationExpiresAt
        ) {
            groupLifecycle = GroupLifecycle.Expired;
            emit GroupInvitationExpired(uint64(block.timestamp));
        }
        if (
            groupLifecycle != GroupLifecycle.Declined &&
            groupLifecycle != GroupLifecycle.Expired
        ) revert InvitationUnavailable();
        groupLifecycle = GroupLifecycle.Cancelled;
        emit UnactivatedGroupCancelled(msg.sender);
    }

    function groupIsActive() public view returns (bool) {
        return !isGroup || groupLifecycle == GroupLifecycle.Active;
    }

    /// @notice Principal still actively held for a member; generated yield is excluded.
    function activePrincipalSavings(uint256 positionId) public view returns (uint256) {
        Position storage stored = _position(positionId);
        return stored.lockedBalance + stored.emergencyBalance;
    }

    function groupExitApprovalEligible(uint256 positionId) public view returns (bool) {
        Position storage stored = _position(positionId);
        return memberStatus[positionId] == MemberStatus.Active && Math.mulDiv(
            activePrincipalSavings(positionId),
            10_000,
            stored.target
        ) >= MIN_GROUP_EXIT_APPROVAL_PROGRESS_BPS;
    }

    /// @notice Opens a 24-hour cooperative exit request for the caller's own group position.
    function requestGroupExit() external returns (uint256 requestId) {
        if (!isGroup) revert GroupOnly();
        if (!groupIsActive()) revert GroupNotActive();
        if (block.timestamp >= maturity) revert DepositsClosed();
        if (activeMemberCount() < MIN_GROUP_SIZE) revert GroupEarlyUnlockDisabled();

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
            if (_requestHasExpired(previous)) {
                _recordGroupExitExpiry(previousIdPlusOne - 1, previous);
            } else if (
                previous.status == GroupExitRequestStatus.Pending ||
                previous.status == GroupExitRequestStatus.Authorized
            ) {
                revert GroupExitUnresolved();
            }
        }

        requestId = nextGroupExitRequestId++;
        uint64 expiresAt = uint64(block.timestamp) + GROUP_EXIT_REQUEST_LIFETIME;
        uint32 requiredApprovals;
        for (uint256 i; i < _positions.length; ++i) {
            address member = _positions[i].member;
            if (memberStatus[i] == MemberStatus.Active && member != msg.sender) {
                groupExitRequiredApprover[requestId][member] = true;
                ++requiredApprovals;
            }
        }
        groupExitRequests[requestId] = GroupExitRequest({
            positionId: positionId,
            requester: msg.sender,
            createdAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            authorizationExpiresAt: 0,
            requiredApprovals: requiredApprovals,
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
        if (
            !groupExitRequiredApprover[requestId][msg.sender] ||
            memberStatus[approverPosition] != MemberStatus.Active
        ) revert ApprovalUnavailable();
        // Approval power is earned through measurable participation. Deposits made while
        // another member's request is pending can bring an approver up to this threshold.
        if (
            !groupExitApprovalEligible(approverPosition)
        ) revert InsufficientApprovalProgress();
        if (groupExitApproval[requestId][msg.sender]) revert DuplicateApproval();

        groupExitApproval[requestId][msg.sender] = true;
        emit GroupExitApproved(requestId, msg.sender);

        (, uint32 completed, bool unanimous) = _approvalProgress(requestId);
        request.completedApprovals = completed;
        if (unanimous && _allRequiredApproversEligible(requestId)) {
            _authorizeGroupExit(requestId, request);
        }
    }

    /// @notice Rechecks already-recorded unanimous approvals after a member restores eligibility.
    function authorizeGroupExit(uint256 requestId) external {
        GroupExitRequest storage request = _pendingGroupExitRequest(requestId);
        (,, bool unanimous) = _approvalProgress(requestId);
        if (!unanimous) revert ApprovalMissing();
        if (!_allRequiredApproversEligible(requestId)) revert InsufficientApprovalProgress();
        _authorizeGroupExit(requestId, request);
    }

    /// @notice Revokes an approval only while the request remains unresolved.
    function revokeGroupExitApproval(uint256 requestId) external {
        _pendingGroupExitRequest(requestId);
        uint256 approverPosition = _positionIdForMember(msg.sender);
        if (memberStatus[approverPosition] != MemberStatus.Active) revert ApprovalUnavailable();
        if (!groupExitApproval[requestId][msg.sender]) revert ApprovalMissing();
        groupExitApproval[requestId][msg.sender] = false;
        (, uint32 completed,) = _approvalProgress(requestId);
        groupExitRequests[requestId].completedApprovals = completed;
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
        if (!_requestHasExpired(request)) revert GroupExitUnavailable();
        _recordGroupExitExpiry(requestId, request);
    }

    /// @notice Pays only the requester's locked claim after final unanimous authorization.
    function completeGroupExit(uint256 requestId) external nonReentrant {
        GroupExitRequest storage request = groupExitRequests[requestId];
        if (request.status != GroupExitRequestStatus.Authorized) revert GroupExitNotAuthorized();
        if (request.authorizationExpiresAt <= block.timestamp) {
            revert GroupExitAuthorizationWindowExpired();
        }
        if (msg.sender != request.requester) revert MemberOnly();
        if (block.timestamp >= maturity) revert NotMatured();
        uint256 active = activeMemberCount();
        if (active == 0 || active - 1 < MIN_GROUP_SIZE) revert GroupEarlyUnlockDisabled();
        if (!_allRequiredApproversEligible(requestId)) revert InsufficientApprovalProgress();
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
        safetyController.recordWithdrawal(principal);

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
        return (
            request.status == GroupExitRequestStatus.Authorized &&
            request.authorizationExpiresAt > block.timestamp
        ) || (
            request.status == GroupExitRequestStatus.Pending &&
            request.expiresAt > block.timestamp
        );
    }

    /// @dev Called by the immutable market before listing. It records lazy expiry on-chain.
    function prepareMarketListing(uint256 positionId) external {
        if (msg.sender != earlyExitMarket) revert MarketOnly();
        if (!isGroup) return;
        if (!groupIsActive()) revert GroupNotActive();
        uint256 requestIdPlusOne = currentGroupExitRequest[positionId];
        if (requestIdPlusOne == 0) return;
        GroupExitRequest storage request = groupExitRequests[requestIdPlusOne - 1];
        if (_requestHasExpired(request)) {
            _recordGroupExitExpiry(requestIdPlusOne - 1, request);
            return;
        }
        if (
            request.status == GroupExitRequestStatus.Pending ||
            request.status == GroupExitRequestStatus.Authorized
        ) revert GroupExitUnresolved();
    }

    function deposit(uint256 positionId, uint256 amount) external nonReentrant {
        if (isGroup && !groupIsActive()) revert GroupNotActive();
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
        if (publicJoining && !publicJoinClosed) {
            publicJoinClosed = true;
            emit PublicGroupJoiningClosed(uint32(_positions.length));
        }

        // The shared controller enforces position, vault and protocol caps from
        // net outstanding principal. Any later revert rolls this reservation back.
        safetyController.recordDeposit(activePrincipalSavings(positionId), amount);
        if (stored.deposited + amount > stored.target) revert TargetExceeded();

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
        safetyController.recordWithdrawal(amount);
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
        safetyController.recordWithdrawal(principal);

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
        if (isGroup && !groupIsActive()) revert GroupNotActive();
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
        if (isGroup && !groupIsActive()) return false;
        if (block.timestamp < maturity) return false;
        if (isGroup && _rewardEligibleCount() < MIN_GROUP_SIZE) return false;
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

    /// @notice Returns the immutable target paired with an eligible reward recipient.
    /// @dev Protocol-revenue weight is capped at target, so yield and excess deposits
    /// cannot increase a group's epoch allocation.
    function rewardTargetAt(uint256 eligibleIndex) external view returns (uint256) {
        uint256 count = _positions.length;
        uint256 current;
        for (uint256 i; i < count; ++i) {
            if (!_rewardEligible(i)) continue;
            if (current == eligibleIndex) return _positions[i].target;
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
        if (activeMemberCount() < MIN_GROUP_SIZE) revert GroupEarlyUnlockDisabled();
        if (memberStatus[request.positionId] != MemberStatus.Active) revert GroupExitUnavailable();
    }

    function _approvalProgress(uint256 requestId)
        internal
        view
        returns (uint32 required, uint32 completed, bool unanimous)
    {
        GroupExitRequest storage request = groupExitRequests[requestId];
        if (request.status == GroupExitRequestStatus.None) revert GroupExitUnavailable();
        required = request.requiredApprovals;
        for (uint256 i; i < _positions.length; ++i) {
            address member = _positions[i].member;
            if (
                groupExitRequiredApprover[requestId][member] &&
                groupExitApproval[requestId][member]
            ) ++completed;
        }
        unanimous = required != 0 && completed == required;
    }

    function _allRequiredApproversEligible(uint256 requestId) internal view returns (bool) {
        for (uint256 i; i < _positions.length; ++i) {
            address member = _positions[i].member;
            if (!groupExitRequiredApprover[requestId][member]) continue;
            if (
                !groupExitApproval[requestId][member] ||
                !groupExitApprovalEligible(i)
            ) return false;
        }
        return true;
    }

    function _authorizeGroupExit(
        uint256 requestId,
        GroupExitRequest storage request
    ) internal {
        uint64 authorizationExpiresAt =
            uint64(block.timestamp) + GROUP_EXIT_AUTHORIZATION_LIFETIME;
        request.completedApprovals = request.requiredApprovals;
        request.authorizationExpiresAt = authorizationExpiresAt;
        request.status = GroupExitRequestStatus.Authorized;
        emit GroupExitAuthorized(
            requestId,
            request.requiredApprovals,
            request.completedApprovals,
            authorizationExpiresAt
        );
    }

    function _requestHasExpired(GroupExitRequest storage request)
        internal
        view
        returns (bool)
    {
        return (
            request.status == GroupExitRequestStatus.Pending &&
            request.expiresAt <= block.timestamp
        ) || (
            request.status == GroupExitRequestStatus.Authorized &&
            request.authorizationExpiresAt <= block.timestamp
        );
    }

    function _recordGroupExitExpiry(
        uint256 requestId,
        GroupExitRequest storage request
    ) internal {
        bool authorizationExpired = request.status == GroupExitRequestStatus.Authorized;
        request.status = GroupExitRequestStatus.Expired;
        if (authorizationExpired) emit GroupExitAuthorizationExpired(requestId);
        else emit GroupExitExpired(requestId);
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
