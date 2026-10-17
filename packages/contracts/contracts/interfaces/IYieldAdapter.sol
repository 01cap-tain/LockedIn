// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IYieldAdapter {
    function asset() external view returns (address);
    function totalManagedAssets() external view returns (uint256);
    function deposit(uint256 amount) external returns (uint256 shares);
    function withdraw(uint256 amount, address recipient) external returns (uint256 withdrawn);
}
