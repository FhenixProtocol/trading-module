import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import type { ConfidentialOTC, FHERC20_Harness } from "../typechain-types";

// Derive both types from hre to avoid pnpm dual-instance mismatches — two
// copies of the same package end up at different paths and TypeScript treats
// them as incompatible. Deriving from hre guarantees both the annotation and
// the actual return value resolve from the same copy.
type CofheClient = Awaited<ReturnType<typeof hre.cofhe.createClientWithBatteries>>;
type HardhatEthersSigner = Awaited<ReturnType<typeof hre.ethers.getSigners>>[number];

/** Mintable FHERC20 stand-in (existing repo harness — replaces MockFUSD/MockOTCToken/MockDecimalsToken). */
type ConfidentialToken = FHERC20_Harness;

// Dual-ledger (public ERC-20 + confidential layer) tokens link the shared library.
// Used to pin that the OTC checks `confidentialDecimals()` — the ledger it trades on —
// rather than the public `decimals()`.
const LIB_FQN = "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib";

async function linkedFactory(name: string) {
  const lib = await ethers.deployContract(LIB_FQN);
  await lib.waitForDeployment();
  return ethers.getContractFactory(name, { libraries: { [LIB_FQN]: await lib.getAddress() } });
}

/** 6-decimal public ledger scaled to `confDecimals` confidential precision (mirrors FUSDJmi). */
async function deployDualLedger(confDecimals: number) {
  const Harness = await linkedFactory("ConfidentialHarness");
  const token = await Harness.deploy();
  await token.waitForDeployment();
  await (await token.initialize(confDecimals)).wait();
  return token;
}

/** FhenixToken: 18-decimal public ledger, `confDecimals` confidential precision (proxy deploy). */
async function deployFhenixToken(confDecimals: number) {
  const [deployer] = await ethers.getSigners();
  const implFactory = await linkedFactory("FhenixTokenHarness");
  const impl = await implFactory.deploy();
  await impl.waitForDeployment();
  const initData = impl.interface.encodeFunctionData("initialize", [
    deployer.address,
    deployer.address,
    0,
    confDecimals,
  ]);
  const proxy = await ethers.deployContract("ERC1967Proxy", [await impl.getAddress(), initData]);
  await proxy.waitForDeployment();
  return implFactory.attach(await proxy.getAddress());
}

const Q = 1_048_576n; // 2^20 — Q44.20 denominator (oracle prices, fee)
const X64 = 1n << 64n; // 2^64 — Q64.64 denominator (order prices)
const FAR_FUTURE = 281_474_976_710_655n; // uint48.max — operator approval window
const ONE = 1_000_000n; // 1 whole token at 6 decimals

// Bracket labels (mirror the contract; uint8 → bigint over the wire).
const EMPTY = 0n;
const NANO = 1n;
const SMALL = 2n;
const LARGE = 4n;
const UNPUBLISHED = 255n;

// ── Realistic oracle prices (Q44.20: floor(usd_per_whole_token × 2^20)) ───────
const ORACLE_ECBTC = 65_000n * Q; // $65,000 / BTC
const ORACLE_ECETH = 3_500n * Q; // $3,500  / ETH (also the ETH bond price)

// ── Order prices (Q64.64: output-raw per input-raw) ───────────────────────────
const PRICE_BTC_CUSD = 65_000n * X64; // ecBTC → cUSD: $65,000 per ecBTC → stored 65_000 / 2^0
const PRICE_CUSD_BTC = X64 / 65_000n; // cUSD → ecBTC → stored 33_039 / 2^31
const PRICE_BTC_ETH = (65_000n * X64) / 3_500n; // ecBTC → ecETH ≈ 18.57 → stored 38_035 / 2^11

// ── Convenience amounts ────────────────────────────────────────────────────────
const mBTC = ONE / 1_000n; // 0.001 ecBTC = 1_000 raw → $65 at oracle → NANO

// ── Pre-computed fill costs (verified against the Q44.20 formula) ─────────────
const FILL_1MBTC_CUSD = 65n * ONE; // 1_000 raw ecBTC → 65_000_000 cUSD ($65)
const FILL_400RAW_CUSD = 26n * ONE; // 400   raw ecBTC → 26_000_000 cUSD ($26)
const FILL_200RAW_CUSD = 13n * ONE; // 200   raw ecBTC → 13_000_000 cUSD ($13)
// PRICE_BTC_ETH is stored as 38_035 / 2^11, so the costs (18_571.78 and
// 7_428.71) carry a residue; the taker pays the ceiling, so the maker keeps it.
const FILL_1MBTC_ETH = 18_572n; // 1_000 raw ecBTC → 18_572 raw ecETH
const FILL_400RAW_ETH = 7_429n; // 400   raw ecBTC → 7_429  raw ecETH

