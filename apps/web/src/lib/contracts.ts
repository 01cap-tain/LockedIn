import {
  BrowserProvider,
  Contract,
  Interface,
  JsonRpcProvider,
  formatUnits,
  getAddress,
  parseUnits,
  type Filter,
  type Log,
  type Provider,
  type Signer,
} from "ethers";

// Thin client for contract reads and signed transactions. It deliberately
// contains no authoritative pricing or ownership rules: those are enforced by
// Solidity, while this module only prepares inputs and presents chain results.

const factoryAbi = [
  "function PROTOCOL_VERSION() view returns (string)",
  "function deploymentId() view returns (bytes32)",
  "function deploymentChainId() view returns (uint256)",
  "function asset() view returns (address)",
  "function createPersonalVault(uint256 target,uint64 maturity,uint16 emergencyBps,uint8 mode) returns (address)",
  "function createPublicGroupVault(string groupName,uint256 target,uint16 emergencyBps,uint32 maxMembers,uint64 enrollmentDeadline,uint64 maturity,uint8 mode,bool publicJoining) returns (address)",
  "function vaultCount() view returns (uint256)",
  "function vaultAt(uint256 index) view returns (address)",
  "function vaultsOf(address member) view returns (address[])",
  "function isVault(address vault) view returns (bool)",
  "function groupName(address vault) view returns (string)",
  "function earlyExitMarket() view returns (address)",
  "function rewardPool() view returns (address)",
  "function safetyController() view returns (address)",
  "event VaultCreated(address indexed vault,address indexed creator,bool indexed isGroup,uint8 mode,address yieldAdapter,uint64 maturity)",
] as const;

const safetyControllerAbi = [
  "function paused() view returns (bool)",
] as const;

const aaveAdapterAbi = [
  "function reserveStatus() view returns (bool active,bool frozen,bool paused,uint256 supplyCap,uint256 currentSupply,uint256 availableLiquidity)",
] as const;

const vaultAbi = [
  "function createdAt() view returns (uint64)",
  "function asset() view returns (address)",
  "function maturity() view returns (uint64)",
  "function isGroup() view returns (bool)",
  "function mode() view returns (uint8)",
  "function yieldAdapter() view returns (address)",
  "function memberCount() view returns (uint256)",
  "function acceptedMemberCount() view returns (uint32)",
  "function publicJoining() view returns (bool)",
  "function openEnrollment() view returns (bool)",
  "function publicJoinClosed() view returns (bool)",
  "function maxMemberCount() view returns (uint32)",
  "function enrollmentDeadline() view returns (uint64)",
  "function joinPublicGroup(uint256 target,uint16 emergencyBps)",
  "function activateGroup()",
  "function memberAt(uint256 positionId) view returns (address)",
  "function positionOwner(uint256 positionId) view returns (address)",
  "function rewardDisqualified(uint256 positionId) view returns (bool)",
  "function memberStatus(uint256 positionId) view returns (uint8)",
  "function groupCreator() view returns (address)",
  "function groupLifecycle() view returns (uint8)",
  "function positionOf(address member) view returns (uint256)",
  "function position(uint256 positionId) view returns (address member,uint256 target,uint256 deposited,uint256 emergencyBalance,uint256 lockedBalance,uint256 lockedShares,uint16 emergencyBps,bool lockedWithdrawn)",
  "function positionValue(uint256 positionId) view returns (uint256)",
  "function accruedYield(uint256 positionId) view returns (uint256)",
  "function currentLiquidityRate() view returns (uint256)",
  "function goalComplete(uint256 positionId) view returns (bool)",
  "function deposit(uint256 positionId,uint256 amount)",
  "function withdrawEmergency(uint256 positionId,uint256 amount)",
  "function withdrawLocked(uint256 positionId)",
  "function requestGroupExit() returns (uint256)",
  "function approveGroupExit(uint256 requestId)",
  "function authorizeGroupExit(uint256 requestId)",
  "function revokeGroupExitApproval(uint256 requestId)",
  "function cancelGroupExit(uint256 requestId)",
  "function expireGroupExit(uint256 requestId)",
  "function completeGroupExit(uint256 requestId)",
  "function currentGroupExitRequest(uint256 positionId) view returns (uint256)",
  "function groupExitRequests(uint256 requestId) view returns (uint256 positionId,address requester,uint64 createdAt,uint64 expiresAt,uint64 authorizationExpiresAt,uint32 requiredApprovals,uint32 completedApprovals,uint8 status)",
  "function groupExitApproval(uint256 requestId,address member) view returns (bool)",
  "function groupExitApprovalProgress(uint256 requestId) view returns (uint32 required,uint32 completed)",
  "function activeMemberCount() view returns (uint256)",
  "function activePrincipalSavings(uint256 positionId) view returns (uint256)",
  "function groupExitApprovalEligible(uint256 positionId) view returns (bool)",
  "event Deposited(uint256 indexed positionId,address indexed member,uint256 amount,uint256 emergencyAmount,uint256 lockedAmount)",
  "event EmergencyWithdrawn(uint256 indexed positionId,address indexed member,uint256 amount)",
  "event LockedWithdrawn(uint256 indexed positionId,address indexed owner,uint256 amount)",
  "event PositionTransferred(uint256 indexed positionId,address indexed previousOwner,address indexed newOwner)",
  "event RewardEligibilityRevoked(uint256 indexed positionId,address indexed member)",
  "event GroupExitRequested(uint256 indexed requestId,uint256 indexed positionId,address indexed requester,uint64 expiresAt)",
  "event GroupExitApproved(uint256 indexed requestId,address indexed approver)",
  "event GroupExitApprovalRevoked(uint256 indexed requestId,address indexed approver)",
  "event GroupExitCancelled(uint256 indexed requestId,address indexed requester)",
  "event GroupExitExpired(uint256 indexed requestId)",
  "event GroupExitAuthorized(uint256 indexed requestId,uint32 requiredApprovals,uint32 completedApprovals,uint64 authorizationExpiresAt)",
  "event GroupExitAuthorizationExpired(uint256 indexed requestId)",
  "event GroupExitCompleted(uint256 indexed requestId,uint256 indexed positionId,address indexed requester,uint256 amount)",
  "event GroupMemberStatusChanged(uint256 indexed positionId,address indexed member,uint8 previousStatus,uint8 newStatus)",
  "event GroupInvitationCreated(address indexed member,uint64 expiresAt)",
  "event GroupInvitationAccepted(address indexed member,uint32 acceptedCount,uint32 requiredCount)",
  "event GroupInvitationDeclined(address indexed member)",
  "event GroupActivated(uint64 activatedAt)",
  "event GroupInvitationExpired(uint64 expiredAt)",
  "event PublicGroupJoined(address indexed member,uint256 indexed positionId,uint32 memberCount)",
  "event UnactivatedGroupCancelled(address indexed creator)",
] as const;

const tokenAbi = [
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function mint(address recipient,uint256 amount)",
] as const;

const marketAbi = [
  "function activeListing(address vault,uint256 positionId) view returns (uint256)",
  "function nextListingId() view returns (uint256)",
  "function createListing(address vault,uint256 positionId,uint64 expiresAt,uint256 minimumPayout) returns (uint256)",
  "function cancelListing(uint256 listingId)",
  "function fundListing(uint256 listingId)",
  "function listings(uint256 listingId) view returns (address vault,uint256 positionId,address seller,uint256 claimValue,uint16 systemDiscountBps,uint256 saverPayout,uint256 providerPotentialReturn,uint256 providerFee,uint256 minimumPayout,uint64 expiresAt,bool active)",
  "function payoutFor(uint256 claimValue,uint16 discountBps) view returns (uint256)",
  "function feeFor(uint256 saverPayout) view returns (uint256)",
  "function referenceDiscount(address vault,uint256 positionId) view returns ((uint16 discountBps,uint16 remainingTimePenalty,uint16 commitmentPenalty,uint16 liquidityRiskPenalty,uint16 timeWeightedSavingsPenalty,uint16 goalCompletionPenalty,uint16 regularityPenalty,uint16 recencyPenalty))",
  "event ListingCreated(uint256 indexed listingId,address indexed vault,uint256 indexed positionId,address seller,uint256 claimValue,uint16 systemDiscountBps,uint256 saverPayout,uint256 providerPotentialReturn,uint256 providerFee,uint256 minimumPayout,uint64 expiresAt)",
  "event ListingCancelled(uint256 indexed listingId)",
  "event ListingExpired(uint256 indexed listingId)",
  "event ListingFunded(uint256 indexed listingId,address indexed provider,uint256 claimValue,uint16 systemDiscountBps,uint256 saverPayout,uint256 providerPotentialReturn,uint256 providerFee)",
] as const;

const USDT_DECIMALS = 6;
const POLYGON_AMOY_CHAIN_ID = 80_002n;
const AMOY_MIN_PRIORITY_FEE = parseUnits("25", "gwei");
let amoyReadProvider: JsonRpcProvider | undefined;
let amoyReadProviderIndex = 0;

function rpcBatchMaxCount(): number {
  const configured = Number(import.meta.env.VITE_RPC_BATCH_MAX_COUNT ?? "3");
  if (!Number.isFinite(configured)) return 3;
  return Math.min(20, Math.max(1, Math.floor(configured)));
}

const AMOY_READ_FALLBACKS = [
  "https://polygon-amoy.drpc.org",
  "https://polygon-amoy-rpc.blockreq.com/v1/rpc/public",
  "https://polygon-amoy-bor-rpc.publicnode.com",
] as const;

function amoyReadUrls(): string[] {
  return [import.meta.env.VITE_PUBLIC_RPC_URL, ...AMOY_READ_FALLBACKS]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
}

function resetAmoyReadProvider(): void {
  amoyReadProvider?.destroy();
  amoyReadProvider = undefined;
  amoyReadProviderIndex += 1;
}

async function withAmoyReadRetry<T>(
  operation: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean = () => true
): Promise<T> {
  const isAmoy = (import.meta.env.VITE_EVM_CHAIN_ID ?? "").toLowerCase() === "0x13882";
  if (!isAmoy) return operation();

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error) || attempt === 2) break;
      resetAmoyReadProvider();
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * Nimiq Pay remains the signer and transaction submitter. Public Amoy reads
 * use a direct provider so transient failures in the wallet's custom-chain
 * RPC bridge cannot masquerade as signature or contract failures.
 */
function readProviderFor(signer: Signer): Provider {
  if (
    (import.meta.env.VITE_EVM_CHAIN_ID ?? "").toLowerCase() === "0x13882"
  ) {
    const urls = amoyReadUrls();
    const rpcUrl = urls[amoyReadProviderIndex % urls.length];
    amoyReadProvider ??= new JsonRpcProvider(
      rpcUrl,
      Number(POLYGON_AMOY_CHAIN_ID),
      {
        staticNetwork: true,
        // dRPC's public/free endpoint permits at most three requests in one
        // JSON-RPC batch. Ethers otherwise batches every call made in the same
        // event-loop turn and turns healthy contract reads into HTTP 500s.
        batchMaxCount: rpcBatchMaxCount(),
      }
    );
    return amoyReadProvider;
  }
  if (!signer.provider)
    throw new Error("The EVM signer has no readable provider.");
  return signer.provider;
}

