export type FinancialAction =
  | "USDT_APPROVAL"
  | "VAULT_CREATION"
  | "DEPOSIT"
  | "EMERGENCY_WITHDRAWAL"
  | "MATURED_CLAIM"
  | "EXIT_LISTING"
  | "LISTING_CANCELLATION"
  | "EXIT_PURCHASE"
  | "COOPERATIVE_EXIT"
  | "REWARD_CLAIM";

export type RecoveryState =
  | "AWAITING_WALLET_APPROVAL"
  | "SUBMITTED"
  | "CONFIRMING"
  | "CONFIRMED"
  | "REJECTED"
  | "FAILED"
  | "REPLACED"
  | "DROPPED"
  | "CANCELLED"
  | "OUTCOME_UNKNOWN";

export interface RecoverableOperation {
  version: 1;
  operationId: string;
  account: string;
  chainId: string;
  transactionHash?: string;
  replacementHash?: string;
  nonce?: number;
  action: FinancialAction;
  targetContract: string;
  expectedEvent: string;
  expectedArguments: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  state: RecoveryState;
  failureReason?: string;
}

const STORAGE_KEY = "lockedin-polygon-operations-v1";

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadRecoverableOperations(): RecoverableOperation[] {
  const value = storage()?.getItem(STORAGE_KEY);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as RecoverableOperation[];
    return Array.isArray(parsed) ? parsed.filter((entry) => entry?.version === 1) : [];
  } catch {
    return [];
  }
}

function save(operations: RecoverableOperation[]): void {
  storage()?.setItem(STORAGE_KEY, JSON.stringify(operations.slice(-100)));
}

export function recordSubmittedOperation(
  operation: Omit<RecoverableOperation, "version" | "operationId" | "transactionHash" | "createdAt" | "updatedAt" | "state">
    & { transactionHash: string }
): RecoverableOperation {
  const now = new Date().toISOString();
  const entry: RecoverableOperation = {
    ...operation,
    version: 1,
    operationId: `${operation.chainId}:${operation.transactionHash.toLowerCase()}`,
    createdAt: now,
    updatedAt: now,
    state: "SUBMITTED",
  };
  const existing = loadRecoverableOperations();
  save([...existing.filter((item) => item.operationId !== entry.operationId), entry]);
  return entry;
}

export function recordAwaitingOperation(
  operation: Omit<RecoverableOperation, "version" | "operationId" | "transactionHash" | "createdAt" | "updatedAt" | "state">
): RecoverableOperation {
  const now = new Date().toISOString();
  const entropy = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const entry: RecoverableOperation = {
    ...operation,
    version: 1,
    operationId: `${operation.chainId}:pending:${entropy}`,
    createdAt: now,
    updatedAt: now,
    state: "AWAITING_WALLET_APPROVAL",
  };
  save([...loadRecoverableOperations(), entry]);
  return entry;
}

export function attachSubmittedTransaction(
  operationId: string,
  transactionHash: string,
  nonce?: number
): RecoverableOperation | null {
  const operations = loadRecoverableOperations();
  const index = operations.findIndex((entry) => entry.operationId === operationId);
  const current = operations[index];
  if (index < 0 || !current) return null;
  const updated: RecoverableOperation = {
    ...current,
    transactionHash,
    nonce,
    state: "SUBMITTED",
    updatedAt: new Date().toISOString(),
  };
  operations[index] = updated;
  save(operations);
  return updated;
}

export function updateRecoverableOperation(
  operationId: string,
  state: RecoveryState,
  details: Pick<RecoverableOperation, "replacementHash" | "failureReason"> = {}
): RecoverableOperation | null {
  const operations = loadRecoverableOperations();
  const index = operations.findIndex((entry) => entry.operationId === operationId);
  if (index < 0) return null;
  const current = operations[index];
  if (!current) return null;
  const updated: RecoverableOperation = {
    ...current,
    ...details,
    state,
    updatedAt: new Date().toISOString(),
  };
  operations[index] = updated;
  save(operations);
  return updated;
}

export function pendingOperationsFor(account: string, chainId: bigint): RecoverableOperation[] {
  const terminal = new Set<RecoveryState>(["CONFIRMED", "REJECTED", "FAILED", "DROPPED", "CANCELLED"]);
  return loadRecoverableOperations().filter((entry) =>
    entry.account.toLowerCase() === account.toLowerCase()
    && entry.chainId === chainId.toString()
    && !terminal.has(entry.state)
  );
}
