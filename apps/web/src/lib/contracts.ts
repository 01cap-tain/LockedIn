import {
  Contract,
  Interface,
  formatUnits,
  getAddress,
  parseUnits,
  type Log,
  type Signer,
} from "ethers";

// Thin client for contract reads and signed transactions. It deliberately
// contains no authoritative pricing or ownership rules: those are enforced by
// Solidity, while this module only prepares inputs and presents chain results.

const factoryAbi = [
  "function asset() view returns (address)",
  "function createPersonalVault(uint256 target,uint64 maturity,uint16 emergencyBps,uint8 mode) returns (address)",
  "function createGroupVault(address[] members,uint256[] targets,uint16[] emergencyBps,uint64 maturity,uint8 mode) returns (address)",
  "function vaultCount() view returns (uint256)",
  "function vaultAt(uint256 index) view returns (address)",
  "function vaultsOf(address member) view returns (address[])",
  "function earlyExitMarket() view returns (address)",
  "event VaultCreated(address indexed vault,address indexed creator,bool indexed isGroup,uint8 mode,address yieldAdapter,uint64 maturity)",
] as const;

const vaultAbi = [
  "function asset() view returns (address)",
  "function maturity() view returns (uint64)",
  "function isGroup() view returns (bool)",
  "function mode() view returns (uint8)",
  "function yieldAdapter() view returns (address)",
  "function memberCount() view returns (uint256)",
  "function memberAt(uint256 positionId) view returns (address)",
  "function positionOwner(uint256 positionId) view returns (address)",
  "function rewardDisqualified(uint256 positionId) view returns (bool)",
  "function memberStatus(uint256 positionId) view returns (uint8)",
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
  "function revokeGroupExitApproval(uint256 requestId)",
  "function cancelGroupExit(uint256 requestId)",
  "function expireGroupExit(uint256 requestId)",
  "function completeGroupExit(uint256 requestId)",
  "function currentGroupExitRequest(uint256 positionId) view returns (uint256)",
  "function groupExitRequests(uint256 requestId) view returns (uint256 positionId,address requester,uint64 createdAt,uint64 expiresAt,uint32 requiredApprovals,uint32 completedApprovals,uint8 status)",
  "function groupExitApproval(uint256 requestId,address member) view returns (bool)",
  "function groupExitApprovalProgress(uint256 requestId) view returns (uint32 required,uint32 completed)",
  "function activeMemberCount() view returns (uint256)",
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
  "event GroupExitAuthorized(uint256 indexed requestId,uint32 requiredApprovals,uint32 completedApprovals)",
  "event GroupExitCompleted(uint256 indexed requestId,uint256 indexed positionId,address indexed requester,uint256 amount)",
  "event GroupMemberStatusChanged(uint256 indexed positionId,address indexed member,uint8 previousStatus,uint8 newStatus)",
] as const;

