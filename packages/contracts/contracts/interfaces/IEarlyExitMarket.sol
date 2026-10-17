// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IEarlyExitMarket {
    function createListing(address vault, uint256 positionId, uint16 askingDiscountBps, uint64 expiresAt)
        external
        returns (uint256 listingId);

    function submitOffer(uint256 listingId, uint16 discountBps, uint64 expiresAt)
        external
        returns (uint256 offerId);

    function acceptOffer(uint256 listingId, uint256 offerId) external;
}