function publicReadProvider(preferredProvider?: Provider | null): Provider {
  // Once a wallet is connected, prefer its already-confirmed Amoy provider.
  // This avoids making the discovery catalogue depend on a separate public RPC
  // when the wallet can read the same authoritative contracts directly.
  if (preferredProvider) return preferredProvider;
  const publicRpcUrl =
    import.meta.env.VITE_PUBLIC_RPC_URL ??
    import.meta.env.VITE_HARDHAT_RPC_URL ??
    "https://polygon-amoy.drpc.org";
  if (publicRpcUrl) {
    const configuredChainId = BigInt(import.meta.env.VITE_EVM_CHAIN_ID ?? "0x13882");
    return new JsonRpcProvider(publicRpcUrl, Number(configuredChainId), {
      staticNetwork: true,
      batchMaxCount: rpcBatchMaxCount(),
    });
  }
  if (typeof window !== "undefined" && window.ethereum)
    return new BrowserProvider(window.ethereum);
  throw new Error(
    "Configure VITE_PUBLIC_RPC_URL to read public vaults without a wallet."
  );
}

export interface CreateVaultInput {
  groupMode: "personal" | "group";
  yieldMode: "safe" | "earn";
  target: string;
  maturity: string;
  emergencyPercent: number;
  additionalMembers: string[];
  maxParticipants?: number;
  groupName?: string;
  groupVisibility?: "public" | "invite-only";
  enrollmentDeadline?: string;
}

/**
 * Explains whether the connected immutable factory can serve the current
 * creator-first group flow. Protocol 0.5 can create only a fixed member array;
 * it cannot let invited members choose their own financial terms later.
 */
export function groupCreationUnsupportedReason(
  protocolVersion: string,
  visibility: "public" | "invite-only"
): string | null {
  if (protocolVersion === "lockedin-circle/0.8.0") return null;
  if (visibility === "public") {
    return `Public circles require protocol 0.8.0; the connected factory is ${protocolVersion}.`;
  }
  return `Invite-only creation is blocked on ${protocolVersion}: this factory requires at least four member addresses, targets and emergency allocations at creation. It cannot support invited members choosing their own savings terms later.`;
}

export interface VaultSnapshot {
  address: string;
  signerAddress: string;
  positionId: bigint;
  ownsLockedPosition: boolean;
  isOriginalMember: boolean;
  target: string;
  deposited: string;
  emergencyBalance: string;
  lockedBalance: string;
  lockedShares: string;
  currentValue: string;
  accruedYield: string;
  vaultMode: "safe" | "earn";
  yieldAdapter: string;
  variableApyPercent: number | null;
  aaveSafety: AaveSafetySnapshot | null;
  emergencyPercent: number;
  goalComplete: boolean;
  lockedWithdrawn: boolean;
  createdAt: Date;
  maturity: Date;
  isGroup: boolean;
  groupCreator: string;
  groupName: string;
  publicJoining: boolean;
  openEnrollment: boolean;
  maxMemberCount: number;
  enrollmentDeadline: Date | null;
  circleState: "open" | "ready" | "active" | "matured" | "completed";
  groupLifecycle:
    | "not-applicable"
    | "pending"
    | "active"
    | "declined"
    | "expired"
    | "cancelled";
  invitationExpiresAt: Date | null;
  connectedInvitationAccepted: boolean;
  connectedInvitationDeclined: boolean;
  members: VaultMemberSnapshot[];
}

export interface AaveSafetySnapshot {
  active: boolean;
  frozen: boolean;
  paused: boolean;
  supplyCap: string;
  currentSupply: string;
  availableLiquidity: string;
  withdrawalTemporarilyUnavailable: boolean;
}

export interface DeploymentVerification {
  protocolVersion: string;
  deploymentId: string;
  chainId: bigint;
  asset: string;
  market: string;
  rewardPool: string;
  safetyController: string;
  paused: boolean;
}

export type ExpectedDeployment = Partial<
  Omit<DeploymentVerification, "paused" | "chainId">
> & { chainId?: bigint };

/** Pure comparison used by both connection gating and unit tests. */
export function assertDeploymentMatches(
  actual: Omit<DeploymentVerification, "paused">,
  expected: ExpectedDeployment
): void {
  const mismatch = (label: string, value: string, wanted?: string) => {
    if (wanted && value.toLowerCase() !== wanted.toLowerCase())
      throw new Error(
        `Deployment mismatch: ${label} is ${value}, expected ${wanted}. Contract actions remain disabled.`
      );
  };
  if (expected.chainId !== undefined && actual.chainId !== expected.chainId)
    throw new Error(
      `Deployment mismatch: wallet chain ${actual.chainId} does not match manifest chain ${expected.chainId}.`
    );
  mismatch("protocol version", actual.protocolVersion, expected.protocolVersion);
  mismatch("deployment ID", actual.deploymentId, expected.deploymentId);
  mismatch("asset", actual.asset, expected.asset);
  mismatch("market", actual.market, expected.market);
  mismatch("reward pool", actual.rewardPool, expected.rewardPool);
  mismatch("safety controller", actual.safetyController, expected.safetyController);
}

export interface VaultMemberSnapshot {
  positionId: bigint;
  member: string;
  owner: string;
  target: string;
  deposited: string;
  emergencyBalance: string;
  lockedBalance: string;
  currentValue: string;
  activePrincipal: string;
  approvalProgressPercent: number;
  approvalEligible: boolean;
  invitationAccepted: boolean;
  invitationDeclined: boolean;
  goalComplete: boolean;
  rewardDisqualified: boolean;
  lockedWithdrawn: boolean;
  status: "active" | "cooperative-exit" | "market-exit" | "matured";
}

export interface GroupExitRequestSnapshot {
  id: bigint;
  positionId: bigint;
  requester: string;
  expiresAt: Date;
  authorizationExpiresAt: Date | null;
  currentDeadline: Date;
  requiredApprovals: number;
  completedApprovals: number;
  connectedMemberApproved: boolean;
  status: "pending" | "authorized" | "cancelled" | "expired" | "completed";
}

export interface VaultSummary {
  address: string;
  positionId: bigint;
  access: "owner" | "emergency-only";
  isOriginalMember: boolean;
  isGroup: boolean;
  createdAt: Date;
  maturity: Date;
  memberCount: number;
  target: string;
  deposited: string;
  currentValue: string;
  progressPercent: number;
  expectedProgressPercent: number;
  pace: "on-track" | "behind" | "complete";
  vaultMode: "safe" | "earn";
  legacy: boolean;
}

export interface PublicGroupSummary {
  address: string;
  creator: string;
  groupName: string;
  enrollmentDeadline: Date;
  maturity: Date;
  memberCount: number;
  acceptedMemberCount: number;
  maxMemberCount: number;
  publicJoining: boolean;
  joiningOpen: boolean;
  creatorTarget: string;
  progressPercent: number;
  totalDeposited: string;
  totalTarget: string;
  vaultMode: "safe" | "earn";
  lifecycle: "open" | "ready" | "active" | "matured" | "completed";
  members: Array<{
    address: string;
    positionId: bigint;
    progressPercent: number;
  }>;
}

export interface ReferenceDiscountSnapshot {
  discountPercent: number;
  remainingTimePenalty: number;
  commitmentPenalty: number;
  liquidityRiskPenalty: number;
  timeWeightedSavingsPenalty: number;
  goalCompletionPenalty: number;
  regularityPenalty: number;
  recencyPenalty: number;
}

export interface ExitListingSnapshot {
  marketAddress: string;
  reference: ReferenceDiscountSnapshot;
  listing: null | {
    id: bigint;
    vault: string;
    positionId: bigint;
    isGroup: boolean;
    seller: string;
    claimValue: string;
    currentClaimValue: string;
    systemDiscountPercent: number;
    saverPayout: string;
    currentSaverPayout: string;
    providerPotentialReturn: string;
    currentProviderPotentialReturn: string;
    providerFee: string;
    currentProviderFee: string;
    currentTotalProviderPaid: string;
    minimumPayout: string;
    maturity: Date;
    expiresAt: Date;
    active: boolean;
    status: "active" | "expired" | "cancelled-or-sold";
  };
}

export interface ActivityItem {
  id: string;
  blockNumber: number;
  transactionHash: string;
  title: string;
  detail: string;
  vault?: string;
  member?: string;
  amount?: string;
  timestamp: Date;
}

/** A finalized early-exit settlement reconstructed from canonical market events. */
export interface CompletedTrade {
  listingId: bigint;
  vault: string;
  positionId: bigint;
  isGroup: boolean;
  seller: string;
  provider: string;
  claimValue: string;
  systemDiscountPercent: number;
  saverPayout: string;
  providerPotentialReturn: string;
  providerFee: string;
  totalProviderPaid: string;
  blockNumber: number;
  transactionHash: string;
  timestamp: Date;
}

function factoryAddress(): string {
  const configured = import.meta.env.VITE_FACTORY_ADDRESS;
  if (!configured || /^0x0{40}$/i.test(configured)) {
    throw new Error(
      "Set VITE_FACTORY_ADDRESS to the deployed VaultFactory address."
    );
  }
  return getAddress(configured);
}

interface ClientDeployment {
  deploymentId: string;
  protocolVersion: string;
  factoryAddress: string;
  marketAddress: string;
  deploymentBlock: number;
  legacy: boolean;
}

function configuredDeployments(): ClientDeployment[] {
  try {
    const parsed = JSON.parse(import.meta.env.VITE_DEPLOYMENTS_JSON ?? "[]") as ClientDeployment[];
    if (parsed.length > 0) return parsed.map((entry) => ({
      ...entry,
      factoryAddress: getAddress(entry.factoryAddress),
      marketAddress: getAddress(entry.marketAddress),
    }));
  } catch {
    // A malformed optional registry must not weaken active-deployment checks.
  }
  return [{
    deploymentId: import.meta.env.VITE_EXPECTED_DEPLOYMENT_ID ?? "",
    protocolVersion: import.meta.env.VITE_EXPECTED_PROTOCOL_VERSION ?? "",
    factoryAddress: factoryAddress(),
    marketAddress: import.meta.env.VITE_EXPECTED_MARKET_ADDRESS ?? "",
    deploymentBlock: Number(import.meta.env.VITE_CONTRACT_START_BLOCK ?? 0),
    legacy: false,
  }];
}

async function deploymentForVault(provider: Provider, vaultAddress: string): Promise<ClientDeployment> {
  for (const deployment of configuredDeployments()) {
    const factory = new Contract(deployment.factoryAddress, factoryAbi, provider);
    try {
      if (await factory.getFunction("isVault")(vaultAddress)) return deployment;
    } catch {
      // Continue through historic deployments when one RPC read is unavailable.
    }
  }
  throw new Error("This vault is not registered by any configured LockedIn deployment.");
}

function factoryFor(signer: Signer): Contract {
  return new Contract(factoryAddress(), factoryAbi, signer);
}

async function assertFactoryDeployment(signer: Signer): Promise<void> {
  // Calling an ABI against an address with no bytecode produces the confusing
  // `could not decode result data` error. Fail early with an actionable message.
  const provider = readProviderFor(signer);
  if ((await provider.getCode(factoryAddress())) === "0x") {
    throw new Error(
      "No VaultFactory contract exists at the configured address on this network. Redeploy it and restart the app."
    );
  }
}

