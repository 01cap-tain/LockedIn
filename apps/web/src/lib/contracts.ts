import { Contract, Interface, formatUnits, getAddress, parseUnits, type Log, type Signer } from 'ethers'

const factoryAbi = [
  'function asset() view returns (address)',
  'function createPersonalVault(uint256 target,uint64 maturity,uint16 emergencyBps) returns (address)',
  'function createGroupVault(address[] members,uint256[] targets,uint16[] emergencyBps,uint64 maturity) returns (address)',
  'function vaultCount() view returns (uint256)',
  'function vaultAt(uint256 index) view returns (address)',
  'function vaultsOf(address member) view returns (address[])',
  'function earlyExitMarket() view returns (address)',
  'event VaultCreated(address indexed vault,address indexed creator,bool indexed isGroup,uint64 maturity)',
] as const

const vaultAbi = [
  'function asset() view returns (address)',
  'function maturity() view returns (uint64)',
  'function isGroup() view returns (bool)',
  'function memberCount() view returns (uint256)',
  'function memberAt(uint256 positionId) view returns (address)',
  'function positionOwner(uint256 positionId) view returns (address)',
  'function rewardDisqualified(uint256 positionId) view returns (bool)',
  'function positionOf(address member) view returns (uint256)',
  'function position(uint256 positionId) view returns (address member,uint256 target,uint256 deposited,uint256 emergencyBalance,uint256 lockedBalance,uint16 emergencyBps,bool lockedWithdrawn)',
  'function goalComplete(uint256 positionId) view returns (bool)',
  'function deposit(uint256 positionId,uint256 amount)',
  'function withdrawEmergency(uint256 positionId,uint256 amount)',
  'event Deposited(uint256 indexed positionId,address indexed member,uint256 amount,uint256 emergencyAmount,uint256 lockedAmount)',
  'event EmergencyWithdrawn(uint256 indexed positionId,address indexed member,uint256 amount)',
  'event LockedWithdrawn(uint256 indexed positionId,address indexed owner,uint256 amount)',
  'event PositionTransferred(uint256 indexed positionId,address indexed previousOwner,address indexed newOwner)',
  'event RewardEligibilityRevoked(uint256 indexed positionId,address indexed member)',
] as const

const tokenAbi = ['function approve(address spender,uint256 amount) returns (bool)'] as const

const marketAbi = [
  'function activeListing(address vault,uint256 positionId) view returns (uint256)',
  'function nextListingId() view returns (uint256)',
  'function createListing(address vault,uint256 positionId,uint64 expiresAt) returns (uint256)',
  'function cancelListing(uint256 listingId)',
  'function submitOffer(uint256 listingId,uint16 discountBps,uint64 expiresAt) returns (uint256)',
  'function cancelOffer(uint256 listingId,uint256 offerId)',
  'function rejectOffer(uint256 listingId,uint256 offerId)',
  'function acceptOffer(uint256 listingId,uint256 offerId)',
  'function listings(uint256 listingId) view returns (address vault,uint256 positionId,address seller,uint256 positionValue,uint16 systemDiscountBps,uint64 expiresAt,bool active)',
  'function offerCount(uint256 listingId) view returns (uint256)',
  'function offers(uint256 listingId,uint256 offerId) view returns (address provider,uint16 discountBps,uint64 expiresAt,bool active)',
  'function claimValue(uint256 positionValue,uint16 discountBps) view returns (uint256)',
  'function feeFor(uint256 sellerReceives) view returns (uint256)',
  'function referenceDiscount(address vault,uint256 positionId) view returns ((uint16 discountBps,uint16 remainingDaysScore,uint16 timeWeightedProgressScore,uint16 consistencyScore,uint16 positionValueScore))',
  'event ListingCreated(uint256 indexed listingId,address indexed vault,uint256 indexed positionId,address seller,uint256 positionValue,uint16 systemDiscountBps,uint64 expiresAt)',
  'event ListingCancelled(uint256 indexed listingId)',
  'event ListingExpired(uint256 indexed listingId)',
  'event OfferSubmitted(uint256 indexed listingId,uint256 indexed offerId,address indexed provider,uint16 discountBps,uint64 expiresAt)',
  'event OfferRejected(uint256 indexed listingId,uint256 indexed offerId)',
  'event OfferAccepted(uint256 indexed listingId,uint256 indexed offerId,address indexed provider,uint256 sellerReceives,uint256 providerFee)',
] as const

