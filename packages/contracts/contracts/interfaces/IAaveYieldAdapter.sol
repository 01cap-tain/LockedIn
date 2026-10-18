// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IYieldAdapter} from "./IYieldAdapter.sol";

/// @notice Read-only Aave identities added to the generic yield-adapter boundary.
interface IAaveYieldAdapter is IYieldAdapter {
    function aavePool() external view returns (address);
    function aToken() external view returns (address);
}