/**
 * Verifies the wallet against the versioned deployment manifest before the UI
 * enables writes. This prevents a valid-looking address on the wrong chain, or
 * a mixed set of contracts, from being treated as the intended protocol.
 */
async function verifyDeploymentOnce(
  signer: Signer
): Promise<DeploymentVerification> {
  await assertFactoryDeployment(signer);
  const provider = readProviderFor(signer);
  const factory = new Contract(factoryAddress(), factoryAbi, provider);
  const network = await provider.getNetwork();
  // These calls use the direct read provider, not the wallet bridge. Parallel
  // reads keep mobile verification short while ethers batches compatible RPCs.
  const [protocolVersion, deploymentId, chainId, asset, market, rewardPool, safetyController] =
    await Promise.all([
      factory.getFunction("PROTOCOL_VERSION")(),
      factory.getFunction("deploymentId")(),
      factory.getFunction("deploymentChainId")(),
      factory.getFunction("asset")(),
      factory.getFunction("earlyExitMarket")(),
      factory.getFunction("rewardPool")(),
      factory.getFunction("safetyController")(),
    ]);
  const expected = {
    chainId: import.meta.env.VITE_EXPECTED_CHAIN_ID,
    protocolVersion: import.meta.env.VITE_EXPECTED_PROTOCOL_VERSION,
    deploymentId: import.meta.env.VITE_EXPECTED_DEPLOYMENT_ID,
    asset: import.meta.env.VITE_EXPECTED_ASSET_ADDRESS,
    market: import.meta.env.VITE_EXPECTED_MARKET_ADDRESS,
    rewardPool: import.meta.env.VITE_EXPECTED_REWARD_POOL_ADDRESS,
    safetyController: import.meta.env.VITE_EXPECTED_SAFETY_CONTROLLER_ADDRESS,
  };
  if (network.chainId !== BigInt(chainId))
    throw new Error(`Deployment mismatch: wallet chain ${network.chainId} does not match factory chain ${chainId}.`);
  assertDeploymentMatches(
    {
      protocolVersion: String(protocolVersion),
      deploymentId: String(deploymentId),
      chainId: network.chainId,
      asset: String(asset),
      market: String(market),
      rewardPool: String(rewardPool),
      safetyController: String(safetyController),
    },
    {
      chainId: expected.chainId ? BigInt(expected.chainId) : undefined,
      protocolVersion: expected.protocolVersion,
      deploymentId: expected.deploymentId,
      asset: expected.asset,
      market: expected.market,
      rewardPool: expected.rewardPool,
      safetyController: expected.safetyController,
    }
  );
  const linkedContracts = [["asset", asset], ["market", market], ["reward pool", rewardPool], ["safety controller", safetyController]] as const;
  const linkedCode = await Promise.all(
    linkedContracts.map(([, address]) => provider.getCode(String(address)))
  );
  linkedContracts.forEach(([label], index) => {
    if (linkedCode[index] === "0x")
      throw new Error(`Deployment mismatch: ${label} has no contract bytecode.`);
  });
  const safety = new Contract(String(safetyController), safetyControllerAbi, provider);
  return {
    protocolVersion: String(protocolVersion),
    deploymentId: String(deploymentId),
    chainId: BigInt(chainId),
    asset: getAddress(String(asset)),
    market: getAddress(String(market)),
    rewardPool: getAddress(String(rewardPool)),
    safetyController: getAddress(String(safetyController)),
    paused: Boolean(await safety.getFunction("paused")()),
  };
}

export async function verifyDeployment(
  signer: Signer
): Promise<DeploymentVerification> {
  return withAmoyReadRetry(
    () => verifyDeploymentOnce(signer),
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      // A genuine identity mismatch is deterministic and must never be hidden
      // behind retries intended only for temporary RPC transport failures.
      return !message.includes("Deployment mismatch");
    }
  );
}

async function marketFor(signer: Signer): Promise<Contract> {
  const readProvider = readProviderFor(signer);
  const readFactory = new Contract(factoryAddress(), factoryAbi, readProvider);
  const address = await readFactory.getFunction("earlyExitMarket")();
  return new Contract(address, marketAbi, signer);
}

async function marketReaderFor(signer: Signer): Promise<Contract> {
  const readProvider = readProviderFor(signer);
  const readFactory = new Contract(factoryAddress(), factoryAbi, readProvider);
  const address = await readFactory.getFunction("earlyExitMarket")();
  return new Contract(address, marketAbi, readProvider);
}

function amount(value: string): bigint {
  const parsed = parseUnits(value, USDT_DECIMALS);
  if (parsed <= 0n) throw new Error("Amount must be greater than zero.");
  return parsed;
}

function memberStatusLabel(status: bigint): VaultMemberSnapshot["status"] {
  if (status === 1n) return "cooperative-exit";
  if (status === 2n) return "market-exit";
  if (status === 3n) return "matured";
  return "active";
}

function groupLifecycleLabel(
  lifecycle: bigint
): VaultSnapshot["groupLifecycle"] {
  if (lifecycle === 1n) return "pending";
  if (lifecycle === 2n) return "active";
  if (lifecycle === 3n) return "declined";
  if (lifecycle === 4n) return "expired";
  if (lifecycle === 5n) return "cancelled";
  return "not-applicable";
}

function derivedCircleState(input: {
  lifecycle: bigint;
  acceptedMembers: number;
  maturity: bigint;
  allLockedWithdrawn?: boolean;
}): VaultSnapshot["circleState"] {
  if (BigInt(Math.floor(Date.now() / 1_000)) >= input.maturity)
    return input.allLockedWithdrawn ? "completed" : "matured";
  if (input.lifecycle === 2n) return "active";
  if (input.acceptedMembers >= 4) return "ready";
  return "open";
}

function groupExitStatusLabel(
  status: bigint,
  expiresAt: Date,
  authorizationExpiresAt: Date | null
): GroupExitRequestSnapshot["status"] {
  if (status === 2n)
    return authorizationExpiresAt && authorizationExpiresAt.getTime() <= Date.now()
      ? "expired"
      : "authorized";
  if (status === 3n) return "cancelled";
  if (status === 4n || (status === 1n && expiresAt.getTime() <= Date.now()))
    return "expired";
  if (status === 5n) return "completed";
  return "pending";
}

/**
 * Amoy validators currently reject the low priority fee returned by some RPC
 * providers. Use the chain's enforced floor and derive a max fee from the live
 * base fee. Other networks keep their wallet/provider-selected fee policy.
 */
async function transactionOverrides(
  signer: Signer
): Promise<Record<string, bigint>> {
  return withAmoyReadRetry<Record<string, bigint>>(async () => {
    const provider = readProviderFor(signer);
    const network = await provider.getNetwork();
    if (network.chainId !== POLYGON_AMOY_CHAIN_ID)
      return {} as Record<string, bigint>;

    const [feeData, latestBlock] = await Promise.all([
      provider.getFeeData(),
      provider.getBlock("latest"),
    ]);
    const reportedPriority = feeData.maxPriorityFeePerGas ?? 0n;
    const maxPriorityFeePerGas =
      reportedPriority > AMOY_MIN_PRIORITY_FEE
        ? reportedPriority
        : AMOY_MIN_PRIORITY_FEE;
    const baseFee = latestBlock?.baseFeePerGas ?? feeData.gasPrice ?? 0n;
    const calculatedMaxFee = baseFee * 2n + maxPriorityFeePerGas;
    const reportedMaxFee = feeData.maxFeePerGas ?? 0n;

    return {
      maxPriorityFeePerGas,
      maxFeePerGas:
        reportedMaxFee > calculatedMaxFee ? reportedMaxFee : calculatedMaxFee,
    };
  });
}

export async function loadNativeGasStatus(
  signer: Signer,
  address: string
): Promise<{ balance: bigint; requiredReserve: bigint }> {
  return withAmoyReadRetry(async () => {
    const provider = readProviderFor(signer);
    const [balance, feeData] = await Promise.all([
      provider.getBalance(address),
      provider.getFeeData(),
    ]);
    const feePerGas =
      feeData.maxFeePerGas ?? feeData.gasPrice ?? AMOY_MIN_PRIORITY_FEE;
    return { balance, requiredReserve: feePerGas * 1_500_000n };
  });
}

/**
 * Waits for a wallet-submitted transaction through the independent read RPC.
 * Nimiq Pay remains the signer/submission provider, but its custom-chain bridge
 * must not turn a confirmed transaction into a UI failure when receipt polling
 * is rate-limited.
 */
async function confirmTransaction(signer: Signer, hash: string) {
  const receipt = await withAmoyReadRetry(() =>
    readProviderFor(signer).waitForTransaction(hash, 1, 60_000)
  );
  if (!receipt)
    throw new Error(
      `Transaction ${hash} was submitted but confirmation timed out. Check it on PolygonScan before retrying.`
    );
  if (receipt.status !== 1)
    throw new Error(`Transaction ${hash} reverted on Polygon Amoy.`);
  return receipt;
}

export async function createVault(
  signer: Signer,
  input: CreateVaultInput
): Promise<string> {
  await assertFactoryDeployment(signer);
  const factory = factoryFor(signer);
  const target = amount(input.target);
  const maturity = BigInt(
    Math.floor(new Date(input.maturity).getTime() / 1_000)
  );
  if (maturity <= BigInt(Math.floor(Date.now() / 1_000)))
    throw new Error("Maturity must be in the future.");
  const emergencyBps = input.emergencyPercent * 100;
  const yieldMode = input.yieldMode === "earn" ? 1 : 0;
  const memberCount = 1;
  // Nimiq Pay's custom-chain bridge intermittently fails `eth_estimateGas` on
  // Amoy. These limits use measured deployment costs plus
  // a 25% margin; unused gas is not charged. The per-member component keeps
  // large groups within a realistic bound without granting unlimited gas.
  const measuredBaseGas = input.yieldMode === "earn" ? 4_850_000n : 4_200_000n;
  const measuredMemberGas = 210_000n * BigInt(memberCount - 1);
  const gasLimit = ((measuredBaseGas + measuredMemberGas) * 125n) / 100n;
  const overrides = { ...(await transactionOverrides(signer)), gasLimit };

  let transaction;

  if (input.groupMode === "personal") {
    transaction = await factory.getFunction("createPersonalVault")(
      target,
      maturity,
      emergencyBps,
      yieldMode,
      overrides
    );
  } else {
    const protocolVersion = String(
      await factory.getFunction("PROTOCOL_VERSION")()
    );
    const unsupportedReason = groupCreationUnsupportedReason(
      protocolVersion,
      input.groupVisibility ?? "invite-only"
    );
    if (unsupportedReason) throw new Error(unsupportedReason);
    const maxParticipants = input.maxParticipants ?? 4;
    if (!Number.isInteger(maxParticipants) || maxParticipants < 4 || maxParticipants > 50)
      throw new Error("Public group capacity must be between 4 and 50 participants.");
    const groupName = input.groupName?.trim() ?? "";
    if (!groupName) throw new Error("Group name is required.");
    const enrollmentDeadline = BigInt(
      Math.floor(new Date(input.enrollmentDeadline ?? "").getTime() / 1_000)
    );
    if (enrollmentDeadline <= BigInt(Math.floor(Date.now() / 1_000)) || enrollmentDeadline >= maturity)
      throw new Error("Enrollment must close after today and before maturity.");
    transaction = await factory.getFunction("createPublicGroupVault")(
      groupName,
      target,
      emergencyBps,
      maxParticipants,
      enrollmentDeadline,
      maturity,
      yieldMode,
      input.groupVisibility !== "invite-only",
      overrides
    );
  }

  const receipt = await confirmTransaction(signer, transaction.hash);
  for (const log of receipt.logs) {
    const event = parsedEvent(log, factoryAbi);
    if (event?.name === "VaultCreated")
      return getAddress(String(event.args.vault));
  }
  throw new Error(
    `Vault transaction ${receipt.hash} confirmed, but its VaultCreated event could not be decoded.`
  );
}

