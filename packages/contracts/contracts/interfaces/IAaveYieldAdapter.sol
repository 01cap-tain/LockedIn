// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IYieldAdapter} from "./IYieldAdapter.sol";

/// @notice Read-only Aave identities added to the generic yield-adapter boundary.
interface IAaveYieldAdapter is IYieldAdapter {
    function aavePool() external view returns (address);
    function aToken() external view returns (address);

    /// @notice Current reserve controls and immediately available underlying liquidity.
    /// @dev The supply cap is returned in whole underlying-token units, as defined by Aave.
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
        );
}
