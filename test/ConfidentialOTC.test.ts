import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { Encryptable, type EncryptedUint64Input } from "@cofhe/sdk";
import type { ConfidentialOTC, FHERC20_Harness } from "../typechain-types";

// Derive both types from hre to avoid pnpm dual-instance mismatches — two
// copies of the same package end up at different paths and TypeScript treats
// them as incompatible. Deriving from hre guarantees both the annotation and
// the actual return value resolve from the same copy.
type CofheClient = Awaited<ReturnType<typeof hre.cofhe.createClientWithBatteries>>;
type HardhatEthersSigner = Awaited<ReturnType<typeof hre.ethers.getSigners>>[number];

/** Mintable FHERC20 stand-in (existing repo harness — replaces MockFUSD/MockOTCToken/MockDecimalsToken). */
type ConfidentialToken = FHERC20_Harness;

const Q = 1_048_576n; // 2^20 — Q44.20 denominator
const FAR_FUTURE = 281_474_976_710_655n; // uint48.max — operator approval window
const ONE = 1_000_000n; // 1 whole token at 6 decimals

// Bracket labels (mirror the contract; uint8 → bigint over the wire).
const EMPTY = 0n;
const NANO = 1n;
const SMALL = 2n;
const UNPUBLISHED = 255n;

// ── Realistic oracle prices (Q44.20: floor(usd_per_whole_token × 2^20)) ───────
const ORACLE_ECBTC = 65_000n * Q; // $65,000 / BTC
const ORACLE_ECETH = 3_500n * Q; // $3,500  / ETH (also the ETH bond price)

// ── Order prices (Q44.20: output-raw per input-raw) ───────────────────────────
const PRICE_BTC_FUSD = 65_000n * Q; // ecBTC → fUSD: $65,000 per ecBTC
const PRICE_FUSD_BTC = Q / 65_000n; // fUSD → ecBTC (integer truncation intentional)
const PRICE_BTC_ETH = (65_000n * Q) / 3_500n; // ecBTC → ecETH ≈ 18.57 = 19_473_554n

// ── Convenience amounts ────────────────────────────────────────────────────────
const mBTC = ONE / 1_000n; // 0.001 ecBTC = 1_000 raw → $65 at oracle → NANO

// ── Pre-computed fill costs (verified against the Q44.20 formula) ─────────────
const FILL_1MBTC_FUSD = 65n * ONE; // 1_000 raw ecBTC → 65_000_000 fUSD ($65)
const FILL_400RAW_FUSD = 26n * ONE; // 400   raw ecBTC → 26_000_000 fUSD ($26)
const FILL_200RAW_FUSD = 13n * ONE; // 200   raw ecBTC → 13_000_000 fUSD ($13)
const FILL_1MBTC_ETH = 18_571n; // 1_000 raw ecBTC → 18_571 raw ecETH
const FILL_400RAW_ETH = 7_428n; // 400   raw ecBTC → 7_428  raw ecETH