export async function joinPublicGroup(
  signer: Signer,
  vaultAddress: string,
  targetValue: string,
  emergencyPercent: number
): Promise<bigint> {
  const vault = new Contract(getAddress(vaultAddress), vaultAbi, signer);
  const transaction = await vault.getFunction("joinPublicGroup")(
    amount(targetValue),
    emergencyPercent * 100,
    {
    ...(await transactionOverrides(signer)),
    gasLimit: 450_000n,
    }
  );
  const receipt = await confirmTransaction(signer, transaction.hash);
  for (const log of receipt.logs) {
    const event = parsedEvent(log, vaultAbi);
    if (event?.name === "PublicGroupJoined") return BigInt(event.args.positionId);
  }
  throw new Error("The join transaction confirmed, but the new position could not be identified.");
}

export async function activateGroup(
  signer: Signer,
  vaultAddress: string
): Promise<void> {
  const vault = new Contract(getAddress(vaultAddress), vaultAbi, signer);
  const transaction = await vault.getFunction("activateGroup")({
    ...(await transactionOverrides(signer)),
    gasLimit: 300_000n,
  });
  await confirmTransaction(signer, transaction.hash);
}

export async function loadVault(
  signer: Signer,
  address: string,
  requestedPositionId?: bigint
): Promise<VaultSnapshot> {
  return withAmoyReadRetry(() => loadVaultOnce(signer, address, requestedPositionId));
}

async function loadVaultOnce(
  signer: Signer,
  address: string,
  requestedPositionId?: bigint
): Promise<VaultSnapshot> {
  const signerAddress = await signer.getAddress();
  const vaultAddress = getAddress(address);
  const readProvider = readProviderFor(signer);
  const vault = new Contract(vaultAddress, vaultAbi, readProvider);
  const deployment = await deploymentForVault(readProvider, vaultAddress);
  const factory = new Contract(deployment.factoryAddress, factoryAbi, readProvider);
  const protocolVersion = deployment.protocolVersion;
  const supportsPublicJoining = protocolVersion !== "lockedin-circle/0.5.0";
  const supportsEnrollment = protocolVersion === "lockedin-circle/0.8.0";
  const memberCount: bigint = await vault.getFunction("memberCount")();
  let positionId = requestedPositionId;
  if (positionId === undefined) {
    // Prefer the caller's immutable member record (which may retain emergency
    // funds after a sale), then fall back to a position acquired in the market.
    try {
      positionId = await vault.getFunction("positionOf")(signerAddress);
    } catch {
      for (let index = 0n; index < memberCount; index += 1n) {
        const owner: string = await vault.getFunction("positionOwner")(index);
        if (owner.toLowerCase() === signerAddress.toLowerCase()) {
          positionId = index;
          break;
        }
      }
    }
  }
  if (positionId === undefined)
    throw new Error("This wallet has no accessible position in the vault.");
  const [
    stored,
    positionOwner,
    completed,
    createdAt,
    maturity,
    isGroup,
    mode,
    yieldAdapter,
    currentValue,
    accruedYield,
    liquidityRate,
    groupCreator,
    groupLifecycle,
    groupName,
    acceptedMemberCount,
    publicJoining,
    openEnrollment,
    maxMemberCount,
    enrollmentDeadline,
  ] = await Promise.all([
    vault.getFunction("position")(positionId),
    vault.getFunction("positionOwner")(positionId),
    vault.getFunction("goalComplete")(positionId),
    vault.getFunction("createdAt")(),
    vault.getFunction("maturity")(),
    vault.getFunction("isGroup")(),
    vault.getFunction("mode")(),
    vault.getFunction("yieldAdapter")(),
    vault.getFunction("positionValue")(positionId),
    vault.getFunction("accruedYield")(positionId),
    vault.getFunction("currentLiquidityRate")(),
    vault.getFunction("groupCreator")(),
    vault.getFunction("groupLifecycle")(),
    supportsEnrollment ? factory.getFunction("groupName")(vaultAddress) : "",
    vault.getFunction("acceptedMemberCount")(),
    supportsPublicJoining ? vault.getFunction("publicJoining")() : false,
    supportsEnrollment
      ? vault.getFunction("openEnrollment")()
      : supportsPublicJoining
        ? vault.getFunction("publicJoinClosed")().then((closed: boolean) => !closed)
        : false,
    supportsPublicJoining ? vault.getFunction("maxMemberCount")() : memberCount,
    supportsEnrollment ? vault.getFunction("enrollmentDeadline")() : 0n,
  ]);
  const members: VaultMemberSnapshot[] = await Promise.all(
    Array.from({ length: Number(memberCount) }, async (_, index) => {
      const memberPosition = await vault.getFunction("position")(index);
      const [
        owner,
        memberComplete,
        rewardDisqualified,
        status,
        activePrincipal,
        approvalEligible,
      ] =
        await Promise.all([
          vault.getFunction("positionOwner")(index),
          vault.getFunction("goalComplete")(index),
          vault.getFunction("rewardDisqualified")(index),
          vault.getFunction("memberStatus")(index),
          vault.getFunction("activePrincipalSavings")(index),
          vault.getFunction("groupExitApprovalEligible")(index),
        ]);
      const memberValue: bigint = await vault.getFunction("positionValue")(
        index
      );
      return {
        positionId: BigInt(index),
        member: getAddress(memberPosition.member),
        owner: getAddress(owner),
        target: formatUnits(memberPosition.target, USDT_DECIMALS),
        deposited: formatUnits(memberPosition.deposited, USDT_DECIMALS),
        emergencyBalance: formatUnits(
          memberPosition.emergencyBalance,
          USDT_DECIMALS
        ),
        lockedBalance: formatUnits(memberPosition.lockedBalance, USDT_DECIMALS),
        currentValue: formatUnits(memberValue, USDT_DECIMALS),
        activePrincipal: formatUnits(activePrincipal, USDT_DECIMALS),
        approvalProgressPercent:
          Number(memberPosition.target) === 0
            ? 0
            : (Number(activePrincipal) / Number(memberPosition.target)) * 100,
        approvalEligible,
        invitationAccepted: true,
        invitationDeclined: false,
        goalComplete: memberComplete,
        rewardDisqualified,
        lockedWithdrawn: memberPosition.lockedWithdrawn,
        status: memberStatusLabel(status),
      };
    })
  );
  let aaveSafety: AaveSafetySnapshot | null = null;
  if (
    Number(mode) === 1 &&
    import.meta.env.VITE_YIELD_ADAPTER_KIND !== "MockYieldAdapter"
  ) {
    try {
      const adapter = new Contract(
        String(yieldAdapter),
        aaveAdapterAbi,
        readProvider
      );
      const reserve = await adapter.getFunction("reserveStatus")();
      const availableLiquidity = BigInt(reserve.availableLiquidity);
      aaveSafety = {
        active: Boolean(reserve.active),
        frozen: Boolean(reserve.frozen),
        paused: Boolean(reserve.paused),
        supplyCap: BigInt(reserve.supplyCap).toString(),
        currentSupply: formatUnits(reserve.currentSupply, USDT_DECIMALS),
        availableLiquidity: formatUnits(availableLiquidity, USDT_DECIMALS),
        withdrawalTemporarilyUnavailable:
          !reserve.active ||
          reserve.paused ||
          availableLiquidity < BigInt(currentValue),
      };
    } catch {
      // A mock adapter intentionally does not pretend to expose Aave reserve
      // health. Unknown live status stays explicit rather than being shown safe.
      aaveSafety = null;
    }
  }
  return {
    address: vaultAddress,
    signerAddress,
    positionId,
    ownsLockedPosition:
      String(positionOwner).toLowerCase() === signerAddress.toLowerCase(),
    isOriginalMember:
      String(stored.member).toLowerCase() === signerAddress.toLowerCase(),
    target: formatUnits(stored.target, USDT_DECIMALS),
    deposited: formatUnits(stored.deposited, USDT_DECIMALS),
    emergencyBalance: formatUnits(stored.emergencyBalance, USDT_DECIMALS),
    lockedBalance: formatUnits(stored.lockedBalance, USDT_DECIMALS),
    lockedShares: stored.lockedShares.toString(),
    currentValue: formatUnits(currentValue, USDT_DECIMALS),
    accruedYield: formatUnits(accruedYield, USDT_DECIMALS),
    vaultMode: Number(mode) === 1 ? "earn" : "safe",
    yieldAdapter: getAddress(yieldAdapter),
    variableApyPercent: Number(mode) === 1 ? rayRateToApy(liquidityRate) : null,
    aaveSafety,
    emergencyPercent: Number(stored.emergencyBps) / 100,
    goalComplete: completed,
    lockedWithdrawn: stored.lockedWithdrawn,
    createdAt: new Date(Number(createdAt) * 1_000),
    maturity: new Date(Number(maturity) * 1_000),
    isGroup,
    groupCreator: getAddress(groupCreator),
    groupName: String(groupName),
    publicJoining: Boolean(publicJoining),
    openEnrollment: Boolean(openEnrollment),
    maxMemberCount: Number(maxMemberCount),
    enrollmentDeadline: Number(enrollmentDeadline) === 0
      ? null
      : new Date(Number(enrollmentDeadline) * 1_000),
    circleState: derivedCircleState({
      lifecycle: BigInt(groupLifecycle),
      acceptedMembers: Number(acceptedMemberCount),
      maturity: BigInt(maturity),
      allLockedWithdrawn: members.every((member) => member.lockedWithdrawn || Number(member.lockedBalance) === 0),
    }),
    groupLifecycle: groupLifecycleLabel(groupLifecycle),
    invitationExpiresAt: null,
    connectedInvitationAccepted: true,
    connectedInvitationDeclined: false,
    members,
  };
}

export async function loadVaultsForSigner(
  signer: Signer,
  knownCompletedTrades?: CompletedTrade[]
): Promise<VaultSummary[]> {
  return withAmoyReadRetry(() => loadVaultsForSignerOnce(signer, knownCompletedTrades));
}

