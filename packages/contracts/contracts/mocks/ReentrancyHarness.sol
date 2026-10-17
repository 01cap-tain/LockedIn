// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SavingsVault} from "../SavingsVault.sol";

interface ITokenReceiver {
    function onTokenReceived() external;
}

contract CallbackUSDT is ERC20 {
    bool public callbacksEnabled;

    constructor() ERC20("Callback USDT", "cUSDT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function setCallbacksEnabled(bool enabled) external {
        callbacksEnabled = enabled;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (callbacksEnabled && from != address(0) && to.code.length != 0) {
            ITokenReceiver(to).onTokenReceived();
        }
    }
}

contract ReentrantMember is ITokenReceiver {
    SavingsVault public vault;
    IERC20 public token;
    uint256 public positionId;
    uint256 public attackAmount;
    bool public reentrySucceeded;

    function configure(SavingsVault vault_, IERC20 token_, uint256 positionId_) external {
        vault = vault_;
        token = token_;
        positionId = positionId_;
    }

    function deposit(uint256 amount) external {
        token.approve(address(vault), amount);
        vault.deposit(positionId, amount);
    }

    function withdrawWithReentry(uint256 amount) external {
        attackAmount = amount;
        vault.withdrawEmergency(positionId, amount);
        attackAmount = 0;
    }

    function onTokenReceived() external {
        if (msg.sender == address(token) && attackAmount != 0) {
            (reentrySucceeded,) = address(vault).call(
                abi.encodeCall(SavingsVault.withdrawEmergency, (positionId, attackAmount))
            );
        }
    }
}
