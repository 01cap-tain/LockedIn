// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IEarlyExitMarket {
    function purchasePosition(address vault, uint256 positionId, uint256 minimumPayout) external;
}
