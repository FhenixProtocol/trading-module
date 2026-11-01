# Trading Module

`ConfidentialOTC` is a peer-to-peer venue for swapping one confidential (FHERC20) token for another on Fhenix CoFHE. Order sizes and fills stay encrypted; each order publishes a coarse size bracket so the book can be browsed.

Design reference: [docs/OTC_REFERENCE.md](docs/OTC_REFERENCE.md).

## Layout

```
contracts/OTC/ConfidentialOTC.sol   the module
contracts/interfaces/               IFHERC20, IERC7984, AggregatorV3Interface
contracts/FHERC20/, utils/          FHERC20 token the tests trade against (copied from fusd-jmi)
contracts/test/                     test harnesses and mocks
test/ConfidentialOTC.test.ts        Hardhat test suite (CoFHE mocks)
auditor/                            audit reports
```



## Usage

Requires Node 20+ and pnpm.

```sh
pnpm install
pnpm test          # compiles and runs the suite on the in-process Hardhat network
pnpm check-types   # TypeScript type check
pnpm format:sol    # forge fmt for Solidity
```



## Audits


| Report                                                          | Scope                                     |
| --------------------------------------------------------------- | ----------------------------------------- |
| Consensys Diligence, Fhenix OTC Contract Updates (October 2026) | `ConfidentialOTC.sol`, `a85f700..f13e9b6` |