const USDT_DECIMALS = 6

export interface CreateVaultInput {
  mode: 'personal' | 'group'
  target: string
  maturity: string
  emergencyPercent: number
  additionalMembers: string[]
}

export interface VaultSnapshot {
  address: string
  signerAddress: string
  positionId: bigint
  target: string
  deposited: string
  emergencyBalance: string
  lockedBalance: string
  emergencyPercent: number
  goalComplete: boolean
  lockedWithdrawn: boolean
  maturity: Date
  isGroup: boolean
  members: VaultMemberSnapshot[]
}

export interface VaultMemberSnapshot {
  positionId: bigint
  member: string
  owner: string
  target: string
  deposited: string
  emergencyBalance: string
  lockedBalance: string
  goalComplete: boolean
  rewardDisqualified: boolean
  lockedWithdrawn: boolean
}

export interface VaultSummary {
  address: string
  isGroup: boolean
  maturity: Date
  memberCount: number
}

export interface ReferenceDiscountSnapshot {
  discountPercent: number
  remainingDaysScore: number
  timeWeightedProgressScore: number
  consistencyScore: number
  positionValueScore: number
}

export interface OfferSnapshot {
  id: bigint
  provider: string
  discountPercent: number
  sellerReceives: string
  providerFee: string
  expiresAt: Date
  active: boolean
}

export interface ExitListingSnapshot {
  marketAddress: string
  reference: ReferenceDiscountSnapshot
  listing: null | {
    id: bigint
    vault: string
    positionId: bigint
    isGroup: boolean
    seller: string
    positionValue: string
    systemDiscountPercent: number
    expiresAt: Date
    active: boolean
    status: 'active' | 'expired' | 'cancelled-or-sold'
    offers: OfferSnapshot[]
  }
}

export interface ActivityItem {
  id: string
  blockNumber: number
  transactionHash: string
  title: string
  detail: string
  vault?: string
  timestamp: Date
}

function factoryAddress(): string {
  const configured = import.meta.env.VITE_FACTORY_ADDRESS
  if (!configured || /^0x0{40}$/i.test(configured)) {
    throw new Error('Set VITE_FACTORY_ADDRESS to the deployed VaultFactory address.')
  }
  return getAddress(configured)
}

function factoryFor(signer: Signer): Contract {
  return new Contract(factoryAddress(), factoryAbi, signer)
}

async function assertFactoryDeployment(signer: Signer): Promise<void> {
  const provider = signer.provider
  if (!provider || await provider.getCode(factoryAddress()) === '0x') {
    throw new Error('No VaultFactory contract exists at the configured address on this network. Redeploy it and restart the app.')
  }
}

async function marketFor(signer: Signer): Promise<Contract> {
  const address = await factoryFor(signer).getFunction('earlyExitMarket')()
  return new Contract(address, marketAbi, signer)
}

function amount(value: string): bigint {
  const parsed = parseUnits(value, USDT_DECIMALS)
  if (parsed <= 0n) throw new Error('Amount must be greater than zero.')
  return parsed
}

export async function createVault(signer: Signer, input: CreateVaultInput): Promise<string> {
  await assertFactoryDeployment(signer)
  const factory = factoryFor(signer)
  const signerAddress = await signer.getAddress()
  const target = amount(input.target)
  const maturity = BigInt(Math.floor(new Date(input.maturity).getTime() / 1_000))
  if (maturity <= BigInt(Math.floor(Date.now() / 1_000))) throw new Error('Maturity must be in the future.')
  const emergencyBps = input.emergencyPercent * 100

  if (input.mode === 'personal') {
    await (await factory.getFunction('createPersonalVault')(target, maturity, emergencyBps)).wait()
  } else {
    const members = [signerAddress, ...input.additionalMembers.map(getAddress)]
    if (members.length < 2) throw new Error('Add at least one other EVM member address.')
    if (new Set(members.map((member) => member.toLowerCase())).size !== members.length) {
      throw new Error('Group member addresses must be unique.')
    }
    await (
      await factory.getFunction('createGroupVault')(
        members,
        members.map(() => target),
        members.map(() => emergencyBps),
        maturity,
      )
    ).wait()
  }

  const count: bigint = await factory.getFunction('vaultCount')()
  return getAddress(await factory.getFunction('vaultAt')(count - 1n))
}

