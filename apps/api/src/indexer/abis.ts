import { Interface } from 'ethers'

export type ContractKind = 'factory' | 'market' | 'reward' | 'safety' | 'vault'

const definitions: Record<ContractKind, readonly string[]> = {
  factory: [
    'event VaultCreated(address indexed vault,address indexed creator,bool indexed isGroup,uint8 mode,address yieldAdapter,uint64 maturity)',
  ],
  market: [
    'event ListingCreated(uint256 indexed listingId,address indexed vault,uint256 indexed positionId,address seller,uint256 claimValue,uint16 systemDiscountBps,uint256 saverPayout,uint256 providerPotentialReturn,uint256 providerFee,uint256 minimumPayout,uint64 expiresAt)',
    'event ListingCancelled(uint256 indexed listingId)',
    'event ListingExpired(uint256 indexed listingId)',
    'event ListingFunded(uint256 indexed listingId,address indexed provider,uint256 claimValue,uint16 systemDiscountBps,uint256 saverPayout,uint256 providerPotentialReturn,uint256 providerFee)',
  ],
  reward: [
    'event VaultRegistered(address indexed vault)',
    'event VaultFunded(address indexed vault,address indexed funder,uint256 amount)',
    'event RewardsActivated(address indexed vault,uint256 memberCount,uint256 rewardEach)',
    'event RewardClaimed(address indexed recipient,uint256 amount)',
    'event ProtocolRevenueReceived(address indexed payer,uint256 indexed epochId,uint256 amount)',
    'event ProtocolGroupRegistered(uint256 indexed epochId,address indexed vault,uint256 weight,uint256 memberCount)',
    'event ProtocolEpochFinalized(uint256 indexed epochId,uint256 revenue,uint256 totalWeight,uint256 groupCount)',
    'event ProtocolGroupAllocated(uint256 indexed epochId,address indexed vault,uint256 grossAllocation,uint256 rewardEach,uint256 distributed)',
    'event ProtocolRevenueRolledForward(uint256 indexed fromEpochId,uint256 indexed toEpochId,uint256 amount)',
  ],
  safety: [
    'event ProtocolPaused(address indexed safetyCouncil)',
    'event UnpauseScheduled(uint64 executableAt)',
    'event ProtocolUnpaused(address indexed executor)',
    'event CapsScheduled(uint256 maxPositionPrincipal,uint256 maxVaultPrincipal,uint256 maxProtocolPrincipal,uint64 executableAt)',
    'event CapsUpdated(uint256 maxPositionPrincipal,uint256 maxVaultPrincipal,uint256 maxProtocolPrincipal)',
    'event ScheduledChangesCancelled()',
    'event VaultRegistered(address indexed vault)',
    'event PrincipalExposureIncreased(address indexed vault,uint256 amount,uint256 vaultOutstanding,uint256 protocolOutstanding)',
    'event PrincipalExposureReduced(address indexed vault,uint256 amount,uint256 vaultOutstanding,uint256 protocolOutstanding)',
  ],
  vault: [
    'event Deposited(uint256 indexed positionId,address indexed member,uint256 amount,uint256 emergencyAmount,uint256 lockedAmount)',
    'event EmergencyWithdrawn(uint256 indexed positionId,address indexed member,uint256 amount)',
    'event LockedWithdrawn(uint256 indexed positionId,address indexed owner,uint256 amount)',
    'event PositionTransferred(uint256 indexed positionId,address indexed previousOwner,address indexed newOwner)',
    'event RewardEligibilityRevoked(uint256 indexed positionId,address indexed member)',
    'event GroupExitRequested(uint256 indexed requestId,uint256 indexed positionId,address indexed requester,uint64 expiresAt)',
    'event GroupExitApproved(uint256 indexed requestId,address indexed approver)',
    'event GroupExitApprovalRevoked(uint256 indexed requestId,address indexed approver)',
    'event GroupExitCancelled(uint256 indexed requestId,address indexed requester)',
    'event GroupExitExpired(uint256 indexed requestId)',
    'event GroupExitAuthorized(uint256 indexed requestId,uint32 requiredApprovals,uint32 completedApprovals,uint64 authorizationExpiresAt)',
    'event GroupExitAuthorizationExpired(uint256 indexed requestId)',
    'event GroupExitCompleted(uint256 indexed requestId,uint256 indexed positionId,address indexed requester,uint256 amount)',
    'event GroupMemberStatusChanged(uint256 indexed positionId,address indexed member,uint8 previousStatus,uint8 newStatus)',
    'event GroupInvitationCreated(address indexed member,uint64 expiresAt)',
    'event GroupInvitationAccepted(address indexed member,uint32 acceptedCount,uint32 requiredCount)',
    'event GroupInvitationDeclined(address indexed member)',
    'event GroupActivated(uint64 activatedAt)',
    'event GroupInvitationExpired(uint64 expiredAt)',
    'event UnactivatedGroupCancelled(address indexed creator)',
  ],
}

export const contractInterfaces: Record<ContractKind, Interface> = {
  factory: new Interface(definitions.factory),
  market: new Interface(definitions.market),
  reward: new Interface(definitions.reward),
  safety: new Interface(definitions.safety),
  vault: new Interface(definitions.vault),
}

export const rewardReadAbi = [
  'function protocolRecipientCount(uint256 epochId,address vault) view returns (uint256)',
  'function protocolRecipientAt(uint256 epochId,address vault,uint256 index) view returns (address)',
] as const

export const vaultReadAbi = [
  'function memberCount() view returns (uint256)',
  'function position(uint256 positionId) view returns (address member,uint256 target,uint256 deposited,uint256 emergencyBalance,uint256 lockedBalance,uint256 lockedShares,uint16 emergencyBps,bool lockedWithdrawn)',
  'function activePrincipalSavings(uint256 positionId) view returns (uint256)',
  'function memberStatus(uint256 positionId) view returns (uint8)',
  'function rewardEligibleCount() view returns (uint256)',
  'function rewardRecipientAt(uint256 eligibleIndex) view returns (address)',
] as const
