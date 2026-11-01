// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { euint64, externalEuint64, sharedEuint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { IERC165 } from "@openzeppelin/contracts/interfaces/IERC165.sol";

/**
 * @dev Interface for a confidential fungible token standard utilizing the Fhenix FHE library.
 */
interface IERC7984 is IERC165 {
    /**
     * @dev Emitted when the expiration timestamp for an operator `operator` is updated for a given `holder`.
     * The operator may move any amount of tokens on behalf of the holder until the timestamp `until`.
     */
    event OperatorSet(address indexed holder, address indexed operator, uint48 until);

    /// @dev Emitted when a confidential transfer is made from `from` to `to` of encrypted amount `amount`.
    event ConfidentialTransfer(address indexed from, address indexed to, euint64 indexed amount);

    /**
     * @dev Emitted when an encrypted amount is disclosed.
     *
     * Accounts with access to the encrypted amount `encryptedAmount` that is also accessible to this contract
     * should be able to disclose the amount. This functionality is implementation specific.
     */
    event AmountDisclosed(euint64 indexed encryptedAmount, uint64 amount);

    /// @dev Returns the name of the token.
    function name() external view returns (string memory);

    /// @dev Returns the symbol of the token.
    function symbol() external view returns (string memory);

    /// @dev Returns the number of decimals of the token. Recommended to be 6.
    function decimals() external view returns (uint8);

    /// @dev Returns the contract URI. See https://eips.ethereum.org/EIPS/eip-7572[ERC-7572] for details.
    function contractURI() external view returns (string memory);

    /// @dev Returns the confidential total supply of the token.
    function confidentialTotalSupply() external view returns (euint64);

    /// @dev Returns the confidential balance of the account `account`.
    function confidentialBalanceOf(address account) external view returns (euint64);

    /// @dev Returns true if `spender` is currently an operator for `holder`.
    function isOperator(address holder, address spender) external view returns (bool);

    /**
     * @dev Sets `operator` as an operator for `holder` until the timestamp `until`.
     *
     * NOTE: An operator may transfer any amount of tokens on behalf of a holder while approved.
     */
    function setOperator(address operator, uint48 until) external;

    /**
     * @dev Transfers the encrypted amount `encryptedAmount` to `to`.
     *
     * `inputProof` is the batch signature returned alongside the handle by `encryptInputs`, and must
     * have been signed for this contract as the consuming contract.
     *
     * Returns the encrypted amount that was actually transferred.
     */
    function confidentialTransfer(
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) external returns (sharedEuint64);

    /**
     * @dev Similar to {confidentialTransfer-address-externalEuint64-bytes} but for a value already
     * held by another contract. The caller shares the handle with {FHE-shareEuint64} naming this
     * token; the token consumes that share, so the sharer must be the direct caller.
     */
    function confidentialTransfer(
        address to,
        sharedEuint64 sharedAmount
    ) external returns (sharedEuint64 transferred);

    /**
     * @dev Transfers the encrypted amount `encryptedAmount` from `from` to `to`.
     * `msg.sender` must be either `from` or an operator for `from`.
     *
     * Returns the encrypted amount that was actually transferred.
     */
    function confidentialTransferFrom(
        address from,
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) external returns (sharedEuint64);

    /**
     * @dev Similar to {confidentialTransferFrom-address-address-externalEuint64-bytes} but for a value
     * already held by another contract, shared with {FHE-shareEuint64} naming this token.
     */
    function confidentialTransferFrom(
        address from,
        address to,
        sharedEuint64 sharedAmount
    ) external returns (sharedEuint64 transferred);

    /**
     * @dev Similar to {confidentialTransfer-address-externalEuint64-bytes} but with a callback to `to`
     * after the transfer.
     *
     * The callback is made to the {IERC7984Receiver-onConfidentialTransferReceived} function on the
     * to address with the actual transferred amount (may differ from the given `encryptedAmount`) and the given
     * data `data`.
     */
    function confidentialTransferAndCall(
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof,
        bytes calldata data
    ) external returns (sharedEuint64 transferred);

    /// @dev Similar to {confidentialTransfer-address-sharedEuint64} but with a callback to `to` after the transfer.
    function confidentialTransferAndCall(
        address to,
        sharedEuint64 sharedAmount,
        bytes calldata data
    ) external returns (sharedEuint64 transferred);

    /**
     * @dev Similar to {confidentialTransferFrom-address-address-externalEuint64-bytes} but with a
     * callback to `to` after the transfer.
     */
    function confidentialTransferFromAndCall(
        address from,
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof,
        bytes calldata data
    ) external returns (sharedEuint64 transferred);

    /**
     * @dev Similar to {confidentialTransferFrom-address-address-sharedEuint64} but with a callback to `to`
     * after the transfer.
     *
     */
    function confidentialTransferFromAndCall(
        address from,
        address to,
        sharedEuint64 sharedAmount,
        bytes calldata data
    ) external returns (sharedEuint64 transferred);
}
