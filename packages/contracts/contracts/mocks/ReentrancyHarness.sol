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
            try ITokenReceiver(to).onTokenReceived() {} catch {}
        }
    }
}

contract FalseReturnUSDT is ERC20 {
    bool public failTransfersFrom;

    constructor() ERC20("False Return USDT", "fUSDT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function setFailTransfersFrom(bool fail) external {
        failTransfersFrom = fail;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (failTransfersFrom) return false;
        return super.transferFrom(from, to, value);
    }
}

contract ReentrantMarketSeller is ITokenReceiver {
    SavingsVault public vault;
    IERC20 public token;
    address public market;
    uint256 public listingId;
    uint256 public offerId;
    bool public reentrySucceeded;

    function configure(SavingsVault vault_, IERC20 token_, address market_) external {
        vault = vault_;
        token = token_;
        market = market_;
    }

    function deposit(uint256 positionId, uint256 amount) external {
        token.approve(address(vault), amount);
        vault.deposit(positionId, amount);
    }

    function list(uint256 positionId, uint16 discountBps, uint64 expiresAt) external {
        (bool success, bytes memory data) = market.call(
            abi.encodeWithSignature(
                "createListing(address,uint256,uint16,uint64)",
                address(vault), positionId, discountBps, expiresAt
            )
        );
        require(success, "listing failed");
        listingId = abi.decode(data, (uint256));
    }

    function accept(uint256 offerId_) external {
        offerId = offerId_;
        (bool success,) = market.call(
            abi.encodeWithSignature("acceptOffer(uint256,uint256)", listingId, offerId_)
        );
        require(success, "accept failed");
    }

    function onTokenReceived() external {
        if (msg.sender == address(token)) {
            (reentrySucceeded,) = market.call(
                abi.encodeWithSignature("acceptOffer(uint256,uint256)", listingId, offerId)
            );
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
