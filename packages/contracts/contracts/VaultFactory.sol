// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IAToken} from "@aave/core-v3/contracts/interfaces/IAToken.sol";
import {RewardPool} from "./RewardPool.sol";
import {SavingsVault} from "./SavingsVault.sol";
import {SavingsVaultDeployer} from "./SavingsVaultDeployer.sol";
import {EarlyExitMarket} from "./EarlyExitMarket.sol";
import {AaveYieldAdapter} from "./AaveYieldAdapter.sol";
import {IYieldAdapter} from "./interfaces/IYieldAdapter.sol";
import {IYieldAdapterFactory} from "./interfaces/IYieldAdapterFactory.sol";
import {SafetyController} from "./SafetyController.sol";

/// @notice Deploys immutable Safe or Earn savings vaults and records membership indexes.
/// @dev The factory creates infrastructure but receives no authority over member principal.
contract VaultFactory {
    /// @notice Human-readable release family included in the immutable deployment fingerprint.
    string public constant PROTOCOL_VERSION = "lockedin-circle/0.8.0";
    uint256 public constant MIN_GROUP_MEMBERS = 4;
    uint256 public constant MAX_GROUP_MEMBERS = 50;

    error InvalidConfiguration();
    error UnsupportedToken();
    error VaultOnly();

    IERC20 public immutable asset;
    RewardPool public immutable rewardPool;
    EarlyExitMarket public immutable earlyExitMarket;
    IPool public immutable aavePool;
    IAToken public immutable aToken;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable deploymentId;
    IYieldAdapterFactory public immutable testYieldAdapterFactory;
    SavingsVaultDeployer public immutable vaultDeployer;
    SafetyController public immutable safetyController;

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
        address riskReserve_,
        address maintenanceTreasury_,
        IPool aavePool_,
        IAToken aToken_,
        uint256 deploymentChainId_,
        IYieldAdapterFactory testYieldAdapterFactory_,
        SavingsVaultDeployer vaultDeployer_,
        SafetyController safetyController_,
        RewardPool rewardPool_
    ) {
        if (
            address(asset_) == address(0) || address(asset_).code.length == 0 ||
            block.chainid != deploymentChainId_ ||
            riskReserve_ == address(0) || maintenanceTreasury_ == address(0) ||
            riskReserve_ == maintenanceTreasury_ || riskReserve_ == address(asset_) ||
            maintenanceTreasury_ == address(asset_) || riskReserve_ == address(this) ||
            maintenanceTreasury_ == address(this)
        ) revert InvalidConfiguration();
        if (
            address(vaultDeployer_) == address(0) ||
            address(vaultDeployer_).code.length == 0 ||
            vaultDeployer_.factory() != address(this)
        ) revert InvalidConfiguration();
        try IERC20Metadata(address(asset_)).decimals() returns (uint8 tokenDecimals) {
            if (tokenDecimals != 6) revert UnsupportedToken();
        } catch {
            revert UnsupportedToken();
        }
        if (
            address(testYieldAdapterFactory_) != address(0)
                && (
                    address(testYieldAdapterFactory_).code.length == 0
                        || testYieldAdapterFactory_.asset() != address(asset_)
                )
        ) revert InvalidConfiguration();
        if (
            address(safetyController_) == address(0) ||
            address(safetyController_).code.length == 0 ||
            safetyController_.factory() != address(this)
        ) revert InvalidConfiguration();
        if (
            address(rewardPool_) == address(0) || address(rewardPool_).code.length == 0 ||
            rewardPool_.factory() != address(this) || rewardPool_.asset() != asset_
        ) revert InvalidConfiguration();
        asset = asset_;
        aavePool = aavePool_;
        aToken = aToken_;
        deploymentChainId = deploymentChainId_;
        testYieldAdapterFactory = testYieldAdapterFactory_;
        vaultDeployer = vaultDeployer_;
        safetyController = safetyController_;
        rewardPool = rewardPool_;
        earlyExitMarket = new EarlyExitMarket(
            asset_,
            rewardPool,
            address(this),
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
                address(safetyController_)
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
        IYieldAdapter adapter;
        if (mode == SavingsVault.VaultMode.Earn) {
            if (address(testYieldAdapterFactory) != address(0)) {
                // Amoy has no official Aave deployment. Its explicit test factory creates
                // isolated mock adapters without inventing production-protocol addresses.
                adapter = testYieldAdapterFactory.createAdapter();
                if (adapter.asset() != address(asset)) revert InvalidConfiguration();
            } else {
                // Production/fork mode keeps the real Aave adapter and validates Pool,
                // aToken, chain and token identities inside its constructor.
                adapter = new AaveYieldAdapter(
                    asset, aavePool, aToken, address(this), deploymentChainId
                );
            }
        }
        vault = vaultDeployer.deployVault(
            asset,
            rewardPool,
            maturity,
            group,
            creator,
            address(earlyExitMarket),
            safetyController,
            mode,
            adapter,
            members,
            targets,
            emergencyBps,
            address(this),
            publicJoining,
            maxMemberCount,
            publicMemberTarget,
            publicEmergencyBps,
            openEnrollment,
            enrollmentDeadline
        );
        // Binding is a one-time factory operation; after this point only the vault can
        // supply or redeem adapter assets.
        if (mode == SavingsVault.VaultMode.Earn) adapter.bindVault(vault);
        _vaults.push(vault);
        isVault[vault] = true;
        if (group) _groupNames[vault] = groupName_;
        safetyController.registerVault(vault);

        for (uint256 i; i < members.length; ++i) {
            _memberVaults[members[i]].push(vault);
        }
        // RewardPool accepts eligibility assertions only from factory-created vaults.
        rewardPool.registerVault(vault);
        emit VaultCreated(vault, msg.sender, group, mode, address(adapter), maturity);
    }
}