export async function loadVault(signer: Signer, address: string): Promise<VaultSnapshot> {
  const signerAddress = await signer.getAddress()
  const vaultAddress = getAddress(address)
  const vault = new Contract(vaultAddress, vaultAbi, signer)
  const positionId: bigint = await vault.getFunction('positionOf')(signerAddress)
  const [stored, completed, maturity, isGroup, memberCount] = await Promise.all([
    vault.getFunction('position')(positionId),
    vault.getFunction('goalComplete')(positionId),
    vault.getFunction('maturity')(),
    vault.getFunction('isGroup')(),
    vault.getFunction('memberCount')(),
  ])
  const members: VaultMemberSnapshot[] = await Promise.all(
    Array.from({ length: Number(memberCount) }, async (_, index) => {
      const memberPosition = await vault.getFunction('position')(index)
      const [owner, memberComplete, rewardDisqualified] = await Promise.all([
        vault.getFunction('positionOwner')(index),
        vault.getFunction('goalComplete')(index),
        vault.getFunction('rewardDisqualified')(index),
      ])
      return {
        positionId: BigInt(index),
        member: getAddress(memberPosition.member),
        owner: getAddress(owner),
        target: formatUnits(memberPosition.target, USDT_DECIMALS),
        deposited: formatUnits(memberPosition.deposited, USDT_DECIMALS),
        emergencyBalance: formatUnits(memberPosition.emergencyBalance, USDT_DECIMALS),
        lockedBalance: formatUnits(memberPosition.lockedBalance, USDT_DECIMALS),
        goalComplete: memberComplete,
        rewardDisqualified,
        lockedWithdrawn: memberPosition.lockedWithdrawn,
      }
    }),
  )
  return {
    address: vaultAddress,
    signerAddress,
    positionId,
    target: formatUnits(stored.target, USDT_DECIMALS),
    deposited: formatUnits(stored.deposited, USDT_DECIMALS),
    emergencyBalance: formatUnits(stored.emergencyBalance, USDT_DECIMALS),
    lockedBalance: formatUnits(stored.lockedBalance, USDT_DECIMALS),
    emergencyPercent: Number(stored.emergencyBps) / 100,
    goalComplete: completed,
    lockedWithdrawn: stored.lockedWithdrawn,
    maturity: new Date(Number(maturity) * 1_000),
    isGroup,
    members,
  }
}

export async function loadVaultsForSigner(signer: Signer): Promise<VaultSummary[]> {
  await assertFactoryDeployment(signer)
  const factory = factoryFor(signer)
  const addresses: string[] = await factory.getFunction('vaultsOf')(await signer.getAddress())
  return Promise.all(addresses.map(async (address) => {
    const vault = new Contract(address, vaultAbi, signer)
    const [isGroup, maturity, memberCount] = await Promise.all([
      vault.getFunction('isGroup')(),
      vault.getFunction('maturity')(),
      vault.getFunction('memberCount')(),
    ])
    return {
      address: getAddress(address),
      isGroup,
      maturity: new Date(Number(maturity) * 1_000),
      memberCount: Number(memberCount),
    }
  }))
}

export async function depositToVault(signer: Signer, vaultAddress: string, positionId: bigint, value: string): Promise<void> {
  const vault = new Contract(getAddress(vaultAddress), vaultAbi, signer)
  const token = new Contract(await vault.getFunction('asset')(), tokenAbi, signer)
  const parsed = amount(value)
  await (await token.getFunction('approve')(await vault.getAddress(), parsed)).wait()
  await (await vault.getFunction('deposit')(positionId, parsed)).wait()
}

export async function withdrawEmergency(signer: Signer, vaultAddress: string, positionId: bigint, value: string): Promise<void> {
  const vault = new Contract(getAddress(vaultAddress), vaultAbi, signer)
  await (await vault.getFunction('withdrawEmergency')(positionId, amount(value))).wait()
}