describe("ConfidentialOTC", () => {
  before(async () => {
    // The cofhe mock contracts emit very gas-heavy per-op debug logs; the
    // bracket recompute alone runs ~10 FHE ops per fill. Disable to stay
    // under the block gas limit.
    await hre.cofhe.mocks.disableLogs();
  });

  async function setup() {
    const [deployer, alice, bob] = await ethers.getSigners();

    const cusd = (await ethers.deployContract("FHERC20_Harness", [
      "Confidential USD",
      "cUSD",
      6,
      "",
    ])) as unknown as ConfidentialToken;
    await cusd.waitForDeployment();

    const ecbtc = (await ethers.deployContract("FHERC20_Harness", [
      "Confidential WBTC",
      "ecBTC",
      6,
      "",
    ])) as unknown as ConfidentialToken;
    await ecbtc.waitForDeployment();

    const eceth = (await ethers.deployContract("FHERC20_Harness", [
      "Confidential ETH",
      "ecETH",
      6,
      "",
    ])) as unknown as ConfidentialToken;
    await eceth.waitForDeployment();

    const otc = (await ethers.deployContract("ConfidentialOTC", [deployer.address])) as unknown as ConfidentialOTC;
    await otc.waitForDeployment();

    // Whitelist the test tokens at realistic oracle prices (the stablecoin at
    // $1 = Q_DENOM), and set the ETH price used to size fill bonds.
    await (await otc.connect(deployer).whitelistToken(await cusd.getAddress(), Q)).wait();
    await (await otc.connect(deployer).whitelistToken(await ecbtc.getAddress(), ORACLE_ECBTC)).wait();
    await (await otc.connect(deployer).whitelistToken(await eceth.getAddress(), ORACLE_ECETH)).wait();
    await (await otc.connect(deployer).setEthOraclePrice(ORACLE_ECETH)).wait();

    const aliceClient = await hre.cofhe.createClientWithBatteries(alice);
    const bobClient = await hre.cofhe.createClientWithBatteries(bob);

    const otcAddr = await otc.getAddress();
    const cusdAddr = await cusd.getAddress();
    const ecbtcAddr = await ecbtc.getAddress();
    const ecethAddr = await eceth.getAddress();

    return {
      deployer,
      alice,
      bob,
      cusd,
      ecbtc,
      eceth,
      otc,
      aliceClient,
      bobClient,
      otcAddr,
      cusdAddr,
      ecbtcAddr,
      ecethAddr,
    };
  }

  /// Returns `[handle, proof]`, spread straight into the consuming call. The proof covers the
  /// whole batch and binds it to `consumer`, so the inputs are only usable by that contract.
  async function enc(client: CofheClient, value: bigint, consumer: ConfidentialOTC) {
    return client
      .encryptInputs([Encryptable.uint64(value)])
      .setConsumingContract(await consumer.getAddress())
      .execute();
  }

  type EncInput = Awaited<ReturnType<typeof enc>>;

  /// Lets the threshold-network mock publish a decryption for a public handle,
  /// then decrypts it locally to produce the (value, signature) proof pair.
  async function proof(client: CofheClient, handle: string) {
    await hre.network.provider.send("evm_increaseTime", [11]);
    await hre.network.provider.send("evm_mine");
    return client.decryptForTx(handle).withoutACP().execute();
  }

  /// Mints the input leg to the maker (+ operator grant) and, when the trade
  /// uses cUSD as a leg, mints `cusdAmount` cUSD too. The maker bond defaults
  /// to 0, so no ETH is required at create.
  async function fundMaker(
    maker: HardhatEthersSigner,
    token: ConfidentialToken,
    tokenAmount: bigint,
    cusd: ConfidentialToken,
    cusdAmount: bigint,
    otcAddr: string,
  ) {
    if ((await token.getAddress()) !== (await cusd.getAddress())) {
      await (await token.mint(maker.address, tokenAmount)).wait();
      await (await token.connect(maker).setOperator(otcAddr, FAR_FUTURE)).wait();
    }
    if (cusdAmount > 0n) {
      await (await cusd.mint(maker.address, cusdAmount)).wait();
      await (await cusd.connect(maker).setOperator(otcAddr, FAR_FUTURE)).wait();
    }
  }

  /// createOrder (step 1) → returns the assigned id while pending.
  async function createOrder(
    otc: ConfidentialOTC,
    maker: HardhatEthersSigner,
    input: string,
    output: string,
    price: bigint,
    expiry: bigint,
    encAmount: EncInput[0],
    inputProof: EncInput[1],
  ): Promise<bigint> {
    const id = await otc.nextOrderId();
    await (await otc.connect(maker).createOrder(input, output, price, expiry, encAmount, inputProof)).wait();
    return id;
  }

  /// activateOrder (step 2): publishes the create record's bracket and lists it.
  async function activate(otc: ConfidentialOTC, maker: HardhatEthersSigner, makerClient: CofheClient, id: bigint) {
    const view = await otc.getOrder(id); // frontier handle == create record (seq 1)
    const dec = await proof(makerClient, view.bracketHandle);
    await (await otc.connect(maker).activateOrder(id, dec.decryptedValue, dec.signature)).wait();
  }

  /// Full create + activate, the common path for fill/cancel tests.
  async function createAndActivate(
    otc: ConfidentialOTC,
    maker: HardhatEthersSigner,
    makerClient: CofheClient,
    input: string,
    output: string,
    price: bigint,
    expiry: bigint,
    encAmount: EncInput[0],
    inputProof: EncInput[1],
  ): Promise<bigint> {
    const id = await createOrder(otc, maker, input, output, price, expiry, encAmount, inputProof);
    await activate(otc, maker, makerClient, id);
    return id;
  }

  /// fillOrder (tx1) with the required ETH bond → returns the new record seq.
  async function fill(
    otc: ConfidentialOTC,
    taker: HardhatEthersSigner,
    takerClient: CofheClient,
    id: bigint,
    amount: bigint,
  ): Promise<bigint> {
    const bond = await otc.ethBondSize();
    await (await otc.connect(taker).fillOrder(id, ...(await enc(takerClient, amount, otc)), { value: bond })).wait();
    return (await otc.getOrder(id)).latestSeq;
  }

  /// publishBracket (tx2) for a given record seq → returns the published value.
  async function publish(
    otc: ConfidentialOTC,
    who: HardhatEthersSigner,
    whoClient: CofheClient,
    id: bigint,
    seq: bigint,
  ): Promise<bigint> {
    const rec = await otc.getPublish(id, seq);
    const dec = await proof(whoClient, rec.handle);
    await (await otc.connect(who).publishBracket(id, seq, dec.decryptedValue, dec.signature)).wait();
    return BigInt(dec.decryptedValue);
  }

  /// Decrypts each (id, seq) record's handle for `client` and returns the four
  /// parallel arrays publishBrackets takes, plus the plaintext values.
  async function publishInputs(otc: ConfidentialOTC, client: CofheClient, records: [bigint, bigint][]) {
    const ids: bigint[] = [];
    const seqs: bigint[] = [];
    const values: bigint[] = [];
    const sigs: string[] = [];
    for (const [id, seq] of records) {
      const rec = await otc.getPublish(id, seq);
      const dec = await proof(client, rec.handle);
      ids.push(id);
      seqs.push(seq);
      values.push(BigInt(dec.decryptedValue));
      sigs.push(dec.signature);
    }
    return { args: [ids, seqs, values, sigs] as const, values };
  }

  /// fill + publish in one shot (taker publishes within the window).
  async function fillAndPublish(
    otc: ConfidentialOTC,
    taker: HardhatEthersSigner,
    takerClient: CofheClient,
    id: bigint,
    amount: bigint,
  ): Promise<bigint> {
    const seq = await fill(otc, taker, takerClient, id, amount);
    return publish(otc, taker, takerClient, id, seq);
  }

  async function expectBalance(token: ConfidentialToken, who: string, amount: bigint) {
    await hre.cofhe.mocks.expectPlaintext(await token.confidentialBalanceOf(who), amount);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // constructor
  // ─────────────────────────────────────────────────────────────────────────

  describe("constructor", () => {
    it("reverts on zero treasury address", async () => {
      const factory = await ethers.getContractFactory("ConfidentialOTC");
      await expect(factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("deploys with an empty whitelist — no token is auto-listed", async () => {
      const [signer] = await ethers.getSigners();
      const token = (await ethers.deployContract("FHERC20_Harness", [
        "Confidential USD",
        "cUSD",
        6,
        "",
      ])) as unknown as ConfidentialToken;
      await token.waitForDeployment();
      const otc = (await ethers.deployContract("ConfidentialOTC", [signer.address])) as unknown as ConfidentialOTC;
      await otc.waitForDeployment();

      const config = await otc.getTokenConfig(await token.getAddress());
      expect(config.whitelisted).to.equal(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Whitelist / Oracle
  // ─────────────────────────────────────────────────────────────────────────

  describe("whitelist / oracle", () => {
    it("owner can whitelist a token and getTokenConfig reflects it", async () => {
      const { deployer, otc } = await setup();
      const token = (await ethers.deployContract("FHERC20_Harness", ["T", "T", 6, ""])) as unknown as ConfidentialToken;
      await token.waitForDeployment();
      const tokenAddr = await token.getAddress();

      await (await otc.connect(deployer).whitelistToken(tokenAddr, 1_000n * Q)).wait();

      const cfg = await otc.getTokenConfig(tokenAddr);
      expect(cfg.whitelisted).to.equal(true);
      expect(cfg.oraclePrice).to.equal(1_000n * Q);
    });

    /// Asserts a token's five raw-unit bracket thresholds: t = ceil(MAX × 2^20 / (P × 10^(6−dec))).
    async function expectThresholds(otc: ConfidentialOTC, token: string, expected: bigint[]) {
      const cfg = await otc.getTokenConfig(token);
      const handles = [cfg.tEmpty, cfg.tNano, cfg.tSmall, cfg.tMedium, cfg.tLarge];
      for (let i = 0; i < 5; i++) await hre.cofhe.mocks.expectPlaintext(handles[i], expected[i]);
    }

    it("derives raw-unit bracket thresholds on whitelist and re-derives them on every price push", async () => {
      const { deployer, otc, cusdAddr, ecbtcAddr } = await setup();

      // cUSD at $1 with 6 decimals: raw units ARE cUSD units, so the bounds are the USD maxima.
      await expectThresholds(otc, cusdAddr, [1n, 100_000_000n, 1_000_000_000n, 10_000_000_000n, 100_000_000_000n]);

      // ecBTC at $65,000: each bound is ceil(MAX / 65_000) raw units.
      await expectThresholds(otc, ecbtcAddr, [1n, 1_539n, 15_385n, 153_847n, 1_538_462n]);

      // A push at $100,000 divides evenly: $100 → 1_000 raw, $100k → 1_000_000 raw.
      await (await otc.connect(deployer).updateOraclePrices([ecbtcAddr], [100_000n * Q])).wait();
      await expectThresholds(otc, ecbtcAddr, [1n, 1_000n, 10_000n, 100_000n, 1_000_000n]);

      // A 4-decimal ledger at $1,000/whole: $100 is 0.1 token = 1_000 raw, so the
      // decimals rescale is folded into the thresholds too.
      const token4 = await deployDualLedger(4);
      const token4Addr = await token4.getAddress();
      await (await otc.connect(deployer).whitelistToken(token4Addr, 1_000n * Q)).wait();
      expect((await otc.getTokenConfig(token4Addr)).decimals).to.equal(4);
      await expectThresholds(otc, token4Addr, [1n, 1_000n, 10_000n, 100_000n, 1_000_000n]);
    });

    it("non-owner cannot whitelist", async () => {
      const { alice, otc } = await setup();
      const token = (await ethers.deployContract("FHERC20_Harness", ["T", "T", 6, ""])) as unknown as ConfidentialToken;
      await token.waitForDeployment();
      await expect(otc.connect(alice).whitelistToken(await token.getAddress(), Q)).to.be.revertedWithCustomError(
        otc,
        "OwnableUnauthorizedAccount",
      );
    });

    it("whitelistToken reverts on zero address", async () => {
      const { deployer, otc } = await setup();
      await expect(otc.connect(deployer).whitelistToken(ethers.ZeroAddress, Q)).to.be.revertedWithCustomError(
        otc,
        "ZeroAddress",
      );
    });

    it("whitelistToken reverts when price is below MIN_ORACLE_PRICE", async () => {
      const { deployer, otc } = await setup();
      const token = (await ethers.deployContract("FHERC20_Harness", ["T", "T", 6, ""])) as unknown as ConfidentialToken;
      await token.waitForDeployment();
      await expect(otc.connect(deployer).whitelistToken(await token.getAddress(), 0n)).to.be.revertedWithCustomError(
        otc,
        "ZeroPrice",
      );
    });

    it("whitelistToken reverts for tokens with more than 6 decimals", async () => {
      const { deployer, otc } = await setup();
      const token8 = (await ethers.deployContract("FHERC20_Harness", [
        "Eight",
        "E8",
        8,
        "",
      ])) as unknown as ConfidentialToken;
      await token8.waitForDeployment();
      await expect(otc.connect(deployer).whitelistToken(await token8.getAddress(), Q)).to.be.revertedWithCustomError(
        otc,
        "InvalidDecimals",
      );
    });

    // Dual-ledger tokens: the check must target the confidential layer, not the public ERC-20.
    it("whitelists a dual-ledger token with 18 public / 6 confidential decimals", async () => {
      const { deployer, otc } = await setup();
      const Mock = await linkedFactory("MockERC20Confidential");
      const token = await Mock.deploy("Confidential Token", "CTK", 18); // public 18 → confidential clamped to 6
      await token.waitForDeployment();
      expect(await token.decimals()).to.equal(18);
      expect(await token.confidentialDecimals()).to.equal(6);

      const tokenAddr = await token.getAddress();
      await (await otc.connect(deployer).whitelistToken(tokenAddr, 1_000n * Q)).wait();
      expect((await otc.getTokenConfig(tokenAddr)).whitelisted).to.equal(true);
    });

    it("whitelists a dual-ledger token with 6 public / 4 confidential decimals", async () => {
      const { deployer, otc } = await setup();
      const token = await deployDualLedger(4);
      const tokenAddr = await token.getAddress();
      await (await otc.connect(deployer).whitelistToken(tokenAddr, 1_000n * Q)).wait();
      expect((await otc.getTokenConfig(tokenAddr)).whitelisted).to.equal(true);
    });

    it("whitelistToken reverts for a dual-ledger token whose confidential layer exceeds 6 decimals", async () => {
      const { deployer, otc } = await setup();
      const token = await deployFhenixToken(8); // public 18 / confidential 8
      expect(await token.confidentialDecimals()).to.equal(8);
      await expect(otc.connect(deployer).whitelistToken(await token.getAddress(), Q)).to.be.revertedWithCustomError(
        otc,
        "InvalidDecimals",
      );
    });

    it("owner can delist a token", async () => {
      const { deployer, otc, ecbtcAddr } = await setup();
      await (await otc.connect(deployer).delistToken(ecbtcAddr)).wait();
      expect((await otc.getTokenConfig(ecbtcAddr)).whitelisted).to.equal(false);
    });

    it("createOrder reverts with TokenNotWhitelisted when either leg is not whitelisted", async () => {
      const { alice, otc, aliceClient, cusdAddr, ecbtcAddr } = await setup();
      const unlisted = (await ethers.deployContract("FHERC20_Harness", [
        "U",
        "U",
        6,
        "",
      ])) as unknown as ConfidentialToken;
      await unlisted.waitForDeployment();
      const amt = await enc(aliceClient, mBTC, otc);

      await expect(
        otc.connect(alice).createOrder(await unlisted.getAddress(), cusdAddr, PRICE_BTC_CUSD, 0n, ...amt),
      ).to.be.revertedWithCustomError(otc, "TokenNotWhitelisted");

      await expect(
        otc.connect(alice).createOrder(ecbtcAddr, await unlisted.getAddress(), PRICE_BTC_CUSD, 0n, ...amt),
      ).to.be.revertedWithCustomError(otc, "TokenNotWhitelisted");
    });

    it("owner can set the oracle address", async () => {
      const { deployer, bob, otc } = await setup();
      await expect(otc.connect(deployer).setOracle(bob.address))
        .to.emit(otc, "OracleUpdated")
        .withArgs(ethers.ZeroAddress, bob.address);
      expect(await otc.oracle()).to.equal(bob.address);
    });

    it("oracle address can update a whitelisted token price", async () => {
      const { deployer, bob, otc, ecbtcAddr } = await setup();
      await (await otc.connect(deployer).setOracle(bob.address)).wait();

      const newPrice = 70_000n * Q; // $70k
      await (await otc.connect(bob).updateOraclePrices([ecbtcAddr], [newPrice])).wait();
      expect((await otc.getTokenConfig(ecbtcAddr)).oraclePrice).to.equal(newPrice);
    });

    it("owner can also update oracle price directly", async () => {
      const { deployer, otc, ecbtcAddr } = await setup();
      await (await otc.connect(deployer).updateOraclePrices([ecbtcAddr], [70_000n * Q])).wait();
      expect((await otc.getTokenConfig(ecbtcAddr)).oraclePrice).to.equal(70_000n * Q);
    });

    it("updateOraclePrices reverts for unauthorized callers", async () => {
      const { alice, otc, ecbtcAddr } = await setup();
      await expect(otc.connect(alice).updateOraclePrices([ecbtcAddr], [Q])).to.be.revertedWithCustomError(
        otc,
        "Unauthorized",
      );
    });

    it("updateOraclePrices reverts for non-whitelisted token", async () => {
      const { deployer, otc } = await setup();
      const unlisted = (await ethers.deployContract("FHERC20_Harness", [
        "U",
        "U",
        6,
        "",
      ])) as unknown as ConfidentialToken;
      await unlisted.waitForDeployment();
      await expect(
        otc.connect(deployer).updateOraclePrices([await unlisted.getAddress()], [Q]),
      ).to.be.revertedWithCustomError(otc, "TokenNotWhitelisted");
    });

    it("updateOraclePrices reverts when price is below MIN_ORACLE_PRICE", async () => {
      const { deployer, otc, ecbtcAddr } = await setup();
      await expect(otc.connect(deployer).updateOraclePrices([ecbtcAddr], [0n])).to.be.revertedWithCustomError(
        otc,
        "ZeroPrice",
      );
    });

    // ── updateOraclePrices (batch) ──────────────────────────────────────────

    it("updateOraclePrices reprices several tokens in one tx and emits per token", async () => {
      const { deployer, bob, otc, ecbtcAddr, ecethAddr } = await setup();
      await (await otc.connect(deployer).setOracle(bob.address)).wait();

      const btc = 70_000n * Q;
      const eth = 4_000n * Q;
      await expect(otc.connect(bob).updateOraclePrices([ecbtcAddr, ecethAddr], [btc, eth]))
        .to.emit(otc, "OraclePriceUpdated")
        .withArgs(ecbtcAddr, btc)
        .and.to.emit(otc, "OraclePriceUpdated")
        .withArgs(ecethAddr, eth);

      const [cfgBtc, cfgEth] = await Promise.all([otc.getTokenConfig(ecbtcAddr), otc.getTokenConfig(ecethAddr)]);
      expect(cfgBtc.oraclePrice).to.equal(btc);
      expect(cfgEth.oraclePrice).to.equal(eth);
      expect(cfgBtc.priceUpdatedAt).to.equal(cfgEth.priceUpdatedAt); // same block
    });

    it("updateOraclePrices reverts on length mismatch", async () => {
      const { deployer, otc, ecbtcAddr, ecethAddr } = await setup();
      await expect(otc.connect(deployer).updateOraclePrices([ecbtcAddr, ecethAddr], [Q])).to.be.revertedWithCustomError(
        otc,
        "LengthMismatch",
      );
    });

    it("updateOraclePrices is atomic: one bad entry reverts the whole batch", async () => {
      const { deployer, otc, ecbtcAddr, ecethAddr } = await setup();
      const before = (await otc.getTokenConfig(ecbtcAddr)).oraclePrice;
      const unlisted = (await ethers.deployContract("FHERC20_Harness", [
        "U",
        "U",
        6,
        "",
      ])) as unknown as ConfidentialToken;
      await unlisted.waitForDeployment();

      // Valid first entry, unlisted second: nothing may persist from entry 0.
      await expect(
        otc.connect(deployer).updateOraclePrices([ecbtcAddr, await unlisted.getAddress()], [70_000n * Q, Q]),
      ).to.be.revertedWithCustomError(otc, "TokenNotWhitelisted");
      expect((await otc.getTokenConfig(ecbtcAddr)).oraclePrice).to.equal(before);

      // Same for a below-minimum price anywhere in the batch.
      await expect(
        otc.connect(deployer).updateOraclePrices([ecbtcAddr, ecethAddr], [70_000n * Q, 0n]),
      ).to.be.revertedWithCustomError(otc, "ZeroPrice");
      expect((await otc.getTokenConfig(ecbtcAddr)).oraclePrice).to.equal(before);
    });

    it("updateOraclePrices accepts an empty batch as a no-op", async () => {
      const { deployer, otc } = await setup();
      await (await otc.connect(deployer).updateOraclePrices([], [])).wait();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // params & bond sizing
  // ─────────────────────────────────────────────────────────────────────────

  describe("params / bond sizing", () => {
    it("prices the $5 fill bond into wei via the ETH oracle", async () => {
      const { otc } = await setup();
      // $5 (5_000_000) / $3,500 ETH = 0.0014285… ETH.
      // wei = 5_000_000 × 1e12 × 2^20 / (3_500 × 2^20) = 5_000_000 × 1e12 / 3_500.
      const expected = (5_000_000n * 10n ** 12n) / 3_500n;
      expect(await otc.ethBondSize()).to.equal(expected);
      expect(await otc.makerBondSize()).to.equal(0n); // makerBondUsd defaults to 0
    });

    it("owner can retune params; only owner", async () => {
      const { deployer, alice, otc } = await setup();
      await (await otc.connect(deployer).setParams(10_000_000n, 1_000_000n, 1_000n, 300n)).wait();
      expect(await otc.fillBondUsd()).to.equal(10_000_000n);
      expect(await otc.makerBondUsd()).to.equal(1_000_000n);
      expect(await otc.bountyBps()).to.equal(1_000n);
      expect(await otc.windowSeconds()).to.equal(300n);

      await expect(otc.connect(alice).setParams(0n, 0n, 0n, 0n)).to.be.revertedWithCustomError(
        otc,
        "OwnableUnauthorizedAccount",
      );
    });

    it("ethBondSize reverts when the ETH oracle price is unset", async () => {
      const [deployer] = await ethers.getSigners();
      const otc = (await ethers.deployContract("ConfidentialOTC", [deployer.address])) as unknown as ConfidentialOTC;
      await otc.waitForDeployment();
      await expect(otc.connect(deployer).ethBondSize()).to.be.revertedWithCustomError(otc, "EthOracleUnset");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // createOrder + activateOrder
  // ─────────────────────────────────────────────────────────────────────────

  describe("createOrder / activateOrder", () => {
    it("creates a pending order that escrows input, then publishes + lists it", async () => {
      const { alice, ecbtc, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);

      // 1 mBTC = 0.001 BTC @ $65,000 = $65 → NANO
      const id = await createOrder(
        otc,
        alice,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );

      let order = await otc.getOrder(id);
      expect(order.pending).to.equal(true);
      expect(order.active).to.equal(false);
      expect(order.bracket).to.equal(UNPUBLISHED); // not revealed yet
      expect(order.latestSeq).to.equal(1n);
      expect(order.publishedSeq).to.equal(0n);
      await expectBalance(ecbtc, otcAddr, mBTC); // 1 mBTC escrowed
      await expectBalance(ecbtc, alice.address, ONE - mBTC);
      await hre.cofhe.mocks.expectPlaintext(order.bracketHandle, NANO); // encrypted snapshot
      expect((await otc.getOrdersByPair(ecbtcAddr, cusdAddr)).length).to.equal(0);

      await activate(otc, alice, aliceClient, id);

      order = await otc.getOrder(id);
      expect(order.pending).to.equal(false);
      expect(order.active).to.equal(true);
      expect(order.bracket).to.equal(NANO); // plaintext now published
      expect(order.publishedSeq).to.equal(1n);
      expect(order.maker).to.equal(alice.address);
      expect(order.inputToken).to.equal(ecbtcAddr);
      expect(order.outputToken).to.equal(cusdAddr);
      expect(order.price).to.equal(65_000n); // PRICE_BTC_CUSD as 65_000 / 2^0
      expect(order.priceShift).to.equal(0n);

      expect((await otc.getOrdersByPair(ecbtcAddr, cusdAddr)).map(x => x)).to.deep.equal([id]);
    });

    it("publishes SMALL for a $130 order (2 mBTC @ $65,000, outputToken == cUSD)", async () => {
      const { alice, ecbtc, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, 2n * mBTC, otc)),
      );
      expect((await otc.getOrder(id)).bracket).to.equal(SMALL);
    });

    it("computes bracket from the raw cUSD amount (cUSD→ecBTC, inputToken == cUSD)", async () => {
      const { alice, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, cusd, 0n, cusd, 200n * ONE, otcAddr);

      // Escrow 200 cUSD ($200) selling for ecBTC → SMALL.
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        cusdAddr,
        ecbtcAddr,
        PRICE_CUSD_BTC,
        0n,
        ...(await enc(aliceClient, 200n * ONE, otc)),
      );
      await expectBalance(cusd, otcAddr, 200n * ONE); // no cleanup fee anymore
      expect((await otc.getOrder(id)).bracket).to.equal(SMALL);
    });

    it("brackets from the oracle, so a maker cannot inflate their own size via price", async () => {
      const { alice, ecbtc, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);

      // The bracket rate used to come from o.price on cANY→cUSD orders. At
      // uint64.max the overflow cap collapses to 1, so 1 raw unit multiplied
      // out to 17_592_186_044_415 ($17.6M) — 176x the WHALE floor. Sourcing
      // the rate from the ecBTC oracle values it at what it is: $0.000065.
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        ((1n << 64n) - 1n) << 44n, // the Q44.20 uint64.max rate, in Q64.64
        0n,
        ...(await enc(aliceClient, 1n, otc)),
      );

      expect((await otc.getOrder(id)).bracket).to.equal(NANO);
    });

    it("reverts on zero address, same leg, zero price, and bad expiry", async () => {
      const { alice, otc, aliceClient, cusdAddr, ecbtcAddr } = await setup();
      const amt = await enc(aliceClient, mBTC, otc);

      await expect(
        otc.connect(alice).createOrder(ethers.ZeroAddress, cusdAddr, PRICE_BTC_CUSD, 0n, ...amt),
      ).to.be.revertedWithCustomError(otc, "ZeroAddress");

      await expect(
        otc.connect(alice).createOrder(cusdAddr, cusdAddr, PRICE_BTC_CUSD, 0n, ...amt),
      ).to.be.revertedWithCustomError(otc, "SameLeg");

      await expect(otc.connect(alice).createOrder(ecbtcAddr, cusdAddr, 0n, 0n, ...amt)).to.be.revertedWithCustomError(
        otc,
        "ZeroPrice",
      );

      const past = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) - 1n;
      await expect(
        otc.connect(alice).createOrder(ecbtcAddr, cusdAddr, PRICE_BTC_CUSD, past, ...amt),
      ).to.be.revertedWithCustomError(otc, "InvalidExpiry");
    });

    it("cannot activate an unknown order, and cannot re-publish a settled record", async () => {
      const { alice, ecbtc, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await expect(otc.connect(alice).activateOrder(999n, 1, "0x")).to.be.revertedWithCustomError(otc, "OrderNotFound");

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );
      const rec = await otc.getPublish(id, 1n);
      const dec = await proof(aliceClient, rec.handle);
      await expect(
        otc.connect(alice).activateOrder(id, dec.decryptedValue, dec.signature),
      ).to.be.revertedWithCustomError(otc, "AlreadySettled");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // fillOrder (cUSD leg)
  // ─────────────────────────────────────────────────────────────────────────

  describe("fillOrder", () => {
    /// Maker alice posts 1 mBTC ($65) @ PRICE_BTC_CUSD → NANO bracket.
    async function withOrder() {
      const ctx = await setup();
      const { alice, bob, ecbtc, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = ctx;

      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await (await cusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await cusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );
      return { ...ctx, id };
    }

    it("fully fills: taker pays cUSD, receives ecBTC, bracket → EMPTY + delisted", async () => {
      const { alice, bob, ecbtc, cusd, otc, bobClient, otcAddr, cusdAddr, ecbtcAddr, id } = await withOrder();

      const seq = await fill(otc, bob, bobClient, id, mBTC);

      await expectBalance(ecbtc, bob.address, mBTC); // taker got 1 mBTC
      await expectBalance(ecbtc, otcAddr, 0n); // escrow drained
      await expectBalance(cusd, bob.address, 1_000n * ONE - FILL_1MBTC_CUSD);
      await expectBalance(cusd, alice.address, FILL_1MBTC_CUSD); // maker received $65

      // Still listed + stale (NANO) until the post-fill publish lands.
      expect((await otc.getOrdersByPair(ecbtcAddr, cusdAddr)).length).to.equal(1);

      const value = await publish(otc, bob, bobClient, id, seq);
      expect(value).to.equal(EMPTY);
      const order = await otc.getOrder(id);
      expect(order.bracket).to.equal(EMPTY);
      expect(order.active).to.equal(false); // frontier EMPTY delists
      expect((await otc.getOrdersByPair(ecbtcAddr, cusdAddr)).length).to.equal(0);

      expect((await otc.getTakerFills(bob.address)).map(x => x)).to.deep.equal([id]);
    });

    it("partially fills and keeps the order active with an updated bracket", async () => {
      const { bob, ecbtc, cusd, otc, bobClient, otcAddr, id } = await withOrder();

      const value = await fillAndPublish(otc, bob, bobClient, id, 400n);

      await expectBalance(ecbtc, bob.address, 400n);
      await expectBalance(ecbtc, otcAddr, 600n); // 600 raw remaining
      await expectBalance(cusd, bob.address, 1_000n * ONE - FILL_400RAW_CUSD);

      const order = await otc.getOrder(id);
      expect(order.active).to.equal(true);
      expect(value).to.equal(NANO); // 600 raw × $65,000 = $39 → NANO
      expect(order.bracket).to.equal(NANO);
    });

    it("caps the fill at the remaining size when the taker over-requests", async () => {
      const { bob, ecbtc, cusd, otc, bobClient, otcAddr, id } = await withOrder();

      await fill(otc, bob, bobClient, id, 10n * mBTC); // wants 10 mBTC, only 1 remains

      await expectBalance(ecbtc, bob.address, mBTC);
      await expectBalance(ecbtc, otcAddr, 0n);
      await expectBalance(cusd, bob.address, 1_000n * ONE - FILL_1MBTC_CUSD);
    });

    it("releases nothing when the taker cannot cover the full payment (no free drain)", async () => {
      const { alice, bob, ecbtc, cusd, otc, bobClient, otcAddr, cusdAddr, ecbtcAddr, aliceClient } = await setup();

      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await (await cusd.mint(bob.address, 30n * ONE)).wait(); // enough for $26, not $65
      await (await cusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );

      // Full fill attempt costs $65; bob only has $30 → nothing released, NANO stays.
      const v1 = await fillAndPublish(otc, bob, bobClient, id, mBTC);
      await expectBalance(ecbtc, bob.address, 0n);
      await expectBalance(ecbtc, otcAddr, mBTC);
      await expectBalance(cusd, bob.address, 30n * ONE);
      expect(v1).to.equal(NANO);

      // A fill he CAN afford: 400 raw ecBTC costs $26.
      await fillAndPublish(otc, bob, bobClient, id, 400n);
      await expectBalance(ecbtc, bob.address, 400n);
      await expectBalance(cusd, bob.address, 30n * ONE - FILL_400RAW_CUSD);
    });

    it("reverts without the ETH bond", async () => {
      const { bob, otc, bobClient, id } = await withOrder();
      await expect(
        otc.connect(bob).fillOrder(id, ...(await enc(bobClient, mBTC, otc))), // no value
      ).to.be.revertedWithCustomError(otc, "WrongBond");
    });

    it("reverts on unknown, pending, or inactive orders", async () => {
      const { alice, bob, ecbtc, cusd, otc, aliceClient, bobClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();
      const bond = await otc.ethBondSize();
      await expect(
        otc.connect(bob).fillOrder(999n, ...(await enc(bobClient, mBTC, otc)), { value: bond }),
      ).to.be.revertedWithCustomError(otc, "OrderNotFound");

      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      const id = await createOrder(
        otc,
        alice,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );
      await expect(
        otc.connect(bob).fillOrder(id, ...(await enc(bobClient, mBTC, otc)), { value: bond }),
      ).to.be.revertedWithCustomError(otc, "OrderNotActive");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // price resolution — Q64.64 in, PRICE_BITS-bit mantissa + per-order shift stored
  // ─────────────────────────────────────────────────────────────────────────

  describe("price resolution", () => {
    // Under the old fixed Q44.20 point, a $84,000 BTC bid could only be quoted
    // at $87,381 or $80,660, a 4-decimal BTC could not be bid above $10,485.76,
    // and a cUSD bid for a $0.0001 token filled at most $1,759 at a time.
    // Expected values are worked out with exact integer math outside the
    // contract, not by mirroring it.
    const BTC_USD = 84_000n;
    const U64_MAX = (1n << 64n) - 1n;

    /// Deploys and whitelists an extra token. The oracle price only drives brackets.
    async function listToken(otc: ConfidentialOTC, symbol: string, decimals: number, oracleQ20: bigint) {
      const token = (await ethers.deployContract("FHERC20_Harness", [
        symbol,
        symbol,
        decimals,
        "",
      ])) as unknown as ConfidentialToken;
      await token.waitForDeployment();
      await (await otc.whitelistToken(await token.getAddress(), oracleQ20)).wait();
      return { token, addr: await token.getAddress() };
    }

    async function expectStored(otc: ConfidentialOTC, id: bigint, price: bigint, shift: bigint) {
      const order = await otc.getOrder(id);
      expect([order.price, order.priceShift]).to.deep.equal([price, shift]);
    }

    // 2^64 / 84,000 normalizes to shift 32, where the exact mantissa is
    // 51,130.56 — rounded up to 51,131, i.e. 2^32 / 51,131 = $83,999.28 per BTC.
    // Its neighbours are $84,000.93 (above the maker's limit) and $83,997.64.
    it("stores a $84,000 cUSD → cBTC bid as 51_131 / 2^32 — $83,999.28, never above the maker's limit", async () => {
      const { alice, cusd, otc, aliceClient, otcAddr, cusdAddr } = await setup();
      const { addr: cbtcAddr } = await listToken(otc, "cBTC", 6, BTC_USD * Q);
      await fundMaker(alice, cusd, 0n, cusd, BTC_USD * ONE, otcAddr);

      await expect(
        otc.connect(alice).createOrder(cusdAddr, cbtcAddr, X64 / BTC_USD, 0n, ...(await enc(aliceClient, ONE, otc))),
      )
        .to.emit(otc, "OrderCreated")
        .withArgs(0n, alice.address, cusdAddr, cbtcAddr, 51_131n, 32n, 0n);

      await expectStored(otc, 0n, 51_131n, 32n);
      expect(((1n << 32n) * 100n) / 51_131n).to.equal(8_399_928n); // $83,999.28, in cents
      expect(((1n << 32n) * 100n) / 51_130n).to.equal(8_400_092n); // one step down: $84,000.92
    });

    it("pays a taker selling exactly 1 BTC into that bid $83,999.28", async () => {
      const { alice, bob, cusd, otc, aliceClient, bobClient, otcAddr, cusdAddr } = await setup();
      const { token: cbtc, addr: cbtcAddr } = await listToken(otc, "cBTC", 6, BTC_USD * Q);
      await fundMaker(alice, cusd, 0n, cusd, BTC_USD * ONE, otcAddr);
      await fundMaker(bob, cbtc, ONE, cusd, 0n, otcAddr); // 1 BTC

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        cusdAddr,
        cbtcAddr,
        X64 / BTC_USD,
        0n,
        ...(await enc(aliceClient, BTC_USD * ONE, otc)),
      );

      // The largest cUSD request whose ceil'd cost is still exactly 1,000,000 raw cBTC.
      const want = 83_999_282_157n;
      await fill(otc, bob, bobClient, id, want);

      await expectBalance(cbtc, bob.address, 0n);
      await expectBalance(cbtc, alice.address, ONE);
      await expectBalance(cusd, bob.address, want);
      await expectBalance(cusd, otcAddr, BTC_USD * ONE - want); // $0.72 left to fill
    });

    // One raw unit of a 4-decimal BTC is 0.0001 BTC ($8.40), so the rate is
    // 2^64 / 8,400,000 → 65,448 / 2^39 = $83,998.87 per BTC.
    it("quotes and fills a 4-decimal BTC bid at market: 1 BTC for $83,998.87", async () => {
      const { alice, bob, cusd, otc, aliceClient, bobClient, otcAddr, cusdAddr } = await setup();
      const { token: cbtc4, addr: cbtc4Addr } = await listToken(otc, "cBTC4", 4, BTC_USD * Q);
      await fundMaker(alice, cusd, 0n, cusd, BTC_USD * ONE, otcAddr);
      await fundMaker(bob, cbtc4, 10_000n, cusd, 0n, otcAddr); // 1 BTC

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        cusdAddr,
        cbtc4Addr,
        X64 / 8_400_000n,
        0n,
        ...(await enc(aliceClient, BTC_USD * ONE, otc)),
      );
      await expectStored(otc, id, 65_448n, 39n);

      const want = 83_998_871_453n; // largest request costing exactly 10,000 raw
      await fill(otc, bob, bobClient, id, want);

      await expectBalance(cbtc4, bob.address, 0n);
      await expectBalance(cbtc4, alice.address, 10_000n);
      await expectBalance(cusd, bob.address, want);
    });

    // 10,000 raw T per raw cUSD stores as 40,000 / 2^2, so _fillCap allows
    // ~4.6e14 raw cUSD ($461M) per fill instead of the old $1,759.
    it("fills a $10,000 cUSD bid for a $0.0001 token in one go", async () => {
      const { alice, bob, cusd, otc, aliceClient, bobClient, otcAddr, cusdAddr } = await setup();
      const { token: t, addr: tAddr } = await listToken(otc, "T", 6, 104n); // floor($0.0001 × 2^20)

      const escrow = 10_000n * ONE;
      await fundMaker(alice, cusd, 0n, cusd, escrow, otcAddr);
      await fundMaker(bob, t, escrow * 10_000n, cusd, 0n, otcAddr);

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        cusdAddr,
        tAddr,
        10_000n * X64,
        0n,
        ...(await enc(aliceClient, escrow, otc)),
      );
      await expectStored(otc, id, 40_000n, 2n);

      await fill(otc, bob, bobClient, id, escrow);

      await expectBalance(cusd, bob.address, escrow);
      await expectBalance(cusd, otcAddr, 0n);
      await expectBalance(t, alice.address, escrow * 10_000n);
    });

    it("rejects a rate above 2^64 − 1 and stores the largest one that fits", async () => {
      const { alice, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, cusd, 0n, cusd, 1_000n * ONE, otcAddr);

      // (2^128 − 1) / 2^64 rounds up to exactly 2^64, one past the mantissa.
      await expect(
        otc
          .connect(alice)
          .createOrder(cusdAddr, ecbtcAddr, (1n << 128n) - 1n, 0n, ...(await enc(aliceClient, ONE, otc))),
      ).to.be.revertedWithCustomError(otc, "SafeCastOverflowedUintDowncast");

      // The largest integer rate still fits: (2^64 − 1) at shift 0.
      const id = await createOrder(
        otc,
        alice,
        cusdAddr,
        ecbtcAddr,
        U64_MAX * X64,
        0n,
        ...(await enc(aliceClient, ONE, otc)),
      );
      await expectStored(otc, id, U64_MAX, 0n);
    });

    it("keeps shift 0 from a rate of 2^15, rounds up, and clamps tiny rates at shift 63", async () => {
      const { alice, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, cusd, 0n, cusd, 1_000n * ONE, otcAddr);

      const cases: [bigint, bigint, bigint][] = [
        // [priceX64, stored price, stored shift]
        [1n << 79n, 1n << 15n, 0n], // rate 2^15: the first rate kept whole
        [(1n << 79n) - 1n, 1n << 16n, 1n], // just under: 65,535.99… rounds up to 2^16
        [X64, 1n << 15n, 15n], // $1.00 → 32,768 / 2^15
        [(1n << 16n) - 1n, 1n << 15n, 63n], // just under 2^-48: clamped at shift 63, rounds up
        [10_485n, 5_243n, 63n], // the lowest rate PriceTooLow accepts
      ];
      for (const [priceX64, price, shift] of cases) {
        const id = await createOrder(
          otc,
          alice,
          cusdAddr,
          ecbtcAddr,
          priceX64,
          0n,
          ...(await enc(aliceClient, ONE, otc)),
        );
        await expectStored(otc, id, price, shift);
      }
    });

    // A rate below 2^-48 has fewer than 16 significant bits even as Q64.64
    // calldata, so shift 63 (drop 1) can only round priceX64 up to even: at
    // most one Q64.64 step, a relative error of 1 / priceX64.
    it("rounds a sub-2^-48 priceX64 up to even at shift 63, at most one Q64.64 step", async () => {
      const { alice, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, cusd, 0n, cusd, 1_000n * ONE, otcAddr);

      const cases: [bigint, bigint][] = [
        // [priceX64, stored price] — all at shift 63, so the stored rate is 2 × price / 2^64
        [1n << 16n, 1n << 15n], // rate 2^-48: the last full 16-bit mantissa, exact
        [(1n << 16n) + 1n, (1n << 15n) + 1n], // odd: +1 step = +0.15 bp
        [21_961n, 10_981n], // a 0-decimal BTC for a $0.0001 token, see below: +0.46 bp
        [10_485n, 5_243n], // the lowest rate PriceTooLow accepts: +1 step = +0.95 bp
      ];
      for (const [priceX64, price] of cases) {
        const id = await createOrder(
          otc,
          alice,
          cusdAddr,
          ecbtcAddr,
          priceX64,
          0n,
          ...(await enc(aliceClient, ONE, otc)),
        );
        await expectStored(otc, id, price, 63n);
        expect(2n * price - priceX64).to.equal(priceX64 % 2n);
      }
    });

    // One raw unit of a 0-decimal BTC is 1 BTC ($84,000) and one raw unit of a
    // 6-decimal $0.0001 token is $0.0000000001, so the rate is 1 / 8.4e14 ≈
    // 1.19e-15, below 2^-48 ≈ 3.55e-15. It stores as 10_980 / 2^63, exact, and
    // _fillCap (8.40016e14) still covers the whole order. At shift s a fill
    // outputs at most ~2^(64 − s) raw units, so here every fill outputs exactly
    // 1 BTC: the rounded-up output, not the mantissa, sets what a taker pays.
    it("sells $84,000 of a $0.0001 token for 1 0-decimal BTC; each split fill costs a whole BTC", async () => {
      const { alice, bob, cusd, otc, aliceClient, bobClient, otcAddr } = await setup();
      const { token: t, addr: tAddr } = await listToken(otc, "T", 6, 104n); // floor($0.0001 × 2^20)
      const { token: btc0, addr: btc0Addr } = await listToken(otc, "cBTC0", 0, BTC_USD * Q);

      const escrow = 840_000_000_000_000n; // 840M T = $84,000
      await fundMaker(alice, t, escrow, cusd, 0n, otcAddr);
      await fundMaker(bob, btc0, 2n, cusd, 0n, otcAddr);

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        tAddr,
        btc0Addr,
        X64 / escrow,
        0n,
        ...(await enc(aliceClient, escrow, otc)),
      );
      await expectStored(otc, id, 10_980n, 63n);

      // Half the order is worth 0.5 BTC, but 0.5 raw output rounds up to 1.
      await fill(otc, bob, bobClient, id, escrow / 2n);
      await expectBalance(t, bob.address, escrow / 2n);
      await expectBalance(btc0, alice.address, 1n);

      // The other half costs another whole BTC: the maker collects 2 BTC for $84,000.
      await fill(otc, bob, bobClient, id, escrow / 2n);
      await expectBalance(t, bob.address, escrow);
      await expectBalance(btc0, alice.address, 2n);
      await expectBalance(btc0, bob.address, 0n);
    });

    // The encrypted shift and mask at both ends of their range. A fill at
    // _fillCap puts eActual × price + mask exactly on 2^64 − 1 before the
    // shift, so one unit less headroom would wrap and release nothing. This
    // covers the mock's shr, a plain `>>`; the coprocessor needs a testnet fill.
    it("runs FHE.shr at shift 0 and shift 63 with the sum on 2^64 − 1, without wrapping", async () => {
      const { alice, bob, cusd, otc, aliceClient, bobClient, otcAddr, cusdAddr } = await setup();
      const { token: a, addr: aAddr } = await listToken(otc, "A", 6, Q);
      const { token: b, addr: bAddr } = await listToken(otc, "B", 6, Q);
      const HALF = 1n << 63n;

      await fundMaker(alice, a, HALF + 1n, cusd, 0n, otcAddr);
      await fundMaker(bob, b, U64_MAX, cusd, 1n, otcAddr);

      // Shift 0, mask 0: price 2^64 − 1, so _fillCap is 1 raw unit.
      const id0 = await createAndActivate(
        otc,
        alice,
        aliceClient,
        aAddr,
        bAddr,
        U64_MAX * X64,
        0n,
        ...(await enc(aliceClient, 1n, otc)),
      );
      await expectStored(otc, id0, U64_MAX, 0n);
      await fill(otc, bob, bobClient, id0, 5n);
      await expectBalance(a, bob.address, 1n);
      await expectBalance(b, alice.address, U64_MAX);
      await expectBalance(b, bob.address, 0n);

      // Shift 63, mask 2^63 − 1: priceX64 = 2^14 stores 2^13 / 2^63, so
      // _fillCap is 2^50 and 2^50 × 2^13 + (2^63 − 1) = 2^64 − 1. The output
      // is 1 raw unit.
      const id63 = await createAndActivate(
        otc,
        alice,
        aliceClient,
        aAddr,
        cusdAddr,
        1n << 14n,
        0n,
        ...(await enc(aliceClient, HALF, otc)),
      );
      await expectStored(otc, id63, 1n << 13n, 63n);
      await fill(otc, bob, bobClient, id63, U64_MAX);
      await expectBalance(a, bob.address, (1n << 50n) + 1n);
      await expectBalance(cusd, alice.address, 1n);
      await expectBalance(cusd, bob.address, 0n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // delisted token — trading halts, unwinding does not
  // ─────────────────────────────────────────────────────────────────────────

  describe("delisted token", () => {
    /// Active ecBTC → cUSD order, ready for a leg to be delisted under it.
    async function withOrder() {
      const ctx = await setup();
      const { alice, bob, ecbtc, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = ctx;

      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await (await cusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await cusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );
      return { ...ctx, id };
    }

    it("blocks fills when the escrowed leg is delisted", async () => {
      const { deployer, bob, otc, bobClient, ecbtcAddr, id } = await withOrder();
      await (await otc.connect(deployer).delistToken(ecbtcAddr)).wait();

      const bond = await otc.ethBondSize();
      await expect(otc.connect(bob).fillOrder(id, ...(await enc(bobClient, 400n, otc)), { value: bond }))
        .to.be.revertedWithCustomError(otc, "TokenNotWhitelisted")
        .withArgs(ecbtcAddr);
    });

    it("blocks fills when the requested leg is delisted", async () => {
      const { deployer, bob, otc, bobClient, cusdAddr, id } = await withOrder();
      await (await otc.connect(deployer).delistToken(cusdAddr)).wait();

      // Either direction moves the delisted token to a new holder for value,
      // so both legs gate — not just the one sitting in escrow.
      const bond = await otc.ethBondSize();
      await expect(otc.connect(bob).fillOrder(id, ...(await enc(bobClient, 400n, otc)), { value: bond }))
        .to.be.revertedWithCustomError(otc, "TokenNotWhitelisted")
        .withArgs(cusdAddr);
    });

    it("blocks top-ups, so a delisted order cannot grow", async () => {
      const { deployer, alice, otc, aliceClient, ecbtcAddr, id } = await withOrder();
      await (await otc.connect(deployer).delistToken(ecbtcAddr)).wait();

      await expect(otc.connect(alice).topUpOrder(id, ...(await enc(aliceClient, 500n, otc))))
        .to.be.revertedWithCustomError(otc, "TokenNotWhitelisted")
        .withArgs(ecbtcAddr);
    });

    it("still lets the maker cancel and recover escrow", async () => {
      const { deployer, alice, otc, ecbtcAddr, id } = await withOrder();
      await (await otc.connect(deployer).delistToken(ecbtcAddr)).wait();

      await (await otc.connect(alice).cancelOrder(id)).wait();
      const view = await otc.getOrder(id);
      expect(view.closed).to.equal(true);
      expect(view.active).to.equal(false);
    });

    it("still lets a taker publish and recover a bond posted before the delist", async () => {
      const { deployer, bob, otc, bobClient, otcAddr, ecbtcAddr, id } = await withOrder();
      const bond = await otc.ethBondSize();

      // Bond is posted while the token is still tradable, then the token is
      // delisted underneath it. Gating publishBracket here would strand the ETH.
      const seq = await fill(otc, bob, bobClient, id, 400n);
      expect(await ethers.provider.getBalance(otcAddr)).to.equal(bond);

      await (await otc.connect(deployer).delistToken(ecbtcAddr)).wait();

      await publish(otc, bob, bobClient, id, seq);
      expect(await ethers.provider.getBalance(otcAddr)).to.equal(0n);
      expect((await otc.getPublish(id, seq)).settled).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // pause — the contract-scoped twin of delistToken
  // ─────────────────────────────────────────────────────────────────────────

  describe("pause", () => {
    /// Active ecBTC → cUSD order, ready for the contract to be paused under it.
    async function withOrder() {
      const ctx = await setup();
      const { alice, bob, ecbtc, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = ctx;

      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await (await cusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await cusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );
      return { ...ctx, id };
    }

    it("only the owner can pause or unpause", async () => {
      const { deployer, alice, otc } = await setup();

      await expect(otc.connect(alice).pause()).to.be.revertedWithCustomError(otc, "OwnableUnauthorizedAccount");
      await (await otc.connect(deployer).pause()).wait();
      await expect(otc.connect(alice).unpause()).to.be.revertedWithCustomError(otc, "OwnableUnauthorizedAccount");
      expect(await otc.paused()).to.equal(true);
    });

    it("blocks new orders while paused", async () => {
      const { deployer, alice, ecbtc, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await (await otc.connect(deployer).pause()).wait();

      await expect(
        otc.connect(alice).createOrder(ecbtcAddr, cusdAddr, PRICE_BTC_CUSD, 0n, ...(await enc(aliceClient, mBTC, otc))),
      ).to.be.revertedWithCustomError(otc, "EnforcedPause");
    });

    it("blocks fills while paused, on a pair whose legs are both still whitelisted", async () => {
      const { deployer, bob, otc, bobClient, id } = await withOrder();
      await (await otc.connect(deployer).pause()).wait();

      // Nothing is delisted here — the halt is contract-scoped, which is the
      // whole point of having pause alongside delistToken.
      const bond = await otc.ethBondSize();
      await expect(
        otc.connect(bob).fillOrder(id, ...(await enc(bobClient, 400n, otc)), { value: bond }),
      ).to.be.revertedWithCustomError(otc, "EnforcedPause");
    });

    it("blocks top-ups while paused", async () => {
      const { deployer, alice, otc, aliceClient, id } = await withOrder();
      await (await otc.connect(deployer).pause()).wait();

      await expect(
        otc.connect(alice).topUpOrder(id, ...(await enc(aliceClient, 500n, otc))),
      ).to.be.revertedWithCustomError(otc, "EnforcedPause");
    });

    it("still lets the maker cancel and recover escrow", async () => {
      const { deployer, alice, otc, id } = await withOrder();
      await (await otc.connect(deployer).pause()).wait();

      await (await otc.connect(alice).cancelOrder(id)).wait();
      const view = await otc.getOrder(id);
      expect(view.closed).to.equal(true);
      expect(view.active).to.equal(false);
    });

    it("still lets a taker publish and recover a bond posted before the pause", async () => {
      const { deployer, bob, otc, bobClient, otcAddr, id } = await withOrder();
      const bond = await otc.ethBondSize();

      // Bond posted while trading is open, then the contract is paused under
      // it. Gating publishBracket here would strand the ETH for the length of
      // the pause — which, for a migration, is indefinite.
      const seq = await fill(otc, bob, bobClient, id, 400n);
      expect(await ethers.provider.getBalance(otcAddr)).to.equal(bond);

      await (await otc.connect(deployer).pause()).wait();

      await publish(otc, bob, bobClient, id, seq);
      expect(await ethers.provider.getBalance(otcAddr)).to.equal(0n);
      expect((await otc.getPublish(id, seq)).settled).to.equal(true);
    });

    it("still lets a pending order activate while paused", async () => {
      const { deployer, alice, ecbtc, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);

      // Created (escrow already moved) but not yet activated when the pause
      // lands. activateOrder is a publish, not an entry — it must stay open so
      // the order reaches a state the maker can reason about and cancel from.
      const id = await createOrder(
        otc,
        alice,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );
      await (await otc.connect(deployer).pause()).wait();

      await activate(otc, alice, aliceClient, id);
      expect((await otc.getOrder(id)).active).to.equal(true);
    });

    it("restores trading on unpause", async () => {
      const { deployer, bob, otc, bobClient, id } = await withOrder();
      await (await otc.connect(deployer).pause()).wait();
      await (await otc.connect(deployer).unpause()).wait();
      expect(await otc.paused()).to.equal(false);

      expect(await fillAndPublish(otc, bob, bobClient, id, 400n)).to.equal(NANO);
    });

    it("unpausing does not re-list a token delisted while paused", async () => {
      const { deployer, bob, otc, bobClient, ecbtcAddr, id } = await withOrder();
      await (await otc.connect(deployer).pause()).wait();
      await (await otc.connect(deployer).delistToken(ecbtcAddr)).wait();
      await (await otc.connect(deployer).unpause()).wait();

      // The two levers are independent: lifting the contract-scoped halt must
      // not lift the asset-scoped one.
      const bond = await otc.ethBondSize();
      await expect(otc.connect(bob).fillOrder(id, ...(await enc(bobClient, 400n, otc)), { value: bond }))
        .to.be.revertedWithCustomError(otc, "TokenNotWhitelisted")
        .withArgs(ecbtcAddr);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // fill bond, window, bounty
  // ─────────────────────────────────────────────────────────────────────────

  describe("fill bond / publishBracket window", () => {
    async function withFilledOrder() {
      const ctx = await setup();
      const { alice, bob, ecbtc, cusd, otc, aliceClient, bobClient, otcAddr, cusdAddr, ecbtcAddr } = ctx;
      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await (await cusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await cusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, 2n * mBTC, otc)), // 2 mBTC so it can take multiple partial fills
      );
      const seq = await fill(otc, bob, bobClient, id, 400n);
      return { ...ctx, id, seq };
    }

    it("holds the bond on fill and refunds it in full when the depositor publishes in-window", async () => {
      const { bob, otc, bobClient, otcAddr, id, seq } = await withFilledOrder();
      const bond = await otc.ethBondSize();

      expect(await ethers.provider.getBalance(otcAddr)).to.equal(bond); // held
      let rec = await otc.getPublish(id, seq);
      expect(rec.bondWei).to.equal(bond);
      expect(rec.settled).to.equal(false);

      await publish(otc, bob, bobClient, id, seq);

      expect(await ethers.provider.getBalance(otcAddr)).to.equal(0n); // refunded
      rec = await otc.getPublish(id, seq);
      expect(rec.settled).to.equal(true);
    });

    it("rejects a non-depositor publish inside the window", async () => {
      const { deployer, otc, aliceClient, id, seq } = await withFilledOrder();
      const rec = await otc.getPublish(id, seq);
      const dec = await proof(aliceClient, rec.handle);
      await expect(
        otc.connect(deployer).publishBracket(id, seq, dec.decryptedValue, dec.signature),
      ).to.be.revertedWithCustomError(otc, "NotInWindow");
    });

    it("after the window anyone may publish; bounty to publisher, remainder to depositor", async () => {
      const { deployer, bob, otc, aliceClient, id, seq } = await withFilledOrder();
      const bond = await otc.ethBondSize();
      const refund = bond - (bond * (await otc.bountyBps())) / 10_000n;

      // Jump past the 10-minute window.
      await hre.network.provider.send("evm_increaseTime", [601]);
      await hre.network.provider.send("evm_mine");

      const rec = await otc.getPublish(id, seq);
      const dec = await proof(aliceClient, rec.handle); // anyone can decrypt the public handle

      // Depositor (bob) is refunded 80% passively; he is not the sender.
      await expect(
        otc.connect(deployer).publishBracket(id, seq, dec.decryptedValue, dec.signature),
      ).to.changeEtherBalance(bob, refund);

      expect((await otc.getPublish(id, seq)).settled).to.equal(true);
    });

    it("lets the depositor publish an absorbed record to settle and recover the full bond", async () => {
      const { bob, otc, bobClient, otcAddr, id, seq } = await withFilledOrder();
      const bond = await otc.ethBondSize();

      // A second fill creates a newer frontier record.
      const seq2 = await fill(otc, bob, bobClient, id, 400n);
      expect(seq2).to.equal(seq + 1n);
      expect(await ethers.provider.getBalance(otcAddr)).to.equal(2n * bond);

      // Publishing the frontier advances publishedSeq past the first record.
      await publish(otc, bob, bobClient, id, seq2);
      expect((await otc.getOrder(id)).publishedSeq).to.equal(seq2);
      expect(await ethers.provider.getBalance(otcAddr)).to.equal(bond);

      // The first record is now absorbed. The depositor publishes it within
      // its window to settle and recover the full bond — the proof is moot
      // (it never advances the canonical bracket) but the bond comes back.
      const rec = await otc.getPublish(id, seq);
      const dec = await proof(bobClient, rec.handle);
      await expect(otc.connect(bob).publishBracket(id, seq, dec.decryptedValue, dec.signature)).to.changeEtherBalance(
        bob,
        bond,
      );
      expect((await otc.getOrder(id)).publishedSeq).to.equal(seq2);
      expect(await ethers.provider.getBalance(otcAddr)).to.equal(0n);
      expect((await otc.getPublish(id, seq)).settled).to.equal(true);
    });

    it("pays no bounty for a post-window publish of a non-frontier (absorbed) record", async () => {
      const { deployer, bob, otc, bobClient, otcAddr, id, seq } = await withFilledOrder();
      const bond = await otc.ethBondSize();

      // A second fill supersedes the first; publishing it absorbs seq.
      const seq2 = await fill(otc, bob, bobClient, id, 400n);
      await publish(otc, bob, bobClient, id, seq2);
      expect((await otc.getOrder(id)).publishedSeq).to.equal(seq2);
      expect(await ethers.provider.getBalance(otcAddr)).to.equal(bond);

      // Jump past the first record's window so anyone may publish it.
      await hre.network.provider.send("evm_increaseTime", [601]);
      await hre.network.provider.send("evm_mine");

      // A keeper publishes the absorbed record. Because it is not the live
      // frontier, the bounty is suppressed: the depositor is refunded in
      // full and the keeper earns nothing (beyond gas).
      const rec = await otc.getPublish(id, seq);
      const dec = await proof(bobClient, rec.handle);
      await expect(
        otc.connect(deployer).publishBracket(id, seq, dec.decryptedValue, dec.signature),
      ).to.changeEtherBalances([bob, deployer], [bond, 0n], { includeFee: false });
      expect(await ethers.provider.getBalance(otcAddr)).to.equal(0n);
    });

    it("settles on the bounty rate stamped at fill time, not the live one", async () => {
      const { deployer, bob, otc, bobClient, id, seq } = await withFilledOrder();
      const bond = await otc.ethBondSize();
      const bounty = (bond * 2_000n) / 10_000n;

      // The rate in force at fill time is recorded on the bond itself.
      expect((await otc.getPublish(id, seq)).bountyBps_).to.equal(2_000n);

      // Owner raises the bounty to 100% while the bond is outstanding, then
      // publishes it themselves — the seizure the live read would have allowed.
      await (await otc.connect(deployer).setParams(5_000_000n, 0n, 10_000n, 600n)).wait();
      expect(await otc.bountyBps()).to.equal(10_000n);

      await hre.network.provider.send("evm_increaseTime", [601]);
      await hre.network.provider.send("evm_mine");

      // The stamped 20% still governs: the depositor keeps the other 80%.
      const rec = await otc.getPublish(id, seq);
      const dec = await proof(bobClient, rec.handle);
      await expect(
        otc.connect(deployer).publishBracket(id, seq, dec.decryptedValue, dec.signature),
      ).to.changeEtherBalances([bob, deployer], [bond - bounty, bounty], { includeFee: false });
    });

    it("cannot strand an in-flight keeper publish by zeroing the bounty", async () => {
      const { deployer, bob, otc, bobClient, id, seq } = await withFilledOrder();
      const bond = await otc.ethBondSize();
      const bounty = (bond * 2_000n) / 10_000n;

      await hre.network.provider.send("evm_increaseTime", [601]);
      await hre.network.provider.send("evm_mine");

      // Owner zeroes the bounty after the keeper has committed to publishing.
      await (await otc.connect(deployer).setParams(5_000_000n, 0n, 0n, 600n)).wait();
      expect(await otc.bountyBps()).to.equal(0n);

      // The keeper is still paid the rate the record was posted under.
      const rec = await otc.getPublish(id, seq);
      const dec = await proof(bobClient, rec.handle);
      await expect(
        otc.connect(deployer).publishBracket(id, seq, dec.decryptedValue, dec.signature),
      ).to.changeEtherBalances([bob, deployer], [bond - bounty, bounty], { includeFee: false });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // publishBrackets (batch)
  // ─────────────────────────────────────────────────────────────────────────

  describe("publishBrackets", () => {
    /// Alice posts two 1 mBTC orders; Bob fills 400 raw of each, leaving two
    /// unsettled fill records (one per order).
    async function withTwoFills() {
      const ctx = await setup();
      const { alice, bob, ecbtc, cusd, otc, aliceClient, bobClient, otcAddr, cusdAddr, ecbtcAddr } = ctx;
      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await (await cusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await cusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();
      const ids: bigint[] = [];
      const seqs: bigint[] = [];
      for (let i = 0; i < 2; i++) {
        const id = await createAndActivate(
          otc,
          alice,
          aliceClient,
          ecbtcAddr,
          cusdAddr,
          PRICE_BTC_CUSD,
          0n,
          ...(await enc(aliceClient, mBTC, otc)),
        );
        ids.push(id);
        seqs.push(await fill(otc, bob, bobClient, id, 400n));
      }
      return { ...ctx, ids, seqs };
    }

    it("settles fill records on several orders in one tx, refunding every bond", async () => {
      const { bob, otc, bobClient, otcAddr, ids, seqs } = await withTwoFills();
      const bond = await otc.ethBondSize();
      expect(await ethers.provider.getBalance(otcAddr)).to.equal(2n * bond);

      const { args, values } = await publishInputs(otc, bobClient, [
        [ids[0], seqs[0]],
        [ids[1], seqs[1]],
      ]);
      await expect(otc.connect(bob).publishBrackets(...args)).to.changeEtherBalance(bob, 2n * bond, {
        includeFee: false,
      });

      expect(await ethers.provider.getBalance(otcAddr)).to.equal(0n);
      for (let i = 0; i < 2; i++) {
        expect((await otc.getPublish(ids[i], seqs[i])).settled).to.equal(true);
        const order = await otc.getOrder(ids[i]);
        expect(order.publishedSeq).to.equal(seqs[i]);
        expect(order.bracket).to.equal(values[i]);
      }
    });

    it("is all-or-nothing: one already-settled entry reverts the whole batch", async () => {
      const { bob, otc, bobClient, ids, seqs } = await withTwoFills();

      // Settle the first record on its own, then include it again.
      await publish(otc, bob, bobClient, ids[0], seqs[0]);
      const { args } = await publishInputs(otc, bobClient, [
        [ids[0], seqs[0]],
        [ids[1], seqs[1]],
      ]);
      await expect(otc.connect(bob).publishBrackets(...args)).to.be.revertedWithCustomError(otc, "AlreadySettled");

      // The other record is untouched by the failed batch.
      expect((await otc.getPublish(ids[1], seqs[1])).settled).to.equal(false);
    });

    it("enforces the window per entry: a non-depositor batch reverts in-window", async () => {
      const { deployer, otc, aliceClient, ids, seqs } = await withTwoFills();
      const { args } = await publishInputs(otc, aliceClient, [
        [ids[0], seqs[0]],
        [ids[1], seqs[1]],
      ]);
      await expect(otc.connect(deployer).publishBrackets(...args)).to.be.revertedWithCustomError(otc, "NotInWindow");
    });

    it("rejects mismatched array lengths", async () => {
      const { bob, otc, bobClient, ids, seqs } = await withTwoFills();
      const { args } = await publishInputs(otc, bobClient, [[ids[0], seqs[0]]]);
      const [oIds, oSeqs, oValues, oSigs] = args;
      await expect(
        otc.connect(bob).publishBrackets([...oIds, ids[1]], oSeqs, oValues, oSigs),
      ).to.be.revertedWithCustomError(otc, "LengthMismatch");
      await expect(otc.connect(bob).publishBrackets(oIds, oSeqs, oValues, [])).to.be.revertedWithCustomError(
        otc,
        "LengthMismatch",
      );
    });

    it("handles several seqs of one order in any entry order; the frontier wins", async () => {
      const { bob, otc, bobClient, otcAddr, ids, seqs } = await withTwoFills();
      const bond = await otc.ethBondSize();

      // Second fill on the first order creates a newer frontier record.
      const seq2 = await fill(otc, bob, bobClient, ids[0], 400n);
      expect(seq2).to.equal(seqs[0] + 1n);

      // Publish the frontier first, then the older (now absorbed) record.
      const { args, values } = await publishInputs(otc, bobClient, [
        [ids[0], seq2],
        [ids[0], seqs[0]],
      ]);
      await expect(otc.connect(bob).publishBrackets(...args)).to.changeEtherBalance(bob, 2n * bond, {
        includeFee: false,
      });

      const order = await otc.getOrder(ids[0]);
      expect(order.publishedSeq).to.equal(seq2);
      expect(order.bracket).to.equal(values[0]);
      expect((await otc.getPublish(ids[0], seqs[0])).settled).to.equal(true);
      expect((await otc.getPublish(ids[0], seq2)).settled).to.equal(true);
      expect(await ethers.provider.getBalance(otcAddr)).to.equal(bond); // second order's bond still held
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // publish history — per-record kind / amount / paid
  // ─────────────────────────────────────────────────────────────────────────

  describe("publish history", () => {
    // PublishKind (uint8 enum → bigint over the wire).
    const CREATE = 0n;
    const FILL = 1n;
    const TOP_UP = 2n;

    /// Maker alice posts 1 mBTC ($65, NANO) @ PRICE_BTC_CUSD; bob holds `takerCusd`.
    async function withOrder(takerCusd = 1_000n * ONE) {
      const ctx = await setup();
      const { alice, bob, ecbtc, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = ctx;
      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await (await cusd.mint(bob.address, takerCusd)).wait();
      await (await cusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );
      return { ...ctx, id };
    }

    async function expectAllowed(handle: string, who: string, allowed: boolean) {
      const acl = await hre.cofhe.mocks.getMockACL();
      expect(await acl.isAllowed.staticCall(BigInt(handle), who)).to.equal(allowed);
    }

    /// Maker records carry the shared `_E_ZERO64`, which anyone may decrypt.
    async function expectPublicZero(handle: string) {
      const acl = await hre.cofhe.mocks.getMockACL();
      await hre.cofhe.mocks.expectPlaintext(handle, 0n);
      expect(await acl.globalAllowed(BigInt(handle))).to.equal(true);
    }

    it("stamps the create record with the deposit and a public zero paid", async () => {
      const { alice, bob, otc, id } = await withOrder();

      const rec = await otc.getPublish(id, 1n);
      expect(rec.kind).to.equal(CREATE);
      expect(rec.depositor).to.equal(alice.address);
      await hre.cofhe.mocks.expectPlaintext(rec.amount, mBTC);
      expect(rec.amount).to.equal((await otc.getOrder(id)).depositedHandle); // same handle as the deposit
      await expectPublicZero(rec.paid);

      await expectAllowed(rec.amount, alice.address, true);
      await expectAllowed(rec.amount, bob.address, false);
    });

    it("stamps a top-up record with its own delta, not the grown remaining, readable by the maker", async () => {
      const { alice, bob, otc, aliceClient, id } = await withOrder();

      await (await otc.connect(alice).topUpOrder(id, ...(await enc(aliceClient, 3n * mBTC, otc)))).wait();
      const order = await otc.getOrder(id);
      expect(order.latestSeq).to.equal(2n);
      await hre.cofhe.mocks.expectPlaintext(order.remainingHandle, 4n * mBTC);

      const rec = await otc.getPublish(id, order.latestSeq);
      expect(rec.kind).to.equal(TOP_UP);
      expect(rec.depositor).to.equal(alice.address);
      expect(rec.bondWei).to.equal(0n);
      await hre.cofhe.mocks.expectPlaintext(rec.amount, 3n * mBTC);
      await expectPublicZero(rec.paid);

      await expectAllowed(rec.amount, alice.address, true);
      await expectAllowed(rec.amount, bob.address, false);
    });

    it("stamps a fill record with delivered input and paid output, readable by maker and taker only", async () => {
      const { deployer, alice, bob, otc, bobClient, id } = await withOrder();

      const seq = await fill(otc, bob, bobClient, id, 400n);
      const rec = await otc.getPublish(id, seq);
      expect(rec.kind).to.equal(FILL);
      expect(rec.depositor).to.equal(bob.address);
      await hre.cofhe.mocks.expectPlaintext(rec.amount, 400n);
      await hre.cofhe.mocks.expectPlaintext(rec.paid, FILL_400RAW_CUSD);

      for (const handle of [rec.amount, rec.paid]) {
        await expectAllowed(handle, alice.address, true);
        await expectAllowed(handle, bob.address, true);
        await expectAllowed(handle, deployer.address, false);
      }
    });

    it("records the capped size and its cost when the taker over-requests", async () => {
      const { bob, otc, bobClient, id } = await withOrder();

      const seq = await fill(otc, bob, bobClient, id, 10n * mBTC); // only 1 mBTC remains
      const rec = await otc.getPublish(id, seq);
      await hre.cofhe.mocks.expectPlaintext(rec.amount, mBTC);
      await hre.cofhe.mocks.expectPlaintext(rec.paid, FILL_1MBTC_CUSD);
    });

    it("records zero amount and zero paid on an underpaid fill, still private to the parties", async () => {
      const { deployer, alice, bob, otc, bobClient, id } = await withOrder(30n * ONE); // $30 < $65 cost
      const acl = await hre.cofhe.mocks.getMockACL();

      const seq = await fill(otc, bob, bobClient, id, mBTC);
      const rec = await otc.getPublish(id, seq);
      expect(rec.kind).to.equal(FILL);
      await hre.cofhe.mocks.expectPlaintext(rec.amount, 0n);
      await hre.cofhe.mocks.expectPlaintext(rec.paid, 0n);

      // A real transfer result, not the shared public zero.
      expect(await acl.globalAllowed(BigInt(rec.paid))).to.equal(false);
      await expectAllowed(rec.paid, alice.address, true);
      await expectAllowed(rec.paid, bob.address, true);
      await expectAllowed(rec.paid, deployer.address, false);
    });

    it("reads an order's full history off seq 1..latestSeq", async () => {
      const { alice, bob, otc, aliceClient, bobClient, id } = await withOrder();

      await fill(otc, bob, bobClient, id, 400n);
      await (await otc.connect(alice).topUpOrder(id, ...(await enc(aliceClient, mBTC, otc)))).wait();
      await fill(otc, bob, bobClient, id, 200n);

      const expected = [
        { kind: CREATE, depositor: alice.address, amount: mBTC, paid: 0n },
        { kind: FILL, depositor: bob.address, amount: 400n, paid: FILL_400RAW_CUSD },
        { kind: TOP_UP, depositor: alice.address, amount: mBTC, paid: 0n },
        { kind: FILL, depositor: bob.address, amount: 200n, paid: FILL_200RAW_CUSD },
      ];
      const latest = (await otc.getOrder(id)).latestSeq;
      expect(latest).to.equal(BigInt(expected.length));

      for (let seq = 1n; seq <= latest; seq++) {
        const rec = await otc.getPublish(id, seq);
        const want = expected[Number(seq - 1n)];
        expect(rec.kind).to.equal(want.kind);
        expect(rec.depositor).to.equal(want.depositor);
        await hre.cofhe.mocks.expectPlaintext(rec.amount, want.amount);
        await hre.cofhe.mocks.expectPlaintext(rec.paid, want.paid);
      }
    });

    it("publishing a record settles it without touching kind, amount or paid", async () => {
      const { bob, otc, bobClient, id } = await withOrder();

      const seq = await fill(otc, bob, bobClient, id, 400n);
      const before = await otc.getPublish(id, seq);
      await publish(otc, bob, bobClient, id, seq);
      const after = await otc.getPublish(id, seq);

      expect(after.settled).to.equal(true);
      expect([after.kind, after.amount, after.paid]).to.deep.equal([before.kind, before.amount, before.paid]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // cANY<>cANY
  // ─────────────────────────────────────────────────────────────────────────

  describe("cANY<>cANY", () => {
    /// Alice sells 1 mBTC for ecETH at PRICE_BTC_ETH ($65 → NANO).
    async function withCanyOrder() {
      const ctx = await setup();
      const { alice, bob, ecbtc, eceth, cusd, otc, aliceClient, otcAddr, ecbtcAddr, ecethAddr } = ctx;

      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await (await eceth.mint(bob.address, ONE)).wait();
      await (await eceth.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        ecethAddr,
        PRICE_BTC_ETH,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );
      return { ...ctx, id };
    }

    // The oracle price is per WHOLE token, so `raw × price >> 20` is only in 6-decimal cUSD
    // units when the input token has 6 decimals. A 4-decimal token must be rescaled by
    // 10^(6 − 4): 0.2 ec4 at $65,000 is $13,000 (LARGE). Unscaled it reads as $130 (SMALL).
    it("brackets a 4-decimal input token at its true USD notional (LARGE, not SMALL)", async () => {
      const { deployer, alice, cusd, otc, aliceClient, otcAddr, ecethAddr } = await setup();
      const ec4 = (await ethers.deployContract("FHERC20_Harness", [
        "Four",
        "EC4",
        4,
        "",
      ])) as unknown as ConfidentialToken;
      await ec4.waitForDeployment();
      const ec4Addr = await ec4.getAddress();
      await (await otc.connect(deployer).whitelistToken(ec4Addr, ORACLE_ECBTC)).wait(); // $65,000 per whole ec4

      await fundMaker(alice, ec4, 10_000n, cusd, 0n, otcAddr); // 1 whole ec4 at 4 decimals
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ec4Addr,
        ecethAddr,
        PRICE_BTC_ETH,
        0n,
        ...(await enc(aliceClient, 2_000n, otc)), // 0.2 ec4
      );
      expect((await otc.getOrder(id)).bracket).to.equal(LARGE); // 2_000 × $65,000 × 10^(6−4) >> 20 = $13,000
    });

    it("creates a cANY<>cANY order; bracket uses oracle price for inputToken", async () => {
      const { otc, ecbtcAddr, ecethAddr, id } = await withCanyOrder();

      const order = await otc.getOrder(id);
      expect(order.active).to.equal(true);
      expect(order.inputToken).to.equal(ecbtcAddr);
      expect(order.outputToken).to.equal(ecethAddr);
      expect(order.bracket).to.equal(NANO); // 1_000 × $65,000 >> 20 = $65 → NANO
    });

    it("fully fills a cANY<>cANY order: taker pays ecETH, receives ecBTC", async () => {
      const { alice, bob, ecbtc, eceth, otc, bobClient, otcAddr, id } = await withCanyOrder();

      const value = await fillAndPublish(otc, bob, bobClient, id, mBTC); // cost 18_571 raw ecETH

      await expectBalance(ecbtc, bob.address, mBTC);
      await expectBalance(ecbtc, otcAddr, 0n);
      await expectBalance(eceth, bob.address, ONE - FILL_1MBTC_ETH);
      await expectBalance(eceth, alice.address, FILL_1MBTC_ETH);
      expect(value).to.equal(EMPTY);
      expect((await otc.getOrder(id)).bracket).to.equal(EMPTY);
    });

    it("partially fills cANY<>cANY and recomputes bracket via oracle", async () => {
      const { bob, ecbtc, eceth, otc, bobClient, otcAddr, id } = await withCanyOrder();

      const value = await fillAndPublish(otc, bob, bobClient, id, 400n); // cost 7_428 raw ecETH

      await expectBalance(ecbtc, bob.address, 400n);
      await expectBalance(ecbtc, otcAddr, 600n);
      await expectBalance(eceth, bob.address, ONE - FILL_400RAW_ETH);

      const order = await otc.getOrder(id);
      expect(order.active).to.equal(true);
      expect(value).to.equal(NANO); // 600 raw × $65,000 = $39 → NANO
    });

    it("cANY<>cANY cancel returns ecBTC escrow to maker and delists", async () => {
      const { alice, ecbtc, otc, otcAddr, ecbtcAddr, ecethAddr, id } = await withCanyOrder();

      await expectBalance(ecbtc, otcAddr, mBTC);
      await (await otc.connect(alice).cancelOrder(id)).wait();

      await expectBalance(ecbtc, alice.address, ONE); // started with exactly ONE ecBTC
      await expectBalance(ecbtc, otcAddr, 0n);

      const order = await otc.getOrder(id);
      expect(order.closed).to.equal(true);
      expect(order.bracket).to.equal(EMPTY);
      expect((await otc.getOrdersByPair(ecbtcAddr, ecethAddr)).length).to.equal(0);
    });

    it("oracle price drop changes bracket on next fill (SMALL → NANO)", async () => {
      const { deployer, alice, bob, ecbtc, eceth, cusd, otc, aliceClient, bobClient, otcAddr, ecbtcAddr, ecethAddr } =
        await setup();

      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await (await eceth.mint(bob.address, 100_000n)).wait();
      await (await eceth.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

      // 2 mBTC = $130 at oracle → SMALL
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        ecethAddr,
        PRICE_BTC_ETH,
        0n,
        ...(await enc(aliceClient, 2n * mBTC, otc)),
      );
      expect((await otc.getOrder(id)).bracket).to.equal(SMALL);

      // Crash: oracle drops from $65,000 to $1,000 per BTC.
      await (await otc.connect(deployer).updateOraclePrices([ecbtcAddr], [1_000n * Q])).wait();

      // Fill 500 raw; remaining 1_500 raw × $1,000 = $1.50 → NANO
      const value = await fillAndPublish(otc, bob, bobClient, id, 500n);
      expect(value).to.equal(NANO);
      expect((await otc.getOrder(id)).bracket).to.equal(NANO);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // topUpOrder
  // ─────────────────────────────────────────────────────────────────────────

  describe("topUpOrder", () => {
    /// Alice posts 1 mBTC ($65, NANO) and has 1 BTC total. Bob has 1,000 cUSD.
    async function withOrder() {
      const ctx = await setup();
      const { alice, bob, ecbtc, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = ctx;
      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await (await cusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await cusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );
      return { ...ctx, id };
    }

    /// topUp (tx1) → publish the new bracket (maker, bondless).
    async function topUpAndPublish(
      otc: ConfidentialOTC,
      maker: HardhatEthersSigner,
      makerClient: CofheClient,
      id: bigint,
      amount: bigint,
    ): Promise<bigint> {
      await (await otc.connect(maker).topUpOrder(id, ...(await enc(makerClient, amount, otc)))).wait();
      const seq = (await otc.getOrder(id)).latestSeq;
      return publish(otc, maker, makerClient, id, seq);
    }

    it("increases escrow; bracket upgrades NANO → SMALL after publish", async () => {
      const { alice, ecbtc, otc, aliceClient, otcAddr, id } = await withOrder();

      await expectBalance(ecbtc, otcAddr, mBTC);

      const value = await topUpAndPublish(otc, alice, aliceClient, id, mBTC);

      await expectBalance(ecbtc, otcAddr, 2n * mBTC);
      await expectBalance(ecbtc, alice.address, ONE - 2n * mBTC);
      expect(value).to.equal(SMALL); // 2 mBTC × $65,000 = $130 → SMALL
      expect((await otc.getOrder(id)).bracket).to.equal(SMALL);
    });

    it("topped-up order can be fully filled at the new size", async () => {
      const { alice, bob, ecbtc, cusd, otc, aliceClient, bobClient, otcAddr, id } = await withOrder();

      await topUpAndPublish(otc, alice, aliceClient, id, mBTC);

      const value = await fillAndPublish(otc, bob, bobClient, id, 2n * mBTC); // cost $130

      await expectBalance(ecbtc, bob.address, 2n * mBTC);
      await expectBalance(ecbtc, otcAddr, 0n);
      await expectBalance(cusd, bob.address, 1_000n * ONE - 2n * FILL_1MBTC_CUSD);
      expect(value).to.equal(EMPTY);
    });

    it("resurrects a depleted/dormant order (EMPTY → NANO) and re-lists it", async () => {
      const { alice, bob, ecbtc, otc, aliceClient, bobClient, otcAddr, cusdAddr, ecbtcAddr, id } = await withOrder();

      // Deplete fully and publish EMPTY → order becomes dormant (delisted).
      await fillAndPublish(otc, bob, bobClient, id, mBTC);
      expect((await otc.getOrder(id)).active).to.equal(false);
      expect((await otc.getOrdersByPair(ecbtcAddr, cusdAddr)).length).to.equal(0);

      // Top up + publish re-lists it (frontier non-EMPTY).
      const value = await topUpAndPublish(otc, alice, aliceClient, id, mBTC);
      await expectBalance(ecbtc, otcAddr, mBTC);
      expect(value).to.equal(NANO);
      const order = await otc.getOrder(id);
      expect(order.active).to.equal(true);
      expect((await otc.getOrdersByPair(ecbtcAddr, cusdAddr)).map(x => x)).to.deep.equal([id]);
    });

    it("only the maker can top up, and not on a closed order", async () => {
      const { alice, bob, ecbtc, cusd, otc, aliceClient, bobClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();

      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );
      await expect(otc.connect(bob).topUpOrder(id, ...(await enc(bobClient, mBTC, otc)))).to.be.revertedWithCustomError(
        otc,
        "NotMaker",
      );

      // Cancelled (closed) order rejected.
      await (await otc.connect(alice).cancelOrder(id)).wait();
      await expect(
        otc.connect(alice).topUpOrder(id, ...(await enc(aliceClient, mBTC, otc))),
      ).to.be.revertedWithCustomError(otc, "OrderClosed");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // cancelOrder
  // ─────────────────────────────────────────────────────────────────────────

  describe("cancelOrder", () => {
    async function withOrder() {
      const ctx = await setup();
      const { alice, ecbtc, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = ctx;
      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );
      return { ...ctx, id };
    }

    it("returns the escrow, marks EMPTY + closed, and de-lists", async () => {
      const { alice, ecbtc, otc, otcAddr, cusdAddr, ecbtcAddr, id } = await withOrder();

      await (await otc.connect(alice).cancelOrder(id)).wait();

      await expectBalance(ecbtc, alice.address, ONE); // returned in full
      await expectBalance(ecbtc, otcAddr, 0n);

      const order = await otc.getOrder(id);
      expect(order.active).to.equal(false);
      expect(order.closed).to.equal(true);
      expect(order.bracket).to.equal(EMPTY);
      expect((await otc.getOrdersByPair(ecbtcAddr, cusdAddr)).length).to.equal(0);
    });

    it("returns the maker bond when one was posted", async () => {
      const { deployer, alice, ecbtc, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();
      // Turn the maker bond on ($5).
      await (await otc.connect(deployer).setParams(5_000_000n, 5_000_000n, 2_000n, 600n)).wait();
      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);

      const makerBond = await otc.makerBondSize();
      const id = await otc.nextOrderId();
      await (
        await otc
          .connect(alice)
          .createOrder(ecbtcAddr, cusdAddr, PRICE_BTC_CUSD, 0n, ...(await enc(aliceClient, mBTC, otc)), {
            value: makerBond,
          })
      ).wait();
      await activate(otc, alice, aliceClient, id);

      expect(await ethers.provider.getBalance(otcAddr)).to.equal(makerBond);
      await expect(otc.connect(alice).cancelOrder(id)).to.changeEtherBalance(alice, makerBond);
      expect(await ethers.provider.getBalance(otcAddr)).to.equal(0n);
    });

    it("createOrder reverts when the maker bond is underfunded", async () => {
      const { deployer, alice, ecbtc, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();
      await (await otc.connect(deployer).setParams(5_000_000n, 5_000_000n, 2_000n, 600n)).wait();
      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await expect(
        otc.connect(alice).createOrder(
          ecbtcAddr,
          cusdAddr,
          PRICE_BTC_CUSD,
          0n,
          ...(await enc(aliceClient, mBTC, otc)), // no value
        ),
      ).to.be.revertedWithCustomError(otc, "WrongBond");
    });

    it("only the maker can cancel an unexpired order; cannot cancel twice", async () => {
      const { alice, bob, otc, id } = await withOrder(); // good-til-cancelled
      await expect(otc.connect(bob).cancelOrder(id)).to.be.revertedWithCustomError(otc, "NotExpired");
      await (await otc.connect(alice).cancelOrder(id)).wait();
      await expect(otc.connect(alice).cancelOrder(id)).to.be.revertedWithCustomError(otc, "OrderClosed");
    });

    it("anyone may retire an expired order, and the escrow still returns to the maker", async () => {
      const { alice, bob, ecbtc, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);

      const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        now + 1_000n,
        ...(await enc(aliceClient, mBTC, otc)),
      );

      // Before expiry the order is maker-only, as always.
      await expect(otc.connect(bob).cancelOrder(id)).to.be.revertedWithCustomError(otc, "NotExpired");

      await hre.network.provider.send("evm_increaseTime", [2_000]);
      await hre.network.provider.send("evm_mine");

      // bob is unrelated to the order. He can retire it, but the escrow is
      // hardcoded to o.maker — alice gets every unit back and the OTC is left
      // empty, so nothing reached the caller.
      await expect(otc.connect(bob).cancelOrder(id)).to.emit(otc, "OrderCancelled");
      await expectBalance(ecbtc, alice.address, ONE);
      await expectBalance(ecbtc, otcAddr, 0n);

      const order = await otc.getOrder(id);
      expect(order.closed).to.equal(true);
      expect(order.active).to.equal(false);
      expect((await otc.getOrdersByPair(ecbtcAddr, cusdAddr)).length).to.equal(0);
    });

    it("a cancelled order cannot be filled", async () => {
      const { alice, bob, otc, bobClient, id } = await withOrder();
      const bond = await otc.ethBondSize();
      await (await otc.connect(alice).cancelOrder(id)).wait();
      await expect(
        otc.connect(bob).fillOrder(id, ...(await enc(bobClient, mBTC, otc)), { value: bond }),
      ).to.be.revertedWithCustomError(otc, "OrderNotActive");
    });

    it("a depositor can still recover a fill bond after the order is cancelled", async () => {
      const { alice, bob, ecbtc, cusd, otc, aliceClient, bobClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await (await cusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await cusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, 2n * mBTC, otc)),
      );

      const seq = await fill(otc, bob, bobClient, id, 400n); // bond held
      const bond = await otc.ethBondSize();

      // Maker cancels; the maker bond is 0, so only the fill bond remains held.
      await (await otc.connect(alice).cancelOrder(id)).wait();
      expect(await ethers.provider.getBalance(otcAddr)).to.equal(bond);

      // The taker publishes (within window) to recover the bond; listing is moot.
      await publish(otc, bob, bobClient, id, seq);
      expect(await ethers.provider.getBalance(otcAddr)).to.equal(0n);
      expect((await otc.getPublish(id, seq)).settled).to.equal(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // views: pair index, batch, maker/taker lists
  // ─────────────────────────────────────────────────────────────────────────

  describe("views", () => {
    it("indexes orders directionally and hydrates them in a batch", async () => {
      const { alice, ecbtc, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, ecbtc, ONE, cusd, 200n * ONE, otcAddr);

      // Sell side: ecBTC → cUSD (1 mBTC = $65 NANO).
      const sell = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );
      // Buy side: cUSD → ecBTC ($200 SMALL).
      const buy = await createAndActivate(
        otc,
        alice,
        aliceClient,
        cusdAddr,
        ecbtcAddr,
        PRICE_CUSD_BTC,
        0n,
        ...(await enc(aliceClient, 200n * ONE, otc)),
      );

      const sellSide = await otc.getOrdersByPair(ecbtcAddr, cusdAddr);
      const buySide = await otc.getOrdersByPair(cusdAddr, ecbtcAddr);
      expect(sellSide.map(x => x)).to.deep.equal([sell]);
      expect(buySide.map(x => x)).to.deep.equal([buy]);

      const batch = await otc.getOrdersBatch([sell, buy]);
      expect(batch.length).to.equal(2);
      expect(batch[0].inputToken).to.equal(ecbtcAddr);
      expect(batch[1].inputToken).to.equal(cusdAddr);
      expect(batch[0].active).to.equal(true);
      expect(batch[0].bracket).to.equal(NANO);
      expect(batch[1].bracket).to.equal(SMALL);

      const makerIds = await otc.getMakerOrderIds(alice.address);
      expect(makerIds.map(x => x)).to.deep.equal([sell, buy]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // expiry
  // ─────────────────────────────────────────────────────────────────────────

  describe("expiry", () => {
    it("rejects fills after the expiry timestamp but allows them before", async () => {
      const { alice, bob, ecbtc, cusd, otc, aliceClient, bobClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();

      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await (await cusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await cusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

      const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      const expiry = now + 1_000n;
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        expiry,
        ...(await enc(aliceClient, mBTC, otc)),
      );

      // Before expiry: fill 200 raw ecBTC (cost $13).
      await fillAndPublish(otc, bob, bobClient, id, 200n);
      await expectBalance(ecbtc, bob.address, 200n);
      await expectBalance(cusd, bob.address, 1_000n * ONE - FILL_200RAW_CUSD);

      // Jump past expiry.
      await hre.network.provider.send("evm_increaseTime", [2_000]);
      await hre.network.provider.send("evm_mine");

      const bond = await otc.ethBondSize();
      await expect(
        otc.connect(bob).fillOrder(id, ...(await enc(bobClient, mBTC, otc)), { value: bond }),
      ).to.be.revertedWithCustomError(otc, "OrderExpired");

      // Maker can still cancel the expired order to recover the escrow.
      await (await otc.connect(alice).cancelOrder(id)).wait();
      const order = await otc.getOrder(id);
      expect(order.active).to.equal(false);
      expect(order.closed).to.equal(true);
    });

    it("rejects top-ups after the expiry timestamp but allows them before", async () => {
      const { alice, ecbtc, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();

      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);

      const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        now + 1_000n,
        ...(await enc(aliceClient, mBTC, otc)),
      );

      // Before expiry: top-up escrows more.
      await (await otc.connect(alice).topUpOrder(id, ...(await enc(aliceClient, mBTC, otc)))).wait();
      await expectBalance(ecbtc, otcAddr, 2n * mBTC);

      // Jump past expiry.
      await hre.network.provider.send("evm_increaseTime", [2_000]);
      await hre.network.provider.send("evm_mine");

      // An expired order cannot be grown — it is unfillable, so more escrow
      // would only be dead weight the maker has to cancel to recover.
      await expect(
        otc.connect(alice).topUpOrder(id, ...(await enc(aliceClient, mBTC, otc))),
      ).to.be.revertedWithCustomError(otc, "OrderExpired");
      await expectBalance(ecbtc, otcAddr, 2n * mBTC);
    });

    it("delists on the next publish once expired, instead of staying listed", async () => {
      const { alice, bob, ecbtc, cusd, otc, aliceClient, bobClient, otcAddr, cusdAddr, ecbtcAddr } = await setup();

      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await (await cusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await cusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

      const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        now + 1_000n,
        ...(await enc(aliceClient, 2n * mBTC, otc)),
      );

      // A fill lands while the order is still live, leaving an unsettled record.
      const seq = await fill(otc, bob, bobClient, id, 200n);
      expect((await otc.getOrder(id)).active).to.equal(true);

      // Expiry passes before the taker publishes it.
      await hre.network.provider.send("evm_increaseTime", [2_000]);
      await hre.network.provider.send("evm_mine");

      // The bracket is still non-EMPTY (escrow remains), so the old frontier
      // rule kept the order listed and unfillable. It now delists on expiry.
      const value = await publish(otc, bob, bobClient, id, seq);
      expect(value).to.not.equal(EMPTY);

      const order = await otc.getOrder(id);
      expect(order.active).to.equal(false);
      expect(order.closed).to.equal(false); // dormant, not destroyed — escrow retained
      expect((await otc.getOrdersByPair(ecbtcAddr, cusdAddr)).length).to.equal(0);
      await expectBalance(ecbtc, otcAddr, 2n * mBTC - 200n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // oracle staleness & the Chainlink ETH/USD feed
  // ─────────────────────────────────────────────────────────────────────────

  describe("oracle staleness", () => {
    const TWO_DAYS = 172_800;
    const FEED_DECIMALS = 8n;
    const FEED_ONE = 10n ** FEED_DECIMALS;
    const ETH_USD = 3_500n * FEED_ONE; // $3,500 / ETH, 8-decimal Chainlink scale

    async function advance(seconds: number) {
      await hre.network.provider.send("evm_increaseTime", [seconds]);
      await hre.network.provider.send("evm_mine");
    }

    async function deployFeed(answer: bigint = ETH_USD, decimals: bigint = FEED_DECIMALS) {
      const feed = await ethers.deployContract("MockAggregatorV3", [decimals, answer]);
      await feed.waitForDeployment();
      return feed;
    }

    // ── pushed-price path (no feed configured) ────────────────────────────

    it("stamps ethPriceUpdatedAt on every push", async () => {
      const { deployer, otc } = await setup();

      const first = await otc.ethPriceUpdatedAt();
      expect(first).to.be.greaterThan(0n);
      expect(await otc.isEthPriceStale()).to.equal(false);

      await advance(100);
      await (await otc.connect(deployer).setEthOraclePrice(ORACLE_ECETH)).wait();
      expect(await otc.ethPriceUpdatedAt()).to.be.greaterThan(first);
    });

    it("defaults to a 2-day staleness window, owner-settable", async () => {
      const { deployer, alice, otc } = await setup();

      expect(await otc.maxPriceAge()).to.equal(BigInt(TWO_DAYS));

      await expect(otc.connect(alice).setMaxPriceAge(3_600n)).to.be.revertedWithCustomError(
        otc,
        "OwnableUnauthorizedAccount",
      );
      await expect(otc.connect(deployer).setMaxPriceAge(3_600n)).to.emit(otc, "MaxPriceAgeUpdated").withArgs(3_600n);
      expect(await otc.maxPriceAge()).to.equal(3_600n);
    });

    it("reports a stale pushed price but keeps sizing bonds off it", async () => {
      const { deployer, otc } = await setup();

      const fresh = await otc.ethBondSize();
      expect(fresh).to.be.greaterThan(0n);

      await advance(TWO_DAYS + 1);

      // Staleness is advisory: flagged for monitoring, never enforced. Halting
      // the venue to avoid mis-sizing a $5 refundable deposit is the wrong trade.
      expect(await otc.isEthPriceStale()).to.equal(true);
      expect(await otc.ethBondSize()).to.equal(fresh);

      await (await otc.connect(deployer).setEthOraclePrice(ORACLE_ECETH)).wait();
      expect(await otc.isEthPriceStale()).to.equal(false);
    });

    it("keeps fills working through a fully stale oracle", async () => {
      const ctx = await setup();
      const { alice, bob, ecbtc, cusd, otc, aliceClient, bobClient, otcAddr, cusdAddr, ecbtcAddr } = ctx;

      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await (await cusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await cusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );

      await advance(TWO_DAYS + 1);
      expect(await otc.isEthPriceStale()).to.equal(true);

      // Both the maker and the taker path stay open. This is the regression
      // guard: an earlier revision reverted here, which meant a quiet keeper
      // halted every fill on every pair.
      const id2 = await createOrder(
        otc,
        alice,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );
      expect(id2).to.equal(id + 1n);

      await fillAndPublish(otc, bob, bobClient, id, mBTC);
      await expectBalance(ecbtc, bob.address, mBTC);
    });

    it("skips price resolution entirely when bonds are zero", async () => {
      const { deployer, otc } = await setup();

      await (await otc.connect(deployer).setParams(0n, 0n, 2_000n, 600n)).wait();
      await advance(TWO_DAYS + 1);

      expect(await otc.isEthPriceStale()).to.equal(true);
      expect(await otc.ethBondSize()).to.equal(0n);
      expect(await otc.makerBondSize()).to.equal(0n);
    });

    it("maxPriceAge = 0 disables staleness checks", async () => {
      const { deployer, otc, ecbtcAddr } = await setup();

      await (await otc.connect(deployer).setMaxPriceAge(0n)).wait();
      await advance(TWO_DAYS * 10);

      expect(await otc.isEthPriceStale()).to.equal(false);
      expect(await otc.isPriceStale(ecbtcAddr)).to.equal(false);
      expect(await otc.ethBondSize()).to.be.greaterThan(0n);
    });

    // ── Chainlink feed path ────────────────────────────────────────────────

    it("reads the feed live once configured, ignoring the pushed price", async () => {
      const { deployer, otc } = await setup();
      const feed = await deployFeed();

      await expect(otc.connect(deployer).setEthUsdFeed(await feed.getAddress()))
        .to.emit(otc, "EthUsdFeedUpdated")
        .withArgs(await feed.getAddress());

      // $3,500 → Q44.20. Same price the push oracle held, so the bond matches.
      expect(await otc.ethUsdPriceQ20()).to.equal(3_500n * Q);
      const bondAt3500 = await otc.ethBondSize();

      // Move the feed only. No owner call, no keeper — the next read picks it up.
      await (await feed.setAnswer(7_000n * FEED_ONE)).wait();
      expect(await otc.ethUsdPriceQ20()).to.equal(7_000n * Q);

      // ETH doubled, so a $5 bond costs half as much ETH.
      expect(await otc.ethBondSize()).to.equal(bondAt3500 / 2n);

      // The pushed price is now irrelevant.
      await (await otc.connect(deployer).setEthOraclePrice(1n * Q)).wait();
      expect(await otc.ethUsdPriceQ20()).to.equal(7_000n * Q);
    });

    it("only the owner may set the feed", async () => {
      const { deployer, alice, otc } = await setup();
      const feed = await deployFeed();

      await expect(otc.connect(alice).setEthUsdFeed(await feed.getAddress())).to.be.revertedWithCustomError(
        otc,
        "OwnableUnauthorizedAccount",
      );

      await (await otc.connect(deployer).setEthUsdFeed(await feed.getAddress())).wait();
      expect(await otc.ethUsdFeed()).to.equal(await feed.getAddress());
    });

    it("takes the scale from the feed, so any decimals work", async () => {
      const { deployer, otc } = await setup();

      // Same $3,500 expressed at three different feed scales must all resolve
      // to the same Q44.20 price — nothing here assumes 8 decimals.
      for (const dec of [6n, 8n, 18n]) {
        const feed = await deployFeed(3_500n * 10n ** dec, dec);
        await (await otc.connect(deployer).setEthUsdFeed(await feed.getAddress())).wait();
        expect(await otc.ethUsdPriceQ20()).to.equal(3_500n * Q);
      }
    });

    it("rejects feed answers that cannot be used as a divisor", async () => {
      const { deployer, otc } = await setup();
      const feed = await deployFeed();
      await (await otc.connect(deployer).setEthUsdFeed(await feed.getAddress())).wait();

      // Non-positive: casting a negative answer would overflow the multiply.
      await (await feed.setAnswer(0n)).wait();
      await expect(otc.ethBondSize()).to.be.revertedWithCustomError(otc, "BadOraclePrice");
      await (await feed.setAnswer(-1n)).wait();
      await expect(otc.ethBondSize()).to.be.revertedWithCustomError(otc, "BadOraclePrice");

      // Truncates to zero in Q44.20 (answer × 2^20 / 1e8 == 0 below ~96), which
      // would divide by zero in _usdToWei.
      await (await feed.setAnswer(95n)).wait();
      await expect(otc.ethBondSize()).to.be.revertedWithCustomError(otc, "BadOraclePrice");

      // One tick above the threshold resolves fine.
      await (await feed.setAnswer(96n)).wait();
      expect(await otc.ethUsdPriceQ20()).to.equal(1n);
    });

    it("reports a quiet feed as stale from the feed's own timestamp", async () => {
      const { deployer, otc } = await setup();
      const feed = await deployFeed();
      await (await otc.connect(deployer).setEthUsdFeed(await feed.getAddress())).wait();

      const before = await otc.ethBondSize();
      expect(before).to.be.greaterThan(0n);
      expect(await otc.isEthPriceStale()).to.equal(false);

      // Feed stops updating. Reported, not enforced — fills keep working.
      await advance(TWO_DAYS + 1);
      expect(await otc.isEthPriceStale()).to.equal(true);
      expect(await otc.ethBondSize()).to.equal(before);

      // A fresh round clears it, with no owner involvement.
      await (await feed.setAnswer(ETH_USD)).wait();
      expect(await otc.isEthPriceStale()).to.equal(false);
    });

    it("isEthPriceStale follows the feed, not the pushed timestamp", async () => {
      const { deployer, otc } = await setup();
      const feed = await deployFeed();

      // Feed fresh, pushed price ancient → not stale (the feed is what's used).
      await (await otc.connect(deployer).setEthUsdFeed(await feed.getAddress())).wait();
      await advance(TWO_DAYS + 1);
      await (await feed.setAnswer(ETH_USD)).wait();
      expect(await otc.isEthPriceStale()).to.equal(false);

      // Drop back to the pushed price, which is now ancient → stale.
      await (await otc.connect(deployer).setEthUsdFeed(ethers.ZeroAddress)).wait();
      expect(await otc.isEthPriceStale()).to.equal(true);
    });

    it("falls back to the pushed price when the feed is unset", async () => {
      const { deployer, otc } = await setup();
      const feed = await deployFeed(7_000n * FEED_ONE);

      await (await otc.connect(deployer).setEthUsdFeed(await feed.getAddress())).wait();
      expect(await otc.ethUsdPriceQ20()).to.equal(7_000n * Q);

      await (await otc.connect(deployer).setEthUsdFeed(ethers.ZeroAddress)).wait();
      expect(await otc.ethUsdFeed()).to.equal(ethers.ZeroAddress);
      expect(await otc.ethUsdPriceQ20()).to.equal(ORACLE_ECETH); // pushed $3,500
    });

    it("prices a real fill bond off the feed end to end", async () => {
      const ctx = await setup();
      const { deployer, alice, bob, ecbtc, cusd, otc, aliceClient, bobClient, otcAddr, cusdAddr, ecbtcAddr } = ctx;

      const feed = await deployFeed();
      await (await otc.connect(deployer).setEthUsdFeed(await feed.getAddress())).wait();

      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await (await cusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await cusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );

      await fillAndPublish(otc, bob, bobClient, id, mBTC);
      await expectBalance(ecbtc, bob.address, mBTC);
    });

    // ── per-token bracket prices (advisory only) ──────────────────────────

    it("flags stale token prices as advisory only — fills still work", async () => {
      const ctx = await setup();
      const { deployer, alice, bob, ecbtc, cusd, otc, aliceClient, bobClient, otcAddr, cusdAddr, ecbtcAddr } = ctx;

      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await (await cusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await cusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

      await advance(TWO_DAYS + 1);
      expect(await otc.isPriceStale(ecbtcAddr)).to.equal(true);

      // Refresh only the bond feed; ecBTC's bracket price stays stale.
      await (await otc.connect(deployer).setEthOraclePrice(ORACLE_ECETH)).wait();
      expect(await otc.isPriceStale(ecbtcAddr)).to.equal(true);

      // create → activate → fill all still run. A stale bracket price mis-sorts
      // the book at worst; it must never strand an order.
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );
      await fillAndPublish(otc, bob, bobClient, id, mBTC);
      await expectBalance(ecbtc, bob.address, mBTC);
    });

    it("ages a $1 stablecoin's price like any other token's", async () => {
      const { otc, cusdAddr, ecbtcAddr } = await setup();

      await advance(TWO_DAYS * 5);

      expect(await otc.isPriceStale(cusdAddr)).to.equal(true);
      expect(await otc.isPriceStale(ecbtcAddr)).to.equal(true);
    });

    it("reports price age, and 0 for a token that was never priced", async () => {
      const { otc, ecbtcAddr } = await setup();

      expect(await otc.priceAge(ethers.Wallet.createRandom().address)).to.equal(0n);

      await advance(1_000);
      expect(await otc.priceAge(ecbtcAddr)).to.be.greaterThanOrEqual(1_000n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // protocol swap fee
  // ─────────────────────────────────────────────────────────────────────────

  describe("protocol swap fee", () => {
    const FEE_030 = 3_146n; // 0.30% in Q44.20
    const MAX_FEE = 10_486n; // MAX_SWAP_FEE_Q20 (~1.00%)
    const MAXU64 = (1n << 64n) - 1n;

    /// Mirrors the contract's Q44.20 skim: eRelease × feeQ20 >> 20.
    const feeOf = (amount: bigint, feeQ20: bigint) => (amount * feeQ20) >> 20n;

    /// Mirrors _fillCap: the price overflow bound, reserving 2^shift − 1 of
    /// headroom for the ceil-rounding add in _swap.
    const fillCap = (price: bigint, shift: bigint) => (MAXU64 - ((1n << shift) - 1n)) / price;

    /// Maker alice posts 1 mBTC of ecBTC for cUSD; bob funded to take it.
    async function withOrder(feeQ20: bigint) {
      const ctx = await setup();
      const { deployer, alice, bob, ecbtc, cusd, otc, aliceClient, otcAddr, cusdAddr, ecbtcAddr } = ctx;

      if (feeQ20 > 0n) {
        await (await otc.connect(deployer).setSwapFee(feeQ20)).wait();
      }

      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      await (await cusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await cusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );
      return { ...ctx, id };
    }

    it("is disabled at deploy and leaves the fill path byte-for-byte unchanged", async () => {
      const { deployer, bob, ecbtc, cusd, otc, bobClient, otcAddr, ecbtcAddr, id } = await withOrder(0n);

      expect(await otc.swapFeeQ20()).to.equal(0n);
      await expect(otc.connect(deployer).sweepFees(ecbtcAddr)).to.be.revertedWithCustomError(otc, "NoFeesAccrued");

      await fillAndPublish(otc, bob, bobClient, id, mBTC);

      // Identical to the zero-fee expectations in the fillOrder suite.
      await expectBalance(ecbtc, bob.address, mBTC);
      await expectBalance(ecbtc, otcAddr, 0n);
      await expectBalance(cusd, bob.address, 1_000n * ONE - FILL_1MBTC_CUSD);
      // The feeQ20 == 0 fast path returns before touching _feesAccrued, so the
      // slot is still the null handle and the sweep guard still fires.
      await expect(otc.connect(deployer).sweepFees(ecbtcAddr)).to.be.revertedWithCustomError(otc, "NoFeesAccrued");
    });

    it("skims the fee from the taker and retains it in escrow", async () => {
      const { alice, bob, ecbtc, cusd, otc, bobClient, otcAddr, ecbtcAddr, id } = await withOrder(FEE_030);

      const fee = feeOf(mBTC, FEE_030); // 1_000 raw @ 0.30% → 3 raw
      expect(fee).to.equal(3n);

      await fillAndPublish(otc, bob, bobClient, id, mBTC);

      await expectBalance(ecbtc, bob.address, mBTC - fee); // taker short by the fee
      await expectBalance(ecbtc, otcAddr, fee); // fee stays put — no extra transfer
      await expectBalance(cusd, alice.address, FILL_1MBTC_CUSD); // maker paid in full
    });

    it("decrements eRemaining by the full release, so the bracket is unaffected", async () => {
      const { bob, otc, bobClient, ecbtcAddr, cusdAddr, id } = await withOrder(FEE_030);

      // Order is fully consumed even though the taker received less than the
      // release: eRemaining moves by eRelease, not eToTaker.
      const value = await fillAndPublish(otc, bob, bobClient, id, mBTC);
      expect(value).to.equal(EMPTY);

      const order = await otc.getOrder(id);
      expect(order.bracket).to.equal(EMPTY);
      expect(order.active).to.equal(false);
      expect((await otc.getOrdersByPair(ecbtcAddr, cusdAddr)).length).to.equal(0);
    });

    it("accrues across multiple fills", async () => {
      const { bob, ecbtc, otc, bobClient, otcAddr, id } = await withOrder(FEE_030);

      const fee1 = feeOf(400n, FEE_030);
      const fee2 = feeOf(200n, FEE_030);

      await fillAndPublish(otc, bob, bobClient, id, 400n);
      await expectBalance(ecbtc, bob.address, 400n - fee1);

      await fillAndPublish(otc, bob, bobClient, id, 200n);
      await expectBalance(ecbtc, bob.address, 400n - fee1 + (200n - fee2));

      // Escrow holds the untouched remainder plus both accrued fees.
      await expectBalance(ecbtc, otcAddr, mBTC - 400n - 200n + fee1 + fee2);
    });

    it("charges nothing when the taker fails to pay in full", async () => {
      const ctx = await setup();
      const { deployer, alice, bob, ecbtc, cusd, otc, aliceClient, bobClient, otcAddr, cusdAddr, ecbtcAddr } = ctx;

      await (await otc.connect(deployer).setSwapFee(FEE_030)).wait();
      await fundMaker(alice, ecbtc, ONE, cusd, 0n, otcAddr);
      // Bob cannot cover $65 — the release is 0, so the fee must also be 0.
      await (await cusd.mint(bob.address, 1n * ONE)).wait();
      await (await cusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        PRICE_BTC_CUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );

      await fillAndPublish(otc, bob, bobClient, id, mBTC);

      await expectBalance(ecbtc, bob.address, 0n);
      await expectBalance(ecbtc, otcAddr, mBTC); // escrow intact, nothing skimmed
    });

    it("rejects a rate whose fill cap the fee multiply would overflow, even at fee 0", async () => {
      // priceX64 = 200 stores as 100 / 2^63: its cap is 9.2e16 raw, and
      // 9.2e16 × MAX_FEE wraps uint64. A fee cap would cut each fill to 1.76e15
      // raw (0.019 raw output) while still charging a whole raw unit, so the
      // order is refused up front — at the maximum fee, not the live one.
      const { alice, otc, aliceClient, cusdAddr, ecbtcAddr } = await setup();
      expect(await otc.swapFeeQ20()).to.equal(0n);

      for (const priceX64 of [200n, 10_484n]) {
        // 10,484 → 5,242 / 2^63: one mantissa step below the lowest accepted rate.
        await expect(
          otc.connect(alice).createOrder(ecbtcAddr, cusdAddr, priceX64, 0n, ...(await enc(aliceClient, mBTC, otc))),
        ).to.be.revertedWithCustomError(otc, "PriceTooLow");
      }
    });

    it("keeps eRelease × fee within uint64 at MAX_SWAP_FEE_Q20 for the lowest accepted rate", async () => {
      // priceX64 = 10,485 stores as 5,243 / 2^63, the smallest mantissa whose
      // price cap (1.759e15) still fits the fee bound: cap × MAX_FEE ≤ 2^64 − 1,
      // and a full fill at the cap outputs just under one raw unit.
      const ctx = await setup();
      const { deployer, alice, bob, ecbtc, cusd, otc, aliceClient, bobClient, otcAddr, cusdAddr, ecbtcAddr } = ctx;

      const [price, shift] = [5_243n, 63n];
      await (await otc.connect(deployer).setSwapFee(MAX_FEE)).wait();

      const cap = fillCap(price, shift);
      expect(cap * MAX_FEE).to.be.lessThanOrEqual(MAXU64);
      const deposit = cap + 10n ** 12n; // more than the cap, so it must clamp
      const output = (cap * price + (1n << shift) - 1n) >> shift; // taker pays the ceiling

      await (await ecbtc.mint(alice.address, deposit)).wait();
      await (await ecbtc.connect(alice).setOperator(otcAddr, FAR_FUTURE)).wait();
      await (await cusd.mint(bob.address, output)).wait();
      await (await cusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        cusdAddr,
        10_485n, // priceX64 → 5,243 / 2^63
        0n,
        ...(await enc(aliceClient, deposit, otc)),
      );
      const order = await otc.getOrder(id);
      expect([order.price, order.priceShift]).to.deep.equal([price, shift]);

      await fill(otc, bob, bobClient, id, deposit); // request everything

      // eActual clamped to the cap; the fee is a sane ~1%, not a wrapped
      // value, and the taker's receipt plus the retained fee reconstruct it.
      const fee = feeOf(cap, MAX_FEE);
      expect(fee).to.be.greaterThan(0n);
      expect(fee).to.be.lessThan(cap);
      await expectBalance(ecbtc, bob.address, cap - fee);
      await expectBalance(ecbtc, otcAddr, deposit - cap + fee);
    });

    // ── admin surface ─────────────────────────────────────────────────────

    it("only the owner may set the fee, and only up to MAX_SWAP_FEE_Q20", async () => {
      const { deployer, alice, otc } = await setup();

      expect(await otc.MAX_SWAP_FEE_Q20()).to.equal(MAX_FEE);

      await expect(otc.connect(alice).setSwapFee(FEE_030)).to.be.revertedWithCustomError(
        otc,
        "OwnableUnauthorizedAccount",
      );
      await expect(otc.connect(deployer).setSwapFee(MAX_FEE + 1n)).to.be.revertedWithCustomError(otc, "FeeTooHigh");

      await expect(otc.connect(deployer).setSwapFee(FEE_030)).to.emit(otc, "SwapFeeUpdated").withArgs(FEE_030);
      expect(await otc.swapFeeQ20()).to.equal(FEE_030);

      // The ceiling itself is allowed, and the fee can be switched back off.
      await (await otc.connect(deployer).setSwapFee(MAX_FEE)).wait();
      expect(await otc.swapFeeQ20()).to.equal(MAX_FEE);
      await (await otc.connect(deployer).setSwapFee(0n)).wait();
      expect(await otc.swapFeeQ20()).to.equal(0n);
    });

    it("publishes the fee handle so any account can read the live rate", async () => {
      const { deployer, otc, bobClient } = await setup();

      await (await otc.connect(deployer).setSwapFee(FEE_030)).wait();

      // bob is unrelated to the fee, yet allowPublic lets him decrypt it.
      const dec = await proof(bobClient, await otc.swapFeeHandle());
      expect(BigInt(dec.decryptedValue)).to.equal(FEE_030);
    });

    it("defaults the treasury to the deployer and guards setTreasury", async () => {
      const { deployer, alice, otc } = await setup();

      expect(await otc.treasury()).to.equal(deployer.address);

      await expect(otc.connect(alice).setTreasury(alice.address)).to.be.revertedWithCustomError(
        otc,
        "OwnableUnauthorizedAccount",
      );
      await expect(otc.connect(deployer).setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        otc,
        "ZeroAddress",
      );

      await expect(otc.connect(deployer).setTreasury(alice.address))
        .to.emit(otc, "TreasuryUpdated")
        .withArgs(alice.address);
      expect(await otc.treasury()).to.equal(alice.address);
    });

    // ── collection ────────────────────────────────────────────────────────

    it("sweeps accrued fees to the treasury, and a repeat sweep moves nothing", async () => {
      const { deployer, bob, ecbtc, otc, bobClient, otcAddr, ecbtcAddr, id } = await withOrder(FEE_030);

      // Nothing accrued yet.
      await expect(otc.connect(deployer).sweepFees(ecbtcAddr)).to.be.revertedWithCustomError(otc, "NoFeesAccrued");

      const fee = feeOf(mBTC, FEE_030);
      await fillAndPublish(otc, bob, bobClient, id, mBTC);

      // Route the sweep to a signer holding no ecBTC — proves the destination
      // follows `treasury` rather than the caller, and keeps the assertion exact
      // (alice the maker, and bob the taker, both carry ecBTC of their own).
      const carol = (await ethers.getSigners())[3];
      await (await otc.connect(deployer).setTreasury(carol.address)).wait();

      await hre.network.provider.send("evm_increaseTime", [Number(await otc.SWEEP_COOLDOWN())]);
      await expect(otc.connect(deployer).sweepFees(ecbtcAddr)).to.emit(otc, "FeesSwept");

      await expectBalance(ecbtc, carol.address, fee);
      await expectBalance(ecbtc, otcAddr, 0n); // escrow fully drained

      // The slot now holds the encrypted leftover (0), not the zero handle, so
      // a repeat sweep passes the guard, waits out the cooldown, and moves 0.
      await expect(otc.connect(deployer).sweepFees(ecbtcAddr)).to.be.revertedWithCustomError(otc, "SweepTooSoon");
      await hre.network.provider.send("evm_increaseTime", [Number(await otc.SWEEP_COOLDOWN())]);
      await expect(otc.connect(deployer).sweepFees(ecbtcAddr)).to.emit(otc, "FeesSwept");
      await expectBalance(ecbtc, carol.address, fee);
      await expectBalance(ecbtc, otcAddr, 0n);
    });

    it("keeps fees a clamped sweep did not move, so a later sweep collects them", async () => {
      const { deployer, bob, ecbtc, otc, bobClient, otcAddr, ecbtcAddr, id } = await withOrder(FEE_030);

      const fee = feeOf(mBTC, FEE_030);
      await fillAndPublish(otc, bob, bobClient, id, mBTC); // the contract now holds only the fee

      const carol = (await ethers.getSigners())[3];
      await (await otc.connect(deployer).setTreasury(carol.address)).wait();
      const cooldown = Number(await otc.SWEEP_COOLDOWN());

      // Make the transfer fail without reverting: with the balance gone, the
      // all-or-nothing confidentialTransfer moves 0, as a blocked recipient would.
      await (await ecbtc.burn(otcAddr, fee)).wait();
      await hre.network.provider.send("evm_increaseTime", [cooldown]);
      await expect(otc.connect(deployer).sweepFees(ecbtcAddr)).to.emit(otc, "FeesSwept");
      await expectBalance(ecbtc, carol.address, 0n);

      // The transfer can succeed again; the next sweep collects the full fee.
      await (await ecbtc.mint(otcAddr, fee)).wait();
      await hre.network.provider.send("evm_increaseTime", [cooldown]);
      await expect(otc.connect(deployer).sweepFees(ecbtcAddr)).to.emit(otc, "FeesSwept");
      await expectBalance(ecbtc, carol.address, fee);
      await expectBalance(ecbtc, otcAddr, 0n);
    });

    it("lets the sweeping owner decrypt the swept amount without the treasury key", async () => {
      const { deployer, bob, otc, bobClient, ecbtcAddr, id } = await withOrder(FEE_030);

      await fillAndPublish(otc, bob, bobClient, id, mBTC);

      // Treasury is a separate key, as a cold wallet or multisig would be.
      const carol = (await ethers.getSigners())[3];
      await (await otc.connect(deployer).setTreasury(carol.address)).wait();

      await hre.network.provider.send("evm_increaseTime", [Number(await otc.SWEEP_COOLDOWN())]);
      const receipt = await (await otc.connect(deployer).sweepFees(ecbtcAddr)).wait();
      const swept = receipt!.logs
        .map(l => otc.interface.parseLog(l))
        .find(e => e?.name === "FeesSwept")!.args.eAmount;

      const acl = await hre.cofhe.mocks.getMockACL();
      expect(await acl.isAllowed(swept, deployer.address)).to.equal(true);
      expect(await acl.isAllowed(swept, carol.address)).to.equal(true);
      expect(await acl.isAllowed(swept, bob.address)).to.equal(false);
      await hre.cofhe.mocks.expectPlaintext(swept, feeOf(mBTC, FEE_030));
    });

    it("throttles sweeps to once per SWEEP_COOLDOWN, defeating the sandwich", async () => {
      const { deployer, bob, ecbtc, otc, bobClient, ecbtcAddr, id } = await withOrder(FEE_030);

      const cooldown = await otc.SWEEP_COOLDOWN();
      expect(cooldown).to.equal(82_800n); // 23h

      // No fee yet, so no cooldown anchor.
      expect(await otc.lastSweepAt(ecbtcAddr)).to.equal(0n);
      expect(await otc.sweepUnlockAt(ecbtcAddr)).to.equal(0n);

      // The first fee anchors the cooldown, so the first sweep cannot isolate
      // the first fill either.
      await fillAndPublish(otc, bob, bobClient, id, 400n);
      const firstFee = await otc.lastSweepAt(ecbtcAddr);
      expect(firstFee).to.be.greaterThan(0n);
      expect(await otc.sweepUnlockAt(ecbtcAddr)).to.equal(firstFee + cooldown);
      await expect(otc.connect(deployer).sweepFees(ecbtcAddr)).to.be.revertedWithCustomError(otc, "SweepTooSoon");

      await hre.network.provider.send("evm_setNextBlockTimestamp", [Number(firstFee + cooldown) - 1]);
      await expect(otc.connect(deployer).sweepFees(ecbtcAddr)).to.be.revertedWithCustomError(otc, "SweepTooSoon");

      await hre.network.provider.send("evm_setNextBlockTimestamp", [Number(firstFee + cooldown)]);
      await (await otc.connect(deployer).sweepFees(ecbtcAddr)).wait();

      const last = await otc.lastSweepAt(ecbtcAddr);
      expect(last).to.be.greaterThan(0n);
      expect(await otc.sweepUnlockAt(ecbtcAddr)).to.equal(last + cooldown);

      // The sandwich: a second fill lands, and the owner tries to collect again
      // straight away to isolate that single fill's fee. Blocked.
      await fillAndPublish(otc, bob, bobClient, id, 200n);
      await expect(otc.connect(deployer).sweepFees(ecbtcAddr)).to.be.revertedWithCustomError(otc, "SweepTooSoon");

      const unlock = Number(await otc.sweepUnlockAt(ecbtcAddr));

      await hre.network.provider.send("evm_setNextBlockTimestamp", [unlock - 1]);
      await expect(otc.connect(deployer).sweepFees(ecbtcAddr)).to.be.revertedWithCustomError(otc, "SweepTooSoon");

      await hre.network.provider.send("evm_setNextBlockTimestamp", [unlock]);
      await expect(otc.connect(deployer).sweepFees(ecbtcAddr)).to.emit(otc, "FeesSwept");
    });

    it("allows the next sweep once the cooldown elapses, aggregating the interim fills", async () => {
      const { deployer, bob, ecbtc, otc, bobClient, otcAddr, ecbtcAddr, id } = await withOrder(FEE_030);

      const fee1 = feeOf(400n, FEE_030);
      const fee2 = feeOf(200n, FEE_030);
      const fee3 = feeOf(100n, FEE_030);

      const carol = (await ethers.getSigners())[3];
      await (await otc.connect(deployer).setTreasury(carol.address)).wait();

      await fillAndPublish(otc, bob, bobClient, id, 400n);
      await hre.network.provider.send("evm_increaseTime", [Number(await otc.SWEEP_COOLDOWN())]);
      await (await otc.connect(deployer).sweepFees(ecbtcAddr)).wait();
      await expectBalance(ecbtc, carol.address, fee1);

      // Two more fills accrue while the sweep is locked.
      await fillAndPublish(otc, bob, bobClient, id, 200n);
      await fillAndPublish(otc, bob, bobClient, id, 100n);

      await hre.network.provider.send("evm_increaseTime", [Number(await otc.SWEEP_COOLDOWN())]);
      await hre.network.provider.send("evm_mine");

      await (await otc.connect(deployer).sweepFees(ecbtcAddr)).wait();

      // The disclosed total is the SUM of both interim fills, not either alone.
      await expectBalance(ecbtc, carol.address, fee1 + fee2 + fee3);
      await expectBalance(ecbtc, otcAddr, mBTC - 400n - 200n - 100n);
    });

    it("only the owner may sweep", async () => {
      const { alice, bob, otc, bobClient, ecbtcAddr, id } = await withOrder(FEE_030);

      await fillAndPublish(otc, bob, bobClient, id, mBTC);

      await expect(otc.connect(alice).sweepFees(ecbtcAddr)).to.be.revertedWithCustomError(
        otc,
        "OwnableUnauthorizedAccount",
      );
    });
  });
});
