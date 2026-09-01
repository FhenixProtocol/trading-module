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
      const amt = await enc(aliceClient, mBTC, otc);

      await expect(
        otc.connect(alice).createOrder(await unlisted.getAddress(), fusdAddr, PRICE_BTC_FUSD, 0n, ...amt),
      ).to.be.revertedWithCustomError(otc, "TokenNotWhitelisted");

      await expect(
        otc.connect(alice).createOrder(ecbtcAddr, await unlisted.getAddress(), PRICE_BTC_FUSD, 0n, ...amt),
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
      const id = await createOrder(
        otc,
        alice,
        ecbtcAddr,
        fusdAddr,
        PRICE_BTC_FUSD,
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
        ...(await enc(aliceClient, 2n * mBTC, otc)),
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
        ...(await enc(aliceClient, 200n * ONE, otc)),
      );
      await expectBalance(fusd, otcAddr, 200n * ONE); // no cleanup fee anymore
      expect((await otc.getOrder(id)).bracket).to.equal(SMALL);
    });

    it("brackets from the oracle, so a maker cannot inflate their own size via price", async () => {
      const { alice, ecbtc, fusd, otc, aliceClient, otcAddr, fusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);

      // The bracket rate used to come from o.price on cANY→fUSD orders. At
      // uint64.max the overflow cap collapses to 1, so 1 raw unit multiplied
      // out to 17_592_186_044_415 ($17.6M) — 176x the WHALE floor. Sourcing
      // the rate from the ecBTC oracle values it at what it is: $0.000065.
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        fusdAddr,
        (1n << 64n) - 1n,
        0n,
        ...(await enc(aliceClient, 1n, otc)),
      );

      expect((await otc.getOrder(id)).bracket).to.equal(NANO);
    });

    it("reverts on zero address, same leg, zero price, and bad expiry", async () => {
      const { alice, otc, aliceClient, fusdAddr, ecbtcAddr } = await setup();
      const amt = await enc(aliceClient, mBTC, otc);

      await expect(
        otc.connect(alice).createOrder(ethers.ZeroAddress, fusdAddr, PRICE_BTC_FUSD, 0n, ...amt),
      ).to.be.revertedWithCustomError(otc, "ZeroAddress");

      await expect(
        otc.connect(alice).createOrder(fusdAddr, fusdAddr, PRICE_BTC_FUSD, 0n, ...amt),
      ).to.be.revertedWithCustomError(otc, "SameLeg");

      await expect(otc.connect(alice).createOrder(ecbtcAddr, fusdAddr, 0n, 0n, ...amt)).to.be.revertedWithCustomError(
        otc,
        "ZeroPrice",
      );

      const past = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) - 1n;
      await expect(
        otc.connect(alice).createOrder(ecbtcAddr, fusdAddr, PRICE_BTC_FUSD, past, ...amt),
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
        ...(await enc(aliceClient, mBTC, otc)),
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
        ...(await enc(aliceClient, mBTC, otc)),
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
        otc.connect(bob).fillOrder(id, ...(await enc(bobClient, mBTC, otc))), // no value
      ).to.be.revertedWithCustomError(otc, "WrongBond");
    });

    it("reverts on unknown, pending, or inactive orders", async () => {
      const { alice, bob, ecbtc, fusd, otc, aliceClient, bobClient, otcAddr, fusdAddr, ecbtcAddr } = await setup();
      const bond = await otc.ethBondSize();
      await expect(
        otc.connect(bob).fillOrder(999n, ...(await enc(bobClient, mBTC, otc)), { value: bond }),
      ).to.be.revertedWithCustomError(otc, "OrderNotFound");

      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);
      const id = await createOrder(
        otc,
        alice,
        ecbtcAddr,
        fusdAddr,
        PRICE_BTC_FUSD,
        0n,
        ...(await enc(aliceClient, mBTC, otc)),
      );
      await expect(
        otc.connect(bob).fillOrder(id, ...(await enc(bobClient, mBTC, otc)), { value: bond }),
      ).to.be.revertedWithCustomError(otc, "OrderNotActive");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // delisted token — trading halts, unwinding does not
  // ─────────────────────────────────────────────────────────────────────────

  describe("delisted token", () => {
    /// Active ecBTC → fUSD order, ready for a leg to be delisted under it.
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
      const { deployer, bob, otc, bobClient, fusdAddr, id } = await withOrder();
      await (await otc.connect(deployer).delistToken(fusdAddr)).wait();

      // Either direction moves the delisted token to a new holder for value,
      // so both legs gate — not just the one sitting in escrow.
      const bond = await otc.ethBondSize();
      await expect(otc.connect(bob).fillOrder(id, ...(await enc(bobClient, 400n, otc)), { value: bond }))
        .to.be.revertedWithCustomError(otc, "TokenNotWhitelisted")
        .withArgs(fusdAddr);
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
    /// Active ecBTC → fUSD order, ready for the contract to be paused under it.
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
      const { deployer, alice, ecbtc, fusd, otc, aliceClient, otcAddr, fusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);
      await (await otc.connect(deployer).pause()).wait();

      await expect(
        otc
          .connect(alice)
          .createOrder(ecbtcAddr, fusdAddr, PRICE_BTC_FUSD, 0n, ...(await enc(aliceClient, mBTC, otc))),
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
      const { deployer, alice, ecbtc, fusd, otc, aliceClient, otcAddr, fusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);

      // Created (escrow already moved) but not yet activated when the pause
      // lands. activateOrder is a publish, not an entry — it must stay open so
      // the order reaches a state the maker can reason about and cancel from.
      const id = await createOrder(
        otc,
        alice,
        ecbtcAddr,
        fusdAddr,
        PRICE_BTC_FUSD,
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
        ...(await enc(aliceClient, mBTC, otc)),
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
        ...(await enc(aliceClient, 2n * mBTC, otc)),
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
        ...(await enc(aliceClient, mBTC, otc)),
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
        await otc
          .connect(alice)
          .createOrder(ecbtcAddr, fusdAddr, PRICE_BTC_FUSD, 0n, ...(await enc(aliceClient, mBTC, otc)), {
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
      const { alice, bob, ecbtc, fusd, otc, aliceClient, otcAddr, fusdAddr, ecbtcAddr } = await setup();
      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);

      const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        fusdAddr,
        PRICE_BTC_FUSD,
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
      expect((await otc.getOrdersByPair(ecbtcAddr, fusdAddr)).length).to.equal(0);
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
        ...(await enc(aliceClient, mBTC, otc)),
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
        ...(await enc(aliceClient, 200n * ONE, otc)),
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
        ...(await enc(aliceClient, mBTC, otc)),
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
        otc.connect(bob).fillOrder(id, ...(await enc(bobClient, mBTC, otc)), { value: bond }),
      ).to.be.revertedWithCustomError(otc, "OrderExpired");

      // Maker can still cancel the expired order to recover the escrow.
      await (await otc.connect(alice).cancelOrder(id)).wait();
      const order = await otc.getOrder(id);
      expect(order.active).to.equal(false);
      expect(order.closed).to.equal(true);
    });

    it("delists on the next publish once expired, instead of staying listed", async () => {
      const { alice, bob, ecbtc, fusd, otc, aliceClient, bobClient, otcAddr, fusdAddr, ecbtcAddr } = await setup();

      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);
      await (await fusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await fusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

      const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      const id = await createAndActivate(
        otc,
        alice,
        aliceClient,
        ecbtcAddr,
        fusdAddr,
        PRICE_BTC_FUSD,
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
      expect((await otc.getOrdersByPair(ecbtcAddr, fusdAddr)).length).to.equal(0);
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
      await expect(otc.connect(deployer).setMaxPriceAge(3_600n))
        .to.emit(otc, "MaxPriceAgeUpdated")
        .withArgs(3_600n);
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
        await enc(aliceClient, mBTC),
      );

      await advance(TWO_DAYS + 1);
      expect(await otc.isEthPriceStale()).to.equal(true);

      // Both the maker and the taker path stay open. This is the regression
      // guard: an earlier revision reverted here, which meant a quiet keeper
      // halted every fill on every pair.
      const id2 = await createOrder(otc, alice, ecbtcAddr, fusdAddr, PRICE_BTC_FUSD, 0n, await enc(aliceClient, mBTC));
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
      const { deployer, alice, bob, ecbtc, fusd, otc, aliceClient, bobClient, otcAddr, fusdAddr, ecbtcAddr } = ctx;

      const feed = await deployFeed();
      await (await otc.connect(deployer).setEthUsdFeed(await feed.getAddress())).wait();

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

      await fillAndPublish(otc, bob, bobClient, id, mBTC);
      await expectBalance(ecbtc, bob.address, mBTC);
    });

    // ── per-token bracket prices (advisory only) ──────────────────────────

    it("flags stale token prices as advisory only — fills still work", async () => {
      const ctx = await setup();
      const { deployer, alice, bob, ecbtc, fusd, otc, aliceClient, bobClient, otcAddr, fusdAddr, ecbtcAddr } = ctx;

      await fundMaker(alice, ecbtc, ONE, fusd, 0n, otcAddr);
      await (await fusd.mint(bob.address, 1_000n * ONE)).wait();
      await (await fusd.connect(bob).setOperator(otcAddr, FAR_FUTURE)).wait();

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
        fusdAddr,
        PRICE_BTC_FUSD,
        0n,
        await enc(aliceClient, mBTC),
      );
      await fillAndPublish(otc, bob, bobClient, id, mBTC);
      await expectBalance(ecbtc, bob.address, mBTC);
    });

    it("never reports fUSD as stale — it is the pinned unit of account", async () => {
      const { otc, fusdAddr, ecbtcAddr } = await setup();

      await advance(TWO_DAYS * 5);

      expect(await otc.isPriceStale(fusdAddr)).to.equal(false);
      expect(await otc.isPriceStale(ecbtcAddr)).to.equal(true);
    });

    it("reports price age, and 0 for a token that was never priced", async () => {
      const { otc, ecbtcAddr } = await setup();

      expect(await otc.priceAge(ethers.Wallet.createRandom().address)).to.equal(0n);

      await advance(1_000);
      expect(await otc.priceAge(ecbtcAddr)).to.be.greaterThanOrEqual(1_000n);
    });
  });
});
