// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RewardPool} from "./RewardPool.sol";

interface IVaultFactoryView {
    function isVault(address vault) external view returns (bool);
}

interface IMarketVault {
    function maturity() external view returns (uint64);
    function createdAt() external view returns (uint64);
    function positionOwner(uint256 positionId) external view returns (address);
    function marketPositionData(uint256 positionId)
        external
        view
        returns (
            address member,
            uint256 target,
            uint256 deposited,
            uint256 emergencyBalance,
            uint256 lockedBalance,
            bool lockedWithdrawn,
            uint32 deposits
        );
    function transferPosition(uint256 positionId, address expectedOwner, address newOwner) external;
}

contract EarlyExitMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MIN_DISCOUNT_BPS = 450;
    uint16 public constant MAX_DISCOUNT_BPS = 800;
    uint16 public constant PROVIDER_FEE_BPS = 90;
    uint256 public constant STABLECOIN_SIZE_REFERENCE = 1_000 * 1e6;

    struct Listing {
        address vault;
        uint256 positionId;
        address seller;
        uint256 positionValue;
        uint16 askingDiscountBps;
        uint64 expiresAt;
        bool active;
    }

    struct Offer {
        address provider;
        uint16 discountBps;
        uint64 expiresAt;
        bool active;
    }

    struct ReferenceDiscount {
        uint16 discountBps;
        uint16 remainingDaysScore;
        uint16 timeWeightedProgressScore;
        uint16 consistencyScore;
        uint16 positionValueScore;
    }

    error InvalidAddress();
    error InvalidVault();
    error InvalidDiscount();
    error InvalidExpiration();
    error PositionOwnerOnly();
    error ListingUnavailable();
    error OfferUnavailable();
    error SaverOnly();
    error ProviderOnly();
    error PositionChanged();
    error PositionAlreadySold();
    error PositionNotSaleable();

    IERC20 public immutable asset;
    RewardPool public immutable rewardPool;
    address public immutable factory;
    address public immutable riskReserve;
    address public immutable maintenanceTreasury;

    uint256 public nextListingId;
    mapping(uint256 listingId => Listing) public listings;
    mapping(uint256 listingId => uint256 offerCount) public offerCount;
    mapping(uint256 listingId => mapping(uint256 offerId => Offer)) public offers;
    mapping(address vault => mapping(uint256 positionId => bool)) public positionSold;
    mapping(address vault => mapping(uint256 positionId => uint256 listingIdPlusOne)) public activeListing;

    event ListingCreated(
        uint256 indexed listingId,
        address indexed vault,
        uint256 indexed positionId,
        address seller,
        uint256 positionValue,
        uint16 askingDiscountBps,
        uint64 expiresAt
    );
    event ListingCancelled(uint256 indexed listingId);
    event OfferSubmitted(
        uint256 indexed listingId,
        uint256 indexed offerId,
        address indexed provider,
        uint16 discountBps,
        uint64 expiresAt
    );
    event OfferRejected(uint256 indexed listingId, uint256 indexed offerId);
    event OfferAccepted(
        uint256 indexed listingId,
        uint256 indexed offerId,
        address indexed provider,
        uint256 sellerReceives,
        uint256 providerFee
    );

    constructor(
        IERC20 asset_,
        RewardPool rewardPool_,
        address factory_,
        address riskReserve_,
        address maintenanceTreasury_
    ) {
        if (
            address(asset_) == address(0) || address(rewardPool_) == address(0) ||
            factory_ == address(0) || riskReserve_ == address(0) || maintenanceTreasury_ == address(0)
        ) revert InvalidAddress();
        asset = asset_;
        rewardPool = rewardPool_;
        factory = factory_;
        riskReserve = riskReserve_;
        maintenanceTreasury = maintenanceTreasury_;
    }

    function createListing(address vault, uint256 positionId, uint16 askingDiscountBps, uint64 expiresAt)
        external
        returns (uint256 listingId)
    {
        if (!IVaultFactoryView(factory).isVault(vault)) revert InvalidVault();
        _validateDiscount(askingDiscountBps);
        IMarketVault savingsVault = IMarketVault(vault);
        uint64 maturity = savingsVault.maturity();
        if (expiresAt <= block.timestamp || expiresAt > maturity) revert InvalidExpiration();
        if (savingsVault.positionOwner(positionId) != msg.sender) revert PositionOwnerOnly();
        if (positionSold[vault][positionId]) revert PositionAlreadySold();
        if (activeListing[vault][positionId] != 0) revert ListingUnavailable();

        (address member,,,, uint256 lockedBalance, bool withdrawn,) = savingsVault.marketPositionData(positionId);
        if (member != msg.sender || lockedBalance == 0 || withdrawn || block.timestamp >= maturity) {
            revert PositionNotSaleable();
        }

        listingId = nextListingId++;
        listings[listingId] = Listing({
            vault: vault,
            positionId: positionId,
            seller: msg.sender,
            positionValue: lockedBalance,
            askingDiscountBps: askingDiscountBps,
            expiresAt: expiresAt,
            active: true
        });
        activeListing[vault][positionId] = listingId + 1;
        emit ListingCreated(
            listingId, vault, positionId, msg.sender, lockedBalance, askingDiscountBps, expiresAt
        );
    }

    function cancelListing(uint256 listingId) external {
        Listing storage listing = listings[listingId];
        if (!listing.active) revert ListingUnavailable();
        if (msg.sender != listing.seller) revert SaverOnly();
        _closeListing(listing);
        emit ListingCancelled(listingId);
    }

    function submitOffer(uint256 listingId, uint16 discountBps, uint64 expiresAt)
        external
        returns (uint256 offerId)
    {
        Listing storage listing = _activeListing(listingId);
        _validateDiscount(discountBps);
        if (discountBps > listing.askingDiscountBps) revert InvalidDiscount();
        if (expiresAt <= block.timestamp || expiresAt > listing.expiresAt) revert InvalidExpiration();
        if (msg.sender == listing.seller) revert ProviderOnly();

        offerId = offerCount[listingId]++;
        offers[listingId][offerId] = Offer({
            provider: msg.sender,
            discountBps: discountBps,
            expiresAt: expiresAt,
            active: true
        });
        emit OfferSubmitted(listingId, offerId, msg.sender, discountBps, expiresAt);
    }

    function cancelOffer(uint256 listingId, uint256 offerId) external {
        Offer storage offer = offers[listingId][offerId];
        if (!offer.active) revert OfferUnavailable();
        if (msg.sender != offer.provider) revert ProviderOnly();
        offer.active = false;
        emit OfferRejected(listingId, offerId);
    }

    function rejectOffer(uint256 listingId, uint256 offerId) external {
        Listing storage listing = _activeListing(listingId);
        if (msg.sender != listing.seller) revert SaverOnly();
        Offer storage offer = offers[listingId][offerId];
        if (!offer.active) revert OfferUnavailable();
        offer.active = false;
        emit OfferRejected(listingId, offerId);
    }

    function acceptOffer(uint256 listingId, uint256 offerId) external nonReentrant {
        Listing storage listing = _activeListing(listingId);
        if (msg.sender != listing.seller) revert SaverOnly();
        Offer storage offer = offers[listingId][offerId];
        if (!offer.active || offer.expiresAt <= block.timestamp) revert OfferUnavailable();

        IMarketVault vault = IMarketVault(listing.vault);
        if (block.timestamp >= vault.maturity()) revert PositionNotSaleable();
        if (vault.positionOwner(listing.positionId) != listing.seller) revert PositionOwnerOnly();
        (, , , , uint256 lockedBalance, bool withdrawn,) = vault.marketPositionData(listing.positionId);
        if (withdrawn) revert PositionNotSaleable();
        if (lockedBalance != listing.positionValue) revert PositionChanged();
        if (positionSold[listing.vault][listing.positionId]) revert PositionAlreadySold();

        uint256 sellerReceives = claimValue(listing.positionValue, offer.discountBps);
        uint256 providerFee = feeFor(sellerReceives);
        uint256 rewardShare = providerFee * 60 / 100;
        uint256 riskShare = providerFee * 20 / 100;
        uint256 maintenanceShare = providerFee - rewardShare - riskShare;

        offer.active = false;
        positionSold[listing.vault][listing.positionId] = true;
        _closeListing(listing);

        asset.safeTransferFrom(offer.provider, address(this), sellerReceives + providerFee);
        asset.safeTransfer(listing.seller, sellerReceives);
        asset.forceApprove(address(rewardPool), rewardShare);
        rewardPool.receiveProtocolRevenue(rewardShare);
        asset.safeTransfer(riskReserve, riskShare);
        asset.safeTransfer(maintenanceTreasury, maintenanceShare);
        vault.transferPosition(listing.positionId, listing.seller, offer.provider);

        emit OfferAccepted(listingId, offerId, offer.provider, sellerReceives, providerFee);
    }

    function claimValue(uint256 positionValue, uint16 discountBps) public pure returns (uint256) {
        _validateDiscount(discountBps);
        return positionValue * (10_000 - discountBps) / 10_000;
    }

    function feeFor(uint256 sellerReceives) public pure returns (uint256) {
        return sellerReceives * PROVIDER_FEE_BPS / 10_000;
    }

    function referenceDiscount(address vault, uint256 positionId)
        external
        view
        returns (ReferenceDiscount memory result)
    {
        if (!IVaultFactoryView(factory).isVault(vault)) revert InvalidVault();
        IMarketVault savingsVault = IMarketVault(vault);
        uint64 maturity = savingsVault.maturity();
        uint64 created = savingsVault.createdAt();
        (, uint256 target, uint256 deposited,, uint256 lockedBalance,, uint32 deposits) =
            savingsVault.marketPositionData(positionId);

        uint256 remainingDays = block.timestamp >= maturity ? 0 : (maturity - block.timestamp) / 1 days;
        result.remainingDaysScore = uint16(_min(125, remainingDays * 125 / 365));

        uint256 duration = maturity - created;
        uint256 elapsed = block.timestamp <= created ? 0 : _min(duration, block.timestamp - created);
        uint256 expectedProgressBps = duration == 0 ? 10_000 : elapsed * 10_000 / duration;
        uint256 actualProgressBps = target == 0 ? 0 : _min(10_000, deposited * 10_000 / target);
        if (actualProgressBps < expectedProgressBps) {
            result.timeWeightedProgressScore =
                uint16((expectedProgressBps - actualProgressBps) * 100 / 10_000);
        }

        uint256 elapsedDays = elapsed / 1 days;
        uint256 expectedDeposits = elapsedDays / 30 + 1;
        if (deposits < expectedDeposits) {
            result.consistencyScore = uint16((expectedDeposits - deposits) * 75 / expectedDeposits);
        }

        uint256 cappedValue = _min(STABLECOIN_SIZE_REFERENCE, lockedBalance);
        result.positionValueScore =
            uint16((STABLECOIN_SIZE_REFERENCE - cappedValue) * 50 / STABLECOIN_SIZE_REFERENCE);

        uint256 total = 450 + result.remainingDaysScore + result.timeWeightedProgressScore
            + result.consistencyScore + result.positionValueScore;
        result.discountBps = uint16(_min(MAX_DISCOUNT_BPS, total));
    }

    function _activeListing(uint256 listingId) internal view returns (Listing storage listing) {
        listing = listings[listingId];
        if (!listing.active || listing.expiresAt <= block.timestamp) revert ListingUnavailable();
    }

    function _closeListing(Listing storage listing) internal {
        listing.active = false;
        activeListing[listing.vault][listing.positionId] = 0;
    }

    function _validateDiscount(uint16 discountBps) internal pure {
        if (discountBps < MIN_DISCOUNT_BPS || discountBps > MAX_DISCOUNT_BPS) {
            revert InvalidDiscount();
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
