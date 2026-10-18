// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IEarlyExitMarket {
    /// @notice Returns true only while a position has an unexpired active listing.
    function isPositionListed(address vault, uint256 positionId) external view returns (bool);

    /// @notice Lists a complete claim with a saver-controlled payout floor.
    function createListing(address vault, uint256 positionId, uint64 expiresAt, uint256 minimumPayout)
        external
        returns (uint256 listingId);

    /// @notice Pays the live deterministic price; the first successful provider wins.
    function fundListing(uint256 listingId) external;
}
