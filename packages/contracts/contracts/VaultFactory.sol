// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RewardPool} from "./RewardPool.sol";
import {SavingsVault} from "./SavingsVault.sol";
import {EarlyExitMarket} from "./EarlyExitMarket.sol";

contract VaultFactory {
    uint256 public constant MAX_GROUP_MEMBERS = 50;

    error InvalidConfiguration();
    error CreatorNotMember();

    IERC20 public immutable asset;
    RewardPool public immutable rewardPool;
    EarlyExitMarket public immutable earlyExitMarket;

    address[] private _vaults;
    mapping(address member => address[] vaults) private _memberVaults;
    mapping(address vault => bool) public isVault;

    event VaultCreated(address indexed vault, address indexed creator, bool indexed isGroup, uint64 maturity);

    constructor(IERC20 asset_, address riskReserve_, address maintenanceTreasury_) {
        if (
            address(asset_) == address(0) || riskReserve_ == address(0) || maintenanceTreasury_ == address(0)
        ) revert InvalidConfiguration();
        asset = asset_;
        rewardPool = new RewardPool(asset_, address(this));
        earlyExitMarket = new EarlyExitMarket(
            asset_, rewardPool, address(this), riskReserve_, maintenanceTreasury_
        );
    }

    function createPersonalVault(uint256 target, uint64 maturity, uint16 emergencyBps)
        external
        returns (address vault)
    {
        address[] memory members = new address[](1);
        members[0] = msg.sender;
        uint256[] memory targets = new uint256[](1);
        targets[0] = target;
        uint16[] memory allocations = new uint16[](1);
        allocations[0] = emergencyBps;
        vault = _create(false, members, targets, allocations, maturity);
    }

    function createGroupVault(
        address[] calldata members,
        uint256[] calldata targets,
        uint16[] calldata emergencyBps,
        uint64 maturity
    ) external returns (address vault) {
        uint256 count = members.length;
        if (count < 2 || count > MAX_GROUP_MEMBERS) revert InvalidConfiguration();

        bool creatorIncluded;
        for (uint256 i; i < count; ++i) {
            if (members[i] == msg.sender) creatorIncluded = true;
        }
        if (!creatorIncluded) revert CreatorNotMember();
        vault = _create(true, members, targets, emergencyBps, maturity);
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
        uint64 maturity
    ) internal returns (address vault) {
        SavingsVault deployed = new SavingsVault(
            asset,
            rewardPool,
            maturity,
            group,
            address(earlyExitMarket),
            members,
            targets,
            emergencyBps
        );
        vault = address(deployed);
        _vaults.push(vault);
        isVault[vault] = true;

        for (uint256 i; i < members.length; ++i) {
            _memberVaults[members[i]].push(vault);
        }
        rewardPool.registerVault(vault);
        emit VaultCreated(vault, msg.sender, group, maturity);
    }
}
