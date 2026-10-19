// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Narrow protocol pause and principal-cap controller with no asset custody.
/// @dev The immutable safety council can pause immediately. Unpausing and cap
/// changes require a public timelock; this contract cannot move user funds.
contract SafetyController {
    struct PendingCaps {
        uint256 maxPositionPrincipal;
        uint256 maxVaultPrincipal;
        uint256 maxProtocolPrincipal;
        uint64 executableAt;
        bool exists;
    }

    error SafetyCouncilOnly();
    error FactoryOnly();
    error VaultOnly();
    error ProtocolIsPaused();
    error ProtocolNotPaused();
    error InvalidConfiguration();
    error ExposureCapExceeded();
    error TimelockNotReady();
    error NoPendingChange();

    address public immutable factory;
    address public immutable safetyCouncil;
    uint64 public immutable timelockDelay;

    bool public paused;
    uint64 public unpauseExecutableAt;
    uint256 public maxPositionPrincipal;
    uint256 public maxVaultPrincipal;
    uint256 public maxProtocolPrincipal;
    uint256 public totalOutstandingPrincipal;
    PendingCaps public pendingCaps;

    mapping(address vault => bool registered) public registeredVault;
    mapping(address vault => uint256 principal) public vaultOutstandingPrincipal;

    event ProtocolPaused(address indexed safetyCouncil);
    event UnpauseScheduled(uint64 executableAt);
    event ProtocolUnpaused(address indexed executor);
    event CapsScheduled(
        uint256 maxPositionPrincipal,
        uint256 maxVaultPrincipal,
        uint256 maxProtocolPrincipal,
        uint64 executableAt
    );
    event CapsUpdated(
        uint256 maxPositionPrincipal,
        uint256 maxVaultPrincipal,
        uint256 maxProtocolPrincipal
    );
    event ScheduledChangesCancelled();
    event VaultRegistered(address indexed vault);
    event PrincipalExposureIncreased(
        address indexed vault,
        uint256 amount,
        uint256 vaultOutstanding,
        uint256 protocolOutstanding
    );
    event PrincipalExposureReduced(
        address indexed vault,
        uint256 amount,
        uint256 vaultOutstanding,
        uint256 protocolOutstanding
    );

    constructor(
        address factory_,
        address safetyCouncil_,
        uint64 timelockDelay_,
        uint256 maxPositionPrincipal_,
        uint256 maxVaultPrincipal_,
        uint256 maxProtocolPrincipal_
    ) {
        if (
            factory_ == address(0) || safetyCouncil_ == address(0) ||
            timelockDelay_ == 0 || maxPositionPrincipal_ == 0 ||
            maxVaultPrincipal_ < maxPositionPrincipal_ ||
            maxProtocolPrincipal_ < maxVaultPrincipal_
        ) revert InvalidConfiguration();
        factory = factory_;
        safetyCouncil = safetyCouncil_;
        timelockDelay = timelockDelay_;
        maxPositionPrincipal = maxPositionPrincipal_;
        maxVaultPrincipal = maxVaultPrincipal_;
        maxProtocolPrincipal = maxProtocolPrincipal_;
    }

    modifier onlySafetyCouncil() {
        if (msg.sender != safetyCouncil) revert SafetyCouncilOnly();
        _;
    }

    function requireNotPaused() external view {
        if (paused) revert ProtocolIsPaused();
    }

    function pause() external onlySafetyCouncil {
        paused = true;
        unpauseExecutableAt = 0;
        emit ProtocolPaused(msg.sender);
    }

    function scheduleUnpause() external onlySafetyCouncil {
        if (!paused) revert ProtocolNotPaused();
        unpauseExecutableAt = uint64(block.timestamp) + timelockDelay;
        emit UnpauseScheduled(unpauseExecutableAt);
    }

    function executeUnpause() external {
        uint64 executableAt = unpauseExecutableAt;
        if (executableAt == 0) revert NoPendingChange();
        if (block.timestamp < executableAt) revert TimelockNotReady();
        paused = false;
        unpauseExecutableAt = 0;
        emit ProtocolUnpaused(msg.sender);
    }

    function scheduleCaps(
        uint256 maxPositionPrincipal_,
        uint256 maxVaultPrincipal_,
        uint256 maxProtocolPrincipal_
    ) external onlySafetyCouncil {
        if (
            maxPositionPrincipal_ == 0 ||
            maxVaultPrincipal_ < maxPositionPrincipal_ ||
            maxProtocolPrincipal_ < maxVaultPrincipal_
        ) revert InvalidConfiguration();
        uint64 executableAt = uint64(block.timestamp) + timelockDelay;
        pendingCaps = PendingCaps({
            maxPositionPrincipal: maxPositionPrincipal_,
            maxVaultPrincipal: maxVaultPrincipal_,
            maxProtocolPrincipal: maxProtocolPrincipal_,
            executableAt: executableAt,
            exists: true
        });
        emit CapsScheduled(
            maxPositionPrincipal_,
            maxVaultPrincipal_,
            maxProtocolPrincipal_,
            executableAt
        );
    }

    function executeCaps() external {
        PendingCaps memory next = pendingCaps;
        if (!next.exists) revert NoPendingChange();
        if (block.timestamp < next.executableAt) revert TimelockNotReady();
        maxPositionPrincipal = next.maxPositionPrincipal;
        maxVaultPrincipal = next.maxVaultPrincipal;
        maxProtocolPrincipal = next.maxProtocolPrincipal;
        delete pendingCaps;
        emit CapsUpdated(
            maxPositionPrincipal,
            maxVaultPrincipal,
            maxProtocolPrincipal
        );
    }

    function cancelScheduledChanges() external onlySafetyCouncil {
        unpauseExecutableAt = 0;
        delete pendingCaps;
        emit ScheduledChangesCancelled();
    }

    function registerVault(address vault) external {
        if (msg.sender != factory) revert FactoryOnly();
        if (vault == address(0) || registeredVault[vault]) revert InvalidConfiguration();
        registeredVault[vault] = true;
        emit VaultRegistered(vault);
    }

    /// @notice Reserves principal exposure before a deposit completes.
    function recordDeposit(uint256 positionPrincipal, uint256 amount) external {
        if (!registeredVault[msg.sender]) revert VaultOnly();
        if (paused) revert ProtocolIsPaused();
        uint256 nextPosition = positionPrincipal + amount;
        uint256 nextVault = vaultOutstandingPrincipal[msg.sender] + amount;
        uint256 nextProtocol = totalOutstandingPrincipal + amount;
        if (
            nextPosition > maxPositionPrincipal ||
            nextVault > maxVaultPrincipal ||
            nextProtocol > maxProtocolPrincipal
        ) revert ExposureCapExceeded();
        vaultOutstandingPrincipal[msg.sender] = nextVault;
        totalOutstandingPrincipal = nextProtocol;
        emit PrincipalExposureIncreased(msg.sender, amount, nextVault, nextProtocol);
    }

    /// @notice Reduces net outstanding principal; this remains callable while paused.
    function recordWithdrawal(uint256 amount) external {
        if (!registeredVault[msg.sender]) revert VaultOnly();
        uint256 vaultPrincipal = vaultOutstandingPrincipal[msg.sender];
        if (amount > vaultPrincipal || amount > totalOutstandingPrincipal) {
            revert InvalidConfiguration();
        }
        uint256 nextVault = vaultPrincipal - amount;
        uint256 nextProtocol = totalOutstandingPrincipal - amount;
        vaultOutstandingPrincipal[msg.sender] = nextVault;
        totalOutstandingPrincipal = nextProtocol;
        emit PrincipalExposureReduced(msg.sender, amount, nextVault, nextProtocol);
    }
}