describe("ConfidentialOTC", () => {
  before(async () => {
    // The cofhe mock contracts emit very gas-heavy per-op debug logs; the
    // bracket recompute alone runs ~10 FHE ops per fill. Disable to stay
    // under the block gas limit.
    await hre.cofhe.mocks.disableLogs();
  });

  async function setup() {
    const [deployer, alice, bob] = await ethers.getSigners();

    const fusd = (await ethers.deployContract("FHERC20_Harness", [
      "Confidential USD",
      "fUSD",
      6,
      "",
    ])) as unknown as ConfidentialToken;
    await fusd.waitForDeployment();

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

    const otc = (await ethers.deployContract("ConfidentialOTC", [
      await fusd.getAddress(),
    ])) as unknown as ConfidentialOTC;
    await otc.waitForDeployment();

    // Whitelist both test tokens at realistic oracle prices, and set the ETH
    // price used to size fill bonds. fUSD is auto-whitelisted at Q_DENOM.
    await (await otc.connect(deployer).whitelistToken(await ecbtc.getAddress(), ORACLE_ECBTC)).wait();
    await (await otc.connect(deployer).whitelistToken(await eceth.getAddress(), ORACLE_ECETH)).wait();
    await (await otc.connect(deployer).setEthOraclePrice(ORACLE_ECETH)).wait();

    const aliceClient = await hre.cofhe.createClientWithBatteries(alice);
    const bobClient = await hre.cofhe.createClientWithBatteries(bob);

    const otcAddr = await otc.getAddress();
    const fusdAddr = await fusd.getAddress();
    const ecbtcAddr = await ecbtc.getAddress();
    const ecethAddr = await eceth.getAddress();

    return {
      deployer,
      alice,
      bob,
      fusd,
      ecbtc,
      eceth,
      otc,
      aliceClient,
      bobClient,
      otcAddr,
      fusdAddr,
      ecbtcAddr,
      ecethAddr,
    };
  }

  async function enc(client: CofheClient, value: bigint) {
    const out = await client.encryptInputs([Encryptable.uint64(value)]).execute();
    return out[0];
  }

  /// Lets the threshold-network mock publish a decryption for a public handle,
  /// then decrypts it locally to produce the (value, signature) proof pair.
  async function proof(client: CofheClient, handle: string) {
    await hre.network.provider.send("evm_increaseTime", [11]);
    await hre.network.provider.send("evm_mine");
    return client.decryptForTx(handle).withoutPermit().execute();
  }

  /// Mints the input leg to the maker (+ operator grant) and, when the trade
  /// uses fUSD as a leg, mints `fusdAmount` fUSD too. The maker bond defaults
  /// to 0, so no ETH is required at create.
  async function fundMaker(
    maker: HardhatEthersSigner,
    token: ConfidentialToken,
    tokenAmount: bigint,
    fusd: ConfidentialToken,
    fusdAmount: bigint,
    otcAddr: string,
  ) {
    if ((await token.getAddress()) !== (await fusd.getAddress())) {
      await (await token.mint(maker.address, tokenAmount)).wait();
      await (await token.connect(maker).setOperator(otcAddr, FAR_FUTURE)).wait();
    }
    if (fusdAmount > 0n) {
      await (await fusd.mint(maker.address, fusdAmount)).wait();
      await (await fusd.connect(maker).setOperator(otcAddr, FAR_FUTURE)).wait();
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
    encAmount: EncryptedUint64Input,
  ): Promise<bigint> {
    const id = await otc.nextOrderId();
    await (await otc.connect(maker).createOrder(input, output, price, expiry, encAmount)).wait();
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
    encAmount: EncryptedUint64Input,
  ): Promise<bigint> {
    const id = await createOrder(otc, maker, input, output, price, expiry, encAmount);
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
    await (await otc.connect(taker).fillOrder(id, await enc(takerClient, amount), { value: bond })).wait();
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
    it("reverts on zero fUSD address", async () => {
      const factory = await ethers.getContractFactory("ConfidentialOTC");
      await expect(factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    });

    it("reverts when fUSD does not use exactly 6 decimals", async () => {
      const fusd18 = (await ethers.deployContract("FHERC20_Harness", [
        "fUSD18",
        "fUSD18",
        18,
        "",
      ])) as unknown as ConfidentialToken;
      await fusd18.waitForDeployment();

      const factory = await ethers.getContractFactory("ConfidentialOTC");
      await expect(factory.deploy(await fusd18.getAddress())).to.be.revertedWithCustomError(factory, "InvalidDecimals");
    });

    it("auto-whitelists fUSD at Q_DENOM", async () => {
      const { otc, fusdAddr } = await setup();
      const config = await otc.getTokenConfig(fusdAddr);
      expect(config.whitelisted).to.equal(true);
      expect(config.oraclePrice).to.equal(Q); // Q_DENOM = 2^20
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

    it("owner can delist a token", async () => {
      const { deployer, otc, ecbtcAddr } = await setup();
      await (await otc.connect(deployer).delistToken(ecbtcAddr)).wait();
      expect((await otc.getTokenConfig(ecbtcAddr)).whitelisted).to.equal(false);
    });

    it("createOrder reverts with TokenNotWhitelisted when either leg is not whitelisted", async () => {
      const { alice, otc, aliceClient, fusdAddr, ecbtcAddr } = await setup();
      const unlisted = (await ethers.deployContract("FHERC20_Harness", [
        "U",
        "U",
        6,
        "",
      ])) as unknown as ConfidentialToken;
      await unlisted.waitForDeployment();
      const amt = await enc(aliceClient, mBTC);

      await expect(
        otc.connect(alice).createOrder(await unlisted.getAddress(), fusdAddr, PRICE_BTC_FUSD, 0n, amt),
      ).to.be.revertedWithCustomError(otc, "TokenNotWhitelisted");

      await expect(
        otc.connect(alice).createOrder(ecbtcAddr, await unlisted.getAddress(), PRICE_BTC_FUSD, 0n, amt),
      ).to.be.revertedWithCustomError(otc, "TokenNotWhitelisted");
    });

    it("owner can set the oracle address", async () => {
      const { deployer, bob, otc } = await setup();
      await (await otc.connect(deployer).setOracle(bob.address)).wait();
      expect(await otc.oracle()).to.equal(bob.address);
    });

    it("oracle address can update a whitelisted token price", async () => {
      const { deployer, bob, otc, ecbtcAddr } = await setup();
      await (await otc.connect(deployer).setOracle(bob.address)).wait();

      const newPrice = 70_000n * Q; // $70k
      await (await otc.connect(bob).updateOraclePrice(ecbtcAddr, newPrice)).wait();
      expect((await otc.getTokenConfig(ecbtcAddr)).oraclePrice).to.equal(newPrice);
    });

    it("owner can also update oracle price directly", async () => {
      const { deployer, otc, ecbtcAddr } = await setup();
      await (await otc.connect(deployer).updateOraclePrice(ecbtcAddr, 70_000n * Q)).wait();
      expect((await otc.getTokenConfig(ecbtcAddr)).oraclePrice).to.equal(70_000n * Q);
    });

    it("updateOraclePrice reverts for unauthorized callers", async () => {
      const { alice, otc, ecbtcAddr } = await setup();
      await expect(otc.connect(alice).updateOraclePrice(ecbtcAddr, Q)).to.be.revertedWithCustomError(
        otc,
        "Unauthorized",
      );
    });

    it("updateOraclePrice reverts for non-whitelisted token", async () => {
      const { deployer, otc } = await setup();
      const unlisted = (await ethers.deployContract("FHERC20_Harness", [
        "U",
        "U",
        6,
        "",
      ])) as unknown as ConfidentialToken;
      await unlisted.waitForDeployment();
      await expect(
        otc.connect(deployer).updateOraclePrice(await unlisted.getAddress(), Q),
      ).to.be.revertedWithCustomError(otc, "TokenNotWhitelisted");
    });

    it("updateOraclePrice reverts when price is below MIN_ORACLE_PRICE", async () => {
      const { deployer, otc, ecbtcAddr } = await setup();
      await expect(otc.connect(deployer).updateOraclePrice(ecbtcAddr, 0n)).to.be.revertedWithCustomError(
        otc,
        "ZeroPrice",
      );
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
      const fusd = (await ethers.deployContract("FHERC20_Harness", [
        "Confidential USD",
        "fUSD",
        6,
        "",
      ])) as unknown as ConfidentialToken;
      await fusd.waitForDeployment();
      const otc = (await ethers.deployContract("ConfidentialOTC", [
        await fusd.getAddress(),
      ])) as unknown as ConfidentialOTC;
      await otc.waitForDeployment();
      await expect(otc.connect(deployer).ethBondSize()).to.be.revertedWithCustomError(otc, "EthOracleUnset");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // createOrder + activateOrder
  // ─────────────────────────────────────────────────────────────────────────

  describe("createOrder / activateOrder", () => {
    it("creates a pending order that escrows input, then publishes + lists it", async () => {
      const { alice, ecbtc, fusd, otc, aliceClient, otcAddr, fusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);

      // 1 mBTC = 0.001 BTC @ $65,000 = $65 → NANO
      const id = await createOrder(otc, alice, ecbtcAddr, fusdAddr, PRICE_BTC_FUSD, 0n, await enc(aliceClient, mBTC));

      let order = await otc.getOrder(id);
      expect(order.pending).to.equal(true);
      expect(order.active).to.equal(false);
      expect(order.bracket).to.equal(UNPUBLISHED); // not revealed yet
      expect(order.latestSeq).to.equal(1n);
      expect(order.publishedSeq).to.equal(0n);
      await expectBalance(ecbtc, otcAddr, mBTC); // 1 mBTC escrowed
      await expectBalance(ecbtc, alice.address, ONE - mBTC);
      await hre.cofhe.mocks.expectPlaintext(order.bracketHandle, NANO); // encrypted snapshot
      expect((await otc.getOrdersByPair(ecbtcAddr, fusdAddr)).length).to.equal(0);

      await activate(otc, alice, aliceClient, id);

      order = await otc.getOrder(id);
      expect(order.pending).to.equal(false);
      expect(order.active).to.equal(true);
      expect(order.bracket).to.equal(NANO); // plaintext now published
      expect(order.publishedSeq).to.equal(1n);
      expect(order.maker).to.equal(alice.address);
      expect(order.inputToken).to.equal(ecbtcAddr);
      expect(order.outputToken).to.equal(fusdAddr);
      expect(order.price).to.equal(PRICE_BTC_FUSD);

      expect((await otc.getOrdersByPair(ecbtcAddr, fusdAddr)).map(x => x)).to.deep.equal([id]);
    });

    it("publishes SMALL for a $130 order (2 mBTC @ $65,000, outputToken == fUSD)", async () => {
      const { alice, ecbtc, fusd, otc, aliceClient, otcAddr, fusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        fusdAddr,
        PRICE_BTC_FUSD,
        0n,
        await enc(aliceClient, 2n * mBTC),
      );
      expect((await otc.getOrder(id)).bracket).to.equal(SMALL);
    });

    it("computes bracket from the raw fUSD amount (fUSD→ecBTC, inputToken == fUSD)", async () => {
      const { alice, fusd, otc, aliceClient, otcAddr, fusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, fusd, 0n, fusd, 200n * ONE, otcAddr);

      // Escrow 200 fUSD ($200) selling for ecBTC → SMALL.
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        fusdAddr,
        ecbtcAddr,
        PRICE_FUSD_BTC,
        0n,
        await enc(aliceClient, 200n * ONE),
      );
      await expectBalance(fusd, otcAddr, 200n * ONE); // no cleanup fee anymore
      expect((await otc.getOrder(id)).bracket).to.equal(SMALL);
    });

    it("reverts on zero address, same leg, zero price, and bad expiry", async () => {
      const { alice, otc, aliceClient, fusdAddr, ecbtcAddr } = await setup();
      const amt = await enc(aliceClient, mBTC);

      await expect(
        otc.connect(alice).createOrder(ethers.ZeroAddress, fusdAddr, PRICE_BTC_FUSD, 0n, amt),
      ).to.be.revertedWithCustomError(otc, "ZeroAddress");

      await expect(
        otc.connect(alice).createOrder(fusdAddr, fusdAddr, PRICE_BTC_FUSD, 0n, amt),
      ).to.be.revertedWithCustomError(otc, "SameLeg");

      await expect(otc.connect(alice).createOrder(ecbtcAddr, fusdAddr, 0n, 0n, amt)).to.be.revertedWithCustomError(
        otc,
        "ZeroPrice",
      );

      const past = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) - 1n;
      await expect(
        otc.connect(alice).createOrder(ecbtcAddr, fusdAddr, PRICE_BTC_FUSD, past, amt),
      ).to.be.revertedWithCustomError(otc, "InvalidExpiry");
    });

    it("cannot activate an unknown order, and cannot re-publish a settled record", async () => {
      const { alice, ecbtc, fusd, otc, aliceClient, otcAddr, fusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);
      await expect(otc.connect(alice).activateOrder(999n, 1, "0x")).to.be.revertedWithCustomError(otc, "OrderNotFound");

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        fusdAddr,
        PRICE_BTC_FUSD,
        0n,
        await enc(aliceClient, mBTC),
      );
      const rec = await otc.getPublish(id, 1n);
      const dec = await proof(aliceClient, rec.handle);
      await expect(
        otc.connect(alice).activateOrder(id, dec.decryptedValue, dec.signature),
      ).to.be.revertedWithCustomError(otc, "AlreadySettled");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // fillOrder (fUSD leg)
  // ─────────────────────────────────────────────────────────────────────────

  describe("fillOrder", () => {
    /// Maker alice posts 1 mBTC ($65) @ PRICE_BTC_FUSD → NANO bracket.
    async function withOrder() {
      const ctx = await setup();
      const { alice, bob, ecbtc, fusd, otc, aliceClient, otcAddr, fusdAddr, ecbtcAddr } = ctx;

      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);
      await (await fusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await fusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        fusdAddr,
        PRICE_BTC_FUSD,
        0n,
        await enc(aliceClient, mBTC),
      );
      return { ...ctx, id };
    }

    it("fully fills: taker pays fUSD, receives ecBTC, bracket → EMPTY + delisted", async () => {
      const { alice, bob, ecbtc, fusd, otc, bobClient, otcAddr, fusdAddr, ecbtcAddr, id } = await withOrder();

      const seq = await fill(otc, bob, bobClient, id, mBTC);

      await expectBalance(ecbtc, bob.address, mBTC); // taker got 1 mBTC
      await expectBalance(ecbtc, otcAddr, 0n); // escrow drained
      await expectBalance(fusd, bob.address, 1_000n * ONE - FILL_1MBTC_FUSD);
      await expectBalance(fusd, alice.address, FILL_1MBTC_FUSD); // maker received $65

      // Still listed + stale (NANO) until the post-fill publish lands.
      expect((await otc.getOrdersByPair(ecbtcAddr, fusdAddr)).length).to.equal(1);

      const value = await publish(otc, bob, bobClient, id, seq);
      expect(value).to.equal(EMPTY);
      const order = await otc.getOrder(id);
      expect(order.bracket).to.equal(EMPTY);
      expect(order.active).to.equal(false); // frontier EMPTY delists
      expect((await otc.getOrdersByPair(ecbtcAddr, fusdAddr)).length).to.equal(0);

      expect((await otc.getTakerFills(bob.address)).map(x => x)).to.deep.equal([id]);
    });

    it("partially fills and keeps the order active with an updated bracket", async () => {
      const { bob, ecbtc, fusd, otc, bobClient, otcAddr, id } = await withOrder();

      const value = await fillAndPublish(otc, bob, bobClient, id, 400n);

      await expectBalance(ecbtc, bob.address, 400n);
      await expectBalance(ecbtc, otcAddr, 600n); // 600 raw remaining
      await expectBalance(fusd, bob.address, 1_000n * ONE - FILL_400RAW_FUSD);

      const order = await otc.getOrder(id);
      expect(order.active).to.equal(true);
      expect(value).to.equal(NANO); // 600 raw × $65,000 = $39 → NANO
      expect(order.bracket).to.equal(NANO);
    });

    it("caps the fill at the remaining size when the taker over-requests", async () => {
      const { bob, ecbtc, fusd, otc, bobClient, otcAddr, id } = await withOrder();

      await fill(otc, bob, bobClient, id, 10n * mBTC); // wants 10 mBTC, only 1 remains

      await expectBalance(ecbtc, bob.address, mBTC);
      await expectBalance(ecbtc, otcAddr, 0n);
      await expectBalance(fusd, bob.address, 1_000n * ONE - FILL_1MBTC_FUSD);
    });

    it("releases nothing when the taker cannot cover the full payment (no free drain)", async () => {
      const { alice, bob, ecbtc, fusd, otc, bobClient, otcAddr, fusdAddr, ecbtcAddr, aliceClient } = await setup();

      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);
      await (await fusd.mint(bob.address, 30n * ONE)).wait(); // enough for $26, not $65
      await (await fusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        fusdAddr,
        PRICE_BTC_FUSD,
        0n,
        await enc(aliceClient, mBTC),
      );

      // Full fill attempt costs $65; bob only has $30 → nothing released, NANO stays.
      const v1 = await fillAndPublish(otc, bob, bobClient, id, mBTC);
      await expectBalance(ecbtc, bob.address, 0n);
      await expectBalance(ecbtc, otcAddr, mBTC);
      await expectBalance(fusd, bob.address, 30n * ONE);
      expect(v1).to.equal(NANO);

      // A fill he CAN afford: 400 raw ecBTC costs $26.
      await fillAndPublish(otc, bob, bobClient, id, 400n);
      await expectBalance(ecbtc, bob.address, 400n);
      await expectBalance(fusd, bob.address, 30n * ONE - FILL_400RAW_FUSD);
    });

    it("reverts without the ETH bond", async () => {
      const { bob, otc, bobClient, id } = await withOrder();
      await expect(
        otc.connect(bob).fillOrder(id, await enc(bobClient, mBTC)), // no value
      ).to.be.revertedWithCustomError(otc, "WrongBond");
    });

    it("reverts on unknown, pending, or inactive orders", async () => {
      const { alice, bob, ecbtc, fusd, otc, aliceClient, bobClient, otcAddr, fusdAddr, ecbtcAddr } = await setup();
      const bond = await otc.ethBondSize();
      await expect(
        otc.connect(bob).fillOrder(999n, await enc(bobClient, mBTC), { value: bond }),
      ).to.be.revertedWithCustomError(otc, "OrderNotFound");

      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);
      const id = await createOrder(otc, alice, ecbtcAddr, fusdAddr, PRICE_BTC_FUSD, 0n, await enc(aliceClient, mBTC));
      await expect(
        otc.connect(bob).fillOrder(id, await enc(bobClient, mBTC), { value: bond }),
      ).to.be.revertedWithCustomError(otc, "OrderNotActive");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // fill bond, window, bounty
  // ─────────────────────────────────────────────────────────────────────────

  describe("fill bond / publishBracket window", () => {
    async function withFilledOrder() {
      const ctx = await setup();
      const { alice, bob, ecbtc, fusd, otc, aliceClient, bobClient, otcAddr, fusdAddr, ecbtcAddr } = ctx;
      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);
      await (await fusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await fusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        fusdAddr,
        PRICE_BTC_FUSD,
        0n,
        await enc(aliceClient, 2n * mBTC), // 2 mBTC so it can take multiple partial fills
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
  });

  // ─────────────────────────────────────────────────────────────────────────
  // cANY<>cANY
  // ─────────────────────────────────────────────────────────────────────────

  describe("cANY<>cANY", () => {
    /// Alice sells 1 mBTC for ecETH at PRICE_BTC_ETH ($65 → NANO).
    async function withCanyOrder() {
      const ctx = await setup();
      const { alice, bob, ecbtc, eceth, fusd, otc, aliceClient, otcAddr, ecbtcAddr, ecethAddr } = ctx;

      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);
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
        await enc(aliceClient, mBTC),
      );
      return { ...ctx, id };
    }

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
      const { deployer, alice, bob, ecbtc, eceth, fusd, otc, aliceClient, bobClient, otcAddr, ecbtcAddr, ecethAddr } =
        await setup();

      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);
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
        await enc(aliceClient, 2n * mBTC),
      );
      expect((await otc.getOrder(id)).bracket).to.equal(SMALL);

      // Crash: oracle drops from $65,000 to $1,000 per BTC.
      await (await otc.connect(deployer).updateOraclePrice(ecbtcAddr, 1_000n * Q)).wait();

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
    /// Alice posts 1 mBTC ($65, NANO) and has 1 BTC total. Bob has 1,000 fUSD.
    async function withOrder() {
      const ctx = await setup();
      const { alice, bob, ecbtc, fusd, otc, aliceClient, otcAddr, fusdAddr, ecbtcAddr } = ctx;
      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);
      await (await fusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await fusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        fusdAddr,
        PRICE_BTC_FUSD,
        0n,
        await enc(aliceClient, mBTC),
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
      await (await otc.connect(maker).topUpOrder(id, await enc(makerClient, amount))).wait();
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
      const { alice, bob, ecbtc, fusd, otc, aliceClient, bobClient, otcAddr, id } = await withOrder();

      await topUpAndPublish(otc, alice, aliceClient, id, mBTC);

      const value = await fillAndPublish(otc, bob, bobClient, id, 2n * mBTC); // cost $130

      await expectBalance(ecbtc, bob.address, 2n * mBTC);
      await expectBalance(ecbtc, otcAddr, 0n);
      await expectBalance(fusd, bob.address, 1_000n * ONE - 2n * FILL_1MBTC_FUSD);
      expect(value).to.equal(EMPTY);
    });

    it("resurrects a depleted/dormant order (EMPTY → NANO) and re-lists it", async () => {
      const { alice, bob, ecbtc, otc, aliceClient, bobClient, otcAddr, fusdAddr, ecbtcAddr, id } = await withOrder();

      // Deplete fully and publish EMPTY → order becomes dormant (delisted).
      await fillAndPublish(otc, bob, bobClient, id, mBTC);
      expect((await otc.getOrder(id)).active).to.equal(false);
      expect((await otc.getOrdersByPair(ecbtcAddr, fusdAddr)).length).to.equal(0);

      // Top up + publish re-lists it (frontier non-EMPTY).
      const value = await topUpAndPublish(otc, alice, aliceClient, id, mBTC);
      await expectBalance(ecbtc, otcAddr, mBTC);
      expect(value).to.equal(NANO);
      const order = await otc.getOrder(id);
      expect(order.active).to.equal(true);
      expect((await otc.getOrdersByPair(ecbtcAddr, fusdAddr)).map(x => x)).to.deep.equal([id]);
    });

    it("only the maker can top up, and not on a closed order", async () => {
      const { alice, bob, ecbtc, fusd, otc, aliceClient, bobClient, otcAddr, fusdAddr, ecbtcAddr } = await setup();

      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        fusdAddr,
        PRICE_BTC_FUSD,
        0n,
        await enc(aliceClient, mBTC),
      );
      await expect(otc.connect(bob).topUpOrder(id, await enc(bobClient, mBTC))).to.be.revertedWithCustomError(
        otc,
        "NotMaker",
      );

      // Cancelled (closed) order rejected.
      await (await otc.connect(alice).cancelOrder(id)).wait();
      await expect(otc.connect(alice).topUpOrder(id, await enc(aliceClient, mBTC))).to.be.revertedWithCustomError(
        otc,
        "OrderClosed",
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // cancelOrder
  // ─────────────────────────────────────────────────────────────────────────

  describe("cancelOrder", () => {
    async function withOrder() {
      const ctx = await setup();
      const { alice, ecbtc, fusd, otc, aliceClient, otcAddr, fusdAddr, ecbtcAddr } = ctx;
      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        fusdAddr,
        PRICE_BTC_FUSD,
        0n,
        await enc(aliceClient, mBTC),
      );
      return { ...ctx, id };
    }

    it("returns the escrow, marks EMPTY + closed, and de-lists", async () => {
      const { alice, ecbtc, otc, otcAddr, fusdAddr, ecbtcAddr, id } = await withOrder();

      await (await otc.connect(alice).cancelOrder(id)).wait();

      await expectBalance(ecbtc, alice.address, ONE); // returned in full
      await expectBalance(ecbtc, otcAddr, 0n);

      const order = await otc.getOrder(id);
      expect(order.active).to.equal(false);
      expect(order.closed).to.equal(true);
      expect(order.bracket).to.equal(EMPTY);
      expect((await otc.getOrdersByPair(ecbtcAddr, fusdAddr)).length).to.equal(0);
    });

    it("returns the maker bond when one was posted", async () => {
      const { deployer, alice, ecbtc, fusd, otc, aliceClient, otcAddr, fusdAddr, ecbtcAddr } = await setup();
      // Turn the maker bond on ($5).
      await (await otc.connect(deployer).setParams(5_000_000n, 5_000_000n, 2_000n, 600n)).wait();
      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);

      const makerBond = await otc.makerBondSize();
      const id = await otc.nextOrderId();
      await (
        await otc.connect(alice).createOrder(ecbtcAddr, fusdAddr, PRICE_BTC_FUSD, 0n, await enc(aliceClient, mBTC), {
          value: makerBond,
        })
      ).wait();
      await activate(otc, alice, aliceClient, id);

      expect(await ethers.provider.getBalance(otcAddr)).to.equal(makerBond);
      await expect(otc.connect(alice).cancelOrder(id)).to.changeEtherBalance(alice, makerBond);
      expect(await ethers.provider.getBalance(otcAddr)).to.equal(0n);
    });

    it("createOrder reverts when the maker bond is underfunded", async () => {
      const { deployer, alice, ecbtc, fusd, otc, aliceClient, otcAddr, fusdAddr, ecbtcAddr } = await setup();
      await (await otc.connect(deployer).setParams(5_000_000n, 5_000_000n, 2_000n, 600n)).wait();
      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);
      await expect(
        otc.connect(alice).createOrder(
          ecbtcAddr,
          fusdAddr,
          PRICE_BTC_FUSD,
          0n,
          await enc(aliceClient, mBTC), // no value
        ),
      ).to.be.revertedWithCustomError(otc, "WrongBond");
    });

    it("only the maker can cancel; cannot cancel twice", async () => {
      const { alice, bob, otc, id } = await withOrder();
      await expect(otc.connect(bob).cancelOrder(id)).to.be.revertedWithCustomError(otc, "NotMaker");
      await (await otc.connect(alice).cancelOrder(id)).wait();
      await expect(otc.connect(alice).cancelOrder(id)).to.be.revertedWithCustomError(otc, "OrderClosed");
    });

    it("a cancelled order cannot be filled", async () => {
      const { alice, bob, otc, bobClient, id } = await withOrder();
      const bond = await otc.ethBondSize();
      await (await otc.connect(alice).cancelOrder(id)).wait();
      await expect(
        otc.connect(bob).fillOrder(id, await enc(bobClient, mBTC), { value: bond }),
      ).to.be.revertedWithCustomError(otc, "OrderNotActive");
    });

    it("a depositor can still recover a fill bond after the order is cancelled", async () => {
      const { alice, bob, ecbtc, fusd, otc, aliceClient, bobClient, otcAddr, fusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);
      await (await fusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await fusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        fusdAddr,
        PRICE_BTC_FUSD,
        0n,
        await enc(aliceClient, 2n * mBTC),
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
      const { alice, ecbtc, fusd, otc, aliceClient, otcAddr, fusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, ecbtc, ONE, fusd, 200n * ONE, otcAddr);

      // Sell side: ecBTC → fUSD (1 mBTC = $65 NANO).
      const sell = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        fusdAddr,
        PRICE_BTC_FUSD,
        0n,
        await enc(aliceClient, mBTC),
      );
      // Buy side: fUSD → ecBTC ($200 SMALL).
      const buy = await createAndActivate(
        otc,
        alice,
        aliceClient,
        fusdAddr,
        ecbtcAddr,
        PRICE_FUSD_BTC,
        0n,
        await enc(aliceClient, 200n * ONE),
      );

      const sellSide = await otc.getOrdersByPair(ecbtcAddr, fusdAddr);
      const buySide = await otc.getOrdersByPair(fusdAddr, ecbtcAddr);
      expect(sellSide.map(x => x)).to.deep.equal([sell]);
      expect(buySide.map(x => x)).to.deep.equal([buy]);

      const batch = await otc.getOrdersBatch([sell, buy]);
      expect(batch.length).to.equal(2);
      expect(batch[0].inputToken).to.equal(ecbtcAddr);
      expect(batch[1].inputToken).to.equal(fusdAddr);
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
      const { alice, bob, ecbtc, fusd, otc, aliceClient, bobClient, otcAddr, fusdAddr, ecbtcAddr } = await setup();

      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);
      await (await fusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await fusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

      const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      const expiry = now + 1_000n;
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        fusdAddr,
        PRICE_BTC_FUSD,
        expiry,
        await enc(aliceClient, mBTC),
      );

      // Before expiry: fill 200 raw ecBTC (cost $13).
      await fillAndPublish(otc, bob, bobClient, id, 200n);
      await expectBalance(ecbtc, bob.address, 200n);
      await expectBalance(fusd, bob.address, 1_000n * ONE - FILL_200RAW_FUSD);

      // Jump past expiry.
      await hre.network.provider.send("evm_increaseTime", [2_000]);
      await hre.network.provider.send("evm_mine");

      const bond = await otc.ethBondSize();
      await expect(
        otc.connect(bob).fillOrder(id, await enc(bobClient, mBTC), { value: bond }),
      ).to.be.revertedWithCustomError(otc, "OrderExpired");

      // Maker can still cancel the expired order to recover the escrow.
      await (await otc.connect(alice).cancelOrder(id)).wait();
      const order = await otc.getOrder(id);
      expect(order.active).to.equal(false);
      expect(order.closed).to.equal(true);
    });
  });
});
