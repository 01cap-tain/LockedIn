import { describe, expect, it, vi } from "vitest";

import {
  connectEvmWallet,
  watchEvmWallet,
  type Eip1193EventsProvider,
} from "./evm-wallet";

function providerWith(
  request: (method: string) => unknown
): Eip1193EventsProvider {
  return {
    request: vi.fn(({ method }: { method: string }) =>
      Promise.resolve(request(method))
    ),
  };
}

describe("EVM wallet connection", () => {
  it("rejects a missing provider when the development fallback is disabled", async () => {
    await expect(
      connectEvmWallet({
        expectedChainId: "0x89",
        allowDevelopmentFallback: false,
      })
    ).rejects.toMatchObject({ code: "MISSING_PROVIDER" });
  });

  it("maps user rejection to a typed connection error", async () => {
    const provider: Eip1193EventsProvider = {
      request: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("Rejected"), { code: 4001 })
        ),
    };
    await expect(
      connectEvmWallet({ provider, expectedChainId: "0x89" })
    ).rejects.toEqual(expect.objectContaining({ code: "CONNECTION_REJECTED" }));
  });

  it("maps a plain-object user rejection to a typed connection error", async () => {
    const provider: Eip1193EventsProvider = {
      request: vi.fn().mockRejectedValue({ code: "4001", message: "Denied" }),
    };
    await expect(
      connectEvmWallet({ provider, expectedChainId: "0x13882" })
    ).rejects.toMatchObject({
      code: "CONNECTION_REJECTED",
      message: "EVM wallet access was rejected.",
    });
  });

  it("preserves a plain provider error message for diagnosis", async () => {
    const provider: Eip1193EventsProvider = {
      request: vi.fn().mockRejectedValue({
        code: -32603,
        message: "The wallet RPC could not complete the request.",
      }),
    };
    await expect(
      connectEvmWallet({ provider, expectedChainId: "0x13882" })
    ).rejects.toMatchObject({
      code: "CONNECTION_FAILED",
      message: "The wallet RPC could not complete the request.",
    });
  });

  it("requests a network switch before rejecting a provider on the wrong chain", async () => {
    const provider = providerWith((method) =>
      method === "eth_requestAccounts"
        ? ["0x0000000000000000000000000000000000000001"]
        : "0x1"
    );
    await expect(
      connectEvmWallet({ provider, expectedChainId: "0x89" })
    ).rejects.toMatchObject({ code: "WRONG_NETWORK" });
    expect(provider.request).toHaveBeenCalledWith({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x89" }],
    });
  });

  it("connects after the wallet approves a network switch", async () => {
    const address = "0x0000000000000000000000000000000000000001";
    let chainId = "0x1";
    const provider = providerWith((method) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts")
        return [address];
      if (method === "eth_chainId") return chainId;
      if (method === "wallet_switchEthereumChain") {
        chainId = "0x13882";
        return null;
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const session = await connectEvmWallet({
      provider,
      expectedChainId: "0x13882",
    });
    expect(session.chainId).toBe("0x13882");
    expect(session.address).toBe(address);
  });

  it("offers to add Polygon Amoy when MetaMask does not know the chain", async () => {
    const address = "0x0000000000000000000000000000000000000001";
    let chainId = "0x1";
    const provider = providerWith((method) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts")
        return [address];
      if (method === "eth_chainId") return chainId;
      if (method === "wallet_switchEthereumChain") {
        throw Object.assign(new Error("Unknown chain"), { code: 4902 });
      }
      if (method === "wallet_addEthereumChain") {
        chainId = "0x13882";
        return null;
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    await expect(
      connectEvmWallet({ provider, expectedChainId: "0x13882" })
    ).resolves.toMatchObject({ address, chainId: "0x13882" });
    expect(provider.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "wallet_addEthereumChain",
        params: [
          expect.objectContaining({
            chainId: "0x13882",
            chainName: "Polygon Amoy",
          }),
        ],
      })
    );
  });

  it("connects the EVM account exposed by an EIP-1193 provider", async () => {
    const address = "0x0000000000000000000000000000000000000001";
    const provider = providerWith((method) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts")
        return [address];
      if (method === "eth_chainId") return "0x89";
      throw new Error(`Unexpected method: ${method}`);
    });

    const session = await connectEvmWallet({
      provider,
      expectedChainId: "0x89",
    });
    expect(session.address).toBe(address);
    expect(session.chainId).toBe("0x89");
    expect(session.source).toBe("injected-wallet");
  });

  it("can explicitly bypass an injected wallet for the development fallback", async () => {
    const injected = providerWith(() => {
      throw new Error("Injected provider should not be called");
    });
    await expect(
      connectEvmWallet({
        provider: injected,
        expectedChainId: "0x1",
        allowDevelopmentFallback: true,
        forceDevelopmentFallback: true,
        developmentRpcUrl: "http://127.0.0.1:1",
      })
    ).rejects.not.toMatchObject({
      message: "Injected provider should not be called",
    });
  });

  it("forwards account and chain changes and removes both listeners", () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const provider: Eip1193EventsProvider = {
      request: vi.fn(),
      on: vi.fn((event, listener) => listeners.set(event, listener)),
      removeListener: vi.fn((event) => listeners.delete(event)),
    };
    const onAccountsChanged = vi.fn();
    const onChainChanged = vi.fn();
    const stop = watchEvmWallet(provider, {
      onAccountsChanged,
      onChainChanged,
    });

    listeners.get("accountsChanged")?.(["0xabc"]);
    listeners.get("chainChanged")?.("0x89");
    expect(onAccountsChanged).toHaveBeenCalledWith(["0xabc"]);
    expect(onChainChanged).toHaveBeenCalledWith("0x89");
    stop();
    expect(provider.removeListener).toHaveBeenCalledTimes(2);
  });
});