export async function loadExitMarket(signer: Signer, vault: VaultSnapshot): Promise<ExitListingSnapshot> {
  const market = await marketFor(signer)
  const marketAddress = await market.getAddress()
  const reference = await market.getFunction('referenceDiscount')(vault.address, vault.positionId)
  const listingIdPlusOne: bigint = await market.getFunction('activeListing')(vault.address, vault.positionId)
  const referenceSnapshot: ReferenceDiscountSnapshot = {
    discountPercent: Number(reference.discountBps) / 100,
    remainingDaysScore: Number(reference.remainingDaysScore),
    timeWeightedProgressScore: Number(reference.timeWeightedProgressScore),
    consistencyScore: Number(reference.consistencyScore),
    positionValueScore: Number(reference.positionValueScore),
  }
  if (listingIdPlusOne === 0n) return { marketAddress, reference: referenceSnapshot, listing: null }

  const listingId = listingIdPlusOne - 1n
  const listing = await market.getFunction('listings')(listingId)
  const isGroup: boolean = await new Contract(listing.vault, vaultAbi, signer).getFunction('isGroup')()
  const count: bigint = await market.getFunction('offerCount')(listingId)
  const offers = await Promise.all(Array.from({ length: Number(count) }, async (_, index) => {
    const offer = await market.getFunction('offers')(listingId, index)
    const sellerReceives: bigint = await market.getFunction('claimValue')(listing.positionValue, offer.discountBps)
    const providerFee: bigint = await market.getFunction('feeFor')(sellerReceives)
    return {
      id: BigInt(index),
      provider: getAddress(offer.provider),
      discountPercent: Number(offer.discountBps) / 100,
      sellerReceives: formatUnits(sellerReceives, USDT_DECIMALS),
      providerFee: formatUnits(providerFee, USDT_DECIMALS),
      expiresAt: new Date(Number(offer.expiresAt) * 1_000),
      active: offer.active,
    }
  }))

  return {
    marketAddress,
    reference: referenceSnapshot,
    listing: {
      id: listingId,
      vault: getAddress(listing.vault),
      positionId: listing.positionId,
      isGroup,
      seller: getAddress(listing.seller),
      positionValue: formatUnits(listing.positionValue, USDT_DECIMALS),
      systemDiscountPercent: Number(listing.systemDiscountBps) / 100,
      expiresAt: new Date(Number(listing.expiresAt) * 1_000),
      active: listing.active && Number(listing.expiresAt) * 1_000 > Date.now(),
      status: listing.active && Number(listing.expiresAt) * 1_000 > Date.now()
        ? 'active'
        : listing.active ? 'expired' : 'cancelled-or-sold',
      offers,
    },
  }
}

export async function loadExitListing(signer: Signer, listingId: bigint): Promise<ExitListingSnapshot> {
  const market = await marketFor(signer)
  const listing = await market.getFunction('listings')(listingId)
  if (listing.vault === '0x0000000000000000000000000000000000000000') {
    throw new Error('Listing does not exist.')
  }
  const reference = await market.getFunction('referenceDiscount')(listing.vault, listing.positionId)
  const isGroup: boolean = await new Contract(listing.vault, vaultAbi, signer).getFunction('isGroup')()
  const count: bigint = await market.getFunction('offerCount')(listingId)
  const offers = await Promise.all(Array.from({ length: Number(count) }, async (_, index) => {
    const offer = await market.getFunction('offers')(listingId, index)
    const sellerReceives: bigint = await market.getFunction('claimValue')(listing.positionValue, offer.discountBps)
    const providerFee: bigint = await market.getFunction('feeFor')(sellerReceives)
    return {
      id: BigInt(index),
      provider: getAddress(offer.provider),
      discountPercent: Number(offer.discountBps) / 100,
      sellerReceives: formatUnits(sellerReceives, USDT_DECIMALS),
      providerFee: formatUnits(providerFee, USDT_DECIMALS),
      expiresAt: new Date(Number(offer.expiresAt) * 1_000),
      active: offer.active,
    }
  }))
  return {
    marketAddress: await market.getAddress(),
    reference: {
      discountPercent: Number(reference.discountBps) / 100,
      remainingDaysScore: Number(reference.remainingDaysScore),
      timeWeightedProgressScore: Number(reference.timeWeightedProgressScore),
      consistencyScore: Number(reference.consistencyScore),
      positionValueScore: Number(reference.positionValueScore),
    },
    listing: {
      id: listingId,
      vault: getAddress(listing.vault),
      positionId: listing.positionId,
      isGroup,
      seller: getAddress(listing.seller),
      positionValue: formatUnits(listing.positionValue, USDT_DECIMALS),
      systemDiscountPercent: Number(listing.systemDiscountBps) / 100,
      expiresAt: new Date(Number(listing.expiresAt) * 1_000),
      active: listing.active && Number(listing.expiresAt) * 1_000 > Date.now(),
      status: listing.active && Number(listing.expiresAt) * 1_000 > Date.now()
        ? 'active'
        : listing.active ? 'expired' : 'cancelled-or-sold',
      offers,
    },
  }
}

