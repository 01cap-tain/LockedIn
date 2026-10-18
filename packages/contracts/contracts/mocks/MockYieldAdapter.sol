// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IYieldAdapter} from "../interfaces/IYieldAdapter.sol";
import {IYieldAdapterFactory} from "../interfaces/IYieldAdapterFactory.sol";

/// @notice Testnet-only share adapter whose yield is funded with real mock-token transfers.
/// @dev It models changing exchange rates without pretending Aave exists on Polygon Amoy.
contract MockYieldAdapter is IYieldAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error FactoryOnly();
    error VaultOnly();
    error AlreadyBound();
    error InvalidConfiguration();
    error InvalidAmount();
    error ZeroShares();
    error InsolventAdapter();
    error TokenAccountingMismatch();

    IERC20 private immutable _asset;
    address public immutable factory;
    uint256 private immutable _liquidityRate;
    address public vault;
    uint256 public totalShares;

    event VaultBound(address indexed vault);
    event Deposited(uint256 assets, uint256 shares);
    event Withdrawn(uint256 shares, uint256 assets, address indexed recipient);
    event YieldFunded(address indexed funder, uint256 assets);

    constructor(IERC20 asset_, address factory_, uint256 expectedChainId_, uint256 liquidityRate_) {
        if (
            address(asset_) == address(0) || address(asset_).code.length == 0 || factory_ == address(0)
                || block.chainid != expectedChainId_
        ) revert InvalidConfiguration();
        _asset = asset_;
        factory = factory_;
        _liquidityRate = liquidityRate_;
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

    function asset() external view returns (address) {
        return address(_asset);
    }

    function totalAssets() public view returns (uint256) {
        return _asset.balanceOf(address(this));
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalShares;
        return supply == 0 ? 0 : Math.mulDiv(shares, totalAssets(), supply);
    }

    function currentLiquidityRate() external view returns (uint256) {
        return _liquidityRate;
    }

    function deposit(uint256 amount) external onlyVault nonReentrant returns (uint256 shares) {
        if (amount == 0) revert InvalidAmount();
        uint256 assetsBefore = totalAssets();
        uint256 supply = totalShares;
        if (supply != 0 && assetsBefore == 0) revert InsolventAdapter();

        _pullExact(msg.sender, amount);
        shares = supply == 0 ? amount : Math.mulDiv(amount, supply, assetsBefore);
        if (shares == 0) revert ZeroShares();
        totalShares = supply + shares;
        emit Deposited(amount, shares);
    }

    function withdraw(uint256 shares, address recipient)
        external
        onlyVault
        nonReentrant
        returns (uint256 assets)
    {
        uint256 supply = totalShares;
        if (shares == 0 || shares > supply || recipient == address(0)) revert InvalidAmount();
        assets = Math.mulDiv(shares, totalAssets(), supply);
        if (assets == 0) revert InvalidAmount();

        // Shares are consumed only after the transfer succeeds; a failure preserves retryability.
        _transferOutExact(recipient, assets);
        totalShares = supply - shares;
        emit Withdrawn(shares, assets, recipient);
    }

    /// @notice Adds actual token assets without minting shares, increasing every holder's exchange rate.
    function fundYield(uint256 amount) external nonReentrant {
        if (amount == 0 || totalShares == 0) revert InvalidAmount();
        _pullExact(msg.sender, amount);
        emit YieldFunded(msg.sender, amount);
    }

    function _pullExact(address payer, uint256 amount) internal {
        uint256 beforeBalance = _asset.balanceOf(address(this));
        _asset.safeTransferFrom(payer, address(this), amount);
        if (_asset.balanceOf(address(this)) != beforeBalance + amount) revert TokenAccountingMismatch();
    }

    function _transferOutExact(address recipient, uint256 amount) internal {
        uint256 senderBefore = _asset.balanceOf(address(this));
        uint256 recipientBefore = _asset.balanceOf(recipient);
        _asset.safeTransfer(recipient, amount);
        uint256 senderAfter = _asset.balanceOf(address(this));
        uint256 recipientAfter = _asset.balanceOf(recipient);
        if (
            senderBefore < senderAfter || senderBefore - senderAfter != amount || recipientAfter < recipientBefore
                || recipientAfter - recipientBefore != amount
        ) revert TokenAccountingMismatch();
    }
}

/// @notice Creates isolated MockYieldAdapters for Amoy and deterministic local tests.
contract MockYieldAdapterFactory is IYieldAdapterFactory {
    IERC20 private immutable _asset;
    uint256 public immutable expectedChainId;
    uint256 public immutable liquidityRate;

    event AdapterCreated(address indexed adapter, address indexed requestingFactory);

    constructor(IERC20 asset_, uint256 expectedChainId_, uint256 liquidityRate_) {
        if (address(asset_) == address(0) || address(asset_).code.length == 0) revert MockYieldAdapter.InvalidConfiguration();
        _asset = asset_;
        expectedChainId = expectedChainId_;
        liquidityRate = liquidityRate_;
    }

    function asset() external view returns (address) {
        return address(_asset);
    }

    function createAdapter() external returns (IYieldAdapter adapter) {
        adapter = new MockYieldAdapter(_asset, msg.sender, expectedChainId, liquidityRate);
        emit AdapterCreated(address(adapter), msg.sender);
    }
}