async function loadVaultsForSignerOnce(
  signer: Signer,
  knownCompletedTrades?: CompletedTrade[]
): Promise<VaultSummary[]> {
  // Original membership and current economic ownership are different after a
  // market sale. Join the factory member index with funded trades so the saver
  // keeps only emergency access while the provider discovers the bought claim.
  await assertFactoryDeployment(signer);
  const readProvider = readProviderFor(signer);
  const signerAddress = await signer.getAddress();
  const memberDeployments = await Promise.all(configuredDeployments().map(async (deployment) => {
    const factory = new Contract(deployment.factoryAddress, factoryAbi, readProvider);
    const addresses: string[] = await factory.getFunction("vaultsOf")(signerAddress);
    return addresses.map((address) => ({ address: getAddress(address), deployment }));
  }));
  const memberAddresses = memberDeployments.flat();
  const memberPositions = await Promise.all(
    memberAddresses.map(async ({ address, deployment }) => ({
      address,
      positionId: BigInt(
        await new Contract(address, vaultAbi, readProvider).getFunction("positionOf")(
          signerAddress
        )
      ),
      deployment,
    }))
  );
  let completedTrades: CompletedTrade[] = knownCompletedTrades ?? [];
  if (knownCompletedTrades === undefined) {
    try {
      completedTrades = await loadCompletedTrades(signer);
    } catch {
      // Original member vault discovery remains usable if historical log reads
      // are temporarily unavailable. A later refresh restores bought positions.
    }
  }
  const purchasedPositions = await Promise.all(
    completedTrades
      .filter((trade) => trade.provider.toLowerCase() === signerAddress.toLowerCase())
      .map(async (trade) => ({
        address: trade.vault,
        positionId: trade.positionId,
        deployment: await deploymentForVault(readProvider, trade.vault),
      }))
  );
  const candidates = new Map<string, { address: string; positionId: bigint; deployment: ClientDeployment }>();
  for (const candidate of [...memberPositions, ...purchasedPositions]) {
    candidates.set(
      `${candidate.address.toLowerCase()}-${candidate.positionId.toString()}`,
      candidate
    );
  }

  const summaries = await Promise.all(
    [...candidates.values()].map(async ({ address, positionId, deployment }) => {
      const vault = new Contract(address, vaultAbi, readProvider);
      const [isGroup, maturity, createdAt, memberCount, mode, stored, owner, currentValue] = await Promise.all([
        vault.getFunction("isGroup")(),
        vault.getFunction("maturity")(),
        vault.getFunction("createdAt")(),
        vault.getFunction("memberCount")(),
        vault.getFunction("mode")(),
        vault.getFunction("position")(positionId),
        vault.getFunction("positionOwner")(positionId),
        vault.getFunction("positionValue")(positionId),
      ]);
      const ownsPosition = String(owner).toLowerCase() === signerAddress.toLowerCase();
      const hasOwnedClaim = ownsPosition && !stored.lockedWithdrawn;
      const isOriginalMember =
        String(stored.member).toLowerCase() === signerAddress.toLowerCase();
      const hasEmergency = BigInt(stored.emergencyBalance) > 0n;
      if (!hasOwnedClaim && (!isOriginalMember || !hasEmergency)) return null;
      const target = BigInt(stored.target);
      const deposited = BigInt(stored.deposited);
      const progressBps = target === 0n ? 0n : (deposited * 10_000n) / target;
      const nowSeconds = BigInt(Math.floor(Date.now() / 1_000));
      const duration = BigInt(maturity) - BigInt(createdAt);
      const elapsed = nowSeconds <= BigInt(createdAt)
        ? 0n
        : nowSeconds >= BigInt(maturity)
          ? duration
          : nowSeconds - BigInt(createdAt);
      const expectedBps = duration <= 0n ? 10_000n : (elapsed * 10_000n) / duration;
      const progressPercent = Math.min(100, Number(progressBps) / 100);
      const expectedProgressPercent = Math.min(100, Number(expectedBps) / 100);
      return {
        address: getAddress(address),
        positionId,
        access: hasOwnedClaim ? ("owner" as const) : ("emergency-only" as const),
        isOriginalMember,
        isGroup,
        createdAt: new Date(Number(createdAt) * 1_000),
        maturity: new Date(Number(maturity) * 1_000),
        memberCount: Number(memberCount),
        target: formatUnits(target, USDT_DECIMALS),
        deposited: formatUnits(deposited, USDT_DECIMALS),
        currentValue: formatUnits(currentValue, USDT_DECIMALS),
        progressPercent,
        expectedProgressPercent,
        pace: progressPercent >= 100
          ? ("complete" as const)
          : progressPercent + 2 >= expectedProgressPercent
            ? ("on-track" as const)
            : ("behind" as const),
        vaultMode: Number(mode) === 1 ? ("earn" as const) : ("safe" as const),
        legacy: deployment.legacy,
      };
    })
  );
  return summaries.filter((summary): summary is VaultSummary => summary !== null);
}

/**
 * Reads group circles from the factory without asking for wallet access.
 * Protocol 0.7 circles expose immutable shared metadata and keep enrollment
 * separate from deposits. Older deployments are not presented as joinable.
 */
export async function loadPublicGroups(
  preferredProvider?: Provider | null
): Promise<PublicGroupSummary[]> {
  const provider = publicReadProvider(preferredProvider);
  const factory = new Contract(factoryAddress(), factoryAbi, provider);
  const read = async <T,>(operation: () => Promise<T>): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 220 * (attempt + 1)));
      }
    }
    throw lastError;
  };
  const [countValue, protocolVersion] = await Promise.all([
    read(() => factory.getFunction("vaultCount")()),
    read(() => factory.getFunction("PROTOCOL_VERSION")()),
  ]);
  const count = BigInt(countValue);
  const supportsPublicJoining = String(protocolVersion) === "lockedin-circle/0.8.0";
  // Factory address reads are independent. Resolve them concurrently so the
  // discovery screen does not wait on one RPC round trip per historic vault.
  const addresses = await Promise.all(
    Array.from({ length: Number(count) }, (_, index) =>
      read(() => factory.getFunction("vaultAt")(index)).then((address: string) => getAddress(address))
    )
  );

  const groups = await Promise.all(
    addresses.map(async (address) => {
      const vault = new Contract(address, vaultAbi, provider);
      const isGroup = Boolean(await read(() => vault.getFunction("isGroup")()));
      if (!isGroup) return null;
      const [creator, maturity, mode, memberCount, acceptedCount, lifecycle] =
        await Promise.all([
          read(() => vault.getFunction("groupCreator")()),
          read(() => vault.getFunction("maturity")()),
          read(() => vault.getFunction("mode")()),
          read(() => vault.getFunction("memberCount")()),
          read(() => vault.getFunction("acceptedMemberCount")()),
          read(() => vault.getFunction("groupLifecycle")()),
        ]);

      // A factory can retain immutable vaults created by an earlier vault
      // implementation. Probe optional 0.8 metadata per vault so one legacy
      // circle cannot blank the entire discovery catalogue.
      const optionalRead = async <T,>(read: () => Promise<T>, fallback: T) => {
        if (!supportsPublicJoining) return fallback;
        try {
          return await read();
        } catch {
          return fallback;
        }
      };
      const [publicJoining, publicJoinClosed, maxMemberCount, groupName, enrollmentDeadline] =
        await Promise.all([
          optionalRead(() => vault.getFunction("publicJoining")(), false),
          optionalRead(() => vault.getFunction("publicJoinClosed")(), true),
          optionalRead(() => vault.getFunction("maxMemberCount")(), BigInt(memberCount)),
          optionalRead(() => factory.getFunction("groupName")(address), ""),
          optionalRead(() => vault.getFunction("enrollmentDeadline")(), BigInt(maturity)),
        ]);
      const members = await Promise.all(
        Array.from({ length: Number(memberCount) }, async (_, index) => {
          const stored = await read(() => vault.getFunction("position")(index));
          const target = BigInt(stored.target);
          const deposited = BigInt(stored.deposited);
          return {
            address: getAddress(stored.member),
            positionId: BigInt(index),
            target,
            deposited,
            lockedWithdrawn: Boolean(stored.lockedWithdrawn),
            progressPercent:
              target === 0n
                ? 0
                : Math.min(100, Number((deposited * 10_000n) / target) / 100),
          };
        })
      );
      const totalTarget = members.reduce((sum, member) => sum + member.target, 0n);
      const totalDeposited = members.reduce(
        (sum, member) => sum + member.deposited,
        0n
      );
      const circleState = derivedCircleState({
        lifecycle: BigInt(lifecycle),
        acceptedMembers: Number(acceptedCount),
        maturity: BigInt(maturity),
        allLockedWithdrawn: members.every((member) => member.lockedWithdrawn || member.deposited === 0n),
      });
      return {
        address,
        creator: getAddress(creator),
        groupName: String(groupName),
        enrollmentDeadline: new Date(Number(enrollmentDeadline) * 1_000),
        maturity: new Date(Number(maturity) * 1_000),
        memberCount: Number(memberCount),
        acceptedMemberCount: Number(acceptedCount),
        maxMemberCount: publicJoining
          ? Number(maxMemberCount)
          : Number(memberCount),
        publicJoining,
        joiningOpen:
          publicJoining &&
          !publicJoinClosed &&
          (circleState === "open" || circleState === "ready") &&
          Number(memberCount) < Number(maxMemberCount) &&
          Date.now() < Number(enrollmentDeadline) * 1_000,
        creatorTarget: formatUnits(
          members[0]?.target ?? 0n,
          USDT_DECIMALS
        ),
        progressPercent:
          totalTarget === 0n
            ? 0
            : Math.min(100, Number((totalDeposited * 10_000n) / totalTarget) / 100),
        totalDeposited: formatUnits(totalDeposited, USDT_DECIMALS),
        totalTarget: formatUnits(totalTarget, USDT_DECIMALS),
        vaultMode: Number(mode) === 1 ? "earn" : "safe",
        lifecycle: circleState,
        members: members.map((member) => ({
          address: member.address,
          positionId: member.positionId,
          progressPercent: member.progressPercent,
        })),
      } satisfies PublicGroupSummary;
    })
  );
  return groups
    // Discovery includes public and invite-only circles. Visibility controls
    // enrollment permission; it should not hide the circle itself.
    .filter((group): group is PublicGroupSummary => group !== null)
    .sort((left, right) => right.maturity.getTime() - left.maturity.getTime());
}

export async function depositToVault(
  signer: Signer,
  vaultAddress: string,
  positionId: bigint,
  value: string
): Promise<void> {
  const vault = new Contract(getAddress(vaultAddress), vaultAbi, signer);
  const readVault = new Contract(
    getAddress(vaultAddress),
    vaultAbi,
    readProviderFor(signer)
  );
  const token = new Contract(
    await readVault.getFunction("asset")(),
    tokenAbi,
    signer
  );
  const parsed = amount(value);
  const vaultAddressResolved = await vault.getAddress();
  const owner = await signer.getAddress();
  const tokenAddress = await token.getAddress();
  const allowance = BigInt(await withAmoyReadRetry(() => {
    const readToken = new Contract(tokenAddress, tokenAbi, readProviderFor(signer));
    return readToken.getFunction("allowance")(owner, vaultAddressResolved);
  }));
  if (allowance < parsed) {
    const approval = await token.getFunction("approve")(
      vaultAddressResolved,
      parsed,
      await transactionOverrides(signer)
    );
    await confirmTransaction(signer, approval.hash);
  }
  const deposit = await vault.getFunction("deposit")(
    positionId,
    parsed,
    await transactionOverrides(signer)
  );
  await confirmTransaction(signer, deposit.hash);
}

