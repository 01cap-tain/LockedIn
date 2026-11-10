// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SavingsVault} from "./SavingsVault.sol";
import {SavingsVaultDeployer} from "./SavingsVaultDeployer.sol";
import {EarlyExitMarket} from "./EarlyExitMarket.sol";
import {SafetyController} from "./SafetyController.sol";
import {RewardPool} from "./RewardPool.sol";

/// @notice Deploys immutable Safe-only V1 savings vaults and records membership indexes.
/// @dev The factory creates infrastructure but receives no authority over member principal.
contract VaultFactory {
    /// @notice Human-readable release family included in the immutable deployment fingerprint.
    string public constant PROTOCOL_VERSION = "lockedin-circle/1.5.0-safe";
    uint256 public constant POLYGON_MAINNET_CHAIN_ID = 137;
    uint64 public constant POLYGON_MAINNET_MINIMUM_MATURITY_DURATION = 7 hours;
    uint256 public constant MIN_GROUP_MEMBERS = 4;
    uint256 public constant MAX_GROUP_MEMBERS = 50;
    uint64 public constant MIN_CONFIGURABLE_MATURITY_DURATION = 7 hours;
    uint64 public constant MAX_CONFIGURABLE_MATURITY_DURATION = 5 * 365 days;

    error InvalidConfiguration();
    error UnsupportedToken();
    error VaultOnly();
    error EarnDisabled();

    IERC20 public immutable asset;
    EarlyExitMarket public immutable earlyExitMarket;
    RewardPool public immutable rewardPool;
    address public immutable riskReserve;
    address public immutable maintenanceTreasury;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable deploymentId;
    SavingsVaultDeployer public immutable vaultDeployer;
    SafetyController public immutable safetyController;
    uint64 public immutable minimumMaturityDuration;

    address[] private _vaults;
    mapping(address member => address[] vaults) private _memberVaults;
    mapping(address vault => bool) public isVault;
    mapping(address vault => string name) private _groupNames;

    event VaultCreated(
        address indexed vault,
        address indexed creator,
        bool indexed isGroup,
        SavingsVault.VaultMode mode,
        address yieldAdapter,
        uint64 maturity
    );

    constructor(
        IERC20 asset_,
        RewardPool rewardPool_,
        address riskReserve_,
        address maintenanceTreasury_,
        uint256 deploymentChainId_,
        SavingsVaultDeployer vaultDeployer_,
        SafetyController safetyController_,
        uint64 minimumMaturityDuration_
    ) {
        if (
            address(asset_) == address(0) || address(asset_).code.length == 0 ||
            block.chainid != deploymentChainId_ ||
            address(rewardPool_) == address(0) || address(rewardPool_).code.length == 0 ||
            riskReserve_ == address(0) || maintenanceTreasury_ == address(0) ||
            address(rewardPool_) == riskReserve_ || address(rewardPool_) == maintenanceTreasury_ ||
            address(rewardPool_) == address(asset_) || riskReserve_ == address(asset_) ||
            maintenanceTreasury_ == address(asset_) ||
            maintenanceTreasury_ == address(this) ||
            minimumMaturityDuration_ < MIN_CONFIGURABLE_MATURITY_DURATION ||
            minimumMaturityDuration_ > MAX_CONFIGURABLE_MATURITY_DURATION ||
            (
                deploymentChainId_ == POLYGON_MAINNET_CHAIN_ID &&
                minimumMaturityDuration_ < POLYGON_MAINNET_MINIMUM_MATURITY_DURATION
            )
        ) revert InvalidConfiguration();
        if (
            address(vaultDeployer_) == address(0) ||
            address(vaultDeployer_).code.length == 0 ||
            vaultDeployer_.factory() != address(this) ||
            rewardPool_.factory() != address(this)
        ) revert InvalidConfiguration();
        try IERC20Metadata(address(asset_)).decimals() returns (uint8 tokenDecimals) {
            if (tokenDecimals != 6) revert UnsupportedToken();
        } catch {
            revert UnsupportedToken();
        }
        if (
            address(safetyController_) == address(0) ||
            address(safetyController_).code.length == 0 ||
            safetyController_.factory() != address(this)
        ) revert InvalidConfiguration();
        asset = asset_;
        rewardPool = rewardPool_;
        riskReserve = riskReserve_;
        maintenanceTreasury = maintenanceTreasury_;
        deploymentChainId = deploymentChainId_;
        vaultDeployer = vaultDeployer_;
        safetyController = safetyController_;
        minimumMaturityDuration = minimumMaturityDuration_;
        earlyExitMarket = new EarlyExitMarket(
            asset_,
            address(this),
            address(rewardPool_),
            riskReserve_,
            maintenanceTreasury_,
            safetyController
        );
        // This fingerprint binds the frontend manifest to this exact protocol graph.
        // A contract at the right address on the wrong chain, or a manifest mixing
        // deployments, therefore cannot silently enable transaction controls.
        deploymentId = keccak256(
            abi.encode(
                PROTOCOL_VERSION,
                block.chainid,
                address(this),
                address(asset_),
                address(earlyExitMarket),
                address(rewardPool_),
                riskReserve_,
                maintenanceTreasury_,
                address(safetyController_),
                minimumMaturityDuration_
            )
        );
    }

    function createPersonalVault(
        uint256 target,
        uint64 maturity,
        uint16 emergencyBps,
        SavingsVault.VaultMode mode
    )
        external
        returns (address vault)
    {
        safetyController.requireNotPaused();
        if (mode != SavingsVault.VaultMode.Safe) revert EarnDisabled();
        address[] memory members = new address[](1);
        members[0] = msg.sender;
        uint256[] memory targets = new uint256[](1);
        targets[0] = target;
        uint16[] memory allocations = new uint16[](1);
        allocations[0] = emergencyBps;
        vault = _create(false, msg.sender, members, targets, allocations, maturity, mode, false, 1, 0, 0, false, "", 0);
    }

    /// @notice Creates a pending circle with only the creator's position.
    /// @dev Other members must join later from their own wallets and choose their own terms.
    function createPublicGroupVault(
        string calldata groupName_,
        uint256 target,
        uint16 emergencyBps,
        uint32 maxMembers,
        uint64 enrollmentDeadline,
        uint64 maturity,
        SavingsVault.VaultMode mode,
        bool publicJoining
    ) external returns (address vault) {
        safetyController.requireNotPaused();
        if (mode != SavingsVault.VaultMode.Safe) revert EarnDisabled();
        if (maxMembers < MIN_GROUP_MEMBERS || maxMembers > MAX_GROUP_MEMBERS) {
            revert InvalidConfiguration();
        }
        if (bytes(groupName_).length == 0 || bytes(groupName_).length > 64) revert InvalidConfiguration();
        address[] memory members = new address[](1);
        members[0] = msg.sender;
        uint256[] memory targets = new uint256[](1);
        targets[0] = target;
        uint16[] memory allocations = new uint16[](1);
        allocations[0] = emergencyBps;
        vault = _create(
            true,
            msg.sender,
            members,
            targets,
            allocations,
            maturity,
            mode,
            publicJoining,
            maxMembers,
            target,
            emergencyBps,
            true,
            groupName_,
            enrollmentDeadline
        );
    }

    /// @notice Adds a public joiner to the factory's address index.
    function recordPublicGroupJoin(address member) external {
        if (!isVault[msg.sender] || member == address(0)) revert VaultOnly();
        _memberVaults[member].push(msg.sender);
    }

    function vaultCount() external view returns (uint256) {
        return _vaults.length;
    }

    function vaultAt(uint256 index) external view returns (address) {
        return _vaults[index];
    }

    function vaultsOf(address member) external view returns (address[] memory) {
        return _memberVaults[member];
    }

    function groupName(address vault) external view returns (string memory) {
        return _groupNames[vault];
    }

    function _create(
        bool group,
        address creator,
        address[] memory members,
        uint256[] memory targets,
        uint16[] memory emergencyBps,
        uint64 maturity,
        SavingsVault.VaultMode mode,
        bool publicJoining,
        uint32 maxMemberCount,
        uint256 publicMemberTarget,
        uint16 publicEmergencyBps,
        bool openEnrollment,
        string memory groupName_,
        uint64 enrollmentDeadline
    ) internal returns (address vault) {
        if (mode != SavingsVault.VaultMode.Safe) revert EarnDisabled();
        vault = vaultDeployer.deployVault(
            asset,
            maturity,
            group,
            creator,
            address(earlyExitMarket),
            safetyController,
            mode,
            members,
            targets,
            emergencyBps,
            address(this),
            publicJoining,
            maxMemberCount,
            publicMemberTarget,
            publicEmergencyBps,
            openEnrollment,
            enrollmentDeadline,
            minimumMaturityDuration
        );
        _vaults.push(vault);
        isVault[vault] = true;
        if (group) _groupNames[vault] = groupName_;
        safetyController.registerVault(vault);

        for (uint256 i; i < members.length; ++i) {
            _memberVaults[members[i]].push(vault);
        }
        emit VaultCreated(vault, msg.sender, group, mode, address(0), maturity);
    }
}
