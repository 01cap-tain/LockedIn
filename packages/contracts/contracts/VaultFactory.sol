// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPool} from "@aave/core-v3/contracts/interfaces/IPool.sol";
import {IAToken} from "@aave/core-v3/contracts/interfaces/IAToken.sol";
import {RewardPool} from "./RewardPool.sol";
import {SavingsVault} from "./SavingsVault.sol";
import {EarlyExitMarket} from "./EarlyExitMarket.sol";
import {AaveYieldAdapter} from "./AaveYieldAdapter.sol";

/// @notice Deploys immutable Safe or Earn savings vaults and records membership indexes.
/// @dev The factory creates infrastructure but receives no authority over member principal.
contract VaultFactory {
    uint256 public constant MAX_GROUP_MEMBERS = 50;

    error InvalidConfiguration();
    error CreatorNotMember();
    error UnsupportedToken();

    IERC20 public immutable asset;
    RewardPool public immutable rewardPool;
    EarlyExitMarket public immutable earlyExitMarket;
    IPool public immutable aavePool;
    IAToken public immutable aToken;
    uint256 public immutable deploymentChainId;

    address[] private _vaults;
    mapping(address member => address[] vaults) private _memberVaults;
    mapping(address vault => bool) public isVault;

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
        uint256 deploymentChainId_
    ) {
        if (
            address(asset_) == address(0) || address(asset_).code.length == 0 ||
            riskReserve_ == address(0) || maintenanceTreasury_ == address(0) ||
            riskReserve_ == maintenanceTreasury_ || riskReserve_ == address(asset_) ||
            maintenanceTreasury_ == address(asset_) || riskReserve_ == address(this) ||
            maintenanceTreasury_ == address(this)
        ) revert InvalidConfiguration();
        try IERC20Metadata(address(asset_)).decimals() returns (uint8 tokenDecimals) {
            if (tokenDecimals != 6) revert UnsupportedToken();
        } catch {
            revert UnsupportedToken();
        }
        asset = asset_;
        aavePool = aavePool_;
        aToken = aToken_;
        deploymentChainId = deploymentChainId_;
        rewardPool = new RewardPool(asset_, address(this));
        earlyExitMarket = new EarlyExitMarket(
            asset_, rewardPool, address(this), riskReserve_, maintenanceTreasury_
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
        address[] memory members = new address[](1);
        members[0] = msg.sender;
        uint256[] memory targets = new uint256[](1);
        targets[0] = target;
        uint16[] memory allocations = new uint16[](1);
        allocations[0] = emergencyBps;
        vault = _create(false, members, targets, allocations, maturity, mode);
    }

    function createGroupVault(
        address[] calldata members,
        uint256[] calldata targets,
        uint16[] calldata emergencyBps,
        uint64 maturity,
        SavingsVault.VaultMode mode
    ) external returns (address vault) {
        uint256 count = members.length;
        if (count < 2 || count > MAX_GROUP_MEMBERS) revert InvalidConfiguration();

        bool creatorIncluded;
        for (uint256 i; i < count; ++i) {
            if (members[i] == msg.sender) creatorIncluded = true;
        }
        if (!creatorIncluded) revert CreatorNotMember();
        vault = _create(true, members, targets, emergencyBps, maturity, mode);
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

    function _create(
        bool group,
        address[] memory members,
        uint256[] memory targets,
        uint16[] memory emergencyBps,
        uint64 maturity,
        SavingsVault.VaultMode mode
    ) internal returns (address vault) {
        AaveYieldAdapter adapter;
        if (mode == SavingsVault.VaultMode.Earn) {
            // Each Earn vault receives an isolated adapter. Sharing one adapter would mix
            // share supplies between vaults and weaken both accounting and access control.
            adapter = new AaveYieldAdapter(
                asset, aavePool, aToken, address(this), deploymentChainId
            );
        }
        SavingsVault deployed = new SavingsVault(
            asset,
            rewardPool,
            maturity,
            group,
            address(earlyExitMarket),
            mode,
            adapter,
            members,
            targets,
            emergencyBps
        );
        vault = address(deployed);
        // Binding is a one-time factory operation; after this point only the vault can
        // supply or redeem adapter assets.
        if (mode == SavingsVault.VaultMode.Earn) adapter.bindVault(vault);
        _vaults.push(vault);
        isVault[vault] = true;

        for (uint256 i; i < members.length; ++i) {
            _memberVaults[members[i]].push(vault);
        }
        // RewardPool accepts eligibility assertions only from factory-created vaults.
        rewardPool.registerVault(vault);
        emit VaultCreated(vault, msg.sender, group, mode, address(adapter), maturity);
    }
}
