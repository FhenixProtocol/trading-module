import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import "@typechain/hardhat";
import "@cofhe/hardhat-plugin";

const config: HardhatUserConfig = {
  solidity: {
    compilers: [{ version: "0.8.27", settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 } } }],
    overrides: {
      // FHE-heavy (bracket recompute, multi-leg fills): overflows the stack on the legacy pipeline.
      "contracts/OTC/ConfidentialOTC.sol": {
        version: "0.8.27",
        settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 }, viaIR: true },
      },
    },
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
};

export default config;
