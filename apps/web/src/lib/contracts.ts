import { Contract, formatUnits, getAddress, parseUnits, type Signer } from 'ethers'

const factoryAbi = [
  'function asset() view returns (address)',
  'function createPersonalVault(uint256 target,uint64 maturity,uint16 emergencyBps) returns (address)',
  'function createGroupVault(address[] members,uint256[] targets,uint16[] emergencyBps,uint64 maturity) returns (address)',
  'function vaultCount() view returns (uint256)',
  'function vaultAt(uint256 index) view returns (address)',
  'function earlyExitMarket() view returns (address)',
] as const

const vaultAbi = [
  'function asset() view returns (address)',
  'function maturity() view returns (uint64)',
  'function positionOf(address member) view returns (uint256)',
  'function position(uint256 positionId) view returns (address member,uint256 target,uint256 deposited,uint256 emergencyBalance,uint256 lockedBalance,uint16 emergencyBps,bool lockedWithdrawn)',
  'function goalComplete(uint256 positionId) view returns (bool)',
  'function deposit(uint256 positionId,uint256 amount)',
  'function withdrawEmergency(uint256 positionId,uint256 amount)',
] as const

const tokenAbi = ['function approve(address spender,uint256 amount) returns (bool)'] as const

const marketAbi = [
  'function activeListing(address vault,uint256 positionId) view returns (uint256)',
  'function nextListingId() view returns (uint256)',
  'function createListing(address vault,uint256 positionId,uint16 askingDiscountBps,uint64 expiresAt) returns (uint256)',
  'function cancelListing(uint256 listingId)',
  'function submitOffer(uint256 listingId,uint16 discountBps,uint64 expiresAt) returns (uint256)',
  'function cancelOffer(uint256 listingId,uint256 offerId)',
  'function rejectOffer(uint256 listingId,uint256 offerId)',
  'function acceptOffer(uint256 listingId,uint256 offerId)',
  'function listings(uint256 listingId) view returns (address vault,uint256 positionId,address seller,uint256 positionValue,uint16 askingDiscountBps,uint64 expiresAt,bool active)',
  'function offerCount(uint256 listingId) view returns (uint256)',
  'function offers(uint256 listingId,uint256 offerId) view returns (address provider,uint16 discountBps,uint64 expiresAt,bool active)',
  'function claimValue(uint256 positionValue,uint16 discountBps) view returns (uint256)',
  'function feeFor(uint256 sellerReceives) view returns (uint256)',
  'function referenceDiscount(address vault,uint256 positionId) view returns ((uint16 discountBps,uint16 remainingDaysScore,uint16 timeWeightedProgressScore,uint16 consistencyScore,uint16 positionValueScore))',
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
    seller: string
    positionValue: string
    askingDiscountPercent: number
    expiresAt: Date
    active: boolean
    offers: OfferSnapshot[]
  }
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
  const [stored, completed, maturity] = await Promise.all([
    vault.getFunction('position')(positionId),
    vault.getFunction('goalComplete')(positionId),
    vault.getFunction('maturity')(),
  ])
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
  }
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
      seller: getAddress(listing.seller),
      positionValue: formatUnits(listing.positionValue, USDT_DECIMALS),
      askingDiscountPercent: Number(listing.askingDiscountBps) / 100,
      expiresAt: new Date(Number(listing.expiresAt) * 1_000),
      active: listing.active,
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
      seller: getAddress(listing.seller),
      positionValue: formatUnits(listing.positionValue, USDT_DECIMALS),
      askingDiscountPercent: Number(listing.askingDiscountBps) / 100,
      expiresAt: new Date(Number(listing.expiresAt) * 1_000),
      active: listing.active,
      offers,
    },
  }
}

export async function createExitListing(
  signer: Signer,
  vault: VaultSnapshot,
  discountPercent: number,
  expiresAt: string,
): Promise<void> {
  const market = await marketFor(signer)
  const expiration = BigInt(Math.floor(new Date(expiresAt).getTime() / 1_000))
  await (
    await market.getFunction('createListing')(
      vault.address,
      vault.positionId,
      Math.round(discountPercent * 100),
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

export function describeContractError(error: unknown): string {
  if (error instanceof Error) {
    const reason = 'reason' in error && typeof error.reason === 'string' ? error.reason : null
    return reason ?? error.message.replace(/^execution reverted:\s*/i, '')
  }
  return 'The contract transaction failed.'
}