const tokenAbi = [
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
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

export interface CreateVaultInput {
  groupMode: "personal" | "group";
  yieldMode: "safe" | "earn";
  target: string;
  maturity: string;
  emergencyPercent: number;
  additionalMembers: string[];
}

export interface VaultSnapshot {
  address: string;
  signerAddress: string;
  positionId: bigint;
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
  emergencyPercent: number;
  goalComplete: boolean;
  lockedWithdrawn: boolean;
  maturity: Date;
  isGroup: boolean;
  members: VaultMemberSnapshot[];
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
  requiredApprovals: number;
  completedApprovals: number;
  connectedMemberApproved: boolean;
  status: "pending" | "authorized" | "cancelled" | "expired" | "completed";
}

export interface VaultSummary {
  address: string;
  isGroup: boolean;
  maturity: Date;
  memberCount: number;
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
    minimumPayout: string;
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

function factoryFor(signer: Signer): Contract {
  return new Contract(factoryAddress(), factoryAbi, signer);
}

async function assertFactoryDeployment(signer: Signer): Promise<void> {
  // Calling an ABI against an address with no bytecode produces the confusing
  // `could not decode result data` error. Fail early with an actionable message.
  const provider = signer.provider;
  if (!provider || (await provider.getCode(factoryAddress())) === "0x") {
    throw new Error(
      "No VaultFactory contract exists at the configured address on this network. Redeploy it and restart the app."
    );
  }
}

async function marketFor(signer: Signer): Promise<Contract> {
  const address = await factoryFor(signer).getFunction("earlyExitMarket")();
  return new Contract(address, marketAbi, signer);
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

function groupExitStatusLabel(
  status: bigint,
  expiresAt: Date
): GroupExitRequestSnapshot["status"] {
  if (status === 2n) return "authorized";
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
  const provider = signer.provider;
  if (!provider) return {};

  const network = await provider.getNetwork();
  if (network.chainId !== POLYGON_AMOY_CHAIN_ID) return {};

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
}

export async function createVault(
  signer: Signer,
  input: CreateVaultInput
): Promise<string> {
  await assertFactoryDeployment(signer);
  const factory = factoryFor(signer);
  const signerAddress = await signer.getAddress();
  const target = amount(input.target);
  const maturity = BigInt(
    Math.floor(new Date(input.maturity).getTime() / 1_000)
  );
  if (maturity <= BigInt(Math.floor(Date.now() / 1_000)))
    throw new Error("Maturity must be in the future.");
  const emergencyBps = input.emergencyPercent * 100;
  const yieldMode = input.yieldMode === "earn" ? 1 : 0;
  const overrides = await transactionOverrides(signer);

  if (input.groupMode === "personal") {
    await (
      await factory.getFunction("createPersonalVault")(
        target,
        maturity,
        emergencyBps,
        yieldMode,
        overrides
      )
    ).wait();
  } else {
    const members = [signerAddress, ...input.additionalMembers.map(getAddress)];
    if (members.length < 2)
      throw new Error("Add at least one other EVM member address.");
    if (
      new Set(members.map((member) => member.toLowerCase())).size !==
      members.length
    ) {
      throw new Error("Group member addresses must be unique.");
    }
    await (
      await factory.getFunction("createGroupVault")(
        members,
        members.map(() => target),
        members.map(() => emergencyBps),
        maturity,
        yieldMode,
        overrides
      )
    ).wait();
  }

  const count: bigint = await factory.getFunction("vaultCount")();
  return getAddress(await factory.getFunction("vaultAt")(count - 1n));
}

export async function loadVault(
  signer: Signer,
  address: string
): Promise<VaultSnapshot> {
  const signerAddress = await signer.getAddress();
  const vaultAddress = getAddress(address);
  const vault = new Contract(vaultAddress, vaultAbi, signer);
  const positionId: bigint = await vault.getFunction("positionOf")(
    signerAddress
  );
  const [
    stored,
    completed,
    maturity,
    isGroup,
    memberCount,
    mode,
    yieldAdapter,
    currentValue,
    accruedYield,
    liquidityRate,
  ] = await Promise.all([
    vault.getFunction("position")(positionId),
    vault.getFunction("goalComplete")(positionId),
    vault.getFunction("maturity")(),
    vault.getFunction("isGroup")(),
    vault.getFunction("memberCount")(),
    vault.getFunction("mode")(),
    vault.getFunction("yieldAdapter")(),
    vault.getFunction("positionValue")(positionId),
    vault.getFunction("accruedYield")(positionId),
    vault.getFunction("currentLiquidityRate")(),
  ]);
  const members: VaultMemberSnapshot[] = await Promise.all(
    Array.from({ length: Number(memberCount) }, async (_, index) => {
      const memberPosition = await vault.getFunction("position")(index);
      const [owner, memberComplete, rewardDisqualified, status] =
        await Promise.all([
          vault.getFunction("positionOwner")(index),
          vault.getFunction("goalComplete")(index),
          vault.getFunction("rewardDisqualified")(index),
          vault.getFunction("memberStatus")(index),
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
        goalComplete: memberComplete,
        rewardDisqualified,
        lockedWithdrawn: memberPosition.lockedWithdrawn,
        status: memberStatusLabel(status),
      };
    })
  );
  return {
    address: vaultAddress,
    signerAddress,
    positionId,
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
    emergencyPercent: Number(stored.emergencyBps) / 100,
    goalComplete: completed,
    lockedWithdrawn: stored.lockedWithdrawn,
    maturity: new Date(Number(maturity) * 1_000),
    isGroup,
    members,
  };
}

export async function loadVaultsForSigner(
  signer: Signer
): Promise<VaultSummary[]> {
  // Factory membership indexes avoid scanning arbitrary blocks just to build
  // the connected user's vault list. Market-wide listings are loaded separately.
  await assertFactoryDeployment(signer);
  const factory = factoryFor(signer);
  const addresses: string[] = await factory.getFunction("vaultsOf")(
    await signer.getAddress()
  );
  return Promise.all(
    addresses.map(async (address) => {
      const vault = new Contract(address, vaultAbi, signer);
      const [isGroup, maturity, memberCount] = await Promise.all([
        vault.getFunction("isGroup")(),
        vault.getFunction("maturity")(),
        vault.getFunction("memberCount")(),
      ]);
      return {
        address: getAddress(address),
        isGroup,
        maturity: new Date(Number(maturity) * 1_000),
        memberCount: Number(memberCount),
      };
    })
  );
}

export async function depositToVault(
  signer: Signer,
  vaultAddress: string,
  positionId: bigint,
  value: string
): Promise<void> {
  const vault = new Contract(getAddress(vaultAddress), vaultAbi, signer);
  const token = new Contract(
    await vault.getFunction("asset")(),
    tokenAbi,
    signer
  );
  const parsed = amount(value);
  const overrides = await transactionOverrides(signer);
  await (
    await token.getFunction("approve")(
      await vault.getAddress(),
      parsed,
      overrides
    )
  ).wait();
  await (
    await vault.getFunction("deposit")(positionId, parsed, overrides)
  ).wait();
}

export async function loadMockUsdtBalance(signer: Signer): Promise<string> {
  const token = new Contract(
    await factoryFor(signer).getFunction("asset")(),
    tokenAbi,
    signer
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

export async function requestMockUsdt(
  signer: Signer,
  value = "250"
): Promise<void> {
  const token = new Contract(
    await factoryFor(signer).getFunction("asset")(),
    tokenAbi,
    signer
  );
  const [symbol, decimals] = await Promise.all([
    token.getFunction("symbol")(),
    token.getFunction("decimals")(),
  ]);
  if (symbol !== "mUSDT" || Number(decimals) !== USDT_DECIMALS) {
    throw new Error("Mock-token minting is unavailable for this deployment.");
  }
  const overrides = await transactionOverrides(signer);
  await (
    await token.getFunction("mint")(
      await signer.getAddress(),
      amount(value),
      overrides
    )
  ).wait();
}

export async function withdrawEmergency(
  signer: Signer,
  vaultAddress: string,
  positionId: bigint,
  value: string
): Promise<void> {
  const vault = new Contract(getAddress(vaultAddress), vaultAbi, signer);
  const overrides = await transactionOverrides(signer);
  await (
    await vault.getFunction("withdrawEmergency")(
      positionId,
      amount(value),
      overrides
    )
  ).wait();
}

export async function withdrawLocked(
  signer: Signer,
  vaultAddress: string,
  positionId: bigint
): Promise<void> {
  const vault = new Contract(getAddress(vaultAddress), vaultAbi, signer);
  const overrides = await transactionOverrides(signer);
  await (
    await vault.getFunction("withdrawLocked")(positionId, overrides)
  ).wait();
}

/** Loads each member's latest cooperative request directly from vault state. */
export async function loadGroupExitRequests(
  signer: Signer,
  vaultAddress: string
): Promise<GroupExitRequestSnapshot[]> {
  const vault = new Contract(getAddress(vaultAddress), vaultAbi, signer);
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
        return {
          id: requestId,
          positionId: request.positionId,
          requester: getAddress(request.requester),
          expiresAt,
          requiredApprovals: Number(progress.required),
          completedApprovals: Number(progress.completed),
          connectedMemberApproved,
          status: groupExitStatusLabel(request.status, expiresAt),
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
  await transaction.wait();
}

export async function requestGroupExit(
  signer: Signer,
  vaultAddress: string
): Promise<void> {
  await sendGroupExitTransaction(signer, vaultAddress, "requestGroupExit");
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
  const market = await marketFor(signer);
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
  const market = await marketFor(signer);
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
  const vault = new Contract(listing.vault, vaultAbi, signer);
  const [isGroup, currentClaimValue, pricing] = await Promise.all([
    vault.getFunction("isGroup")(),
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
    minimumPayout: formatUnits(listing.minimumPayout, USDT_DECIMALS),
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
  const market = await marketFor(signer);
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
  await (
    await market.getFunction("createListing")(
      vault.address,
      vault.positionId,
      expiration,
      payoutFloor,
      overrides
    )
  ).wait();
}

// Funds the live system quote. The approval is deliberately exact, while the contract
// independently recalculates and validates all values in the settlement transaction.
export async function fundExitListing(
  signer: Signer,
  listingId: bigint
): Promise<void> {
  const market = await marketFor(signer);
  const listing = await market.getFunction("listings")(listingId);
  const vault = new Contract(listing.vault, vaultAbi, signer);
  const [currentValue, reference] = await Promise.all([
    vault.getFunction("positionValue")(listing.positionId),
    market.getFunction("referenceDiscount")(listing.vault, listing.positionId),
  ]);
  const saverPayout: bigint = await market.getFunction("payoutFor")(
    currentValue,
    reference.discountBps
  );
  const providerFee: bigint = await market.getFunction("feeFor")(saverPayout);
  const token = new Contract(
    await factoryFor(signer).getFunction("asset")(),
    tokenAbi,
    signer
  );
  const overrides = await transactionOverrides(signer);
  await (
    await token.getFunction("approve")(
      await market.getAddress(),
      saverPayout + providerFee,
      overrides
    )
  ).wait();
  await (await market.getFunction("fundListing")(listingId, overrides)).wait();
}

export async function cancelExitListing(
  signer: Signer,
  listingId: bigint
): Promise<void> {
  const market = await marketFor(signer);
  const overrides = await transactionOverrides(signer);
  await (
    await market.getFunction("cancelListing")(listingId, overrides)
  ).wait();
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

export async function loadActivity(
  signer: Signer,
  vaultAddresses: string[]
): Promise<ActivityItem[]> {
  // Activity is reconstructed from canonical logs. A future database may index
  // the same events for speed, but clients must be able to verify its results.
  const provider = signer.provider;
  if (!provider)
    throw new Error("The connected wallet has no readable provider.");
  const fromBlock = Number(import.meta.env.VITE_CONTRACT_START_BLOCK ?? 0);
  const market = await marketFor(signer);
  const marketAddress = await market.getAddress();
  const normalizedVaults = new Set(
    vaultAddresses.map((address) => address.toLowerCase())
  );
  const [factoryLogs, marketLogs, vaultLogGroups] = await Promise.all([
    provider.getLogs({
      address: factoryAddress(),
      fromBlock,
      toBlock: "latest",
    }),
    provider.getLogs({ address: marketAddress, fromBlock, toBlock: "latest" }),
    Promise.all(
      vaultAddresses.map((address) =>
        provider.getLogs({ address, fromBlock, toBlock: "latest" })
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
  const push = (log: Log, title: string, detail: string, vault?: string) =>
    entries.push({
      id: `${log.transactionHash}-${log.index}`,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      title,
      detail,
      vault,
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
          vault
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
  if (error instanceof Error) {
    const reason =
      "reason" in error && typeof error.reason === "string"
        ? error.reason
        : null;
    return reason ?? error.message.replace(/^execution reverted:\s*/i, "");
  }
  return "The contract transaction failed.";
}
