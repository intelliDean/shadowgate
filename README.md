# ShadowGate SVM

**Payment landed. Did the result arrive?**

ShadowGate is a local deployment regression gate for Solana x402 services. It runs real signed SPL token payments through a local Solana runtime, introduces failures at payment boundaries, and checks the token balances against the result returned to the payer. Its CLI produces a release decision and portable JSON, JUnit XML, and HTML evidence. Its demo interface runs the same tests.

The supplied Hono and Express deployments compare the published x402 middleware with a recovery example. The example persists the exact payment identity and immutable result before broadcast, reconciles ambiguous sends, and permits the verified payer to recover the stored result after an actual process restart.

## Verified build & Independent Application Verification

The suite exercises **42/42 expected experiment checks** across Hono, Express, and the independent **x402 Foundation Weather Service** (`integrations/weather/`, pinned to commit `7f2b2f1f77fa5317615735e3378a6fad41cccb4e`):
* **Official Frameworks (Hono & Express)**: 28 total checks (12 baseline + 16 recovered), retaining 6 baseline gate failures and 16 passing recovered gates.
* **Independent Application (Weather Service)**: 14 total checks (6 baseline + 8 recovered), proving detection of unsafe baseline behavior (3 release gate failures) and release approval under recovered persistence (8/8 gates passed).
* TypeScript checking passes cleanly (`tsc --noEmit`).

The dashboard launches real comparisons in Chromium, displays resulting ledger evidence, filters profiles, opens run history, and exports JUnit/JSON/HTML evidence.

## Run it

Use **Node.js 24 or later** and npm. Linux x64 or WSL2 Ubuntu recommended. No wallet, external RPC subscription, Docker, or real funds needed.

```bash
npm ci
npm test
npm run demo
```

Open **http://127.0.0.1:4173**. Choose baseline, recovered, or full comparison runs across Hono, Express, and Weather.

### CLI & Release Gate Commands

```bash
# Full matrix across all adapters (Hono, Express, Weather): 42 checks
npm run compare -- --adapter all

# Release gate for official Hono/Express deployments:
npm run gate -- --profile recovered --adapter hono
npm run gate -- --profile recovered --adapter express

# Release gate for the independent weather application:
# 1. Detect unsafe baseline configuration (exits 1):
npm run gate -- --profile baseline --adapter weather

# 2. Verify corrected durable recovery (exits 0):
npm run gate -- --profile recovered --adapter weather
```

`compare` exits zero when every experiment matches its stated expectation (including detecting baseline defects). `gate` exits zero only when all experiment assertions and release checks pass. **An expected defect remains a failed release check.**

Reports are saved under `evidence/` with a unique run ID. Each report includes token balances, HTTP status, observed delivery, actual local sponsor fees, and traces. The dashboard can download all three formats.

## What the suite exercises

Each case starts with new ephemeral keys, a fresh SPL mint, exactly one payment in the payer's account, and its own child deployment process. The runner uses the same scenario logic for both framework adapters.

| Scenario | Baseline fixture | Recovered fixture |
| --- | --- | --- |
| Normal payment | Payment and result | Payment and result |
| RPC response lost after successful execution | Detect paid request with no result; retry same payload | Reconcile exact signature and deliver |
| Failure before broadcast | No payment; withhold result | No payment; authenticated recovery of the prepared record returns 409 |
| First confirmation observation fails | Official SDK's existing retry recovers | Recovery path remains functional |
| Process exits after sending payment | Required crash is observed; restart has no recovery endpoint | Inspect prepared artifact on disk before restart; payer recovers that exact artifact |
| Compute budget exceeds sponsor policy | Uncapped fixture accepts it | Configured SDK cap rejects before payment |
| Wrong payer requests stored result | Not part of this profile | Public payment replay gets 409; wrong payer gets 403; rightful payer recovers |
| Repeated authorized recovery | Not part of this profile | Exact payment-bound artifact; exactly one successful payment execution |

