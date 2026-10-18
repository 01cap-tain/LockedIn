// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Minimal vault-facing boundary for share-based yield integrations.
/// @dev Implementations must restrict deposits and withdrawals to their assigned vault.
interface IYieldAdapter {
    function asset() external view returns (address);
    function vault() external view returns (address);
    function bindVault(address vault_) external;
    function totalAssets() external view returns (uint256);
    function totalShares() external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    /// @notice Supplies assets and returns shares minted at the pre-deposit exchange rate.
    function deposit(uint256 amount) external returns (uint256 shares);

    /// @notice Redeems shares without consuming them when the external protocol fails.
    function withdraw(uint256 shares, address recipient) external returns (uint256 assets);
    function currentLiquidityRate() external view returns (uint256);
}
