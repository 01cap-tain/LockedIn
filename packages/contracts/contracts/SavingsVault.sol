// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IYieldAdapter} from "./interfaces/IYieldAdapter.sol";
import {SafetyController} from "./SafetyController.sol";

interface IEarlyExitMarketStatus {
    function isPositionListed(address vault, uint256 positionId) external view returns (bool);
}

interface IPublicGroupFactory {
    function recordPublicGroupJoin(address member) external;
}

/// @notice Non-upgradeable savings vault separating emergency ownership from a transferable locked claim.
/// @dev V1 is Safe-only: locked assets remain in this contract and no reward campaign is active.
contract SavingsVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MIN_EMERGENCY_BPS = 1_000;
    uint16 public constant MAX_EMERGENCY_BPS = 1_500;
    uint64 public constant GROUP_EXIT_REQUEST_LIFETIME = 24 hours;
    uint64 public constant GROUP_EXIT_AUTHORIZATION_LIFETIME = 24 hours;
    uint16 public constant MIN_GROUP_EXIT_APPROVAL_PROGRESS_BPS = 2_500;
    uint256 public constant MIN_GROUP_SIZE = 4;
    uint256 public constant MIN_ACTIVE_MEMBERS_AFTER_COOPERATIVE_EXIT = 2;
    // Testnet release boundary. Restore a production policy before mainnet.
    uint64 public constant MIN_MATURITY_DURATION = 1 hours;
    uint64 public constant MAX_MATURITY_DURATION = 5 * 365 days;

    enum VaultMode { Safe, Earn }
    enum MemberStatus { Active, CooperativeExit, MarketExit, Matured }
    enum GroupExitRequestStatus { None, Pending, Authorized, Cancelled, Expired, Completed }
    enum GroupLifecycle { NotApplicable, Pending, Active, Declined, Expired, Cancelled }
    enum InvitationStatus { Unavailable, Available, Accepted, Revoked, Expired }

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

    struct GroupInvitation {
        address invitee;
        uint64 expiry;
        uint64 generation;
        uint256 nonce;
        bool consumed;
        bool revoked;
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
    error RewardsDisabled();
    error EarnDisabled();
    error PositionListed();
    error GroupOnly();
    error GroupNotActive();
    error InvitationUnavailable();
    error GroupEarlyUnlockDisabled();
    error GroupExitUnavailable();
    error GroupExitUnresolved();
    error GroupExitExpiredRequest();
    error GroupExitAuthorizationWindowExpired();
    error GroupExitNotAuthorized();
    error SelfApproval();
    error ApprovalUnavailable();
    error InsufficientApprovalProgress();
    error DuplicateApproval();
    error ApprovalMissing();
    error TokenAccountingMismatch();
    error Insolvent();
    error PublicJoiningUnavailable();
    error InvitationInvalid();
    error InvitationWrongWallet();
    error InvitationExpired();
    error InvitationRevoked();
    error InvitationAlreadyUsed();
    error InvitationAlreadyAvailable();
    error CircleFull();

    IERC20 public immutable asset;
    uint64 public immutable maturity;
    uint64 public immutable createdAt;
    bool public immutable isGroup;
    address public immutable groupCreator;
    address public immutable earlyExitMarket;
    VaultMode public immutable mode;
    IYieldAdapter public immutable yieldAdapter;
    SafetyController public immutable safetyController;
    address public immutable factory;
    bool public immutable publicJoining;
    bool public immutable openEnrollment;
    uint32 public immutable maxMemberCount;
    uint64 public immutable enrollmentDeadline;
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
    mapping(bytes32 commitment => GroupInvitation invitation) public groupInvitations;
    mapping(address invitee => bytes32 commitment) public activeGroupInvitation;
    mapping(address invitee => mapping(uint256 nonce => bool registered)) public invitationNonceRegistered;
    uint64 public invitationGeneration;
    uint256 public nextGroupExitRequestId;
    uint256 public activeGroupExitRequestIdPlusOne;
    uint256 public totalEmergencyLiability;
    uint256 public totalLockedLiability;
    uint256 public constant totalLockedShares = 0;

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
    event GroupActivated(uint64 activatedAt);
    event PublicGroupJoined(address indexed member, uint256 indexed positionId, uint32 memberCount);
    event PublicGroupJoiningClosed(uint32 finalMemberCount);
    event GroupInvitationCreated(
        bytes32 indexed commitment,
        address indexed invitee,
        uint64 expiry,
        uint256 nonce,
        uint64 generation
    );
    event GroupInvitationRevoked(bytes32 indexed commitment, address indexed invitee);
    event GroupInvitationConsumed(bytes32 indexed commitment, address indexed invitee, uint256 indexed positionId);

    constructor(
        IERC20 asset_,
        uint64 maturity_,
        bool isGroup_,
        address groupCreator_,
        address earlyExitMarket_,
        SafetyController safetyController_,
        VaultMode mode_,
        address[] memory members_,
        uint256[] memory targets_,
        uint16[] memory emergencyBps_,
        address factory_,
        bool publicJoining_,
        uint32 maxMemberCount_,
        uint256 publicMemberTarget_,
        uint16 publicEmergencyBps_,
        bool openEnrollment_,
        uint64 enrollmentDeadline_
    ) {
        uint256 count = members_.length;
        if (
            address(asset_) == address(0) || address(asset_).code.length == 0 ||
            groupCreator_ == address(0) ||
            earlyExitMarket_ == address(0) || earlyExitMarket_.code.length == 0 ||
            address(safetyController_) == address(0) || address(safetyController_).code.length == 0 ||
            factory_ == address(0) || factory_.code.length == 0 ||
            maturity_ <= block.timestamp ||
            uint256(maturity_) < block.timestamp + MIN_MATURITY_DURATION ||
            uint256(maturity_) > block.timestamp + MAX_MATURITY_DURATION ||
            count == 0 || count != targets_.length ||
            count != emergencyBps_.length ||
            (isGroup_ && !openEnrollment_ && count < MIN_GROUP_SIZE) ||
            (openEnrollment_ && (!isGroup_ || count != 1 || maxMemberCount_ < MIN_GROUP_SIZE ||
                maxMemberCount_ < count ||
                enrollmentDeadline_ <= block.timestamp || enrollmentDeadline_ >= maturity_ ||
                publicMemberTarget_ != targets_[0] || publicEmergencyBps_ != emergencyBps_[0])) ||
            (publicJoining_ && !openEnrollment_)
        ) revert InvalidConfiguration();
        if (mode_ != VaultMode.Safe) revert EarnDisabled();

        asset = asset_;
        maturity = maturity_;
        createdAt = uint64(block.timestamp);
        isGroup = isGroup_;
        groupCreator = groupCreator_;
        earlyExitMarket = earlyExitMarket_;
        safetyController = safetyController_;
        mode = mode_;
        yieldAdapter = IYieldAdapter(address(0));
        factory = factory_;
        publicJoining = publicJoining_;
        openEnrollment = openEnrollment_;
        maxMemberCount = openEnrollment_ ? maxMemberCount_ : uint32(count);
        enrollmentDeadline = openEnrollment_ ? enrollmentDeadline_ : 0;

        bool creatorIncluded = false;
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

        if (isGroup_ && openEnrollment_) {
            if (!creatorIncluded) revert InvalidConfiguration();
            groupLifecycle = GroupLifecycle.Pending;
            acceptedMemberCount = 1;
            invitationGeneration = 1;
        } else if (isGroup_) {
            if (!creatorIncluded) revert InvalidConfiguration();
            groupLifecycle = GroupLifecycle.Active;
            acceptedMemberCount = uint32(count);
            emit GroupActivated(uint64(block.timestamp));
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

    /// @notice Joins an open circle with personal financial terms selected by the joiner.
    /// @dev Shared circle rules stay immutable while target and emergency allocation are position-specific.
    function joinPublicGroup(uint256 target, uint16 emergencyBps) external nonReentrant {
        if (
            !openEnrollment || !publicJoining ||
            publicJoinClosed || groupLifecycle != GroupLifecycle.Pending ||
            block.timestamp >= enrollmentDeadline || _positions.length >= maxMemberCount ||
            target == 0 || emergencyBps < MIN_EMERGENCY_BPS || emergencyBps > MAX_EMERGENCY_BPS ||
            _memberPosition[msg.sender] != 0
        ) revert PublicJoiningUnavailable();
        _admitGroupMember(msg.sender, target, emergencyBps);
    }

    /// @notice Creates a wallet-bound, one-time commitment without publishing its secret.
    function createGroupInvitation(
        address invitee,
        bytes32 commitment,
        uint64 expiry,
        uint256 nonce
    ) external {
        if (
            msg.sender != groupCreator || !openEnrollment || publicJoining || publicJoinClosed ||
            groupLifecycle != GroupLifecycle.Pending || invitee == address(0) || commitment == bytes32(0) ||
            _memberPosition[invitee] != 0 || block.timestamp >= enrollmentDeadline ||
            expiry <= block.timestamp || expiry > enrollmentDeadline || _positions.length >= maxMemberCount
        ) revert InvitationUnavailable();
        if (invitationNonceRegistered[invitee][nonce] || groupInvitations[commitment].invitee != address(0)) {
            revert InvitationInvalid();
        }
        bytes32 existing = activeGroupInvitation[invitee];
        if (existing != bytes32(0) && invitationStatus(existing) == InvitationStatus.Available) {
            revert InvitationAlreadyAvailable();
        }

        groupInvitations[commitment] = GroupInvitation({
            invitee: invitee,
            expiry: expiry,
            generation: invitationGeneration,
            nonce: nonce,
            consumed: false,
            revoked: false
        });
        invitationNonceRegistered[invitee][nonce] = true;
        activeGroupInvitation[invitee] = commitment;
        emit GroupInvitationCreated(commitment, invitee, expiry, nonce, invitationGeneration);
    }

    /// @notice Revokes an unused invitation while the circle is still pending.
    function revokeGroupInvitation(bytes32 commitment) external {
        if (msg.sender != groupCreator || !openEnrollment || publicJoining) revert InvitationUnavailable();
        GroupInvitation storage invitation = groupInvitations[commitment];
        if (invitation.invitee == address(0)) revert InvitationInvalid();
        if (invitation.consumed) revert InvitationAlreadyUsed();
        if (invitation.revoked) revert InvitationRevoked();
        if (invitationStatus(commitment) != InvitationStatus.Available) revert InvitationExpired();
        invitation.revoked = true;
        if (activeGroupInvitation[invitation.invitee] == commitment) {
            activeGroupInvitation[invitation.invitee] = bytes32(0);
        }
        emit GroupInvitationRevoked(commitment, invitation.invitee);
    }

    /// @notice Accepts a wallet-bound invitation and creates the invitee's independent position.
    function joinInviteOnlyGroup(
        address invitee,
        bytes32 secret,
        uint64 expiry,
        uint256 nonce,
        uint256 target,
        uint16 emergencyBps
    ) external nonReentrant {
        if (msg.sender != invitee) revert InvitationWrongWallet();
        bytes32 commitment = keccak256(
            abi.encode(address(this), invitee, secret, expiry, nonce, block.chainid)
        );
        GroupInvitation storage invitation = groupInvitations[commitment];
        if (
            invitation.invitee == address(0) || invitation.invitee != invitee ||
            invitation.expiry != expiry || invitation.nonce != nonce
        ) revert InvitationInvalid();
        if (invitation.consumed) revert InvitationAlreadyUsed();
        if (invitation.revoked) revert InvitationRevoked();
        if (_positions.length >= maxMemberCount) revert CircleFull();
        if (invitation.generation != invitationGeneration || block.timestamp >= invitation.expiry) {
            revert InvitationExpired();
        }
        if (
            !openEnrollment || publicJoining || publicJoinClosed ||
            groupLifecycle != GroupLifecycle.Pending || block.timestamp >= enrollmentDeadline
        ) revert InvitationUnavailable();
        if (_memberPosition[msg.sender] != 0) revert PublicJoiningUnavailable();
        if (target == 0 || emergencyBps < MIN_EMERGENCY_BPS || emergencyBps > MAX_EMERGENCY_BPS) {
            revert InvalidConfiguration();
        }

        invitation.consumed = true;
        activeGroupInvitation[invitee] = bytes32(0);
        uint256 positionId = _admitGroupMember(invitee, target, emergencyBps);
        emit GroupInvitationConsumed(commitment, invitee, positionId);
    }

    function invitationStatus(bytes32 commitment) public view returns (InvitationStatus) {
        GroupInvitation storage invitation = groupInvitations[commitment];
        if (invitation.invitee == address(0)) return InvitationStatus.Unavailable;
        if (invitation.consumed) return InvitationStatus.Accepted;
        if (invitation.revoked) return InvitationStatus.Revoked;
        if (
            invitation.generation != invitationGeneration || block.timestamp >= invitation.expiry ||
            publicJoinClosed || groupLifecycle != GroupLifecycle.Pending
        ) return InvitationStatus.Expired;
        return InvitationStatus.Available;
    }

    function _admitGroupMember(
        address member,
        uint256 target,
        uint16 emergencyBps
    ) internal returns (uint256 positionId) {
        positionId = _positions.length;
        _positions.push(Position({
            member: member,
            target: target,
            deposited: 0,
            emergencyBalance: 0,
            lockedBalance: 0,
            lockedShares: 0,
            emergencyBps: emergencyBps,
            lockedWithdrawn: false
        }));
        _memberPosition[member] = positionId + 1;
        positionOwner[positionId] = member;
        ++acceptedMemberCount;
        IPublicGroupFactory(factory).recordPublicGroupJoin(member);
        emit PublicGroupJoined(member, positionId, uint32(_positions.length));
        if (_positions.length == maxMemberCount) {
            publicJoinClosed = true;
            ++invitationGeneration;
            emit PublicGroupJoiningClosed(uint32(_positions.length));
        }
    }

    /// @notice Freezes membership and enables deposits once four or more members have joined.
    /// @dev Any joined member can activate; the creator receives no post-activation financial authority.
    function activateGroup() external {
        if (
            !openEnrollment || groupLifecycle != GroupLifecycle.Pending ||
            _memberPosition[msg.sender] == 0 || acceptedMemberCount < MIN_GROUP_SIZE ||
            block.timestamp >= maturity
        ) revert GroupNotActive();
        safetyController.requireNotPaused();
        publicJoinClosed = true;
        ++invitationGeneration;
        groupLifecycle = GroupLifecycle.Active;
        emit PublicGroupJoiningClosed(uint32(_positions.length));
        emit GroupActivated(uint64(block.timestamp));
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
        if (activeMemberCount() <= MIN_ACTIVE_MEMBERS_AFTER_COOPERATIVE_EXIT) {
            revert GroupEarlyUnlockDisabled();
        }

        uint256 activeRequestIdPlusOne = activeGroupExitRequestIdPlusOne;
        if (activeRequestIdPlusOne != 0) {
            GroupExitRequest storage activeRequest = groupExitRequests[activeRequestIdPlusOne - 1];
            if (_requestHasExpired(activeRequest)) {
                _recordGroupExitExpiry(activeRequestIdPlusOne - 1, activeRequest);
            } else if (
                activeRequest.status == GroupExitRequestStatus.Pending ||
                activeRequest.status == GroupExitRequestStatus.Authorized
            ) {
                revert GroupExitUnresolved();
            } else {
                activeGroupExitRequestIdPlusOne = 0;
            }
        }

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
        uint32 requiredApprovals = 0;
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
        activeGroupExitRequestIdPlusOne = requestId + 1;
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
        GroupExitRequest storage request = groupExitRequests[requestId];
        if (
            request.status != GroupExitRequestStatus.Pending &&
            request.status != GroupExitRequestStatus.Authorized
        ) revert GroupExitUnavailable();
        if (_requestHasExpired(request)) revert GroupExitExpiredRequest();
        if (msg.sender != request.requester) revert MemberOnly();
        request.status = GroupExitRequestStatus.Cancelled;
        if (activeGroupExitRequestIdPlusOne == requestId + 1) {
            activeGroupExitRequestIdPlusOne = 0;
        }
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
        if (active <= MIN_ACTIVE_MEMBERS_AFTER_COOPERATIVE_EXIT) {
            revert GroupEarlyUnlockDisabled();
        }
        if (!_allRequiredApproversEligible(requestId)) revert InsufficientApprovalProgress();

        uint256 positionId = request.positionId;
        Position storage stored = _position(positionId);
        if (
            memberStatus[positionId] != MemberStatus.Active || stored.lockedWithdrawn ||
            positionOwner[positionId] != msg.sender
        ) revert GroupExitUnavailable();

        uint256 principal = stored.lockedBalance;
        stored.lockedBalance = 0;
        stored.lockedWithdrawn = true;
        totalLockedLiability -= principal;
        rewardDisqualified[positionId] = true;
        request.status = GroupExitRequestStatus.Completed;
        if (activeGroupExitRequestIdPlusOne == requestId + 1) {
            activeGroupExitRequestIdPlusOne = 0;
        }
        _setMemberStatus(positionId, MemberStatus.CooperativeExit);
        safetyController.recordWithdrawal(principal);

        // All accounting effects precede the external interaction. A failed token
        // transfer reverts the entire transaction and preserves retryability.
        uint256 amount = principal;
        _transferOutExact(msg.sender, amount);
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
        stored.lockedBalance = 0;
        stored.lockedWithdrawn = true;
        totalLockedLiability -= principal;
        if (memberStatus[positionId] == MemberStatus.Active) {
            _setMemberStatus(positionId, MemberStatus.Matured);
        }
        safetyController.recordWithdrawal(principal);

        // Reverts roll these effects back if the transfer fails.
        uint256 amount = principal;
        _transferOutExact(msg.sender, amount);
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
        return stored.lockedBalance;
    }

    function accruedYield(uint256 positionId) external view returns (uint256) {
        _position(positionId);
        return 0;
    }

    function currentLiquidityRate() external pure returns (uint256) {
        return 0;
    }

    function rewardsReady() public pure returns (bool) {
        return false;
    }

    function rewardEligibleCount() external pure returns (uint256) {
        return 0;
    }

    function rewardRecipientAt(uint256) external pure returns (address) {
        revert RewardsDisabled();
    }

    /// @notice Returns the immutable target paired with an eligible reward recipient.
    /// @dev Protocol-revenue weight is capped at target, so yield and excess deposits
    /// cannot increase a group's epoch allocation.
    function rewardTargetAt(uint256) external pure returns (uint256) {
        revert RewardsDisabled();
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

    function activateRewards() external pure {
        revert RewardsDisabled();
    }

    function totalPrincipalLiability() external view returns (uint256) {
        return totalEmergencyLiability + totalLockedLiability;
    }

    function isSolvent() external view returns (bool) {
        return asset.balanceOf(address(this)) >= totalEmergencyLiability + totalLockedLiability;
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
        uint256 requiredVaultBalance = totalEmergencyLiability + totalLockedLiability;
        if (asset.balanceOf(address(this)) < requiredVaultBalance) {
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
        if (activeMemberCount() <= MIN_ACTIVE_MEMBERS_AFTER_COOPERATIVE_EXIT) {
            revert GroupEarlyUnlockDisabled();
        }
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
        if (activeGroupExitRequestIdPlusOne == requestId + 1) {
            activeGroupExitRequestIdPlusOne = 0;
        }
        if (authorizationExpired) emit GroupExitAuthorizationExpired(requestId);
        else emit GroupExitExpired(requestId);
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
