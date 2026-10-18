// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IYieldAdapter} from "./IYieldAdapter.sol";

/// @notice Deploys one isolated yield adapter for the calling vault factory.
interface IYieldAdapterFactory {
    function asset() external view returns (address);
    function createAdapter() external returns (IYieldAdapter adapter);
}
