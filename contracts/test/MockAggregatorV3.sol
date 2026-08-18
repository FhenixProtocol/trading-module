// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { AggregatorV3Interface } from '../interfaces/AggregatorV3Interface.sol';

/// @title  MockAggregatorV3
/// @notice Test double for a Chainlink price feed. Every field {latestRoundData}
///         returns is independently settable so consumers can be driven into
///         each failure mode: a stale `updatedAt`, a non-positive `answer`, a
///         never-written feed, or a round carried over from an earlier one
///         (`answeredInRound < roundId`).
contract MockAggregatorV3 is AggregatorV3Interface {
    uint8 private _decimals;
    int256 private _answer;
    uint256 private _startedAt;
    uint256 private _updatedAt;
    uint80 private _roundId;
    uint80 private _answeredInRound;

    /// @param decimals_ Feed scale. Chainlink USD pairs use 8.
    /// @param answer_   Initial answer, scaled by 10**decimals_.
    constructor(uint8 decimals_, int256 answer_) {
        _decimals = decimals_;
        _answer = answer_;
        _roundId = 1;
        _answeredInRound = 1;
        _startedAt = block.timestamp;
        _updatedAt = block.timestamp;
    }

    /// @notice Publish a new answer, stamped at the current block.
    function setAnswer(int256 answer_) external {
        _answer = answer_;
        _roundId += 1;
        _answeredInRound = _roundId;
        _startedAt = block.timestamp;
        _updatedAt = block.timestamp;
    }

    /// @notice Overwrite `updatedAt` without touching the answer, to simulate a
    ///         feed that has gone quiet.
    function setUpdatedAt(uint256 updatedAt_) external {
        _updatedAt = updatedAt_;
    }

    /// @notice Force `answeredInRound` behind `roundId` — a carried-over answer.
    function setAnsweredInRound(uint80 answeredInRound_) external {
        _answeredInRound = answeredInRound_;
    }

    /// @notice Change the reported scale, to test the decimals assertion.
    function setDecimals(uint8 decimals_) external {
        _decimals = decimals_;
    }

    /// @inheritdoc AggregatorV3Interface
    function decimals() external view returns (uint8) {
        return _decimals;
    }

    /// @inheritdoc AggregatorV3Interface
    function description() external pure returns (string memory) {
        return 'Mock ETH / USD';
    }

    /// @inheritdoc AggregatorV3Interface
    function version() external pure returns (uint256) {
        return 4;
    }

    /// @inheritdoc AggregatorV3Interface
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (_roundId, _answer, _startedAt, _updatedAt, _answeredInRound);
    }
}
