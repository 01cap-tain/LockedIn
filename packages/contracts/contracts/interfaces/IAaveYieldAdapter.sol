// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IYieldAdapter} from "./IYieldAdapter.sol";

interface IAaveYieldAdapter is IYieldAdapter {
    function aavePool() external view returns (address);
}