export async function loadAllExitListings(signer: Signer): Promise<ExitListingSnapshot[]> {
  const market = await marketFor(signer)
  const count: bigint = await market.getFunction('nextListingId')()
  return Promise.all(Array.from({ length: Number(count) }, (_, index) => loadExitListing(signer, BigInt(index))))
}

export async function createExitListing(
  signer: Signer,
  vault: VaultSnapshot,
  expiresAt: string,
): Promise<void> {
  const market = await marketFor(signer)
  const expiration = BigInt(Math.floor(new Date(expiresAt).getTime() / 1_000))
  await (
    await market.getFunction('createListing')(
      vault.address,
      vault.positionId,
      expiration,
    )
  ).wait()
}

export async function submitExitOffer(
  signer: Signer,
  listingId: bigint,
  discountPercent: number,
  expiresAt: string,
): Promise<void> {
  const market = await marketFor(signer)
  const listing = await market.getFunction('listings')(listingId)
  const discountBps = Math.round(discountPercent * 100)
  const sellerReceives: bigint = await market.getFunction('claimValue')(listing.positionValue, discountBps)
  const providerFee: bigint = await market.getFunction('feeFor')(sellerReceives)
  const token = new Contract(await factoryFor(signer).getFunction('asset')(), tokenAbi, signer)
  await (await token.getFunction('approve')(await market.getAddress(), sellerReceives + providerFee)).wait()
  await (
    await market.getFunction('submitOffer')(
      listingId,
      discountBps,
      BigInt(Math.floor(new Date(expiresAt).getTime() / 1_000)),
    )
  ).wait()
}

export async function cancelExitListing(signer: Signer, listingId: bigint): Promise<void> {
  const market = await marketFor(signer)
  await (await market.getFunction('cancelListing')(listingId)).wait()
}

export async function rejectExitOffer(signer: Signer, listingId: bigint, offerId: bigint): Promise<void> {
  const market = await marketFor(signer)
  await (await market.getFunction('rejectOffer')(listingId, offerId)).wait()
}

export async function cancelExitOffer(signer: Signer, listingId: bigint, offerId: bigint): Promise<void> {
  const market = await marketFor(signer)
  await (await market.getFunction('cancelOffer')(listingId, offerId)).wait()
}

export async function acceptExitOffer(signer: Signer, listingId: bigint, offer: OfferSnapshot): Promise<void> {
  const market = await marketFor(signer)
  await (await market.getFunction('acceptOffer')(listingId, offer.id)).wait()
}

function parsedEvent(log: Log, abi: readonly string[]) {
  try {
    return new Interface(abi).parseLog({ topics: [...log.topics], data: log.data })
  } catch {
    return null
  }
}

