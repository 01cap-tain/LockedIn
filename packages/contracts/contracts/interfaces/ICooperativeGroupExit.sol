// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Public boundary for contract-controlled unanimous group exits.
interface ICooperativeGroupExit {
    function requestGroupExit() external returns (uint256 requestId);
    function approveGroupExit(uint256 requestId) external;
    function revokeGroupExitApproval(uint256 requestId) external;
    function cancelGroupExit(uint256 requestId) external;
    function expireGroupExit(uint256 requestId) external;
    function completeGroupExit(uint256 requestId) external;
    function hasBlockingGroupExitRequest(uint256 positionId) external view returns (bool);
    function groupExitApprovalProgress(uint256 requestId)
        external
        view
        returns (uint32 required, uint32 completed);
}
