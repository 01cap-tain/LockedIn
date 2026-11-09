import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  attachSubmittedTransaction,
  loadRecoverableOperations,
  pendingOperationsFor,
  recordAwaitingOperation,
  recordSubmittedOperation,
  updateRecoverableOperation,
} from "./transaction-recovery";

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
});

describe("durable Polygon operation metadata", () => {
  it("persists wallet approval before a transaction hash exists, then attaches the submission", () => {
    const awaiting = recordAwaitingOperation({
      account: "0x1111111111111111111111111111111111111111",
      chainId: "137",
      action: "DEPOSIT",
      targetContract: "0x2222222222222222222222222222222222222222",
      expectedEvent: "Deposited",
      expectedArguments: { positionId: "1" },
    });
    expect(awaiting.state).toBe("AWAITING_WALLET_APPROVAL");
    expect(awaiting.transactionHash).toBeUndefined();
    const submitted = attachSubmittedTransaction(awaiting.operationId, `0x${"12".repeat(32)}`, 9);
    expect(submitted).toMatchObject({ state: "SUBMITTED", nonce: 9 });
  });
  it("persists only reconstructable non-secret transaction metadata", () => {
    const operation = recordSubmittedOperation({
      account: "0x1111111111111111111111111111111111111111",
      chainId: "137",
      transactionHash: `0x${"ab".repeat(32)}`,
      nonce: 7,
      action: "DEPOSIT",
      targetContract: "0x2222222222222222222222222222222222222222",
      expectedEvent: "Deposited",
      expectedArguments: { positionId: "0", amount: "1000000" },
    });

    expect(loadRecoverableOperations()).toEqual([operation]);
    expect(JSON.stringify(operation)).not.toMatch(/private|mnemonic|signature/i);
  });

  it("keeps unknown outcomes pending and removes confirmed operations from recovery", () => {
    const operation = recordSubmittedOperation({
      account: "0x1111111111111111111111111111111111111111",
      chainId: "137",
      transactionHash: `0x${"cd".repeat(32)}`,
      action: "EXIT_PURCHASE",
      targetContract: "0x2222222222222222222222222222222222222222",
      expectedEvent: "ListingFunded",
      expectedArguments: { listingId: "4" },
    });
    updateRecoverableOperation(operation.operationId, "OUTCOME_UNKNOWN");
    expect(pendingOperationsFor(operation.account, 137n)).toHaveLength(1);
    updateRecoverableOperation(operation.operationId, "CONFIRMED");
    expect(pendingOperationsFor(operation.account, 137n)).toHaveLength(0);
  });

  it("keeps a replacement recoverable under the original operation identity", () => {
    const operation = recordSubmittedOperation({
      account: "0x1111111111111111111111111111111111111111",
      chainId: "137",
      transactionHash: `0x${"34".repeat(32)}`,
      nonce: 11,
      action: "EXIT_PURCHASE",
      targetContract: "0x2222222222222222222222222222222222222222",
      expectedEvent: "ListingFunded",
      expectedArguments: { listingId: "8" },
    });
    const replacement = updateRecoverableOperation(operation.operationId, "REPLACED", {
      replacementHash: `0x${"56".repeat(32)}`,
    });
    expect(replacement?.replacementHash).toBe(`0x${"56".repeat(32)}`);
    expect(pendingOperationsFor(operation.account, 137n)).toHaveLength(1);
  });

  it("isolates pending operations by account and chain", () => {
    recordSubmittedOperation({
      account: "0x1111111111111111111111111111111111111111",
      chainId: "80002",
      transactionHash: `0x${"ef".repeat(32)}`,
      action: "VAULT_CREATION",
      targetContract: "0x2222222222222222222222222222222222222222",
      expectedEvent: "VaultCreated",
      expectedArguments: {},
    });
    expect(pendingOperationsFor("0x1111111111111111111111111111111111111111", 137n)).toEqual([]);
  });
});
