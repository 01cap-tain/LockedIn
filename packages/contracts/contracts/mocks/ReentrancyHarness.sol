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

contract FeeOnTransferUSDT is ERC20 {
    bool public feesEnabled;

    constructor() ERC20("Fee USDT", "feeUSDT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function setFeesEnabled(bool enabled) external {
        feesEnabled = enabled;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (feesEnabled && from != address(0) && to != address(0)) {
            uint256 fee = value / 10;
            super._update(from, to, value - fee);
            if (fee != 0) super._update(from, address(0), fee);
            return;
        }
        super._update(from, to, value);
    }
}

contract SlashableUSDT is ERC20 {
    constructor() ERC20("Slashable USDT", "sUSDT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function slash(address account, uint256 amount) external {
        _burn(account, amount);
    }
}

contract WrongDecimalsToken is ERC20 {
    constructor() ERC20("Wrong Decimals", "WRONG") {}

    function decimals() public pure override returns (uint8) {
        return 18;
    }
}

contract NoReturnUSDT {
    string public constant name = "No Return USDT";
    string public constant symbol = "nrUSDT";
    uint8 public constant decimals = 6;
    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address recipient, uint256 amount) external {
        _transfer(msg.sender, recipient, amount);
    }

    function transferFrom(address sender, address recipient, uint256 amount) external {
        uint256 permitted = allowance[sender][msg.sender];
        require(permitted >= amount, "allowance");
        allowance[sender][msg.sender] = permitted - amount;
        _transfer(sender, recipient, amount);
    }

    function _transfer(address sender, address recipient, uint256 amount) internal {
        require(balanceOf[sender] >= amount, "balance");
        balanceOf[sender] -= amount;
        balanceOf[recipient] += amount;
    }
}

contract ReentrantMarketSeller is ITokenReceiver {
    SavingsVault public vault;
    IERC20 public token;
    address public market;
    uint256 public listingId;
    bool public reentrySucceeded;

    function configure(SavingsVault vault_, IERC20 token_, address market_) external {
        vault = vault_;
        token = token_;
        market = market_;
    }

    function acceptInvitation() external {
        vault.acceptGroupInvitation();
    }

    function deposit(uint256 positionId, uint256 amount) external {
        token.approve(address(vault), amount);
        vault.deposit(positionId, amount);
    }

    function list(uint256 positionId, uint64 expiresAt, uint256 minimumPayout) external {
        (bool success, bytes memory data) = market.call(
            abi.encodeWithSignature(
                "createListing(address,uint256,uint64,uint256)",
                address(vault), positionId, expiresAt, minimumPayout
            )
        );
        require(success, "listing failed");
        listingId = abi.decode(data, (uint256));
    }

    function onTokenReceived() external {
        if (msg.sender == address(token)) {
            // The seller receives tokens during settlement and attempts to reenter the same listing.
            (reentrySucceeded,) = market.call(abi.encodeWithSignature("fundListing(uint256)", listingId));
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

    function acceptInvitation() external {
        vault.acceptGroupInvitation();
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