The 28 experiment checks are `(6 baseline + 8 recovered) × 2 adapters`. Successful delivery requires the artifact ID to equal the SHA-256 digest of the payment's decoded transaction message. Crash cases must produce a transport disconnect, exit code 86, and the expected crash trace; a normal restart does not satisfy the test. Test counts describe the suite; the generated report is the source of truth for a particular run.

## Why this is useful

An HTTP-only test can miss a payment that already settled. A transaction-only test can miss a result the customer never received. ShadowGate checks both sides under controlled process and transport faults. The intended users are teams operating x402 paid APIs and Solana facilitators, especially those paying sponsor fees or handling paid non-delivery incidents.

The product is the reusable runner, deployment contract, evidence, and CI gate. The recovery wrapper is a concrete example of a change the gate can validate. Customer demand, willingness to pay, and exclusive novelty have not been established. A paid CI/team workflow is a business hypothesis, not existing revenue.

## Integrate a deployment

```bash
npm run gate -- --profile recovered --adapter hono --target ./my-target.ts
```

`--target` starts a **local child-process fixture that implements the documented IPC, HTTP, artifact, and journal contract**. It does not accept an arbitrary live URL or automatically adapt an existing application. Your adapter must connect your local deployment to the supplied mint, merchant, RPC, and fault controls. Recovered crash tests inspect a compatible prepared JSON journal before restart; another persistence design requires an adapted oracle. See [the integration contract](docs/INTEGRATION.md).

## Scope and trust boundaries

- Signed transactions and SPL execution are real inside LiteSVM. Tokens and lamports are local and valueless. No mainnet or devnet transactions are made.
- The bounded JSON-RPC bridge reports local execution as a confirmed status for SDK compatibility. It does not model validators, chain consensus, finality, reorgs, or network propagation.
- Hono and Express are separate middleware deployments. Both use the same official x402 facilitator implementation; this is not a comparison of two independent facilitator implementations.
- The recovered fixture uses a single-writer, fsynced, atomic JSON journal and a trusted local RPC. It is a reference implementation, not a production distributed store.
- Recovery requires the payer's Ed25519 proof bound to the payment message. The proof can be replayed to fetch the same immutable artifact; it is not a one-time session token.
- The fee scenario proves compute-limit rejection. Signature-count and compute-price caps are configured but are not independently exercised by this scenario. Existing configurable SDK policy is not presented as a new vulnerability.
- A passing gate covers the included fault scenarios. It does not establish a security audit, guarantee arbitrary side effects happen exactly once, or establish production readiness.

## Project map

| File | Responsibility |
| --- | --- |
| `src/runner.ts` | Framework-independent scenarios, child lifecycle, balance/result assertions |
| `src/fixture.ts`, `src/ledger.ts` | Real token fixture and bounded LiteSVM JSON-RPC bridge |
| `src/target.ts`, `src/journal.ts` | Hono/Express target and persistent recovery example |
| `src/cli.ts`, `src/reports.ts` | Release exit status, redacted JSON, JUnit and standalone HTML |
| `src/demo.ts`, `web/index.html` | Local demo API and interactive evidence interface |
| `.github/workflows/gate.yml` | CI verification and artifact upload |

Read [architecture](docs/ARCHITECTURE.md), [integration](docs/INTEGRATION.md), [the demo script](docs/DEMO.md), and [the pitch](docs/PITCH.md).

## Reproducibility and attribution

Direct versions are pinned and `package-lock.json` fixes the dependency graph: x402 core/SVM/Hono/Express **2.28.0**, LiteSVM **1.5.0**, Solana Kit **5.5.1**, web3.js **1.98.4**, SPL Token **0.4.14**, Hono **4.13.13**, and Express **5.1.0**. Published SDK code is used unchanged; instrumentation lives in the local target and RPC bridge.

- [Official x402 source](https://github.com/coinbase/x402)
- [LiteSVM source](https://github.com/LiteSVM/litesvm)
- [Solana documentation](https://solana.com/docs)

MIT licensed; see [LICENSE](LICENSE).