export async function loadActivity(signer: Signer, vaultAddresses: string[]): Promise<ActivityItem[]> {
  const provider = signer.provider
  if (!provider) throw new Error('The connected wallet has no readable provider.')
  const fromBlock = Number(import.meta.env.VITE_CONTRACT_START_BLOCK ?? 0)
  const market = await marketFor(signer)
  const marketAddress = await market.getAddress()
  const normalizedVaults = new Set(vaultAddresses.map((address) => address.toLowerCase()))
  const [factoryLogs, marketLogs, vaultLogGroups] = await Promise.all([
    provider.getLogs({ address: factoryAddress(), fromBlock, toBlock: 'latest' }),
    provider.getLogs({ address: marketAddress, fromBlock, toBlock: 'latest' }),
    Promise.all(vaultAddresses.map((address) => provider.getLogs({ address, fromBlock, toBlock: 'latest' }))),
  ])

  const relevantListings = new Set<string>()
  for (const log of marketLogs) {
    const event = parsedEvent(log, marketAbi)
    if (event?.name === 'ListingCreated' && normalizedVaults.has(String(event.args.vault).toLowerCase())) {
      relevantListings.add(event.args.listingId.toString())
    }
  }

  const entries: Array<Omit<ActivityItem, 'timestamp'>> = []
  const push = (log: Log, title: string, detail: string, vault?: string) => entries.push({
    id: `${log.transactionHash}-${log.index}`,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    title,
    detail,
    vault,
  })

  for (const log of factoryLogs) {
    const event = parsedEvent(log, factoryAbi)
    if (event?.name !== 'VaultCreated' || !normalizedVaults.has(String(event.args.vault).toLowerCase())) continue
    push(log, event.args.isGroup ? 'Group vault created' : 'Personal vault created', shortAddress(event.args.vault), event.args.vault)
  }
  for (const logs of vaultLogGroups) {
    for (const log of logs) {
      const event = parsedEvent(log, vaultAbi)
      if (!event) continue
      const vault = getAddress(log.address)
      if (event.name === 'Deposited') push(log, 'Deposit confirmed', `${formatUnits(event.args.amount, USDT_DECIMALS)} mUSDT`, vault)
      if (event.name === 'EmergencyWithdrawn') push(log, 'Emergency funds withdrawn', `${formatUnits(event.args.amount, USDT_DECIMALS)} mUSDT`, vault)
      if (event.name === 'LockedWithdrawn') push(log, 'Locked claim withdrawn', `${formatUnits(event.args.amount, USDT_DECIMALS)} mUSDT`, vault)
      if (event.name === 'PositionTransferred') push(log, 'Locked position sold', `${shortAddress(event.args.previousOwner)} → ${shortAddress(event.args.newOwner)}`, vault)
      if (event.name === 'RewardEligibilityRevoked') push(log, 'Reward eligibility ended', shortAddress(event.args.member), vault)
    }
  }
  for (const log of marketLogs) {
    const event = parsedEvent(log, marketAbi)
    if (!event) continue
    const listingId = event.args.listingId?.toString()
    if (!listingId || !relevantListings.has(listingId)) continue
    if (event.name === 'ListingCreated') push(log, `Listing #${listingId} created`, `${Number(event.args.systemDiscountBps) / 100}% system discount`, event.args.vault)
    if (event.name === 'ListingCancelled') push(log, `Listing #${listingId} cancelled`, 'The position may be relisted.')
    if (event.name === 'ListingExpired') push(log, `Listing #${listingId} expired`, 'The position was released for relisting.')
    if (event.name === 'OfferSubmitted') push(log, `Offer #${event.args.offerId} submitted`, `${Number(event.args.discountBps) / 100}% discount`)
    if (event.name === 'OfferRejected') push(log, `Offer #${event.args.offerId} closed`, `Listing #${listingId}`)
    if (event.name === 'OfferAccepted') push(log, `Offer #${event.args.offerId} accepted`, `${formatUnits(event.args.sellerReceives, USDT_DECIMALS)} mUSDT paid to saver`)
  }

  const blocks = new Map<number, Date>()
  await Promise.all([...new Set(entries.map((entry) => entry.blockNumber))].map(async (blockNumber) => {
    const block = await provider.getBlock(blockNumber)
    blocks.set(blockNumber, new Date(Number(block?.timestamp ?? 0) * 1_000))
  }))
  return entries
    .map((entry) => ({ ...entry, timestamp: blocks.get(entry.blockNumber) ?? new Date(0) }))
    .sort((a, b) => b.blockNumber - a.blockNumber)
}

function shortAddress(value: string): string {
  const address = String(value)
  return `${address.slice(0, 8)}…${address.slice(-6)}`
}

export function describeContractError(error: unknown): string {
  if (error instanceof Error) {
    const reason = 'reason' in error && typeof error.reason === 'string' ? error.reason : null
    return reason ?? error.message.replace(/^execution reverted:\s*/i, '')
  }
  return 'The contract transaction failed.'
}
