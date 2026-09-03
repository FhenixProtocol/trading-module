// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Ownable } from '@openzeppelin/contracts/access/Ownable.sol';
import { Pausable } from '@openzeppelin/contracts/utils/Pausable.sol';
import { ReentrancyGuard } from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import { EnumerableSet } from '@openzeppelin/contracts/utils/structs/EnumerableSet.sol';
import { FHE, euint64, euint8, ebool, externalEuint64 } from '@fhenixprotocol/cofhe-contracts/FHE.sol';
import { IFHERC20 } from '../interfaces/IFHERC20.sol';
import { AggregatorV3Interface } from '../interfaces/AggregatorV3Interface.sol';

/// @title  ConfidentialOTC
/// @author Rogue Rotkosky, Fhenix
/// @notice Peer-to-peer confidential OTC trading between any two whitelisted
///         FHERC20 tokens (cANY<>cANY). Order sizes and per-fill amounts are
///         fully encrypted, but each order's size *bracket* is published as a
///         plaintext uint8 on-chain so the book can be browsed, sorted, and
///         filtered without any client-side decryption.
/// @dev    Built on the CoFHE coprocessor: encrypted values are `euint*` handles
///         whose plaintext is only ever revealed through a threshold-network
///         decryption proof (`FHE.publishDecryptResult`). The full system
///         reference lives in docs/otc/OTC_REFERENCE.md; the oracle/whitelist model in
///         docs/otc/ORACLE.md (when present).
///
/// ──────────────────────────────────────────────────────────────────────────
/// Public bracket (the core mechanism)
/// ──────────────────────────────────────────────────────────────────────────
///
/// The bracket is still *computed* under FHE (`_computeBracket` → euint8), but
/// its plaintext is written into the order via a threshold-decryption proof
/// (`FHE.publishDecryptResult`). Every action that changes `eRemaining`
/// (create / fill / top-up) snapshots its own bracket handle into a per-order
/// `Publish` record keyed by a monotonic `seq`, then a second step
/// (`publishBracket`) proves that handle's plaintext and updates the order.
///
/// Token transfers always stay atomic in the first transaction; the second
/// step moves no value — it only reveals the bracket and, via the frontier
/// rule, lists or delists the order.
///
/// ──────────────────────────────────────────────────────────────────────────
/// Order lifecycle
/// ──────────────────────────────────────────────────────────────────────────
///
///   pending  → created, input escrowed (+ optional maker bond); bracket not
///              yet revealed, NOT discoverable or fillable.
///   active   → bracket published non-EMPTY; listed in the pair index; fillable
///              and top-up-able.
///   dormant  → was active, last published bracket is EMPTY (depleted) or the
///              order expired; delisted but NOT destroyed — escrow is retained
///              and the order can be revived by a top-up whose publish re-lists
///              it (the symmetric frontier rule).
///   closed   → cancelled by the maker; terminal. Remaining escrow and the
///              maker bond are returned. Outstanding fill bonds remain
///              recoverable by their depositors.
///
/// Creation is two steps because the *bracket reveal* is two steps, not because
/// of any fee: `createOrder` escrows and computes the encrypted bracket;
/// `activateOrder` publishes it (the create record) and lists the order.
///
/// ──────────────────────────────────────────────────────────────────────────
/// Seq, Publish records, and canonical selection
/// ──────────────────────────────────────────────────────────────────────────
///
/// Each order keeps `latestSeq` (bumped by every create/fill/top-up) and
/// `publishedSeq` (highest seq whose bracket is canonical). A `publishBracket`
/// only advances the displayed bracket when `seq > publishedSeq`; older or
/// out-of-order publishes are swallowed (they still settle their own bond).
/// Once `publishedSeq` passes a record's seq it is *absorbed* — its bracket no
/// longer matters, but its depositor still publishes (proof-free of skim within
/// the window) to settle and recover the bond.
///
/// The frontier rule: only a publish for the latest record (`seq == latestSeq`)
/// changes listing — non-EMPTY lists/re-lists, EMPTY delists. This makes
/// depletion self-evict and top-ups self-revive, and prevents a stale EMPTY
/// proof from delisting an order that has since been refilled.
///
/// ──────────────────────────────────────────────────────────────────────────
/// Bonds (ETH, USD-denominated via the ETH oracle)
/// ──────────────────────────────────────────────────────────────────────────
///
/// - Taker FILL bond: posted in `fillOrder`. Forces the mandatory post-fill
///   publish that keeps the public bracket fresh. Within a depositor-exclusive
///   grace window only the depositor may publish (full refund); after it,
///   anyone may publish for a bounty (`bountyBps`), the remainder refunded to
///   the depositor. This defeats mempool front-running of the proof.
/// - Maker bond: an OPTIONAL anti-spam lever, `makerBondUsd`, defaulting to 0.
///   Posted at `createOrder`, returned only on `cancelOrder`. Maker-initiated
///   publishes (`activateOrder`, `topUpOrder`) are otherwise bondless and
///   self-incentivized.
///
/// Bond sizes are denominated in 6-decimal USD and priced into wei via the ETH
/// oracle price (`ethOraclePrice`, Q44.20 USD per whole ETH). `ethBondSize()`
/// and `makerBondSize()` expose the instantaneous required wei.
///
/// ──────────────────────────────────────────────────────────────────────────
/// Token whitelist & oracle
/// ──────────────────────────────────────────────────────────────────────────
///
/// Only whitelisted tokens may be traded. Each whitelisted token carries a
/// Q44.20 oracle price (fUSD per whole token, scaled by 2^20) used solely for
/// bracket computation — it does not affect fill math, which uses the
/// maker-specified order price exclusively.
///
/// Bracket notional is `raw input units × price >> 20`, in raw 6-decimal fUSD
/// units. Because the oracle price is per WHOLE token, that product is only in
/// fUSD units when the input token itself has 6 decimals; a coarser ledger
/// needs ×10^(6 − decimals). `_toUSD` reads the token's confidential decimals
/// and rescales the price on every bracket computation.
///
/// fUSD is auto-whitelisted in the constructor at oraclePrice = Q_DENOM ($1).
/// Additional tokens are whitelisted by the owner via `whitelistToken`. Oracle
/// prices (including the ETH price used for bonds) are updated by the
/// designated `oracle` address (or the owner).
///
/// ──────────────────────────────────────────────────────────────────────────
/// Halting: delist (asset-scoped) vs. pause (contract-scoped)
/// ──────────────────────────────────────────────────────────────────────────
///
/// Two owner levers halt trading, differently scoped: `delistToken` clears one
/// token's whitelist flag, making that token's orders cancel-only while every
/// other pair keeps trading (the lever for a bad *asset*), and `pause` stops
/// every pair at once (the lever for a bad *contract*, or a migration). Both
/// gate only the paths that OPEN or INCREASE exposure — `createOrder`,
/// `fillOrder`, `topUpOrder`. Unwinding is never gated: `cancelOrder`,
/// `activateOrder` and `publishBracket` stay callable under both, so a halt
/// never strands escrow or an already-posted bond. A fill is not an unwind —
/// it hands the halted asset to a new holder at an `o.price` fixed at
/// `createOrder` and never repriceable.
///
/// ──────────────────────────────────────────────────────────────────────────
/// Order model
/// ──────────────────────────────────────────────────────────────────────────
///
/// Maker creates an order specifying:
///   - inputToken  : whitelisted FHERC20 they are giving into escrow.
///   - outputToken : whitelisted FHERC20 they want in return.
///   - price       : Q44.20 fixed-point rate — output units per input unit,
///                   scaled by 2^20 (1_048_576). Examples:
///                     $1.00  → 1_048_576
///                     $0.50  → 524_288
///                     $100   → 104_857_600
///   - expiry      : unix timestamp after which the order can no longer be
///                   filled. 0 = good-til-cancelled (never expires).
///   - encAmount   : encrypted input token quantity handle, with its `inputProof`
///                   batch signature bound to this contract.
///
/// All tokens are capped at 6 decimals (enforced at whitelist time); fUSD
/// must use exactly 6 decimals (enforced in the constructor). The decimals
/// that matter are those of the CONFIDENTIAL ledger — the only ledger this
/// venue ever moves — so dual-ledger tokens (e.g. FUSDJmi, FhenixToken) are
/// checked via `confidentialDecimals()` rather than the public `decimals()`.
///
/// A maker may call `topUpOrder` to inject more input tokens (even into a
/// dormant order, to revive it). Both `eRemaining` and `eDepositedAmount` grow
/// by the actual transferred delta; the new bracket is published by a follow-up
/// `publishBracket`.
///
/// ──────────────────────────────────────────────────────────────────────────
/// Fill flow (value atomic in tx1; bracket published in tx2)
/// ──────────────────────────────────────────────────────────────────────────
///
///   encTokensWanted → eActual = min(eTokensWanted, eRemaining, overflowCap)
///   eOutput         = eActual × price >> 20            // Q44.20
///   eOutputPaid     = outputToken.transferFrom(taker, maker, eOutput)
///   paidInFull      = (eOutputPaid == eOutput) && (eOutput > 0)
///   eRelease        = paidInFull ? eActual : 0
///   inputToken.transfer(taker, eRelease)               // from OTC escrow
///   eRemaining     -= eRelease
///   → snapshot the post-fill bracket into a Publish record (seq), post ETH bond
///
/// ──────────────────────────────────────────────────────────────────────────
/// Protocol swap fee
/// ──────────────────────────────────────────────────────────────────────────
///
/// A Q44.20 fee (`swapFeeQ20`, 0 at deploy, owner-settable up to
/// MAX_SWAP_FEE_Q20 ≈ 1%) is skimmed from the taker out of the input released
/// by a fill:
///
///   eFee     = eRelease × swapFeeQ20 >> 20
///   eToTaker = eRelease − eFee                 // sent to the taker
///   eRemaining -= eRelease                     // fee-inclusive; maker sold it all
///
/// Charging on the input leg is what makes the fee nearly free: that input is
/// already escrowed here, so the fee is booked into an encrypted per-token
/// accrual (`_feesAccrued`) with no extra confidential transfer. Charging the
/// output leg instead would force the taker→maker payment through this contract
/// and add a second transfer to every fill. `eRemaining` still moves by the full
/// `eRelease`, so no bracket path is affected by fees.
///
/// The rate is kept in BOTH plaintext (`swapFeeQ20`) and ciphertext
/// (`_eSwapFeeQ20`). The ciphertext is cached so a fill loads a handle rather
/// than paying for a fresh trivial encryption, and is `allowPublic`'d so anyone
/// may read the live fee. The plaintext mirror is not redundant: the fee is
/// public policy, and it is the only way to derive the overflow cap and to take
/// the zero-fee fast path — you cannot branch on a ciphertext.
///
/// Accrued fees are swept by the owner via `sweepFees(token)` to `treasury`,
/// at most once per COLLECT_COOLDOWN (23h) per token. A sweep discloses its own
/// size to the treasury, so throttling it stops the owner from bracketing a
/// single fill to back out that taker's exact amount from the public fee rate.
///
/// ──────────────────────────────────────────────────────────────────────────
///
/// FHERC20 transfers are all-or-nothing: if the taker cannot cover the full
/// `eOutput`, the payment moves 0 and `eOutputPaid != eOutput`, so `eRelease`
/// is 0 and the escrow is untouched. This prevents a taker from draining input
/// without paying. Takers must size their request to what they can afford.
///
/// Taker must have set the OTC as operator on their outputToken before calling
/// fillOrder, and must call `publishBracket` afterward (within the grace window)
/// to reveal the new bracket and reclaim their bond.
///
/// ──────────────────────────────────────────────────────────────────────────
/// Brackets
/// ──────────────────────────────────────────────────────────────────────────
///
///   0 = EMPTY    order is depleted or cancelled
///   1 = NANO     < $100
///   2 = SMALL    $100 – $1 000
///   3 = MEDIUM   $1 000 – $10 000
///   4 = LARGE    $10 000 – $100 000
///   5 = WHALE    ≥ $100 000
///   255 = UNPUBLISHED  sentinel before the first reveal (pending orders)
///
contract ConfidentialOTC is Ownable, ReentrancyGuard, Pausable {
    using EnumerableSet for EnumerableSet.UintSet;

    // ─────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Q44.20 price denominator: 2^20 = 1_048_576.
    uint64 public constant Q_DENOM = 1_048_576;

    /// @dev fUSD's confidential ledger must use exactly this many decimals —
    ///      the bracket thresholds below are denominated in 6-decimal fUSD units.
    uint8 public constant FUSD_DECIMALS = 6;

    /// @dev Any whitelisted token's confidential ledger may use at most this
    ///      many decimals. Tokens with more than 6 decimals cannot be priced
    ///      precisely in Q44.20; tokens with fewer are rescaled for bracket math
    ///      (see {_toUSD}). Enforced at whitelist time so createOrder never
    ///      needs to re-check.
    uint8 public constant MAX_TOKEN_DECIMALS = 6;

    /// @dev Minimum oracle price (Q44.20). Prevents tokens so cheap that
    ///      pairing them with expensive tokens overflows Q44.20 arithmetic.
    uint64 public constant MIN_ORACLE_PRICE = 1;

    /// @dev Basis-point denominator for the publish bounty split.
    uint256 public constant BPS_DENOM = 10_000;

    /// @dev Hard ceiling on the protocol swap fee, in Q44.20 (10_486 ≈ 1.00%).
    ///      Realistic OTC taker fees sit at 0.05–0.30%, so this leaves ample
    ///      headroom while bounding how far governance can move the fee against
    ///      takers. It also keeps the `eRelease × fee` overflow bound (see
    ///      {_fillCap}) around 1.76e15 raw units (~$1.76bn at 6 decimals).
    uint64 public constant MAX_SWAP_FEE_Q20 = 10_486;

    /// @dev Minimum interval between fee sweeps of the same token. Deliberately
    ///      a constant: it exists to constrain the owner, so an owner-settable
    ///      version would defeat itself. See {sweepFees}.
    uint64 public constant COLLECT_COOLDOWN = 23 hours;

    /// @dev seq assigned to the create record. Fills and top-ups increment from
    ///      here, so the create record is always the first and is published by
    ///      `activateOrder`.
    uint64 internal constant CREATE_SEQ = 1;

    // ─────────────────────────────────────────────────────────────────────────
    // Bracket labels (plaintext for external callers; encrypted for FHE ops)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Depleted or cancelled order (USD-equivalent size is exactly 0).
    uint8 public constant BRACKET_EMPTY = 0;
    /// @notice < $100.
    uint8 public constant BRACKET_NANO = 1;
    /// @notice $100 – $1 000.
    uint8 public constant BRACKET_SMALL = 2;
    /// @notice $1 000 – $10 000.
    uint8 public constant BRACKET_MEDIUM = 3;
    /// @notice $10 000 – $100 000.
    uint8 public constant BRACKET_LARGE = 4;
    /// @notice ≥ $100 000.
    uint8 public constant BRACKET_WHALE = 5;
    /// @notice Sentinel for an order whose bracket has not been published yet.
    uint8 public constant BRACKET_UNPUBLISHED = 255;

    /// @dev Encrypted bracket values — precomputed in constructor to avoid
    ///      repeated FHE.asEuint8 calls on every order create / fill.
    euint8 private immutable _E_BRACKET_EMPTY;
    euint8 private immutable _E_BRACKET_NANO;
    euint8 private immutable _E_BRACKET_SMALL;
    euint8 private immutable _E_BRACKET_MEDIUM;
    euint8 private immutable _E_BRACKET_LARGE;
    euint8 private immutable _E_BRACKET_WHALE;

    /// @dev Encrypted bracket thresholds in raw fUSD units (6 decimals).
    ///      Precomputed in constructor to avoid repeated FHE.asEuint64 calls.
    euint64 private immutable _NANO_MAX; // 100_000_000   ($100)
    euint64 private immutable _SMALL_MAX; // 1_000_000_000  ($1 000)
    euint64 private immutable _MEDIUM_MAX; // 10_000_000_000  ($10 000)
    euint64 private immutable _LARGE_MAX; // 100_000_000_000  ($100 000)

    /// @dev Precomputed shift operand for the Q44.20 right-shift (÷ 2^20).
    euint64 private immutable _E_SHR_20;

    /// @dev Precomputed encrypted zero, reused for comparisons and fallbacks.
    euint64 private immutable _E_ZERO64;

    /// @dev Q_DENOM - 1, added before the Q44.20 right-shift so the taker's
    ///      obligation rounds up instead of down. See {_swap}.
    euint64 private immutable _E_Q_MASK;

    // ─────────────────────────────────────────────────────────────────────────
    // Token whitelist & oracle
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Per-token whitelist entry.
    /// @dev    oraclePrice is Q44.20 (floor(usd_per_whole_token × 2^20)) and is
    ///         used only for bracket computation — it does not affect fill math.
    struct TokenConfig {
        /// @dev Whether the token may be used as an order leg.
        bool whitelisted;
        /// @dev Q44.20 bracket price (floor(usd_per_whole_token × 2^20)).
        uint64 oraclePrice;
        /// @dev Timestamp of the last oraclePrice update.
        uint64 priceUpdatedAt;
    }

    mapping(address => TokenConfig) private _tokenConfig;

    /// @notice Address permitted to call `updateOraclePrice` / `setEthOraclePrice`.
    ///         Owner always has the same privilege. Zero address disables the role.
    address public oracle;

    /// @notice ETH/USD oracle price, Q44.20 (floor(usd_per_whole_eth × 2^20)).
    ///         Used to convert USD-denominated bond sizes into wei. Must be set
    ///         before any bonded action whose USD size is non-zero.
    uint64 public ethOraclePrice;

    /// @notice Timestamp of the last {setEthOraclePrice}. 0 while unset.
    /// @dev    The companion `TokenConfig.priceUpdatedAt` already existed for the
    ///         cosmetic per-token feed; this mirrors it for the feed that
    ///         actually sizes funds, so bond pricing can detect "configured but
    ///         stale" rather than only "never configured". Only consulted on the
    ///         fallback path — when {ethUsdFeed} is set, Chainlink's own
    ///         `updatedAt` is the staleness clock.
    uint64 public ethPriceUpdatedAt;

    /// @notice Chainlink ETH/USD feed. When set it is the authoritative source
    ///         for bond sizing and {ethOraclePrice} is ignored. Zero address
    ///         falls back to the pushed price.
    /// @dev    Only the bond path reads a feed. Per-token *bracket* prices stay
    ///         pushed: the whitelisted set is confidential wrappers with no
    ///         canonical feeds, and brackets are decade-wide buckets where a
    ///         ~15k-gas external read on an already FHE-heavy path buys nothing.
    AggregatorV3Interface public ethUsdFeed;


    // ─────────────────────────────────────────────────────────────────────────
    // Governable bond / window parameters
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Taker fill bond, in 6-decimal USD. Default $5.
    uint64 public fillBondUsd = 5_000_000;

    /// @notice Optional maker anti-spam bond, in 6-decimal USD. Default 0 (off).
    uint64 public makerBondUsd = 0;

    /// @notice Publisher bounty after the grace window, in basis points. Default 20%.
    uint16 public bountyBps = 2_000;

    /// @notice Depositor-exclusive grace window for fill publishes, in seconds.
    ///         Default 10 minutes.
    uint64 public windowSeconds = 600;

    /// @notice Maximum age an oracle price may reach before it counts as stale.
    ///         Default 2 days. 0 disables staleness checks entirely.
    /// @dev    Enforced as a hard revert only on the ETH/bond path ({_usdToWei}),
    ///         where a drifting price mis-sizes real funds. For per-token bracket
    ///         prices it is advisory — see {isPriceStale} — because brackets are
    ///         decade-wide buckets and reverting fills over a slightly old price
    ///         would strand orders for no safety gain.
    uint64 public maxPriceAge = 2 days;

    // ─────────────────────────────────────────────────────────────────────────
    // Protocol swap fee
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Protocol swap fee, Q44.20 (fraction of the released input skimmed
    ///         from the taker). 0 = disabled, which is the deployed default.
    /// @dev    Deliberately plaintext: the fee is public policy, and a plaintext
    ///         mirror buys two things an `euint64` cannot. It lets {_fillCap}
    ///         derive the overflow bound without a decryption, and it lets
    ///         {_takeFee} branch — you cannot branch on an encrypted value, so
    ///         without this mirror a zero fee would still pay for the full FHE
    ///         mul/shr/sub/add on every fill.
    uint64 public swapFeeQ20;

    /// @dev Encrypted mirror of {swapFeeQ20}, cached so each fill loads a handle
    ///      from storage instead of paying for a fresh `FHE.asEuint64` trivial
    ///      encryption. Re-derived (and re-ACL'd) only when the fee changes.
    ///      `allowPublic`'d, so anyone may read or decrypt the current fee.
    euint64 private _eSwapFeeQ20;

    /// @notice Destination for swept protocol fees. Defaults to the deployer.
    address public treasury;

    /// @dev Encrypted fees accrued per token, awaiting a {sweepFees} sweep.
    ///      Fees are skimmed from input already sitting in escrow, so the
    ///      tokens are present without any extra transfer. An unset slot is the
    ///      zero handle, which `FHE.add` treats as encrypted zero.
    mapping(address => euint64) private _feesAccrued;

    /// @dev Last {sweepFees} timestamp per token, enforcing COLLECT_COOLDOWN.
    ///      0 means never swept, which never blocks the first sweep.
    mapping(address => uint64) private _lastCollectAt;

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The fUSD (confidential stablecoin) — the bracket unit of account.
    IFHERC20 public immutable fUSD;

    struct Order {
        /// @dev Order creator; address(0) means the order does not exist.
        address maker;
        /// @dev Token the maker placed into escrow.
        IFHERC20 inputToken;
        /// @dev Token the maker receives from takers.
        IFHERC20 outputToken;
        /// @dev Encrypted remaining input balance. Decremented on each fill.
        euint64 eRemaining;
        /// @dev Cumulative encrypted total deposited into this order (strictly
        ///      increasing). Increased by each top-up alongside eRemaining.
        ///      FHE.allow'd to the maker; divide eRemaining by this to track
        ///      fill progress across top-ups.
        euint64 eDepositedAmount;
        /// @dev Q44.20 price: output units per input unit × 2^20.
        uint64 price;
        /// @dev Unix timestamp after which the order cannot be filled.
        ///      0 = good-til-cancelled.
        uint64 expiry;
        /// @dev Plaintext published bracket (0–5), or BRACKET_UNPUBLISHED while
        ///      pending. Updated by `publishBracket` when seq > publishedSeq.
        uint8 bracket;
        /// @dev Highest seq assigned to this order (the frontier record).
        uint64 latestSeq;
        /// @dev Highest seq whose bracket is canonical (drives `bracket`).
        uint64 publishedSeq;
        /// @dev Maker bond escrowed in wei (0 when makerBondUsd is 0).
        uint256 makerBondWei;
        /// @dev True once activated and listed; false while pending/dormant/closed.
        bool active;
        /// @dev True between createOrder and the first successful publish.
        bool pending;
        /// @dev True once cancelled; terminal.
        bool closed;
    }

    /// @notice Per-action bracket snapshot. Created in tx1 (create/fill/top-up)
    ///         and consumed by `publishBracket`.
    struct Publish {
        /// @dev Encrypted bracket of eRemaining *after* this action. Immutable,
        ///      so the proof is valid whenever it lands.
        euint8 handle;
        /// @dev Who posted the record (taker for fills; maker for create/top-up).
        address depositor;
        /// @dev Bond in wei. >0 only for fill records; 0 for maker records.
        uint256 bondWei;
        /// @dev tx1 timestamp + windowSeconds. Non-zero only for fill records.
        uint64 deadline;
        /// @dev True once the bond has been settled (published or withdrawn).
        bool settled;
        /// @dev Publisher bounty in bps, stamped at fill time so {setParams}
        ///      stays prospective. 0 for maker records.
        uint16 bountyBps;
    }

    /// @notice Order storage, keyed by order id.
    mapping(uint256 => Order) public orders;
    /// @notice The id that will be assigned to the next created order.
    uint256 public nextOrderId;

    /// @dev Per-order publish records, keyed by seq.
    mapping(uint256 => mapping(uint64 => Publish)) private _publishes;

    /// @dev All order ids ever created by a maker (includes closed orders).
    mapping(address => uint256[]) private _makerOrderIds;

    /// @dev Active order ids keyed by keccak(inputToken, outputToken). Kept
    ///      clean: ids are added on list and removed on delist / cancel.
    mapping(bytes32 => EnumerableSet.UintSet) private _pairOrders;

    /// @dev Distinct order ids a taker has filled (deduped via the set).
    mapping(address => EnumerableSet.UintSet) private _takerFills;

    // ─────────────────────────────────────────────────────────────────────────
    // Views: aggregate read shape
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Flattened, frontend-friendly projection of an order.
    /// @dev    `bracket` is the plaintext published bracket (no decryption
    ///         needed). `bracketHandle` is the frontier encrypted snapshot,
    ///         exposed for an optional manual verification decrypt. Encrypted
    ///         balance handles are decryptable only by the maker.
    struct OrderView {
        /// @dev Order creator.
        address maker;
        /// @dev Escrowed token leg.
        address inputToken;
        /// @dev Requested token leg.
        address outputToken;
        /// @dev Q44.20 order price (output per input).
        uint64 price;
        /// @dev Expiry timestamp (0 = good-til-cancelled).
        uint64 expiry;
        /// @dev Plaintext published bracket (0–5), or BRACKET_UNPUBLISHED.
        uint8 bracket;
        /// @dev Highest seq assigned (the frontier record).
        uint64 latestSeq;
        /// @dev Highest seq whose bracket is canonical.
        uint64 publishedSeq;
        /// @dev Frontier encrypted bracket handle (for optional manual decrypt).
        bytes32 bracketHandle;
        /// @dev Encrypted remaining balance handle (maker-decryptable).
        bytes32 remainingHandle;
        /// @dev Encrypted cumulative deposited handle (maker-decryptable).
        bytes32 depositedHandle;
        /// @dev True while listed and fillable.
        bool active;
        /// @dev True before the first successful publish.
        bool pending;
        /// @dev True once cancelled (terminal).
        bool closed;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice A token was added to the trading whitelist.
    /// @param  token       The whitelisted token.
    /// @param  oraclePrice The initial Q44.20 oracle price assigned to it.
    event TokenWhitelisted(address indexed token, uint64 oraclePrice);

    /// @notice A token was removed from the whitelist; its orders are cancel-only.
    /// @param  token The delisted token.
    event TokenDelisted(address indexed token);

    /// @notice The address holding the oracle role was changed.
    /// @param  previousOracle The address that held the role (0 if disabled).
    /// @param  newOracle      The address that now holds it (0 disables it).
    event OracleUpdated(address indexed previousOracle, address indexed newOracle);

    /// @notice A whitelisted token's bracket oracle price was updated.
    /// @param  token       The token whose price changed.
    /// @param  oraclePrice The new Q44.20 price.
    event OraclePriceUpdated(address indexed token, uint64 oraclePrice);

    /// @notice The ETH/USD oracle price used to size ETH bonds was updated.
    /// @param  oraclePrice The new Q44.20 USD-per-ETH price.
    event EthOraclePriceUpdated(uint64 oraclePrice);

    /// @notice The oracle staleness window was changed.
    /// @param  maxPriceAge The new maximum price age in seconds (0 = disabled).
    event MaxPriceAgeUpdated(uint64 maxPriceAge);

    /// @notice The Chainlink ETH/USD feed used for bond sizing was changed.
    /// @param  feed The new aggregator, or address(0) to fall back to the
    ///              pushed `ethOraclePrice`.
    event EthUsdFeedUpdated(address indexed feed);

    /// @notice The governable bond / window parameters were retuned.
    /// @param  fillBondUsd   New taker fill bond (6-decimal USD).
    /// @param  makerBondUsd  New maker bond (6-decimal USD).
    /// @param  bountyBps     New post-window publisher bounty (basis points).
    /// @param  windowSeconds New depositor-exclusive window length (seconds).
    event ParamsUpdated(uint64 fillBondUsd, uint64 makerBondUsd, uint16 bountyBps, uint64 windowSeconds);

    /// @notice A new order was created (step 1). The order is NOT yet discoverable
    ///         or fillable — indexers should wait for {OrderActivated}.
    /// @param  orderId     The assigned order id.
    /// @param  maker       The order creator.
    /// @param  inputToken  The escrowed token leg.
    /// @param  outputToken The requested token leg.
    /// @param  price       The Q44.20 order price (output per input).
    /// @param  expiry      The expiry timestamp (0 = good-til-cancelled).
    event OrderCreated(
        uint256 indexed orderId,
        address indexed maker,
        address indexed inputToken,
        address outputToken,
        uint64 price,
        uint64 expiry
    );

    /// @notice Emitted the first time an order's bracket is published non-EMPTY and
    ///         it joins the pair index. Order-book indexers should key off this.
    /// @param  orderId The activated order.
    event OrderActivated(uint256 indexed orderId);

    /// @notice An order was filled (step 1; the swap settled atomically).
    /// @param  orderId The filled order.
    /// @param  taker   The filler (and fill-bond depositor).
    /// @param  seq     The post-fill bracket snapshot awaiting {publishBracket}.
    event OrderFilled(uint256 indexed orderId, address indexed taker, uint64 seq);

    /// @notice A maker injected more input tokens into an order (step 1).
    /// @param  orderId The topped-up order.
    /// @param  maker   The order's maker.
    /// @param  seq     The new bracket snapshot awaiting {publishBracket}.
    event OrderToppedUp(uint256 indexed orderId, address indexed maker, uint64 seq);

    /// @notice An order was cancelled by its maker (terminal).
    /// @param  orderId The cancelled order.
    event OrderCancelled(uint256 indexed orderId);

    /// @notice A bracket snapshot was published (whether or not it advanced the
    ///         canonical bracket).
    /// @param  orderId   The order.
    /// @param  seq       The published record's seq.
    /// @param  bracket   The decrypted plaintext bracket.
    /// @param  publisher The caller that submitted the proof.
    /// @param  listed    The order's listing state after this publish.
    event BracketPublished(
        uint256 indexed orderId,
        uint64 indexed seq,
        uint8 bracket,
        address indexed publisher,
        bool listed
    );

    /// @notice An order left the pair index (frontier EMPTY publish → dormant).
    /// @param  orderId The delisted order.
    event OrderDelisted(uint256 indexed orderId);

    /// @notice The protocol swap fee was changed.
    /// @param  swapFeeQ20 The new Q44.20 fee (0 = disabled).
    event SwapFeeUpdated(uint64 swapFeeQ20);

    /// @notice The fee sweep destination was changed.
    /// @param  treasury The new treasury address.
    event TreasuryUpdated(address indexed treasury);

    /// @notice Accrued fees for a token were swept to the treasury.
    /// @param  token    The token swept.
    /// @param  to       The treasury address that received them.
    /// @param  eAmount  Encrypted amount actually transferred (readable by the
    ///                  treasury and this contract).
    event FeesCollected(address indexed token, address indexed to, euint64 eAmount);

    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice A required address argument was the zero address.
    error ZeroAddress();
    /// @notice inputToken and outputToken were the same token.
    error SameLeg();
    /// @notice A price or oracle price was zero / below MIN_ORACLE_PRICE.
    error ZeroPrice();
    /// @notice A token's confidential-ledger decimals are incompatible (fUSD != 6, or token > 6).
    error InvalidDecimals();
    /// @notice The supplied expiry is already in the past.
    error InvalidExpiry();
    /// @notice A token leg is not whitelisted for trading.
    /// @param  token The offending token.
    error TokenNotWhitelisted(address token);
    /// @notice Caller is neither the oracle nor the owner.
    error Unauthorized();
    /// @notice No order exists for the given id.
    error OrderNotFound();
    /// @notice The order is not active (pending, dormant, or closed).
    error OrderNotActive();
    /// @notice The order has been cancelled (terminal).
    error OrderClosed();
    /// @notice The order is still open, so there is no leftover escrow to claim.
    error OrderNotClosed();
    /// @notice The order is past its expiry timestamp.
    error OrderExpired();
    /// @notice Caller is not the order's maker.
    error NotMaker();
    /// @notice A non-maker tried to cancel an order that has not expired.
    error NotExpired();
    /// @notice Array argument lengths do not match.
    error LengthMismatch();
    /// @notice A bonded action was attempted before `ethOraclePrice` was set.
    error EthOracleUnset();
    /// @notice The Chainlink feed returned an answer that cannot be used as a
    ///         divisor: non-positive, or out of Q44.20 range.
    error BadOraclePrice();
    /// @notice msg.value did not cover the required bond, or bountyBps > BPS_DENOM.
    error WrongBond();
    /// @notice No publish record exists for the given (orderId, seq).
    error PublishNotFound();
    /// @notice The publish record's bond has already been settled.
    error AlreadySettled();
    /// @notice A non-depositor tried to publish a fill record inside its window.
    error NotInWindow();
    /// @notice A native ETH transfer (refund / bounty) failed.
    error EthTransferFailed();
    /// @notice The requested swap fee exceeds MAX_SWAP_FEE_Q20.
    error FeeTooHigh();
    /// @notice No fees have accrued for the token being swept.
    error NoFeesAccrued();
    /// @notice A fee sweep was attempted before COLLECT_COOLDOWN elapsed.
    error CollectTooSoon();

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Deploy the OTC, anchoring it to the fUSD unit of account.
    /// @dev    Validates fUSD's confidential-ledger decimals (see {_confidentialDecimals}),
    ///         auto-whitelists it at $1.00 (Q_DENOM), and precomputes the reusable
    ///         encrypted bracket constants/thresholds (persisting their ACL so they
    ///         remain valid operands in later txns). The deployer becomes the owner.
    ///         `ethOraclePrice` starts unset and must be configured via
    ///         {setEthOraclePrice} before any bonded action.
    /// @param  fUSD_     The confidential stablecoin used as the bracket unit of account.
    /// @param  treasury_ Destination for {sweepFees} sweeps. Taken explicitly rather than
    ///                   defaulted to the deployer, so fee custody is a deliberate deployment
    ///                   choice and never silently lands on a hot deployer key.
    constructor(IFHERC20 fUSD_, address treasury_) Ownable(msg.sender) {
        if (address(fUSD_) == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();
        if (_confidentialDecimals(address(fUSD_)) != FUSD_DECIMALS) revert InvalidDecimals();
        fUSD = fUSD_;

        // Auto-whitelist fUSD at $1.00 in Q44.20 (= Q_DENOM).
        // fUSD is the bracket unit of account, so its oracle price is always 1.
        _tokenConfig[address(fUSD_)] = TokenConfig({
            whitelisted: true,
            oraclePrice: Q_DENOM,
            priceUpdatedAt: uint64(block.timestamp)
        });

        _E_BRACKET_EMPTY = FHE.asEuint8(BRACKET_EMPTY);
        _E_BRACKET_NANO = FHE.asEuint8(BRACKET_NANO);
        _E_BRACKET_SMALL = FHE.asEuint8(BRACKET_SMALL);
        _E_BRACKET_MEDIUM = FHE.asEuint8(BRACKET_MEDIUM);
        _E_BRACKET_LARGE = FHE.asEuint8(BRACKET_LARGE);
        _E_BRACKET_WHALE = FHE.asEuint8(BRACKET_WHALE);

        _NANO_MAX = FHE.asEuint64(100_000_000);
        _SMALL_MAX = FHE.asEuint64(1_000_000_000);
        _MEDIUM_MAX = FHE.asEuint64(10_000_000_000);
        _LARGE_MAX = FHE.asEuint64(100_000_000_000);

        _E_SHR_20 = FHE.asEuint64(20);
        _E_ZERO64 = FHE.asEuint64(0);
        _E_Q_MASK = FHE.asEuint64(Q_DENOM - 1);

        // Persist ACL on every reused handle so they remain usable as operands
        // in later transactions (the auto-grant from FHE.asEuint* is transient).
        FHE.allowThis(_E_BRACKET_EMPTY);
        FHE.allowThis(_E_BRACKET_NANO);
        FHE.allowThis(_E_BRACKET_SMALL);
        FHE.allowThis(_E_BRACKET_MEDIUM);
        FHE.allowThis(_E_BRACKET_LARGE);
        FHE.allowThis(_E_BRACKET_WHALE);
        FHE.allowThis(_NANO_MAX);
        FHE.allowThis(_SMALL_MAX);
        FHE.allowThis(_MEDIUM_MAX);
        FHE.allowThis(_LARGE_MAX);
        FHE.allowThis(_E_SHR_20);
        FHE.allowThis(_E_ZERO64);
        FHE.allowThis(_E_Q_MASK);

        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
        _setSwapFee(0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin: token whitelist & oracle
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Whitelist a token, enabling it as an input or output leg.
    /// @dev    Enforces MAX_TOKEN_DECIMALS on the token's confidential ledger (see
    ///         {_confidentialDecimals}) so createOrder never needs to re-check.
    /// @param  token        The token to whitelist.
    /// @param  initialPrice The token's initial Q44.20 oracle price (≥ MIN_ORACLE_PRICE).
    function whitelistToken(address token, uint64 initialPrice) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (initialPrice < MIN_ORACLE_PRICE) revert ZeroPrice();
        if (_confidentialDecimals(token) > MAX_TOKEN_DECIMALS) revert InvalidDecimals();
        _tokenConfig[token] = TokenConfig({
            whitelisted: true,
            oraclePrice: initialPrice,
            priceUpdatedAt: uint64(block.timestamp)
        });
        emit TokenWhitelisted(token, initialPrice);
    }

    /// @dev Decimals of the ledger this venue actually trades on. Every escrow, fill,
    ///      release and refund goes through `confidentialTransfer*`, so for a dual-mode
    ///      token (Erc20Confidential extension) the
    ///      relevant precision is `confidentialDecimals()`, which can be coarser than the
    ///      public `decimals()` backing it. Single-ledger FHERC20s expose only `decimals()`,
    ///      which IS their confidential precision — used as the fallback.
    function _confidentialDecimals(address token) internal view returns (uint8) {
        (bool hasConfidentialDecimals, bytes memory result) = token.staticcall(
            abi.encodeWithSignature('confidentialDecimals()')
        );
        if (hasConfidentialDecimals && result.length == 32) return abi.decode(result, (uint8));
        return IFHERC20(token).decimals();
    }

    /// @notice Remove a token from the whitelist, halting trading in it.
    /// @dev    Blocks createOrder, fillOrder and topUpOrder on either leg.
    ///         Existing orders become cancel-only: cancelOrder and
    ///         publishBracket stay open so escrow and bonds can be recovered.
    /// @param  token The token to delist.
    function delistToken(address token) external onlyOwner {
        _tokenConfig[token].whitelisted = false;
        emit TokenDelisted(token);
    }

    /// @notice Set the oracle address. Zero address disables the oracle role.
    /// @param  oracle_ The new oracle address (or address(0) to disable).
    function setOracle(address oracle_) external onlyOwner {
        address previousOracle = oracle;
        oracle = oracle_;
        emit OracleUpdated(previousOracle, oracle_);
    }

    /// @notice Update the Q44.20 oracle price for a whitelisted token.
    /// @dev    Callable by the designated oracle or the owner. The price is used
    ///         only for bracket computation and does not affect open orders.
    /// @param  token The whitelisted token to reprice.
    /// @param  price The new Q44.20 price (≥ MIN_ORACLE_PRICE).
    function updateOraclePrice(address token, uint64 price) external {
        if (msg.sender != oracle && msg.sender != owner()) revert Unauthorized();
        if (!_tokenConfig[token].whitelisted) revert TokenNotWhitelisted(token);
        if (price < MIN_ORACLE_PRICE) revert ZeroPrice();
        _tokenConfig[token].oraclePrice = price;
        _tokenConfig[token].priceUpdatedAt = uint64(block.timestamp);
        emit OraclePriceUpdated(token, price);
    }

    /// @notice Update the ETH/USD oracle price (Q44.20) used to size ETH bonds.
    /// @dev    Callable by the designated oracle or the owner.
    /// @param  price The new Q44.20 USD-per-ETH price (≥ MIN_ORACLE_PRICE).
    function setEthOraclePrice(uint64 price) external {
        if (msg.sender != oracle && msg.sender != owner()) revert Unauthorized();
        if (price < MIN_ORACLE_PRICE) revert ZeroPrice();
        ethOraclePrice = price;
        ethPriceUpdatedAt = uint64(block.timestamp);
        emit EthOraclePriceUpdated(price);
    }

    /// @notice Set the staleness window for oracle prices. Owner only.
    /// @dev    Passing 0 disables staleness checks — an operational lever for
    ///         oracle migrations. The owner can also simply push a fresh price,
    ///         since {setEthOraclePrice} accepts the owner as well as the oracle.
    /// @param  maxPriceAge_ The new maximum price age, in seconds (0 = disabled).
    function setMaxPriceAge(uint64 maxPriceAge_) external onlyOwner {
        maxPriceAge = maxPriceAge_;
        emit MaxPriceAgeUpdated(maxPriceAge_);
    }

    /// @notice Point bond sizing at a Chainlink ETH/USD feed. Owner only.
    ///
    /// @dev    This is one-time *configuration*, not a price push: it records
    ///         which aggregator to read. Once set, every {_usdToWei} — so every
    ///         `fillOrder` and every bonded `createOrder` — reads the live
    ///         answer straight from Chainlink. No keeper, no cron, no further
    ///         owner involvement, and {ethOraclePrice} stops being consulted.
    ///
    ///         Pass address(0) to fall back to the pushed price (a deprecated
    ///         feed, or a chain that has none).
    ///
    /// @param  feed The Chainlink aggregator, or address(0) to disable.
    function setEthUsdFeed(AggregatorV3Interface feed) external onlyOwner {
        ethUsdFeed = feed;
        emit EthUsdFeedUpdated(address(feed));
    }

    /// @notice The ETH/USD price bond sizing will use right now, in Q44.20.
    /// @return The Q44.20 USD-per-whole-ETH price.
    function ethUsdPriceQ20() external view returns (uint64) {
        return _ethUsdQ20();
    }

    /// @dev The ETH/USD price for bond sizing: the feed when configured, else
    ///      the pushed price. The feed's own `decimals()` sets the scale, so any
    ///      correctly-configured aggregator works without assumptions here.
    ///
    ///      Deliberately does NOT reject a stale price. This value sizes a
    ///      *refundable* bond, so an old price costs a taker cents on a deposit
    ///      they get straight back, whereas reverting would stop every fill on
    ///      every pair. Halting the venue to avoid mis-sizing a $5 refundable
    ///      deposit is the wrong way round. {isEthPriceStale} reports staleness
    ///      for monitoring instead of enforcing it.
    ///
    ///      The two remaining checks are arithmetic safety, not price policy: a
    ///      negative answer would overflow the cast, and a zero result would
    ///      divide by zero in {_usdToWei}.
    /// @return The Q44.20 USD-per-whole-ETH price.
    function _ethUsdQ20() internal view returns (uint64) {
        AggregatorV3Interface feed = ethUsdFeed;
        if (address(feed) == address(0)) {
            if (ethOraclePrice == 0) revert EthOracleUnset();
            return ethOraclePrice;
        }

        (, int256 answer, , , ) = feed.latestRoundData();
        if (answer <= 0) revert BadOraclePrice();

        uint256 q20 = (uint256(answer) * Q_DENOM) / (10 ** feed.decimals());
        if (q20 == 0 || q20 > type(uint64).max) revert BadOraclePrice();
        return uint64(q20);
    }

    /// @notice Update the governable bond / window parameters. Owner only.
    /// @dev    Reverts if `bountyBps_` exceeds BPS_DENOM (100%).
    /// @param  fillBondUsd_   Taker fill bond, in 6-decimal USD.
    /// @param  makerBondUsd_  Maker anti-spam bond, in 6-decimal USD (0 = off).
    /// @param  bountyBps_     Post-window publisher bounty, in basis points.
    /// @param  windowSeconds_ Depositor-exclusive window length, in seconds.
    function setParams(
        uint64 fillBondUsd_,
        uint64 makerBondUsd_,
        uint16 bountyBps_,
        uint64 windowSeconds_
    ) external onlyOwner {
        if (bountyBps_ > BPS_DENOM) revert WrongBond();
        fillBondUsd = fillBondUsd_;
        makerBondUsd = makerBondUsd_;
        bountyBps = bountyBps_;
        windowSeconds = windowSeconds_;
        emit ParamsUpdated(fillBondUsd_, makerBondUsd_, bountyBps_, windowSeconds_);
    }

    /// @notice Halt trading across every pair. Owner only.
    /// @dev    Blocks createOrder, fillOrder and topUpOrder contract-wide;
    ///         cancelOrder, activateOrder and publishBracket stay open so
    ///         escrow and posted bonds stay recoverable. See {delistToken}.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume trading. Owner only.
    /// @dev    Tokens delisted while paused stay delisted — levers are independent.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Return the whitelist config for a token.
    /// @param  token The token to query.
    /// @return The token's {TokenConfig} (whitelisted flag, oracle price, timestamp).
    function getTokenConfig(address token) external view returns (TokenConfig memory) {
        return _tokenConfig[token];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin: protocol swap fee
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Set the protocol swap fee. Owner only.
    ///
    /// @dev    Takes a **plaintext** rate on purpose. The fee is public policy,
    ///         not a secret: publishing it lets takers price a fill before
    ///         sending it, and it is what allows the zero-fee fast path in
    ///         {_takeFee}. The encrypted mirror is re-derived here — once per
    ///         change rather than once per fill.
    ///
    ///         Applies immediately to every subsequent fill, including fills of
    ///         orders created under an older rate. That is safe because the fee
    ///         falls on the taker, who observes the current rate at fill time;
    ///         a maker-borne fee would instead need a per-order snapshot.
    ///
    /// @param  feeQ20 The new Q44.20 fee (0 disables; must be ≤ MAX_SWAP_FEE_Q20).
    function setSwapFee(uint64 feeQ20) external onlyOwner {
        _setSwapFee(feeQ20);
    }

    /// @dev Shared fee-setting path for the constructor and {setSwapFee}.
    /// @param feeQ20 The new Q44.20 fee.
    function _setSwapFee(uint64 feeQ20) internal {
        if (feeQ20 > MAX_SWAP_FEE_Q20) revert FeeTooHigh();
        swapFeeQ20 = feeQ20;
        euint64 eFee = FHE.asEuint64(feeQ20);
        FHE.allowPublic(eFee);
        _eSwapFeeQ20 = eFee;
        emit SwapFeeUpdated(feeQ20);
    }

    /// @notice Set the destination for {sweepFees} sweeps. Owner only.
    /// @param  treasury_ The new treasury address (non-zero).
    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    /// @notice Sweep all fees accrued in `token` to the {treasury}. Owner only.
    ///
    /// @dev    Zeroes the accrual before transferring, so fills landing after
    ///         this call accumulate into a fresh balance that a later sweep
    ///         collects. Never touches live escrow: the contract's balance of
    ///         `token` is the sum of open orders' `eRemaining` plus accrued
    ///         fees, and each fee was carved out of input that had already been
    ///         debited from an order's `eRemaining`.
    ///         Rate-limited to once per COLLECT_COOLDOWN per token. A sweep
    ///         always discloses its own size — the treasury can decrypt its own
    ///         balance whatever ACL is set here — so an unthrottled sweep would
    ///         let the owner bracket a single fill (collect, wait for one fill,
    ///         collect) and read its fee. The rate is public, so that recovers
    ///         the taker's exact amount. The cooldown forces each disclosed
    ///         total to aggregate a day of fills. It is a hard constant, not a
    ///         governable one, since the owner is the party it constrains.
    /// @param  token      The token to sweep.
    /// @return eCollected The encrypted amount actually transferred.
    function sweepFees(address token) external onlyOwner nonReentrant returns (euint64 eCollected) {
        euint64 accrued = _feesAccrued[token];
        if (euint64.unwrap(accrued) == 0) revert NoFeesAccrued();

        uint64 last = _lastCollectAt[token];
        if (last != 0 && block.timestamp < last + COLLECT_COOLDOWN) revert CollectTooSoon();

        _feesAccrued[token] = euint64.wrap(0);
        _lastCollectAt[token] = uint64(block.timestamp);

        address to = treasury;
        eCollected = FHE.receiveEuint64FromCall(
            IFHERC20(token).confidentialTransfer(to, FHE.shareEuint64(accrued, token)),
            token
        );

        FHE.allowThis(eCollected);
        FHE.allow(eCollected, to);

        emit FeesCollected(token, to, eCollected);
    }

    /// @notice Timestamp of the last fee sweep for a token (0 if never swept).
    /// @param  token The token to query.
    /// @return The last sweep timestamp.
    function lastCollectAt(address token) external view returns (uint64) {
        return _lastCollectAt[token];
    }

    /// @notice Earliest timestamp at which `token` may next be swept.
    /// @param  token The token to query.
    /// @return The unlock timestamp (0 when the token has never been swept).
    function collectUnlockAt(address token) external view returns (uint64) {
        uint64 last = _lastCollectAt[token];
        return last == 0 ? 0 : last + COLLECT_COOLDOWN;
    }

    /// @notice Encrypted handle of the live swap fee.
    /// @dev    `allowPublic`'d, so any caller may decrypt it. {swapFeeQ20}
    ///         exposes the same value in plaintext and is cheaper to read.
    /// @return The `euint64` handle of the current Q44.20 fee.
    function swapFeeHandle() external view returns (bytes32) {
        return euint64.unwrap(_eSwapFeeQ20);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Bond sizing
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Instantaneous taker fill bond, in wei.
    /// @dev    Reverts with {EthOracleUnset} if the ETH price has not been set
    ///         and the bond is non-zero.
    /// @return The required fill bond, in wei.
    function ethBondSize() public view returns (uint256) {
        return _usdToWei(fillBondUsd);
    }

    /// @notice Instantaneous maker bond, in wei (0 when makerBondUsd is 0).
    /// @return The required maker bond, in wei.
    function makerBondSize() public view returns (uint256) {
        return _usdToWei(makerBondUsd);
    }

    /// @dev Converts a 6-decimal USD amount to wei via the ETH oracle price:
    ///      wei = usd6 × 1e12 × Q_DENOM / ethOraclePrice. (1e12 bridges the
    ///      6→18 decimal gap; Q_DENOM cancels the Q44.20 price scaling.)
    /// @param  usd6 The USD amount, scaled by 1e6.
    /// @return The equivalent wei (0 when `usd6` is 0).
    function _usdToWei(uint64 usd6) internal view returns (uint256) {
        // Skipped entirely when the bond is 0, so a zero-bond configuration
        // never needs a live price at all.
        if (usd6 == 0) return 0;
        return (uint256(usd6) * 1e12 * Q_DENOM) / _ethUsdQ20();
    }

    /// @dev True when `updatedAt` is older than {maxPriceAge}. Always false when
    ///      the window is 0 (checks disabled). Widened to uint256 so a large
    ///      window cannot overflow the addition.
    /// @param  updatedAt The timestamp to age-check.
    /// @return Whether the value is considered stale.
    function _isStale(uint256 updatedAt) internal view returns (bool) {
        if (maxPriceAge == 0) return false;
        return block.timestamp > updatedAt + uint256(maxPriceAge);
    }

    /// @notice Whether a whitelisted token's bracket price has gone stale.
    /// @dev    Advisory only — {_toUSD} never reverts on this. Brackets are
    ///         coarse buckets, so a slightly old price mis-sorts the book at
    ///         worst;
    ///         fUSD is never stale: it is the unit of account, pinned at $1.
    /// @param  token The token to check.
    /// @return True when the price is older than {maxPriceAge}.
    function isPriceStale(address token) external view returns (bool) {
        if (token == address(fUSD)) return false;
        return _isStale(_tokenConfig[token].priceUpdatedAt);
    }

    /// @notice Seconds since a token's bracket price was last updated.
    /// @param  token The token to check.
    /// @return The age in seconds (0 if never set).
    function priceAge(address token) external view returns (uint256) {
        uint64 updatedAt = _tokenConfig[token].priceUpdatedAt;
        return updatedAt == 0 ? 0 : block.timestamp - updatedAt;
    }

    /// @notice Whether the ETH/USD price used for bond sizing has gone stale.
    /// @dev    Advisory, like {isPriceStale} — nothing reverts on it. Reads
    ///         whichever source {_ethUsdQ20} would: the feed's own `updatedAt`
    ///         when one is configured, otherwise {ethPriceUpdatedAt}. Reporting
    ///         the pushed timestamp while a feed is in use would be wrong in
    ///         both directions, so the branch matters.
    /// @return True when that price is older than {maxPriceAge}.
    function isEthPriceStale() external view returns (bool) {
        AggregatorV3Interface feed = ethUsdFeed;
        if (address(feed) == address(0)) return _isStale(ethPriceUpdatedAt);
        (, , , uint256 updatedAt, ) = feed.latestRoundData();
        return _isStale(updatedAt);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Maker: create (step 1)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Post a new OTC order. The order starts PENDING: its escrow (and
    ///         the optional maker bond) are pulled here, but it is not
    ///         discoverable or fillable until `activateOrder` publishes the
    ///         bracket.
    ///
    /// @dev    Maker must have approved the OTC as operator on `inputToken`.
    ///         If `makerBondUsd > 0`, send at least `makerBondSize()` wei; any
    ///         excess is refunded. Both tokens must be whitelisted.
    ///
    /// @param inputToken  Whitelisted FHERC20 the maker is offering (escrowed here).
    /// @param outputToken Whitelisted FHERC20 the maker wants in return.
    /// @param price       Q44.20 rate: output per input, scaled by 2^20.
    /// @param expiry      Unix timestamp after which the order can no longer be
    ///                    filled. Pass 0 for good-til-cancelled.
    /// @param encAmount   Encrypted input amount handle, signed for this contract.
    /// @param inputProof  Batch signature covering `encAmount`, bound to this contract.
    /// @return orderId    The id assigned to the new (pending) order.
    function createOrder(
        IFHERC20 inputToken,
        IFHERC20 outputToken,
        uint64 price,
        uint64 expiry,
        externalEuint64 encAmount,
        bytes calldata inputProof
    ) external payable nonReentrant whenNotPaused returns (uint256 orderId) {
        if (address(inputToken) == address(0) || address(outputToken) == address(0)) revert ZeroAddress();
        if (address(inputToken) == address(outputToken)) revert SameLeg();
        _requireWhitelisted(address(inputToken), address(outputToken));
        if (price == 0) revert ZeroPrice();
        if (expiry != 0 && expiry <= block.timestamp) revert InvalidExpiry();

        // Maker bond (optional anti-spam lever; usually 0).
        uint256 bond = makerBondSize();
        if (msg.value < bond) revert WrongBond();

        // Wrap the encrypted input and grant the inputToken contract ACL access
        // so it can process the handle during transferFrom.
        euint64 amount = FHE.asEuint64(encAmount, inputProof);

        // Pull input tokens into escrow.  FHERC20 transfers are all-or-nothing:
        // if the maker's balance is below `amount`, `actual` returns as 0 and the
        // order is created empty (EMPTY bracket); otherwise it equals `amount`.
        euint64 actual = FHE.receiveEuint64FromCall(
            inputToken.confidentialTransferFrom(
                msg.sender, address(this), FHE.shareEuint64(amount, address(inputToken))
            ),
            address(inputToken)
        );
        FHE.allowThis(actual);
        FHE.allow(actual, msg.sender); // maker can verify their deposit / track fills

        orderId = nextOrderId++;
        Order storage o = orders[orderId];
        o.maker = msg.sender;
        o.inputToken = inputToken;
        o.outputToken = outputToken;
        o.eRemaining = actual;
        o.eDepositedAmount = actual; // same handle; ACL already granted above
        o.price = price;
        o.expiry = expiry;
        o.bracket = BRACKET_UNPUBLISHED;
        o.latestSeq = CREATE_SEQ;
        o.publishedSeq = 0;
        o.makerBondWei = bond;
        o.active = false;
        o.pending = true;
        o.closed = false;

        // ── Bracket snapshot (create record) ───────────────────────────────────
        // Convert the escrowed input to USD-equivalent and compute the size
        // bracket via FHE comparisons — the maker cannot misrepresent their size.
        // Order is stored first so _toUSD can inspect both legs. The plaintext is
        // revealed later by activateOrder. Maker record: bondless, no window.
        euint8 b = _computeBracket(_toUSD(actual, o));
        _publishes[orderId][CREATE_SEQ] = Publish({
            handle: b,
            depositor: msg.sender,
            bondWei: 0,
            deadline: 0,
            settled: false,
            bountyBps: 0
        });

        _makerOrderIds[msg.sender].push(orderId);

        if (msg.value > bond) _payEth(msg.sender, msg.value - bond);

        emit OrderCreated(orderId, msg.sender, address(inputToken), address(outputToken), price, expiry);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Maker: activate (step 2) — first bracket reveal
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Publish the create record's bracket and list the order. This is
    ///         the first reveal of the public bracket. Sugar for
    ///         `publishBracket(orderId, CREATE_SEQ, ...)`.
    ///
    /// @dev    Permissionless and bondless (maker record). The
    ///         `(decryptedBracket, signature)` pair comes from the CoFHE SDK
    ///         decrypting the public bracket handle.
    /// @param  orderId         The pending order to activate.
    /// @param  decryptedBracket The threshold-decrypted plaintext of the create
    ///                          record's bracket handle.
    /// @param  signature        The threshold-network signature over that decryption.
    function activateOrder(uint256 orderId, uint8 decryptedBracket, bytes calldata signature) external nonReentrant {
        _publish(orderId, CREATE_SEQ, decryptedBracket, signature);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Maker: top up
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Inject additional input tokens into an order (active or dormant).
    ///
    /// @dev    Maker only; the order must not be closed. Both `eRemaining` and
    ///         `eDepositedAmount` increase by the amount actually transferred
    ///         (all-or-nothing). A new bracket snapshot is recorded under a fresh
    ///         seq; call `publishBracket(orderId, seq, ...)` to reveal it. If the
    ///         order was dormant, that publish re-lists it (frontier rule).
    ///
    ///         Bondless and self-incentivized: a stale top-up only under-reports
    ///         the order's size, which is favorable to the order.
    ///
    /// @param orderId   The order to increase.
    /// @param encDelta   Encrypted additional input-token amount handle.
    /// @param inputProof Batch signature covering `encDelta`, bound to this contract.
    /// @return seq      The seq of the new bracket snapshot to publish.
    function topUpOrder(
        uint256 orderId,
        externalEuint64 encDelta,
        bytes calldata inputProof
    ) external nonReentrant whenNotPaused returns (uint64 seq) {
        Order storage o = orders[orderId];
        if (o.maker == address(0)) revert OrderNotFound();
        if (o.closed) revert OrderClosed();
        if (msg.sender != o.maker) revert NotMaker();
        _requireWhitelisted(address(o.inputToken), address(o.outputToken));

        euint64 delta = FHE.asEuint64(encDelta, inputProof);

        // Pull additional tokens into OTC escrow (all-or-nothing).
        euint64 actual = FHE.receiveEuint64FromCall(
            o.inputToken.confidentialTransferFrom(
                msg.sender, address(this), FHE.shareEuint64(delta, address(o.inputToken))
            ),
            address(o.inputToken)
        );
        FHE.allowThis(actual);

        // Grow remaining balance.
        o.eRemaining = FHE.add(o.eRemaining, actual);
        FHE.allowThis(o.eRemaining);
        FHE.allow(o.eRemaining, o.maker);

        // Strictly increase the cumulative deposited total (fill-progress denominator).
        o.eDepositedAmount = FHE.add(o.eDepositedAmount, actual);
        FHE.allowThis(o.eDepositedAmount);
        FHE.allow(o.eDepositedAmount, o.maker);

        // Snapshot the new bracket under a fresh seq (maker record: bondless).
        seq = ++o.latestSeq;
        euint8 b = _computeBracket(_toUSD(o.eRemaining, o));
        _publishes[orderId][seq] = Publish({
            handle: b,
            depositor: msg.sender,
            bondWei: 0,
            deadline: 0,
            settled: false,
            bountyBps: 0
        });

        emit OrderToppedUp(orderId, msg.sender, seq);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Taker: fill (step 1 — value moves atomically here)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Fill an open order (partially or fully). The economic swap settles
    ///         atomically here; the taker posts an ETH fill bond and must then
    ///         call `publishBracket(orderId, seq, ...)` to reveal the post-fill
    ///         bracket and reclaim the bond.
    ///
    /// @dev    Taker must have called `outputToken.setOperator(address(this), …)`
    ///         before calling this function. Send at least `ethBondSize()` wei;
    ///         any excess is refunded.
    ///
    /// @param orderId         The order to fill against.
    /// @param encTokensWanted Encrypted amount of inputToken the taker wants.
    /// @param inputProof      Batch signature covering `encTokensWanted`, bound to this contract.
    /// @return seq            The seq of the post-fill bracket snapshot to publish.
    function fillOrder(
        uint256 orderId,
        externalEuint64 encTokensWanted,
        bytes calldata inputProof
    ) external payable nonReentrant whenNotPaused returns (uint64 seq) {
        Order storage o = orders[orderId];
        if (o.maker == address(0)) revert OrderNotFound();
        if (!o.active) revert OrderNotActive();
        if (o.expiry != 0 && block.timestamp > o.expiry) revert OrderExpired();
        _requireWhitelisted(address(o.inputToken), address(o.outputToken));

        // Fill bond.
        uint256 bond = ethBondSize();
        if (msg.value < bond) revert WrongBond();

        // ── Settle the swap atomically (isolated frame to bound stack depth) ───
        _swap(o, encTokensWanted, inputProof);

        // ── Snapshot the post-fill bracket under a fresh seq (fill record) ─────
        seq = ++o.latestSeq;
        _publishes[orderId][seq] = Publish({
            handle: _computeBracket(_toUSD(o.eRemaining, o)),
            depositor: msg.sender,
            bondWei: bond,
            deadline: uint64(block.timestamp) + windowSeconds,
            settled: false,
            bountyBps: bountyBps
        });

        // Record the interaction for the taker's activity feed (set dedupes).
        _takerFills[msg.sender].add(orderId);

        if (msg.value > bond) _payEth(msg.sender, msg.value - bond);

        emit OrderFilled(orderId, msg.sender, seq);
    }

    /// @dev The encrypted swap: caps the request, pulls the taker's payment to
    ///      the maker, releases escrowed input on full payment, and decrements
    ///      `eRemaining`. Isolated from `fillOrder` so its locals occupy a
    ///      separate stack frame (keeps the IR/legacy stack within bounds).
    /// @param o               The order being filled (mutated in place).
    /// @param encTokensWanted The taker's encrypted requested input amount.
    /// @param inputProof      Batch signature covering `encTokensWanted`.
    function _swap(Order storage o, externalEuint64 encTokensWanted, bytes calldata inputProof) internal {
        // Cap requested amount at available remaining and the overflow bound.
        // FHE.mul/add are mod 2^64; cap so neither eActual × price (+ the
        // Q_DENOM-1 ceil term below) nor the downstream eRelease × fee wraps.
        euint64 eActual = FHE.min(FHE.asEuint64(encTokensWanted, inputProof), o.eRemaining);
        eActual = FHE.min(eActual, FHE.asEuint64(_fillCap(o.price)));
        FHE.allowThis(eActual);

        // Rounded UP, so the sub-unit residue is charged to the taker rather
        // than gifted to them — it is the maker's, and up to one raw unit/fill.
        euint64 eOutput = FHE.shr(FHE.add(FHE.mul(eActual, FHE.asEuint64(o.price)), _E_Q_MASK), _E_SHR_20);
        FHE.allowThis(eOutput);

        // Pull output from taker directly to maker (no intermediate escrow).
        euint64 eOutputPaid = FHE.receiveEuint64FromCall(
            o.outputToken.confidentialTransferFrom(
                msg.sender, o.maker, FHE.shareEuint64(eOutput, address(o.outputToken))
            ),
            address(o.outputToken)
        );
        FHE.allowThis(eOutputPaid);

        // Release input only if the taker paid in full (and not dust).
        euint64 eRelease = FHE.select(
            FHE.and(FHE.eq(eOutputPaid, eOutput), FHE.gt(eOutput, _E_ZERO64)),
            eActual,
            _E_ZERO64
        );
        FHE.allowThis(eRelease);

        // Skim the protocol fee off the released input before it leaves escrow.
        // The fee never moves: it is already held here, so this costs no extra
        // token transfer. When the fee is 0 this is a plaintext no-op.
        euint64 eToTaker = _takeFee(address(o.inputToken), eRelease);

        // Send the taker's share of the released input from OTC escrow, and
        // trust the token's returned amount rather than what was requested.
        euint64 eDelivered = FHE.receiveEuint64FromCall(
            o.inputToken.confidentialTransfer(msg.sender, FHE.shareEuint64(eToTaker, address(o.inputToken))),
            address(o.inputToken)
        );
        FHE.allowThis(eDelivered);
        FHE.allow(eDelivered, msg.sender); // taker can verify receipt

        // Decrement remaining by what actually left escrow plus the fee — the
        // maker sold that much. Any delivery shortfall (eToTaker − eDelivered)
        // stays in eRemaining, so it remains the maker's and is recoverable by
        // cancelOrder. Bracket paths (_toUSD, _computeBracket, seq/frontier
        // rules) stay untouched by fees.
        o.eRemaining = FHE.sub(o.eRemaining, FHE.sub(eRelease, FHE.sub(eToTaker, eDelivered)));
        FHE.allowThis(o.eRemaining);
        FHE.allow(o.eRemaining, o.maker); // maker can track their position
    }

    /// @dev Skims the protocol fee out of a released input amount and books it
    ///      against `token`'s accrual, returning what is left for the taker.
    ///
    ///      Fee = eRelease × swapFeeQ20 >> 20 (the contract's existing Q44.20
    ///      idiom — a mul and a shr, avoiding the far heavier FHE.div a
    ///      basis-point denominator would need). Because fee ≤ 1 (Q44.20), the
    ///      subtraction can never underflow, and a failed fill has eRelease = 0
    ///      so it accrues nothing without any special casing.
    ///
    ///      The `feeQ20 == 0` fast path is why {swapFeeQ20} is mirrored in
    ///      plaintext: you cannot branch on a ciphertext, so with the fee
    ///      disabled every fill would otherwise still pay for four FHE ops.
    ///
    ///      PRECONDITION: `eRelease <= type(uint64).max / swapFeeQ20`. The mul
    ///      below is mod 2^64, so a larger release wraps and silently accrues
    ///      less than the configured rate — no revert, and the books stay
    ///      self-consistent, so nothing surfaces the shortfall. {_swap}
    ///      guarantees this by clamping the fill through {_fillCap}, whose fee
    ///      bound is exactly this limit; the clamp is applied to the fill size
    ///      rather than here so the fee stays exact instead of truncated. Any
    ///      new caller must clamp equivalently — do not rely on this one.
    /// @param  token     The input token the fee is denominated in.
    /// @param  eRelease  The encrypted input released by the fill.
    /// @return eToTaker  The encrypted remainder owed to the taker.
    function _takeFee(address token, euint64 eRelease) internal returns (euint64 eToTaker) {
        uint64 feeQ20 = swapFeeQ20;
        if (feeQ20 == 0) return eRelease;

        euint64 eFee = FHE.shr(FHE.mul(eRelease, _eSwapFeeQ20), _E_SHR_20);
        FHE.allowThis(eFee);

        euint64 accrued = FHE.add(_feesAccrued[token], eFee);
        FHE.allowThis(accrued);
        _feesAccrued[token] = accrued;

        eToTaker = FHE.sub(eRelease, eFee);
        FHE.allowThis(eToTaker);
    }

    /// @dev The plaintext ceiling a fill's input amount is clamped to, so no
    ///      downstream FHE multiply wraps uint64. Two bounds, whichever binds:
    ///      the Q44.20 price multiply in {_swap} — which reserves Q_DENOM-1 of
    ///      headroom for the ceil-rounding add that follows it — and the fee
    ///      multiply in {_takeFee}. At MAX_SWAP_FEE_Q20 the fee bound is ~1.76e15,
    ///      so it only becomes the tighter of the two at very low prices.
    /// @param  price The order's Q44.20 price.
    /// @return cap   The maximum input amount safe to process.
    function _fillCap(uint64 price) internal view returns (uint64 cap) {
        cap = (type(uint64).max - (Q_DENOM - 1)) / price;
        uint64 feeQ20 = swapFeeQ20;
        if (feeQ20 > 1) {
            uint64 feeCap = type(uint64).max / feeQ20;
            if (feeCap < cap) cap = feeCap;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Anyone (subject to window): publish a bracket / settle a bond
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Reveal the plaintext bracket for a Publish record and settle its
    ///         bond. Advances the order's canonical bracket if `seq` is ahead of
    ///         `publishedSeq`, and lists/delists the order if `seq` is the
    ///         frontier (the symmetric frontier rule).
    ///
    /// @dev    For fill records: within the grace window only the depositor may
    ///         call (full refund); after the window anyone may call (bounty to
    ///         caller, remainder to depositor). Maker records (create/top-up)
    ///         carry no bond/window and may be published by anyone.
    /// @param  orderId          The order whose record is being published.
    /// @param  seq              The record's seq (from {OrderFilled}/{OrderToppedUp}).
    /// @param  decryptedBracket The threshold-decrypted bracket plaintext.
    /// @param  signature        The threshold-network signature over the decryption.
    function publishBracket(
        uint256 orderId,
        uint64 seq,
        uint8 decryptedBracket,
        bytes calldata signature
    ) external nonReentrant {
        _publish(orderId, seq, decryptedBracket, signature);
    }

    /// @dev Shared publish path for {activateOrder} and {publishBracket}: enforces
    ///      the fill-record window, verifies the decryption proof against the
    ///      record's immutable handle, advances the canonical bracket when the
    ///      record is ahead, applies the frontier listing/delisting rule, and
    ///      settles the bond. A bounty is paid only for an out-of-window publish
    ///      of the live frontier (the only publish that keeps the book fresh);
    ///      every other settlement refunds the depositor in full, so there is
    ///      nothing to skim on absorbed/non-frontier/closed records.
    /// @param orderId   The order being published.
    /// @param seq       The record's seq.
    /// @param value     The claimed plaintext bracket.
    /// @param signature The threshold-network signature over `value`.
    function _publish(uint256 orderId, uint64 seq, uint8 value, bytes calldata signature) internal {
        Order storage o = orders[orderId];
        if (o.maker == address(0)) revert OrderNotFound();

        Publish storage p = _publishes[orderId][seq];
        if (p.depositor == address(0)) revert PublishNotFound();
        if (p.settled) revert AlreadySettled();

        bool bonded = (p.deadline != 0);

        // Window enforcement (fill records only): inside the window only the
        // depositor may publish, which removes the front-running race entirely.
        if (bonded && block.timestamp <= p.deadline && msg.sender != p.depositor) {
            revert NotInWindow();
        }

        // Verify the plaintext against the snapshot handle.
        FHE.publishDecryptResult(p.handle, value, signature);

        // Canonical bracket + listing (skipped once closed: bracket is moot, we
        // only settle the bond).
        bool listed = o.active;
        if (!o.closed) {
            if (seq > o.publishedSeq) {
                o.publishedSeq = seq;
                o.bracket = value;
            }

            // Frontier rule: only a publish for the latest record changes listing.
            // An expired order delists exactly like a depleted one — same
            // predicate as fillOrder, so listing and fillability cannot diverge.
            if (seq == o.latestSeq) {
                bool expired = o.expiry != 0 && block.timestamp > o.expiry;
                if (value != BRACKET_EMPTY && !expired) {
                    if (!o.active) {
                        bool wasPending = o.pending;
                        o.active = true;
                        o.pending = false;
                        _pairOrders[_pairKey(address(o.inputToken), address(o.outputToken))].add(orderId);
                        if (wasPending) emit OrderActivated(orderId);
                    }
                } else if (o.active) {
                    o.active = false;
                    _pairOrders[_pairKey(address(o.inputToken), address(o.outputToken))].remove(orderId);
                    emit OrderDelisted(orderId);
                }
            }
            listed = o.active;
        }

        // Settle the bond. A bounty is only ever paid to keep the *live* book
        // fresh, which means an out-of-window publish of the current frontier
        // (`seq == latestSeq`) on an open order. Everything else — in-window
        // publishes, and any non-frontier or closed-order publish — refunds the
        // depositor in full. This removes the incentive for a keeper to publish
        // an absorbed (already-superseded) record purely to skim the bounty.
        p.settled = true;
        if (bonded) {
            bool frontierPublish = !o.closed && seq == o.latestSeq;
            if (block.timestamp <= p.deadline || !frontierPublish) {
                _payEth(p.depositor, p.bondWei);
            } else {
                // After window, live frontier → bounty to publisher, remainder
                // to depositor.
                uint256 bounty = (p.bondWei * p.bountyBps) / BPS_DENOM;
                if (bounty > 0) _payEth(msg.sender, bounty);
                _payEth(p.depositor, p.bondWei - bounty);
            }
        }

        emit BracketPublished(orderId, seq, value, msg.sender, listed);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Maker: cancel
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Cancel an order and return the remaining escrow AND the maker
    ///         bond to the maker. Works in the pending, active, and dormant
    ///         states. Maker only until expiry, then anyone; terminal.
    ///
    /// @dev    Escrow and bond always go to `o.maker`, so a third-party cancel
    ///         of an expired order moves no value to the caller — it only frees
    ///         a pair-index slot nothing else can. Expiry 0 stays maker-only.
    ///         Outstanding fill Publish records survive: their depositors can
    ///         still publish to settle and recover their bonds.
    /// @param  orderId The order to cancel.
    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        if (o.maker == address(0)) revert OrderNotFound();
        if (o.closed) revert OrderClosed();

        bool expired = o.expiry != 0 && block.timestamp > o.expiry;
        if (msg.sender != o.maker && !expired) revert NotExpired();

        bool wasActive = o.active;
        o.active = false;
        o.pending = false;
        o.closed = true;
        o.bracket = BRACKET_EMPTY;

        if (wasActive) {
            _pairOrders[_pairKey(address(o.inputToken), address(o.outputToken))].remove(orderId);
        }

        // Return escrowed input, decrementing by what the token reports
        // returning.
        euint64 eReturned = FHE.receiveEuint64FromCall(
            o.inputToken.confidentialTransfer(o.maker, FHE.shareEuint64(o.eRemaining, address(o.inputToken))),
            address(o.inputToken)
        );
        o.eRemaining = FHE.sub(o.eRemaining, eReturned);
        FHE.allowThis(o.eRemaining);
        FHE.allow(o.eRemaining, o.maker);

        // Return the maker bond, if any.
        uint256 bond = o.makerBondWei;
        if (bond > 0) {
            o.makerBondWei = 0;
            _payEth(o.maker, bond);
        }

        emit OrderCancelled(orderId);
    }

    /// @notice Retry returning escrow that a clamped transfer left behind on a
    ///         closed order. Maker only.
    ///
    /// @dev    `cancelOrder` is terminal and cannot condition on the transfer's
    ///         encrypted result, so a delivery that clamped to 0 would otherwise
    ///         strand the escrow forever. Idempotent: with nothing left this
    ///         moves 0 and changes no state.
    /// @param  orderId The closed order to sweep.
    function claimEscrow(uint256 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        if (o.maker == address(0)) revert OrderNotFound();
        if (!o.closed) revert OrderNotClosed();
        if (msg.sender != o.maker) revert NotMaker();

        euint64 eReturned = FHE.receiveEuint64FromCall(
            o.inputToken.confidentialTransfer(o.maker, FHE.shareEuint64(o.eRemaining, address(o.inputToken))),
            address(o.inputToken)
        );
        o.eRemaining = FHE.sub(o.eRemaining, eReturned);
        FHE.allowThis(o.eRemaining);
        FHE.allow(o.eRemaining, o.maker);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Returns the flattened public projection of an order.
    /// @param  orderId The order to project.
    /// @return The {OrderView} for `orderId`.
    function getOrder(uint256 orderId) external view returns (OrderView memory) {
        return _view(orderId);
    }

    /// @notice Batch variant of getOrder — hydrate any list of ids in one call.
    /// @param  ids   The order ids to project.
    /// @return views One {OrderView} per id, in the same order.
    function getOrdersBatch(uint256[] calldata ids) external view returns (OrderView[] memory views) {
        views = new OrderView[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            views[i] = _view(ids[i]);
        }
    }

    /// @notice Active order ids for a directional pair (inputToken → outputToken).
    /// @dev    Directional: getOrdersByPair(TOKEN, fUSD) returns orders selling
    ///         TOKEN for fUSD; pass the legs reversed for the opposite side.
    /// @param  inputToken  The escrowed leg to match on.
    /// @param  outputToken The requested leg to match on.
    /// @return The active order ids listed for that directional pair.
    function getOrdersByPair(address inputToken, address outputToken) external view returns (uint256[] memory) {
        return _pairOrders[_pairKey(inputToken, outputToken)].values();
    }

    /// @notice All order ids a maker has ever created (includes closed orders).
    /// @param  maker The maker to query.
    /// @return The maker's order ids, in creation order.
    function getMakerOrderIds(address maker) external view returns (uint256[] memory) {
        return _makerOrderIds[maker];
    }

    /// @notice Distinct order ids a taker has filled.
    /// @param  taker The taker to query.
    /// @return The deduped set of order ids the taker has filled.
    function getTakerFills(address taker) external view returns (uint256[] memory) {
        return _takerFills[taker].values();
    }

    /// @notice Read a publish record (e.g. to know what seq/handle to publish or
    ///         whether a bond is recoverable).
    /// @param  orderId   The order the record belongs to.
    /// @param  seq       The record's seq.
    /// @return handle    The encrypted bracket snapshot handle.
    /// @return depositor The address that posted the record.
    /// @return bondWei   The bond held, in wei (0 for maker records).
    /// @return deadline  The depositor-exclusive window end (0 for maker records).
    /// @return settled   Whether the bond has been settled.
    /// @return bountyBps_ The bounty rate stamped at fill time, in bps.
    function getPublish(
        uint256 orderId,
        uint64 seq
    )
        external
        view
        returns (bytes32 handle, address depositor, uint256 bondWei, uint64 deadline, bool settled, uint16 bountyBps_)
    {
        Publish storage p = _publishes[orderId][seq];
        return (euint8.unwrap(p.handle), p.depositor, p.bondWei, p.deadline, p.settled, p.bountyBps);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Reverts unless both legs are currently whitelisted. Enforced on
    ///      every path that opens or increases exposure — create, fill, top-up.
    /// @param inputToken  The order's escrowed leg.
    /// @param outputToken The order's requested leg.
    function _requireWhitelisted(address inputToken, address outputToken) internal view {
        if (!_tokenConfig[inputToken].whitelisted) revert TokenNotWhitelisted(inputToken);
        if (!_tokenConfig[outputToken].whitelisted) revert TokenNotWhitelisted(outputToken);
    }

    /// @dev Builds the {OrderView} projection, sourcing the frontier bracket
    ///      handle from the latest publish record.
    /// @param  orderId The order to project.
    /// @return The flattened view of the order.
    function _view(uint256 orderId) internal view returns (OrderView memory) {
        Order storage o = orders[orderId];
        return
            OrderView({
                maker: o.maker,
                inputToken: address(o.inputToken),
                outputToken: address(o.outputToken),
                price: o.price,
                expiry: o.expiry,
                bracket: o.bracket,
                latestSeq: o.latestSeq,
                publishedSeq: o.publishedSeq,
                bracketHandle: euint8.unwrap(_publishes[orderId][o.latestSeq].handle),
                remainingHandle: euint64.unwrap(o.eRemaining),
                depositedHandle: euint64.unwrap(o.eDepositedAmount),
                active: o.active,
                pending: o.pending,
                closed: o.closed
            });
    }

    /// @dev keccak of the directional token pair, the pair-index key.
    /// @param  inputToken  The escrowed leg.
    /// @param  outputToken The requested leg.
    /// @return The directional pair key.
    function _pairKey(address inputToken, address outputToken) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(inputToken, outputToken));
    }

    /// @dev Sends ETH via call; reverts on failure. No-op for zero amount.
    /// @param to     The recipient.
    /// @param amount The wei to send.
    function _payEth(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = payable(to).call{ value: amount }('');
        if (!ok) revert EthTransferFailed();
    }

    /// @dev Converts an encrypted input amount to its USD-equivalent for bracket
    ///      computation, always at the input leg's oracle price — never at the
    ///      maker-supplied `o.price`, which is unbounded and, since the cap below
    ///      is inversely tied to the rate, let a maker publish a one-unit order
    ///      as WHALE. The cap keeps eAmount × price inside uint64.
    ///
    ///      The oracle price is per WHOLE token, so `raw × price >> 20` is only in
    ///      6-decimal fUSD units when the input token has 6 decimals. A coarser
    ///      confidential ledger is rescaled by 10^(FUSD_DECIMALS − decimals); the
    ///      whitelist cap guarantees the exponent is never negative.
    /// @param  eAmount The encrypted input-token amount to value.
    /// @param  o       The order whose input leg selects the oracle price.
    /// @return The encrypted USD-equivalent (6-decimal fUSD units).
    function _toUSD(euint64 eAmount, Order storage o) internal returns (euint64) {
        address inputToken = address(o.inputToken);
        uint64 convPrice = _tokenConfig[inputToken].oraclePrice *
            uint64(10 ** (FUSD_DECIMALS - _confidentialDecimals(inputToken)));
        if (convPrice == Q_DENOM) return eAmount;

        uint64 maxSafe = type(uint64).max / convPrice;
        euint64 eSafe = FHE.min(eAmount, FHE.asEuint64(maxSafe));
        FHE.allowThis(eSafe);
        euint64 eRaw = FHE.mul(eSafe, FHE.asEuint64(convPrice));
        FHE.allowThis(eRaw);
        euint64 eUSD = FHE.shr(eRaw, _E_SHR_20);
        FHE.allowThis(eUSD);
        return eUSD;
    }

    /// @dev Computes the size bracket from an encrypted fUSD amount using FHE
    ///      comparisons and grants the necessary ACL permissions on the result.
    ///      Built with nested FHE.select calls from largest threshold to
    ///      smallest: start at WHALE and peel back each time the amount is
    ///      below the next threshold, finally collapsing exact-zero to EMPTY.
    ///      The result is allowPublic'd so the threshold network can decrypt it
    ///      for a later publishBracket proof.
    /// @param  usdAmount The encrypted USD-equivalent size (6-decimal fUSD units).
    /// @return The encrypted bracket label (0–5), allowThis'd and allowPublic'd.
    function _computeBracket(euint64 usdAmount) internal returns (euint8) {
        ebool isZero = FHE.eq(usdAmount, _E_ZERO64);
        ebool ltNano = FHE.lt(usdAmount, _NANO_MAX);
        ebool ltSmall = FHE.lt(usdAmount, _SMALL_MAX);
        ebool ltMedium = FHE.lt(usdAmount, _MEDIUM_MAX);
        ebool ltLarge = FHE.lt(usdAmount, _LARGE_MAX);

        euint8 b = FHE.select(ltLarge, _E_BRACKET_LARGE, _E_BRACKET_WHALE);
        b = FHE.select(ltMedium, _E_BRACKET_MEDIUM, b);
        b = FHE.select(ltSmall, _E_BRACKET_SMALL, b);
        b = FHE.select(ltNano, _E_BRACKET_NANO, b);
        b = FHE.select(isZero, _E_BRACKET_EMPTY, b);
        FHE.allowThis(b);
        FHE.allowPublic(b);
        return b;
    }
}
