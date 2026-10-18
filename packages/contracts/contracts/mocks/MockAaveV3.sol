// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {DataTypes} from "@aave/core-v3/contracts/protocol/libraries/types/DataTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockAToken is ERC20 {
    address public immutable underlying;
    address public pool;

    error PoolOnly();
    error AlreadyBound();

    constructor(address underlying_) ERC20("Mock Aave USDT", "maUSDT") { underlying = underlying_; }

    function decimals() public pure override returns (uint8) { return 6; }
    function UNDERLYING_ASSET_ADDRESS() external view returns (address) { return underlying; }

    function bindPool(address pool_) external {
        if (pool != address(0)) revert AlreadyBound();
        pool = pool_;
    }

    function mintFromPool(address account, uint256 amount) external {
        if (msg.sender != pool) revert PoolOnly();
        _mint(account, amount);
    }

    function burnFromPool(address account, uint256 amount) external {
        if (msg.sender != pool) revert PoolOnly();
        _burn(account, amount);
    }

    function accrueYield(address account, uint256 amount) external { _mint(account, amount); }
    function slash(address account, uint256 amount) external { _burn(account, amount); }
}

contract WrongUnderlyingAToken is ERC20 {
    address public immutable underlying;
    constructor(address underlying_) ERC20("Wrong Aave Token", "waUSDT") { underlying = underlying_; }
    function decimals() public pure override returns (uint8) { return 6; }
    function UNDERLYING_ASSET_ADDRESS() external view returns (address) { return underlying; }
}

contract WrongDecimalsAToken is ERC20 {
    address public immutable underlying;
    constructor(address underlying_) ERC20("Wrong Decimals Aave Token", "wdaUSDT") { underlying = underlying_; }
    function decimals() public pure override returns (uint8) { return 18; }
    function UNDERLYING_ASSET_ADDRESS() external view returns (address) { return underlying; }
}

contract MockAavePool {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;
    MockAToken public immutable aToken;
    bool public paused;
    bool public frozen;
    bool public failWithdrawals;
    uint128 public liquidityRate;
    mapping(address user => bool enabled) public collateralEnabled;

    error InvalidAsset();
    error ReservePaused();
    error ReserveFrozen();
    error WithdrawalUnavailable();

    constructor(IERC20 asset_, MockAToken aToken_) {
        asset = asset_;
        aToken = aToken_;
    }

    function setPaused(bool value) external { paused = value; }
    function setFrozen(bool value) external { frozen = value; }
    function setFailWithdrawals(bool value) external { failWithdrawals = value; }
    function setLiquidityRate(uint128 value) external { liquidityRate = value; }

    function supply(address suppliedAsset, uint256 amount, address onBehalfOf, uint16) external {
        if (suppliedAsset != address(asset)) revert InvalidAsset();
        if (paused) revert ReservePaused();
        if (frozen) revert ReserveFrozen();
        asset.safeTransferFrom(msg.sender, address(this), amount);
        aToken.mintFromPool(onBehalfOf, amount);
        collateralEnabled[onBehalfOf] = true;
    }

    function withdraw(address suppliedAsset, uint256 amount, address to) external returns (uint256) {
        if (suppliedAsset != address(asset)) revert InvalidAsset();
        if (paused || failWithdrawals || asset.balanceOf(address(this)) < amount) revert WithdrawalUnavailable();
        aToken.burnFromPool(msg.sender, amount);
        asset.safeTransfer(to, amount);
        return amount;
    }

    function setUserUseReserveAsCollateral(address suppliedAsset, bool useAsCollateral) external {
        if (suppliedAsset != address(asset)) revert InvalidAsset();
        collateralEnabled[msg.sender] = useAsCollateral;
    }

    function getReserveData(address suppliedAsset) external view returns (DataTypes.ReserveData memory reserve) {
        if (suppliedAsset != address(asset)) revert InvalidAsset();
        reserve.currentLiquidityRate = liquidityRate;
        reserve.aTokenAddress = address(aToken);
    }
}
