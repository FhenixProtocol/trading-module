// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHERC20_Harness } from "./FHERC20_Harness.sol";

/// @dev Dual-ledger stand-in: the public `decimals()` and the confidential `confidentialDecimals()` differ,
///      so tests can pin that the OTC reads the confidential precision.
contract MockDualLedgerToken is FHERC20_Harness {
    uint8 private immutable _confDecimals;

    constructor(uint8 publicDecimals_, uint8 confDecimals_) FHERC20_Harness("Dual", "DUAL", publicDecimals_, "") {
        _confDecimals = confDecimals_;
    }

    function confidentialDecimals() external view returns (uint8) {
        return _confDecimals;
    }
}
