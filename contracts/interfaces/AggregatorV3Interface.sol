// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/**
 * @dev Minimal Chainlink price-feed interface.
 *
 *
 * NOTE: `answer` is signed and feed-scaled. Consumers must reject non-positive
 * answers, check `updatedAt` for staleness, and normalise using {decimals}.
 */
interface AggregatorV3Interface {
    /// @dev Number of decimals in the feed's `answer`. ETH/USD is typically 8.
    function decimals() external view returns (uint8);

    /// @dev Human-readable feed name, e.g. "ETH / USD".
    function description() external view returns (string memory);

    /// @dev Feed interface version.
    function version() external view returns (uint256);

    /**
     * @dev Data for the most recent round.
     * @return roundId         The round the answer belongs to.
     * @return answer          The price, scaled by 10**{decimals}.
     * @return startedAt       When the round started.
     * @return updatedAt       When the answer was last written — the staleness clock.
     * @return answeredInRound The round the answer was computed in. If it lags
     *                         `roundId`, the answer is carried over from an
     *                         earlier round and should be treated as stale.
     */
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}