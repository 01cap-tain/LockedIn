// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IAToken} from "@aave/core-v3/contracts/interfaces/IAToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DataTypes} from "@aave/core-v3/contracts/protocol/libraries/types/DataTypes.sol";
import {ReserveConfiguration} from "@aave/core-v3/contracts/protocol/libraries/configuration/ReserveConfiguration.sol";

import {IAaveYieldAdapter} from "./interfaces/IAaveYieldAdapter.sol";

/// @notice Vault-scoped Aave V3 adapter with share accounting and no privileged withdrawal path.
/// @dev One factory binds one vault exactly once; all subsequent value movement is vault-only.
contract AaveYieldAdapter is IAaveYieldAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using ReserveConfiguration for DataTypes.ReserveConfigurationMap;

    error FactoryOnly();
    error VaultOnly();
    error AlreadyBound();
    error InvalidConfiguration();
    error InvalidAmount();
    error ZeroShares();
    error InsolventAdapter();
    error TokenAccountingMismatch();

    IERC20 public immutable underlying;
    IPool public immutable pool;
    IAToken public immutable receiptToken;
    address public immutable factory;
    address public vault;
    uint256 public totalShares;

    event VaultBound(address indexed vault);
    event Supplied(uint256 assets, uint256 shares);
    event Redeemed(uint256 shares, uint256 assets, address indexed recipient);

    constructor(IERC20 asset_, IPool pool_, IAToken aToken_, address factory_, uint256 expectedChainId_) {
        if (
            address(asset_) == address(0) || address(pool_) == address(0) || address(aToken_) == address(0)
                || factory_ == address(0) || address(asset_).code.length == 0 || address(pool_).code.length == 0
                || address(aToken_).code.length == 0 || block.chainid != expectedChainId_
        ) revert InvalidConfiguration();
        if (IERC20Metadata(address(asset_)).decimals() != 6 || IERC20Metadata(address(aToken_)).decimals() != 6) {
            revert InvalidConfiguration();
        }
        if (aToken_.UNDERLYING_ASSET_ADDRESS() != address(asset_)) revert InvalidConfiguration();
        if (pool_.getReserveData(address(asset_)).aTokenAddress != address(aToken_)) revert InvalidConfiguration();
        underlying = asset_;
        pool = pool_;
        receiptToken = aToken_;
        factory = factory_;
    }

    modifier onlyVault() {
        if (msg.sender != vault || vault == address(0)) revert VaultOnly();
        _;
    }

    function bindVault(address vault_) external {
        if (msg.sender != factory) revert FactoryOnly();
        if (vault != address(0)) revert AlreadyBound();
        if (vault_ == address(0) || vault_.code.length == 0) revert InvalidConfiguration();
        vault = vault_;
        emit VaultBound(vault_);
    }

    function asset() external view returns (address) { return address(underlying); }
    function aavePool() external view returns (address) { return address(pool); }
    function aToken() external view returns (address) { return address(receiptToken); }

    function totalAssets() public view returns (uint256) {
        // Aave yield appears as a growing aToken balance; idle underlying is included defensively.
        return underlying.balanceOf(address(this)) + receiptToken.balanceOf(address(this));
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        // Mint at the exchange rate that existed before this deposit so new savers do not
        // receive a share of yield accrued by earlier savers.
        uint256 supply = totalShares;
        if (supply == 0) return 0;
        return Math.mulDiv(shares, totalAssets(), supply);
    }

    function currentLiquidityRate() external view returns (uint256) {
        return pool.getReserveData(address(underlying)).currentLiquidityRate;
    }

    function reserveStatus()
        external
        view
        returns (
            bool active,
            bool frozen,
            bool paused,
            uint256 supplyCap,
            uint256 currentSupply,
            uint256 availableLiquidity
        )
    {
        DataTypes.ReserveData memory reserve = pool.getReserveData(address(underlying));
        active = reserve.configuration.getActive();
        frozen = reserve.configuration.getFrozen();
        paused = reserve.configuration.getPaused();
        supplyCap = reserve.configuration.getSupplyCap();
        currentSupply = receiptToken.totalSupply();
        availableLiquidity = underlying.balanceOf(address(receiptToken));
    }

    function deposit(uint256 amount) external onlyVault nonReentrant returns (uint256 shares) {
        if (amount == 0) revert InvalidAmount();
        uint256 assetsBefore = totalAssets();
        // State is updated only after Aave returns the exact amount. A failed or partial
        // redemption therefore leaves every share intact and permits a later retry.
        uint256 balanceBefore = underlying.balanceOf(address(this));
        underlying.safeTransferFrom(msg.sender, address(this), amount);
        if (underlying.balanceOf(address(this)) != balanceBefore + amount) revert TokenAccountingMismatch();

        uint256 supply = totalShares;
        if (supply != 0 && assetsBefore == 0) revert InsolventAdapter();
        shares = supply == 0 ? amount : Math.mulDiv(amount, supply, assetsBefore);
        if (shares == 0) revert ZeroShares();

        underlying.forceApprove(address(pool), amount);
        pool.supply(address(underlying), amount, address(this), 0);
        underlying.forceApprove(address(pool), 0);
        pool.setUserUseReserveAsCollateral(address(underlying), false);
        if (underlying.balanceOf(address(this)) != balanceBefore) revert TokenAccountingMismatch();

        totalShares = supply + shares;
        emit Supplied(amount, shares);
    }

    function withdraw(uint256 shares, address recipient) external onlyVault nonReentrant returns (uint256 assets) {
        uint256 supply = totalShares;
        if (shares == 0 || shares > supply || recipient == address(0)) revert InvalidAmount();
        assets = Math.mulDiv(shares, totalAssets(), supply);
        if (assets == 0) revert InvalidAmount();

        uint256 balanceBefore = underlying.balanceOf(address(this));
        uint256 withdrawn = pool.withdraw(address(underlying), assets, address(this));
        if (withdrawn != assets || underlying.balanceOf(address(this)) != balanceBefore + assets) {
            revert TokenAccountingMismatch();
        }
        totalShares = supply - shares;
        _transferOutExact(recipient, assets);
        emit Redeemed(shares, assets, recipient);
    }

    function _transferOutExact(address recipient, uint256 amount) internal {
        uint256 senderBefore = underlying.balanceOf(address(this));
        uint256 recipientBefore = underlying.balanceOf(recipient);
        underlying.safeTransfer(recipient, amount);
        uint256 senderAfter = underlying.balanceOf(address(this));
        uint256 recipientAfter = underlying.balanceOf(recipient);
        if (
            senderBefore < senderAfter || senderBefore - senderAfter != amount || recipientAfter < recipientBefore
                || recipientAfter - recipientBefore != amount
        ) revert TokenAccountingMismatch();
    }
}