export async function loadMockUsdtBalance(signer: Signer): Promise<string> {
  const readProvider = readProviderFor(signer);
  const readFactory = new Contract(factoryAddress(), factoryAbi, readProvider);
  const token = new Contract(
    await readFactory.getFunction("asset")(),
    tokenAbi,
    readProvider
  );
  const [symbol, decimals, balance] = await Promise.all([
    token.getFunction("symbol")(),
    token.getFunction("decimals")(),
    token.getFunction("balanceOf")(await signer.getAddress()),
  ]);
  if (symbol !== "mUSDT" || Number(decimals) !== USDT_DECIMALS) {
    throw new Error("The configured asset is not the Amoy MockUSDT token.");
  }
  return formatUnits(balance, USDT_DECIMALS);
}

export async function loadUsdtBalance(signer: Signer): Promise<string> {
  return formatUnits(await loadUsdtBalanceUnits(signer), USDT_DECIMALS);
}

/** Returns the connected wallet's vault-asset balance in six-decimal base units. */
export async function loadUsdtBalanceUnits(signer: Signer): Promise<bigint> {
  const readProvider = readProviderFor(signer);
  const readFactory = new Contract(factoryAddress(), factoryAbi, readProvider);
  const token = new Contract(
    await readFactory.getFunction("asset")(),
    tokenAbi,
    readProvider
  );
  const [decimals, balance] = await Promise.all([
    token.getFunction("decimals")(),
    token.getFunction("balanceOf")(await signer.getAddress()),
  ]);
  if (Number(decimals) !== USDT_DECIMALS)
    throw new Error("The configured vault asset is not six-decimal USDT-compatible.");
  return BigInt(balance);
}

export async function requestMockUsdt(
  signer: Signer,
  value = "250"
): Promise<void> {
  const readProvider = readProviderFor(signer);
  const readFactory = new Contract(factoryAddress(), factoryAbi, readProvider);
  const tokenAddress = await readFactory.getFunction("asset")();
  const readToken = new Contract(
    tokenAddress,
    tokenAbi,
    readProvider
  );
  const [symbol, decimals] = await Promise.all([
    readToken.getFunction("symbol")(),
    readToken.getFunction("decimals")(),
  ]);
  if (symbol !== "mUSDT" || Number(decimals) !== USDT_DECIMALS) {
    throw new Error("Mock-token minting is unavailable for this deployment.");
  }
  const token = new Contract(tokenAddress, tokenAbi, signer);
  const overrides = await transactionOverrides(signer);
  const transaction = await token.getFunction("mint")(
    await signer.getAddress(),
    amount(value),
    overrides
  );
  await confirmTransaction(signer, transaction.hash);
}

export async function withdrawEmergency(
  signer: Signer,
  vaultAddress: string,
  positionId: bigint,
  value: string
): Promise<void> {
  const vault = new Contract(getAddress(vaultAddress), vaultAbi, signer);
  const overrides = await transactionOverrides(signer);
  const transaction = await vault.getFunction("withdrawEmergency")(
    positionId,
    amount(value),
    overrides
  );
  await confirmTransaction(signer, transaction.hash);
}

export async function withdrawLocked(
  signer: Signer,
  vaultAddress: string,
  positionId: bigint
): Promise<void> {
  const vault = new Contract(getAddress(vaultAddress), vaultAbi, signer);
  const overrides = await transactionOverrides(signer);
  const transaction = await vault.getFunction("withdrawLocked")(
    positionId,
    overrides
  );
  await confirmTransaction(signer, transaction.hash);
}

/** Loads each member's latest cooperative request directly from vault state. */
export async function loadGroupExitRequests(
  signer: Signer,
  vaultAddress: string
): Promise<GroupExitRequestSnapshot[]> {
  const vault = new Contract(
    getAddress(vaultAddress),
    vaultAbi,
    readProviderFor(signer)
  );
  if (!(await vault.getFunction("isGroup")())) return [];
  const [memberCount, connectedAddress] = await Promise.all([
    vault.getFunction("memberCount")(),
    signer.getAddress(),
  ]);
  const requestIds = await Promise.all(
    Array.from({ length: Number(memberCount) }, async (_, positionId) => {
      const requestIdPlusOne: bigint = await vault.getFunction(
        "currentGroupExitRequest"
      )(positionId);
      return requestIdPlusOne === 0n ? null : requestIdPlusOne - 1n;
    })
  );

  return Promise.all(
    requestIds
      .filter((requestId): requestId is bigint => requestId !== null)
      .map(async (requestId) => {
        const request = await vault.getFunction("groupExitRequests")(requestId);
        const [progress, connectedMemberApproved] = await Promise.all([
          vault.getFunction("groupExitApprovalProgress")(requestId),
          vault.getFunction("groupExitApproval")(requestId, connectedAddress),
        ]);
        const expiresAt = new Date(Number(request.expiresAt) * 1_000);
        const authorizationExpiresAt =
          Number(request.authorizationExpiresAt) === 0
            ? null
            : new Date(Number(request.authorizationExpiresAt) * 1_000);
        const status = groupExitStatusLabel(
          request.status,
          expiresAt,
          authorizationExpiresAt
        );
        return {
          id: requestId,
          positionId: request.positionId,
          requester: getAddress(request.requester),
          expiresAt,
          authorizationExpiresAt,
          currentDeadline:
            status === "authorized" && authorizationExpiresAt
              ? authorizationExpiresAt
              : expiresAt,
          requiredApprovals: Number(progress.required),
          completedApprovals: Number(progress.completed),
          connectedMemberApproved,
          status,
        };
      })
  );
}

async function sendGroupExitTransaction(
  signer: Signer,
  vaultAddress: string,
  functionName: string,
  requestId?: bigint
): Promise<void> {
  const vault = new Contract(getAddress(vaultAddress), vaultAbi, signer);
  const overrides = await transactionOverrides(signer);
  const transaction =
    requestId === undefined
      ? await vault.getFunction(functionName)(overrides)
      : await vault.getFunction(functionName)(requestId, overrides);
  await confirmTransaction(signer, transaction.hash);
}

export async function requestGroupExit(
  signer: Signer,
  vaultAddress: string
): Promise<void> {
  await sendGroupExitTransaction(signer, vaultAddress, "requestGroupExit");
}

export async function acceptGroupInvitation(
  signer: Signer,
  vaultAddress: string
): Promise<void> {
  await sendGroupExitTransaction(signer, vaultAddress, "acceptGroupInvitation");
}

export async function declineGroupInvitation(
  signer: Signer,
  vaultAddress: string
): Promise<void> {
  await sendGroupExitTransaction(signer, vaultAddress, "declineGroupInvitation");
}

export async function cancelUnactivatedGroup(
  signer: Signer,
  vaultAddress: string
): Promise<void> {
  await sendGroupExitTransaction(signer, vaultAddress, "cancelUnactivatedGroup");
}

export async function approveGroupExit(
  signer: Signer,
  vaultAddress: string,
  requestId: bigint
): Promise<void> {
  await sendGroupExitTransaction(
    signer,
    vaultAddress,
    "approveGroupExit",
    requestId
  );
}

export async function authorizeGroupExit(
  signer: Signer,
  vaultAddress: string,
  requestId: bigint
): Promise<void> {
  await sendGroupExitTransaction(
    signer,
    vaultAddress,
    "authorizeGroupExit",
    requestId
  );
}

export async function revokeGroupExitApproval(
  signer: Signer,
  vaultAddress: string,
  requestId: bigint
): Promise<void> {
  await sendGroupExitTransaction(
    signer,
    vaultAddress,
    "revokeGroupExitApproval",
    requestId
  );
}

export async function cancelGroupExit(
  signer: Signer,
  vaultAddress: string,
  requestId: bigint
): Promise<void> {
  await sendGroupExitTransaction(
    signer,
    vaultAddress,
    "cancelGroupExit",
    requestId
  );
}

export async function completeGroupExit(
  signer: Signer,
  vaultAddress: string,
  requestId: bigint
): Promise<void> {
  await sendGroupExitTransaction(
    signer,
    vaultAddress,
    "completeGroupExit",
    requestId
  );
}

function rayRateToApy(rate: bigint): number {
  // Aave exposes an annualized liquidity rate in ray units (1e27). The UI uses
  // it as a current variable rate, never as a guaranteed future return.
  const apr = Number(rate) / 1e27;
  return Math.expm1(apr) * 100;
}

export async function loadExitMarket(
  signer: Signer,
  vault: VaultSnapshot
): Promise<ExitListingSnapshot> {
  return withAmoyReadRetry(() => loadExitMarketOnce(signer, vault));
}

async function loadExitMarketOnce(
  signer: Signer,
  vault: VaultSnapshot
): Promise<ExitListingSnapshot> {
  const market = await marketReaderFor(signer);
  const marketAddress = await market.getAddress();
  const reference = await market.getFunction("referenceDiscount")(
    vault.address,
    vault.positionId
  );
  const listingIdPlusOne: bigint = await market.getFunction("activeListing")(
    vault.address,
    vault.positionId
  );
  const referenceSnapshot = mapReferenceDiscount(reference);
  if (listingIdPlusOne === 0n)
    return { marketAddress, reference: referenceSnapshot, listing: null };

  const listingId = listingIdPlusOne - 1n;
  return {
    marketAddress,
    reference: referenceSnapshot,
    listing: await mapListing(signer, market, listingId),
  };
}

export async function loadExitListing(
  signer: Signer,
  listingId: bigint
): Promise<ExitListingSnapshot> {
  return withAmoyReadRetry(() => loadExitListingOnce(signer, listingId));
}

async function loadExitListingOnce(
  signer: Signer,
  listingId: bigint
): Promise<ExitListingSnapshot> {
  const market = await marketReaderFor(signer);
  const listing = await market.getFunction("listings")(listingId);
  if (listing.vault === "0x0000000000000000000000000000000000000000") {
    throw new Error("Listing does not exist.");
  }
  const reference = await market.getFunction("referenceDiscount")(
    listing.vault,
    listing.positionId
  );
  return {
    marketAddress: await market.getAddress(),
    reference: mapReferenceDiscount(reference),
    listing: await mapListing(signer, market, listingId),
  };
}

function mapReferenceDiscount(
  reference: Record<string, bigint>
): ReferenceDiscountSnapshot {
  return {
    discountPercent: Number(reference.discountBps) / 100,
    remainingTimePenalty: Number(reference.remainingTimePenalty),
    commitmentPenalty: Number(reference.commitmentPenalty),
    liquidityRiskPenalty: Number(reference.liquidityRiskPenalty),
    timeWeightedSavingsPenalty: Number(reference.timeWeightedSavingsPenalty),
    goalCompletionPenalty: Number(reference.goalCompletionPenalty),
    regularityPenalty: Number(reference.regularityPenalty),
    recencyPenalty: Number(reference.recencyPenalty),
  };
}

