import { Contract, JsonRpcProvider, formatUnits, getAddress, parseUnits } from 'ethers'

const factoryAbi = [
  'function asset() view returns (address)',
  'function createPersonalVault(uint256 target,uint64 maturity,uint16 emergencyBps) returns (address)',
  'function createGroupVault(address[] members,uint256[] targets,uint16[] emergencyBps,uint64 maturity) returns (address)',
  'function vaultCount() view returns (uint256)',
  'function vaultAt(uint256 index) view returns (address)',
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

const tokenAbi = [
  'function approve(address spender,uint256 amount) returns (bool)',
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
  maturity: Date
}

function config(): { rpcUrl: string; factoryAddress: string } {
  const rpcUrl = import.meta.env.VITE_HARDHAT_RPC_URL ?? 'http://127.0.0.1:8545'
  const factoryAddress = import.meta.env.VITE_FACTORY_ADDRESS
  if (!factoryAddress || /^0x0{40}$/i.test(factoryAddress)) {
    throw new Error('Set VITE_FACTORY_ADDRESS to the locally deployed VaultFactory address.')
  }
  return { rpcUrl, factoryAddress: getAddress(factoryAddress) }
}

async function localContext() {
  const { rpcUrl, factoryAddress } = config()
  const provider = new JsonRpcProvider(rpcUrl)
  const signer = await provider.getSigner(0)
  const signerAddress = await signer.getAddress()
  return {
    signer,
    signerAddress,
    factory: new Contract(factoryAddress, factoryAbi, signer),
  }
}

function amount(value: string): bigint {
  const parsed = parseUnits(value, USDT_DECIMALS)
  if (parsed <= 0n) throw new Error('Amount must be greater than zero.')
  return parsed
}

export async function getLocalSignerAddress(): Promise<string> {
  return (await localContext()).signerAddress
}

export async function createVault(input: CreateVaultInput): Promise<string> {
  const { factory, signerAddress } = await localContext()
  const target = amount(input.target)
  const maturity = BigInt(Math.floor(new Date(input.maturity).getTime() / 1_000))
  if (maturity <= BigInt(Math.floor(Date.now() / 1_000))) {
    throw new Error('Maturity must be in the future.')
  }
  const emergencyBps = input.emergencyPercent * 100

  if (input.mode === 'personal') {
    const createPersonal = factory.getFunction('createPersonalVault')
    await (await createPersonal(target, maturity, emergencyBps)).wait()
  } else {
    const members = [signerAddress, ...input.additionalMembers.map(getAddress)]
    if (members.length < 2) throw new Error('Add at least one other EVM member address.')
    const uniqueMembers = [...new Set(members.map((member) => member.toLowerCase()))]
    if (uniqueMembers.length !== members.length) throw new Error('Group member addresses must be unique.')
    const createGroup = factory.getFunction('createGroupVault')
    await (
      await createGroup(
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

export async function loadVault(address: string): Promise<VaultSnapshot> {
  const { signer, signerAddress } = await localContext()
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
    maturity: new Date(Number(maturity) * 1_000),
  }
}

export async function depositToVault(vaultAddress: string, positionId: bigint, value: string): Promise<void> {
  const { signer } = await localContext()
  const vault = new Contract(getAddress(vaultAddress), vaultAbi, signer)
  const token = new Contract(await vault.getFunction('asset')(), tokenAbi, signer)
  const parsed = amount(value)
  await (await token.getFunction('approve')(await vault.getAddress(), parsed)).wait()
  await (await vault.getFunction('deposit')(positionId, parsed)).wait()
}

export async function withdrawEmergency(
  vaultAddress: string,
  positionId: bigint,
  value: string,
): Promise<void> {
  const { signer } = await localContext()
  const vault = new Contract(getAddress(vaultAddress), vaultAbi, signer)
  await (await vault.getFunction('withdrawEmergency')(positionId, amount(value))).wait()
}

export function describeContractError(error: unknown): string {
  if (error instanceof Error) {
    const reason = 'reason' in error && typeof error.reason === 'string' ? error.reason : null
    return reason ?? error.message.replace(/^execution reverted:\s*/i, '')
  }
  return 'The local contract transaction failed.'
}
