import process from "node:process";

import { Contract, JsonRpcProvider, getAddress } from "ethers";
import { polygonAaveConfig } from "./polygon-aave-config.js";

// This command is intentionally read-only. It validates authoritative Aave
// identities and explicit production governance inputs, but owns no signer and
// cannot deploy to Polygon mainnet.
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is intentionally unset; provide a reviewed production value.`);
  return value;
};
const rpcUrl = required("POLYGON_RPC_URL");
const safetyCouncil = getAddress(required("POLYGON_SAFETY_COUNCIL_ADDRESS"));
const riskReserve = getAddress(required("POLYGON_RISK_RESERVE_ADDRESS"));
const maintenanceTreasury = getAddress(required("POLYGON_MAINTENANCE_TREASURY_ADDRESS"));
if (new Set([safetyCouncil, riskReserve, maintenanceTreasury].map((value) => value.toLowerCase())).size !== 3) {
  throw new Error("Production safety, reserve and maintenance addresses must be distinct.");
}
const numeric = (name) => {
  const value = BigInt(required(name));
  if (value <= 0n) throw new Error(`${name} must be positive.`);
  return value;
};
const caps = {
  position: numeric("POLYGON_MAX_POSITION_PRINCIPAL"),
  vault: numeric("POLYGON_MAX_VAULT_PRINCIPAL"),
  protocol: numeric("POLYGON_MAX_PROTOCOL_PRINCIPAL"),
};
if (!(caps.position <= caps.vault && caps.vault <= caps.protocol)) throw new Error("Production exposure caps are inconsistent.");

const provider = new JsonRpcProvider(rpcUrl, polygonAaveConfig.chainId, { staticNetwork: true });
const chain = await provider.getNetwork();
if (Number(chain.chainId) !== polygonAaveConfig.chainId) throw new Error(`Expected Polygon 137, received ${chain.chainId}.`);
const token = new Contract(polygonAaveConfig.usdt, ["function decimals() view returns (uint8)"], provider);
const aToken = new Contract(polygonAaveConfig.aUsdt, ["function decimals() view returns (uint8)", "function UNDERLYING_ASSET_ADDRESS() view returns (address)"], provider);
const pool = new Contract(polygonAaveConfig.pool, ["function getReserveData(address) view returns ((uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))"], provider);
const [tokenDecimals, aTokenDecimals, underlying, reserve, poolCode] = await Promise.all([
  token.decimals(), aToken.decimals(), aToken.UNDERLYING_ASSET_ADDRESS(),
  pool.getReserveData(polygonAaveConfig.usdt), provider.getCode(polygonAaveConfig.pool),
]);
if (poolCode === "0x" || Number(tokenDecimals) !== 6 || Number(aTokenDecimals) !== 6 || underlying.toLowerCase() !== polygonAaveConfig.usdt.toLowerCase() || String(reserve[8]).toLowerCase() !== polygonAaveConfig.aUsdt.toLowerCase()) {
  throw new Error("Live Polygon Aave identities do not match the maintained address book.");
}
console.log(JSON.stringify({
  status: "READ_ONLY_PREFLIGHT_ONLY",
  chainId: polygonAaveConfig.chainId,
  aave: polygonAaveConfig,
  governance: { safetyCouncil, riskReserve, maintenanceTreasury },
  caps: Object.fromEntries(Object.entries(caps).map(([key, value]) => [key, value.toString()])),
  note: "No transaction was signed or broadcast. A reviewed multisig deployment procedure is still required.",
}, null, 2));