async function mapListing(signer: Signer, market: Contract, listingId: bigint) {
  const listing = await market.getFunction("listings")(listingId);
  const vault = new Contract(
    listing.vault,
    vaultAbi,
    readProviderFor(signer)
  );
  const [isGroup, maturity, currentClaimValue, pricing] = await Promise.all([
    vault.getFunction("isGroup")(),
    vault.getFunction("maturity")(),
    vault.getFunction("positionValue")(listing.positionId),
    market.getFunction("referenceDiscount")(listing.vault, listing.positionId),
  ]);
  // Listing fields are historical display snapshots. Rebuild the current quote from the
  // same contract views settlement uses so the UI never invents pricing independently.
  const currentSaverPayout: bigint = await market.getFunction("payoutFor")(
    currentClaimValue,
    pricing.discountBps
  );
  const currentProviderFee: bigint = await market.getFunction("feeFor")(
    currentSaverPayout
  );
  const active =
    listing.active && Number(listing.expiresAt) * 1_000 > Date.now();
  return {
    id: listingId,
    vault: getAddress(listing.vault),
    positionId: listing.positionId,
    isGroup,
    seller: getAddress(listing.seller),
    claimValue: formatUnits(listing.claimValue, USDT_DECIMALS),
    currentClaimValue: formatUnits(currentClaimValue, USDT_DECIMALS),
    systemDiscountPercent: Number(listing.systemDiscountBps) / 100,
    saverPayout: formatUnits(listing.saverPayout, USDT_DECIMALS),
    currentSaverPayout: formatUnits(currentSaverPayout, USDT_DECIMALS),
    providerPotentialReturn: formatUnits(
      listing.providerPotentialReturn,
      USDT_DECIMALS
    ),
    currentProviderPotentialReturn: formatUnits(
      currentClaimValue - currentSaverPayout,
      USDT_DECIMALS
    ),
    providerFee: formatUnits(listing.providerFee, USDT_DECIMALS),
    currentProviderFee: formatUnits(currentProviderFee, USDT_DECIMALS),
    currentTotalProviderPaid: formatUnits(
      currentSaverPayout + currentProviderFee,
      USDT_DECIMALS
    ),
    minimumPayout: formatUnits(listing.minimumPayout, USDT_DECIMALS),
    maturity: new Date(Number(maturity) * 1_000),
    expiresAt: new Date(Number(listing.expiresAt) * 1_000),
    active,
    status: active
      ? ("active" as const)
      : listing.active
      ? ("expired" as const)
      : ("cancelled-or-sold" as const),
  };
}

export async function loadAllExitListings(
  signer: Signer
): Promise<ExitListingSnapshot[]> {
  // This direct on-chain scan is acceptable for the local MVP. A production
  // indexer can cache these immutable IDs without becoming settlement authority.
  const market = await marketReaderFor(signer);
  const count: bigint = await market.getFunction("nextListingId")();
  return Promise.all(
    Array.from({ length: Number(count) }, (_, index) =>
      loadExitListing(signer, BigInt(index))
    )
  );
}

export async function createExitListing(
  signer: Signer,
  vault: VaultSnapshot,
  expiresAt: string,
  minimumPayout: string
): Promise<void> {
  const market = await marketFor(signer);
  const expiration = BigInt(Math.floor(new Date(expiresAt).getTime() / 1_000));
  const payoutFloor = amount(minimumPayout);
  const overrides = await transactionOverrides(signer);
  const transaction = await market.getFunction("createListing")(
    vault.address,
    vault.positionId,
    expiration,
    payoutFloor,
    overrides
  );
  await confirmTransaction(signer, transaction.hash);
}

// Funds the live system quote. The approval is deliberately exact, while the contract
// independently recalculates and validates all values in the settlement transaction.
export async function fundExitListing(
  signer: Signer,
  listingId: bigint,
  maximumTotalPayment?: bigint
): Promise<void> {
  const market = await marketFor(signer);
  const readProvider = readProviderFor(signer);
  const readMarket = await marketReaderFor(signer);
  const listing = await readMarket.getFunction("listings")(listingId);
  const vault = new Contract(listing.vault, vaultAbi, readProvider);
  const [currentValue, reference] = await Promise.all([
    vault.getFunction("positionValue")(listing.positionId),
    readMarket.getFunction("referenceDiscount")(
      listing.vault,
      listing.positionId
    ),
  ]);
  const saverPayout: bigint = await readMarket.getFunction("payoutFor")(
    currentValue,
    reference.discountBps
  );
  const providerFee: bigint = await readMarket.getFunction("feeFor")(
    saverPayout
  );
  const totalPayment = saverPayout + providerFee;
  const buyer = await signer.getAddress();
  if (getAddress(listing.seller) === getAddress(buyer))
    throw new Error("ProviderOnly: a saver cannot fund their own early-exit listing.");
  if (!listing.active || Number(listing.expiresAt) * 1_000 <= Date.now())
    throw new Error("The listing is no longer available. Converted USDT remains in your wallet.");
  if (maximumTotalPayment !== undefined && totalPayment > maximumTotalPayment)
    throw new Error("The live listing price increased after the swap. Converted USDT remains in your wallet.");
  const readFactory = new Contract(factoryAddress(), factoryAbi, readProvider);
  const token = new Contract(
    await readFactory.getFunction("asset")(),
    tokenAbi,
    signer
  );
  const marketAddress = await market.getAddress();
  const allowance: bigint = await token.getFunction("allowance")(
    buyer,
    marketAddress
  );
  if (allowance < totalPayment) {
    // Fixed limits avoid unreliable Amoy gas estimation in embedded wallets.
    // The ERC-20 approval remains exact and the market can only pull the
    // settlement amount calculated by the immutable contract.
    const approval = await token.getFunction("approve")(
      marketAddress,
      totalPayment,
      { ...(await transactionOverrides(signer)), gasLimit: 120_000n }
    );
    await confirmTransaction(signer, approval.hash);
  }
  const funding = await market.getFunction("fundListing")(
    listingId,
    { ...(await transactionOverrides(signer)), gasLimit: 650_000n }
  );
  await confirmTransaction(signer, funding.hash);
}

export async function cancelExitListing(
  signer: Signer,
  listingId: bigint
): Promise<void> {
  const market = await marketFor(signer);
  const overrides = await transactionOverrides(signer);
  const transaction = await market.getFunction("cancelListing")(
    listingId,
    overrides
  );
  await confirmTransaction(signer, transaction.hash);
}

function parsedEvent(log: Log, abi: readonly string[]) {
  try {
    return new Interface(abi).parseLog({
      topics: [...log.topics],
      data: log.data,
    });
  } catch {
    return null;
  }
}

// Stay well below the advertised 10,000-block ceiling. Some Amoy gateways
// reject near-limit requests after applying their own inclusive-boundary or
// batching rules, so a 5,000-block window is the reliable public-RPC size.
const MAX_LOG_BLOCK_RANGE = 5_000;

/**
 * Public Amoy RPC services commonly reject `eth_getLogs` requests spanning
 * more than 10,000 blocks. Read the same canonical history in bounded,
 * inclusive windows so Activity keeps working as the deployment gets older.
 */
async function getLogsInChunks(
  provider: Provider,
  filter: Filter,
  fromBlock: number,
  toBlock: number
): Promise<Log[]> {
  const logs: Log[] = [];
  for (
    let firstBlock = fromBlock;
    firstBlock <= toBlock;
    firstBlock += MAX_LOG_BLOCK_RANGE
  ) {
    const lastBlock = Math.min(
      firstBlock + MAX_LOG_BLOCK_RANGE - 1,
      toBlock
    );
    logs.push(
      ...(await provider.getLogs({
        ...filter,
        fromBlock: firstBlock,
        toBlock: lastBlock,
      }))
    );
  }
  return logs;
}

/**
 * Builds the public settlement ledger from immutable EarlyExitMarket events.
 * `ListingFunded` holds the final execution values while `ListingCreated`
 * supplies the seller, vault and position identity for the same listing ID.
 */
export async function loadCompletedTrades(
  signer: Signer
): Promise<CompletedTrade[]> {
  const provider = readProviderFor(signer);
  const trades = await Promise.all(configuredDeployments().map((deployment) =>
    scanCompletedTrades(provider, deployment.marketAddress, deployment.deploymentBlock)
  ));
  return trades.flat().sort((left, right) => right.blockNumber - left.blockNumber);
}

/**
 * Loads the public market ledger without requesting wallet account access.
 * Hosted builds should configure a deliberately public, rate-limited RPC URL;
 * otherwise an already-injected provider is used for read-only calls.
 */
export async function loadPublicCompletedTrades(): Promise<CompletedTrade[]> {
  let lastError: unknown;

  // Market history is public data, so a failing free RPC must not make the
  // savings exit ledger disappear. Try the configured endpoint first, then
  // the same read-only Amoy fallbacks used by contract state reads.
  for (const rpcUrl of amoyReadUrls()) {
    const provider = new JsonRpcProvider(
      rpcUrl,
      Number(POLYGON_AMOY_CHAIN_ID),
      { staticNetwork: true, batchMaxCount: 3 }
    );
    try {
      const trades = await Promise.all(
        configuredDeployments().map((deployment) =>
          scanCompletedTrades(
            provider,
            deployment.marketAddress,
            deployment.deploymentBlock
          )
        )
      );
      return trades
        .flat()
        .sort((left, right) => right.blockNumber - left.blockNumber);
    } catch (error) {
      lastError = error;
    } finally {
      provider.destroy();
    }
  }

  throw lastError ?? new Error("No public Amoy RPC is available.");
}

