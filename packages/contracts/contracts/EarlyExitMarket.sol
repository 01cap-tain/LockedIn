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
    function lastDepositAt(uint256 positionId) external view returns (uint64);
    function currentLiquidityRate() external view returns (uint256);
    function marketPositionData(uint256 positionId)
        external
        view
        returns (
            address member,
            uint256 target,
            uint256 deposited,
            uint256 emergencyBalance,
            uint256 currentPositionValue,
            bool lockedWithdrawn,
            uint32 deposits
        );
    function transferPosition(uint256 positionId, address expectedOwner, address newOwner) external;
    function prepareMarketListing(uint256 positionId) external;
}

/// @notice Atomically sells complete locked claims at a price determined only by on-chain state.
/// @dev Providers cannot quote a discount. They either fund the live system price or do nothing.
contract EarlyExitMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MIN_DISCOUNT_BPS = 450;
    uint16 public constant MAX_DISCOUNT_BPS = 800;
    uint16 public constant PROVIDER_FEE_BPS = 90;

    // A 15% Aave liquidity rate maps to the full 75-basis-point liquidity-risk penalty.
    // This is a deterministic utilization proxy, not a prediction of future Aave performance.
    uint256 public constant AAVE_LIQUIDITY_RATE_REFERENCE = 15e25;

    struct Listing {
        address vault;
        uint256 positionId;
        address seller;
        uint256 claimValue;
        uint16 systemDiscountBps;
        uint256 saverPayout;
        uint256 providerPotentialReturn;
        uint256 providerFee;
        uint256 minimumPayout;
        uint64 expiresAt;
        bool active;
    }

    struct ReferenceDiscount {
        uint16 discountBps;
        uint16 remainingTimePenalty;
        uint16 commitmentPenalty;
        uint16 liquidityRiskPenalty;
        uint16 timeWeightedSavingsPenalty;
        uint16 goalCompletionPenalty;
        uint16 regularityPenalty;
        uint16 recencyPenalty;
    }

    error InvalidAddress();
    error InvalidVault();
    error InvalidExpiration();
    error InvalidDiscount();
    error InvalidMinimumPayout();
    error PositionOwnerOnly();
    error ListingUnavailable();
    error SaverOnly();
    error ProviderOnly();
    error MinimumPayoutNotMet();
    error PositionAlreadySold();
    error PositionNotSaleable();
    error TokenAccountingMismatch();

    IERC20 public immutable asset;
    RewardPool public immutable rewardPool;
    address public immutable factory;
    address public immutable riskReserve;
    address public immutable maintenanceTreasury;

    uint256 public nextListingId;
    mapping(uint256 listingId => Listing) public listings;
    mapping(address vault => mapping(uint256 positionId => bool)) public positionSold;
    mapping(address vault => mapping(uint256 positionId => uint256 listingIdPlusOne)) public activeListing;

    event ListingCreated(
        uint256 indexed listingId,
        address indexed vault,
        uint256 indexed positionId,
        address seller,
        uint256 claimValue,
        uint16 systemDiscountBps,
        uint256 saverPayout,
        uint256 providerPotentialReturn,
        uint256 providerFee,
        uint256 minimumPayout,
        uint64 expiresAt
    );
    event ListingCancelled(uint256 indexed listingId);
    event ListingExpired(uint256 indexed listingId);
    event ListingFunded(
        uint256 indexed listingId,
        address indexed provider,
        uint256 claimValue,
        uint16 systemDiscountBps,
        uint256 saverPayout,
        uint256 providerPotentialReturn,
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
            address(asset_) == address(0) || address(rewardPool_) == address(0) || factory_ == address(0)
                || riskReserve_ == address(0) || maintenanceTreasury_ == address(0)
                || riskReserve_ == maintenanceTreasury_ || riskReserve_ == address(this)
                || maintenanceTreasury_ == address(this) || riskReserve_ == address(asset_)
                || maintenanceTreasury_ == address(asset_) || riskReserve_ == address(rewardPool_)
                || maintenanceTreasury_ == address(rewardPool_) || riskReserve_ == factory_
                || maintenanceTreasury_ == factory_
        ) revert InvalidAddress();
        asset = asset_;
        rewardPool = rewardPool_;
        factory = factory_;
        riskReserve = riskReserve_;
        maintenanceTreasury = maintenanceTreasury_;
    }

    function isPositionListed(address vault, uint256 positionId) external view returns (bool) {
        uint256 value = activeListing[vault][positionId];
        if (value == 0) return false;
        Listing storage listing = listings[value - 1];
        return listing.active && listing.expiresAt > block.timestamp;
    }

    /// @notice Records a saver-protection floor while deriving every price field from chain state.
    function createListing(address vault, uint256 positionId, uint64 expiresAt, uint256 minimumPayout)
        external
        returns (uint256 listingId)
    {
        if (!IVaultFactoryView(factory).isVault(vault)) revert InvalidVault();
        IMarketVault savingsVault = IMarketVault(vault);
        // The vault atomically rejects a live cooperative request and records a
        // lazily expired request before the market creates a fallback listing.
        savingsVault.prepareMarketListing(positionId);
        uint64 maturity = savingsVault.maturity();
        if (expiresAt <= block.timestamp || expiresAt > maturity) revert InvalidExpiration();
        if (savingsVault.positionOwner(positionId) != msg.sender) revert PositionOwnerOnly();
        if (positionSold[vault][positionId]) revert PositionAlreadySold();

        // Expired records close lazily so relisting does not depend on a keeper.
        uint256 previousListingIdPlusOne = activeListing[vault][positionId];
        if (previousListingIdPlusOne != 0) {
            Listing storage previousListing = listings[previousListingIdPlusOne - 1];
            if (previousListing.active && previousListing.expiresAt <= block.timestamp) {
                _closeListing(previousListing);
                emit ListingExpired(previousListingIdPlusOne - 1);
            } else {
                revert ListingUnavailable();
            }
        }

        (address member,,,, uint256 currentClaimValue, bool withdrawn,) = savingsVault.marketPositionData(positionId);
        if (member != msg.sender || currentClaimValue == 0 || withdrawn || block.timestamp >= maturity) {
            revert PositionNotSaleable();
        }

        ReferenceDiscount memory pricing = referenceDiscount(vault, positionId);
        uint256 payout = payoutFor(currentClaimValue, pricing.discountBps);
        if (minimumPayout == 0 || minimumPayout > payout) revert InvalidMinimumPayout();
        uint256 fee = feeFor(payout);

        listingId = nextListingId++;
        listings[listingId] = Listing({
            vault: vault,
            positionId: positionId,
            seller: msg.sender,
            claimValue: currentClaimValue,
            systemDiscountBps: pricing.discountBps,
            saverPayout: payout,
            providerPotentialReturn: currentClaimValue - payout,
            providerFee: fee,
            minimumPayout: minimumPayout,
            expiresAt: expiresAt,
            active: true
        });
        activeListing[vault][positionId] = listingId + 1;
        emit ListingCreated(
            listingId,
            vault,
            positionId,
            msg.sender,
            currentClaimValue,
            pricing.discountBps,
            payout,
            currentClaimValue - payout,
            fee,
            minimumPayout,
            expiresAt
        );
    }

    function cancelListing(uint256 listingId) external {
        Listing storage listing = listings[listingId];
        if (!listing.active) revert ListingUnavailable();
        if (msg.sender != listing.seller) revert SaverOnly();
        _closeListing(listing);
        emit ListingCancelled(listingId);
    }

    /// @notice Funds the recalculated system price and transfers the complete claim atomically.
    /// @dev The first successful provider closes the listing; concurrent later transactions revert.
    function fundListing(uint256 listingId) external nonReentrant {
        Listing storage listing = _activeListing(listingId);
        if (msg.sender == listing.seller) revert ProviderOnly();

        IMarketVault vault = IMarketVault(listing.vault);
        if (block.timestamp >= vault.maturity()) revert PositionNotSaleable();
        if (vault.positionOwner(listing.positionId) != listing.seller) revert PositionOwnerOnly();
        (,,,, uint256 currentClaimValue, bool withdrawn,) = vault.marketPositionData(listing.positionId);
        if (withdrawn || currentClaimValue == 0) revert PositionNotSaleable();
        if (positionSold[listing.vault][listing.positionId]) revert PositionAlreadySold();

        // Settlement never trusts the listing snapshot: yield and behaviour may have changed.
        ReferenceDiscount memory pricing = referenceDiscount(listing.vault, listing.positionId);
        uint256 saverPayout = payoutFor(currentClaimValue, pricing.discountBps);
        if (saverPayout < listing.minimumPayout) revert MinimumPayoutNotMet();
        uint256 providerFee = feeFor(saverPayout);
        uint256 rewardShare = providerFee * 60 / 100;
        uint256 riskShare = providerFee * 20 / 100;
        uint256 maintenanceShare = providerFee - rewardShare - riskShare;

        // Effects precede token callbacks; any failed transfer reverts the full transition.
        positionSold[listing.vault][listing.positionId] = true;
        _closeListing(listing);
        _pullExact(msg.sender, saverPayout + providerFee);
        _transferOutExact(listing.seller, saverPayout);
        if (rewardShare != 0) {
            asset.forceApprove(address(rewardPool), rewardShare);
            rewardPool.receiveProtocolRevenue(rewardShare);
        }
        _transferOutExact(riskReserve, riskShare);
        _transferOutExact(maintenanceTreasury, maintenanceShare);
        vault.transferPosition(listing.positionId, listing.seller, msg.sender);

        emit ListingFunded(
            listingId,
            msg.sender,
            currentClaimValue,
            pricing.discountBps,
            saverPayout,
            currentClaimValue - saverPayout,
            providerFee
        );
    }

    function payoutFor(uint256 claimValue, uint16 discountBps) public pure returns (uint256) {
        if (discountBps < MIN_DISCOUNT_BPS || discountBps > MAX_DISCOUNT_BPS) {
            revert InvalidDiscount();
        }
        return claimValue * (10_000 - discountBps) / 10_000;
    }

    function feeFor(uint256 saverPayout) public pure returns (uint256) {
        return saverPayout * PROVIDER_FEE_BPS / 10_000;
    }

    /// @notice Returns the deterministic pricing explanation for the current block.
    function referenceDiscount(address vault, uint256 positionId)
        public
        view
        returns (ReferenceDiscount memory result)
    {
        if (!IVaultFactoryView(factory).isVault(vault)) revert InvalidVault();
        IMarketVault savingsVault = IMarketVault(vault);
        uint64 maturity = savingsVault.maturity();
        uint64 created = savingsVault.createdAt();
        (, uint256 target, uint256 deposited,,,, uint32 deposits) = savingsVault.marketPositionData(positionId);

        uint256 duration = maturity - created;
        uint256 elapsed = block.timestamp <= created ? 0 : _min(duration, block.timestamp - created);
        uint256 remaining = block.timestamp >= maturity ? 0 : maturity - block.timestamp;
        result.remainingTimePenalty = uint16(duration == 0 ? 0 : remaining * 150 / duration);

        uint256 goalProgressBps = target == 0 ? 0 : _min(10_000, deposited * 10_000 / target);
        uint256 expectedSavings = duration == 0 ? target : target * elapsed / duration;
        if (deposited < expectedSavings && expectedSavings != 0) {
            result.timeWeightedSavingsPenalty =
                uint16((expectedSavings - deposited) * 45 / expectedSavings);
        }
        result.goalCompletionPenalty = uint16((10_000 - goalProgressBps) * 35 / 10_000);

        uint256 expectedDeposits = elapsed / 30 days + 1;
        if (deposits < expectedDeposits) {
            result.regularityPenalty = uint16((expectedDeposits - deposits) * 25 / expectedDeposits);
        }

        uint64 lastDeposit = savingsVault.lastDepositAt(positionId);
        if (lastDeposit == 0) {
            result.recencyPenalty = 20;
        } else if (block.timestamp > uint256(lastDeposit) + 30 days) {
            uint256 overdue = _min(30 days, block.timestamp - uint256(lastDeposit) - 30 days);
            result.recencyPenalty = uint16(overdue * 20 / 30 days);
        }
        result.commitmentPenalty = result.timeWeightedSavingsPenalty + result.goalCompletionPenalty
            + result.regularityPenalty + result.recencyPenalty;

        uint256 liquidityRate = savingsVault.currentLiquidityRate();
        result.liquidityRiskPenalty =
            uint16(_min(75, liquidityRate * 75 / AAVE_LIQUIDITY_RATE_REFERENCE));

        uint256 total = MIN_DISCOUNT_BPS + result.remainingTimePenalty + result.commitmentPenalty
            + result.liquidityRiskPenalty;
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

    function _pullExact(address payer, uint256 amount) internal {
        uint256 balanceBefore = asset.balanceOf(address(this));
        asset.safeTransferFrom(payer, address(this), amount);
        if (asset.balanceOf(address(this)) != balanceBefore + amount) revert TokenAccountingMismatch();
    }

    function _transferOutExact(address recipient, uint256 amount) internal {
        if (amount == 0) return;
        uint256 senderBefore = asset.balanceOf(address(this));
        uint256 recipientBefore = asset.balanceOf(recipient);
        asset.safeTransfer(recipient, amount);
        uint256 senderAfter = asset.balanceOf(address(this));
        uint256 recipientAfter = asset.balanceOf(recipient);
        if (
            senderBefore < senderAfter || senderBefore - senderAfter != amount || recipientAfter < recipientBefore
                || recipientAfter - recipientBefore != amount
        ) revert TokenAccountingMismatch();
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