async function scanCompletedTrades(
  provider: Provider,
  marketAddress: string,
  deploymentBlock = Number(import.meta.env.VITE_CONTRACT_START_BLOCK ?? 0)
): Promise<CompletedTrade[]> {
  const latestBlock = await provider.getBlockNumber();
  const logs = await getLogsInChunks(
    provider,
    { address: marketAddress },
    deploymentBlock,
    latestBlock
  );

  const created = new Map<
    string,
    { vault: string; positionId: bigint; seller: string }
  >();
  const funded: Array<{
    listingId: bigint;
    provider: string;
    claimValue: bigint;
    systemDiscountBps: bigint;
    saverPayout: bigint;
    providerPotentialReturn: bigint;
    providerFee: bigint;
    blockNumber: number;
    transactionHash: string;
    logIndex: number;
  }> = [];

  for (const log of logs) {
    const event = parsedEvent(log, marketAbi);
    if (!event) continue;
    const listingId = event.args.listingId?.toString();
    if (!listingId) continue;

    if (event.name === "ListingCreated") {
      created.set(listingId, {
        vault: getAddress(event.args.vault),
        positionId: event.args.positionId,
        seller: getAddress(event.args.seller),
      });
    }
    if (event.name === "ListingFunded") {
      funded.push({
        listingId: event.args.listingId,
        provider: getAddress(event.args.provider),
        claimValue: event.args.claimValue,
        systemDiscountBps: event.args.systemDiscountBps,
        saverPayout: event.args.saverPayout,
        providerPotentialReturn: event.args.providerPotentialReturn,
        providerFee: event.args.providerFee,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.index,
      });
    }
  }

  const settled = funded.filter((trade) =>
    created.has(trade.listingId.toString())
  );
  const vaultAddresses = [
    ...new Set(
      settled.map(
        (trade) => created.get(trade.listingId.toString())!.vault
      )
    ),
  ];
  const blockNumbers = [...new Set(settled.map((trade) => trade.blockNumber))];
  const [vaultTypeEntries, blockEntries] = await Promise.all([
    Promise.all(
      vaultAddresses.map(async (vault) => [
        vault.toLowerCase(),
        Boolean(await new Contract(vault, vaultAbi, provider).getFunction("isGroup")()),
      ] as const)
    ),
    Promise.all(
      blockNumbers.map(async (blockNumber) => {
        const block = await provider.getBlock(blockNumber);
        return [
          blockNumber,
          new Date(Number(block?.timestamp ?? 0) * 1_000),
        ] as const;
      })
    ),
  ]);
  const vaultTypes = new Map(vaultTypeEntries);
  const blockTimes = new Map(blockEntries);

  return settled
    .sort(
      (a, b) =>
        b.blockNumber - a.blockNumber || b.logIndex - a.logIndex
    )
    .map((trade) => {
      const listing = created.get(trade.listingId.toString())!;
      return {
        listingId: trade.listingId,
        vault: listing.vault,
        positionId: listing.positionId,
        isGroup: vaultTypes.get(listing.vault.toLowerCase()) ?? false,
        seller: listing.seller,
        provider: trade.provider,
        claimValue: formatUnits(trade.claimValue, USDT_DECIMALS),
        systemDiscountPercent: Number(trade.systemDiscountBps) / 100,
        saverPayout: formatUnits(trade.saverPayout, USDT_DECIMALS),
        providerPotentialReturn: formatUnits(
          trade.providerPotentialReturn,
          USDT_DECIMALS
        ),
        providerFee: formatUnits(trade.providerFee, USDT_DECIMALS),
        totalProviderPaid: formatUnits(
          trade.saverPayout + trade.providerFee,
          USDT_DECIMALS
        ),
        blockNumber: trade.blockNumber,
        transactionHash: trade.transactionHash,
        timestamp: blockTimes.get(trade.blockNumber) ?? new Date(0),
      };
    });
}

export async function loadActivity(
  signer: Signer,
  vaultAddresses: string[]
): Promise<ActivityItem[]> {
  // Activity is reconstructed from canonical logs. A future database may index
  // the same events for speed, but clients must be able to verify its results.
  const provider = readProviderFor(signer);
  const fromBlock = Number(import.meta.env.VITE_CONTRACT_START_BLOCK ?? 0);
  const market = await marketReaderFor(signer);
  const marketAddress = await market.getAddress();
  const latestBlock = await provider.getBlockNumber();
  const normalizedVaults = new Set(
    vaultAddresses.map((address) => address.toLowerCase())
  );
  const [factoryLogs, marketLogs, vaultLogGroups] = await Promise.all([
    getLogsInChunks(provider, { address: factoryAddress() }, fromBlock, latestBlock),
    getLogsInChunks(provider, { address: marketAddress }, fromBlock, latestBlock),
    Promise.all(
      vaultAddresses.map((address) =>
        getLogsInChunks(provider, { address }, fromBlock, latestBlock)
      )
    ),
  ]);

  const relevantListings = new Set<string>();
  for (const log of marketLogs) {
    const event = parsedEvent(log, marketAbi);
    if (
      event?.name === "ListingCreated" &&
      normalizedVaults.has(String(event.args.vault).toLowerCase())
    ) {
      relevantListings.add(event.args.listingId.toString());
    }
  }

  const entries: Array<Omit<ActivityItem, "timestamp">> = [];
  const push = (
    log: Log,
    title: string,
    detail: string,
    vault?: string,
    metadata?: Pick<ActivityItem, "member" | "amount">
  ) =>
    entries.push({
      id: `${log.transactionHash}-${log.index}`,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      title,
      detail,
      vault,
      ...metadata,
    });

  for (const log of factoryLogs) {
    const event = parsedEvent(log, factoryAbi);
    if (
      event?.name !== "VaultCreated" ||
      !normalizedVaults.has(String(event.args.vault).toLowerCase())
    )
      continue;
    push(
      log,
      event.args.isGroup ? "Group vault created" : "Personal vault created",
      shortAddress(event.args.vault),
      event.args.vault
    );
  }
  for (const logs of vaultLogGroups) {
    for (const log of logs) {
      const event = parsedEvent(log, vaultAbi);
      if (!event) continue;
      const vault = getAddress(log.address);
      if (event.name === "Deposited")
        push(
          log,
          "Deposit confirmed",
          `${formatUnits(event.args.amount, USDT_DECIMALS)} mUSDT`,
          vault,
          {
            member: getAddress(event.args.member),
            amount: formatUnits(event.args.amount, USDT_DECIMALS),
          }
        );
      if (event.name === "EmergencyWithdrawn")
        push(
          log,
          "Emergency funds withdrawn",
          `${formatUnits(event.args.amount, USDT_DECIMALS)} mUSDT`,
          vault
        );
      if (event.name === "LockedWithdrawn")
        push(
          log,
          "Locked claim withdrawn",
          `${formatUnits(event.args.amount, USDT_DECIMALS)} mUSDT`,
          vault
        );
      if (event.name === "PositionTransferred")
        push(
          log,
          "Locked position sold",
          `${shortAddress(event.args.previousOwner)} → ${shortAddress(
            event.args.newOwner
          )}`,
          vault
        );
      if (event.name === "RewardEligibilityRevoked")
        push(
          log,
          "Reward eligibility ended",
          shortAddress(event.args.member),
          vault
        );
      if (event.name === "GroupExitRequested")
        push(
          log,
          `Group exit #${event.args.requestId.toString()} requested`,
          `Expires ${new Date(
            Number(event.args.expiresAt) * 1_000
          ).toLocaleString()}`,
          vault
        );
      if (event.name === "GroupExitApproved")
        push(
          log,
          `Group exit #${event.args.requestId.toString()} approved`,
          shortAddress(event.args.approver),
          vault
        );
      if (event.name === "GroupExitApprovalRevoked")
        push(
          log,
          `Group exit #${event.args.requestId.toString()} approval revoked`,
          shortAddress(event.args.approver),
          vault
        );
      if (event.name === "GroupExitCancelled")
        push(
          log,
          `Group exit #${event.args.requestId.toString()} cancelled`,
          "The saver may use the Early-Exit Market.",
          vault
        );
      if (event.name === "GroupExitExpired")
        push(
          log,
          `Group exit #${event.args.requestId.toString()} expired`,
          "The saver may use the Early-Exit Market.",
          vault
        );
      if (event.name === "GroupExitAuthorized")
        push(
          log,
          `Group exit #${event.args.requestId.toString()} authorized`,
          `${event.args.completedApprovals.toString()}/${event.args.requiredApprovals.toString()} approvals`,
          vault
        );
      if (event.name === "GroupExitCompleted")
        push(
          log,
          `Group exit #${event.args.requestId.toString()} completed`,
          `${formatUnits(event.args.amount, USDT_DECIMALS)} mUSDT withdrawn`,
          vault
        );
    }
  }
  for (const log of marketLogs) {
    const event = parsedEvent(log, marketAbi);
    if (!event) continue;
    const listingId = event.args.listingId?.toString();
    if (!listingId || !relevantListings.has(listingId)) continue;
    if (event.name === "ListingCreated")
      push(
        log,
        `Listing #${listingId} created`,
        `${Number(event.args.systemDiscountBps) / 100}% system discount`,
        event.args.vault
      );
    if (event.name === "ListingCancelled")
      push(
        log,
        `Listing #${listingId} cancelled`,
        "The position may be relisted."
      );
    if (event.name === "ListingExpired")
      push(
        log,
        `Listing #${listingId} expired`,
        "The position was released for relisting."
      );
    if (event.name === "ListingFunded")
      push(
        log,
        `Listing #${listingId} funded`,
        `${formatUnits(
          event.args.saverPayout,
          USDT_DECIMALS
        )} mUSDT paid to saver`
      );
  }

  const blocks = new Map<number, Date>();
  await Promise.all(
    [...new Set(entries.map((entry) => entry.blockNumber))].map(
      async (blockNumber) => {
        const block = await provider.getBlock(blockNumber);
        blocks.set(
          blockNumber,
          new Date(Number(block?.timestamp ?? 0) * 1_000)
        );
      }
    )
  );
  return entries
    .map((entry) => ({
      ...entry,
      timestamp: blocks.get(entry.blockNumber) ?? new Date(0),
    }))
    .sort((a, b) => b.blockNumber - a.blockNumber);
}

function shortAddress(value: string): string {
  const address = String(value);
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

export function describeContractError(error: unknown): string {
  const details = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const raw = [
    details.shortMessage,
    details.reason,
    details.message,
    details.code,
    error instanceof Error ? error.message : error,
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ");

  if (/user rejected|user denied|action_rejected|4001/i.test(raw))
    return "The request was cancelled in your wallet. Nothing was changed.";
  if (/insufficient funds.*gas|intrinsic transaction cost|gas required exceeds/i.test(raw))
    return "Your wallet needs more POL to cover the Polygon network fee.";
  if (/transfer amount exceeds balance|erc20insufficientbalance|insufficient token|insufficient wallet funds/i.test(raw))
    return "Your wallet does not have enough USDT for this action.";
  if (/targetexceeded|exceeds your goal/i.test(raw))
    return "This contribution would exceed your savings goal. Enter a smaller amount.";
  if (/depositsclosed/i.test(raw))
    return "This savings period has ended, so new contributions are closed.";
  if (/positionlisted/i.test(raw))
    return "This position is already listed for an early exit. Cancel the listing before contributing again.";
  if (/provideronly|saver cannot fund their own/i.test(raw))
    return "You cannot fund your own savings exit. Connect a different provider wallet to complete this purchase.";
  if (/listingunavailable|positionalreadysold/i.test(raw))
    return "This savings exit is no longer available. Refresh the exit list to see current opportunities.";
  if (/minimumpayoutnotmet/i.test(raw))
    return "The live payout moved below the saver’s minimum. The listing was not funded and your USDT remains in your wallet.";
  if (/wrong network|unsupported chain|chain mismatch|network mismatch/i.test(raw))
    return "Your wallet is on the wrong network. Switch to Polygon Amoy and try again.";
  if (/could not decode result data|bad_data/i.test(raw))
    return "This savings vault could not be read on Polygon Amoy. Refresh your wallet connection and try again.";
  if (/require\(false\)|missing revert data/i.test(raw))
    return "The savings contract declined this action before it reached your wallet. Refresh the position and confirm it still has locked value and is eligible for an early exit.";
  if (/failed to fetch|timeout|network error|server_error|unknown_error|could not coalesce|json-?rpc|econn|rate limit|429/i.test(raw))
    return "Polygon Amoy is taking longer than expected. Your funds are unchanged; please try again shortly.";
  if (/execution reverted|call exception|custom error/i.test(raw))
    return "The savings contract declined this action. Refresh the vault details and check that the amount and current status are still valid.";

  return "The action could not be completed. Nothing was changed. Please try again.";
}
