# Three-minute demo script & walkthrough

Run this against fresh generated evidence. If an outcome differs from the expected experiment, inspect it rather than narrating a result that did not occur.

## Preparation

```bash
npm ci
npm test
npm run demo
```

- Open the interactive Mission Control dashboard at `http://127.0.0.1:4173`.
- A pre-rendered 1080p walkthrough is also generated at `demo/shadowgate-demo.mp4`.
- Keep a terminal open to run headless release-gate commands.
- A full comparison runs 42 checks across all three integration targets (Hono, Express, and Weather Service). Run it before recording if necessary, then show its actual run ID, timestamp, and audit trail.

---

## 0:00–0:30 — Show the payment-to-delivery failure

**Say:**  
*“In an x402 micropayment API, an agent pays for a digital resource on-chain. But what happens if an RPC connection drops or the server terminates right after the transaction confirms? The payment executes on Solana, but the customer never receives their paid result. ShadowGate checks on-chain settlement and HTTP delivery together.”*

1. In Mission Control, open the **Baseline Comparison** or start a baseline run.
2. Select the `lost-send-response` case for Hono or Express.
3. Show the ledger balance deltas: **payer 10,000 → 0, merchant 0 → 10,000**.
4. Show the HTTP response: the transport dropped, the customer received 500/timeout, and no protected artifact was delivered.
5. Point out the gate outcome: the baseline release gate **fails with exit code 1**.

**Say:**  
*“The customer was debited, the API took the funds, and the customer was left empty-handed. The test detected the vulnerability, so the release gate rightly blocked deployment.”*

---

## 0:30–1:15 — Prove durable recovery & process restart

**Say:**  
*“Now we switch to our recovered profile. Here, the target implements durable journal persistence and exact-signature reconciliation.”*

1. Switch profile to **Recovered**.
2. Inspect the same `lost-send-response` scenario:
   - The runner retries with the original payment identifier.
   - The server inspects its local journal, matches the settled Solana transaction signature, and serves the paid artifact **without re-debiting the customer**.
   - Show counter evidence: `counters.executed === 1`.
3. Open the `process-restart` case:
   - Highlight the fault event: the server process is killed with **exit code 86** immediately after transaction settlement.
   - Show the two distinct target process IDs: initial PID terminated, recovery PID spawned.
   - Show the prepared journal observed on disk before restart and authenticated recovery of that exact artifact.

**Say:**  
*“This is a completely new server process reading an atomic, fsync-committed journal on disk. It verifies the settled transaction and delivers the cached payload without charging the payer a second time.”*

---

## 1:15–1:50 — Show negative controls & authorization checks

1. **Wrong-payer recovery (`wrong-payer`)**:
   - Replay of public payment headers by an unauthorized wallet receives HTTP **403 Forbidden**.
   - Show that only the verified Ed25519 signer of the original payment can recover the artifact.
2. **Repeated recovery (`repeat-recovery`)**:
   - Verify that sequential recovery requests return the exact same artifact ID with only one transaction debit on the ledger.
3. **Pre-broadcast failure (`prebroadcast-failure`)**:
   - Show that when a transaction fails prior to broadcast, balances remain untouched (10,000 / 0), and any recovery attempt is rejected.
4. **Confirmation observation control (`confirmation-control`)**:
   - Confirm that standard facilitator behavior is preserved without regression.

**Say:**  
*“ShadowGate tests both positive and negative invariants: attackers cannot replay stolen signatures, and failures before broadcast never record false recoveries.”*

---

## 1:50–2:25 — Prove ecosystem reuse & the 42-check matrix

**Say:**  
*“ShadowGate is not coupled to one specific route or web framework. Its runner operates over a modular IntegrationAdapter contract.”*

1. In Mission Control, navigate through the **Target Selector**:
   - **Official Hono Fixture** (14 checks)
   - **Official Express Fixture** (14 checks)
   - **Independent Weather Service** (`integrations/weather`, pinned to commit `7f2b2f1` of `x402-foundation/x402`, 14 checks)
2. Total matrix: **42 out of 42 checks passing**.
3. In the terminal, execute a targeted headless release gate:
   ```bash
   npm run gate -- --profile recovered --adapter weather
   ```
4. Show the exit status (`0`) and the generated report paths.
5. In the dashboard's **Evidence** tab, show one-click exports for **JSON**, **JUnit XML**, and **standalone HTML**.

---

## 2:25–3:00 — Value proposition, LiteSVM reality, & submission scope

**Say:**  
*“Teams building Solana facilitators and paid APIs need to eliminate silent paid non-delivery and fee-policy regressions before hitting production. ShadowGate provides a portable, local gate that fits directly into CI pipelines.*

*Every transaction executed here is genuine signed SPL token execution inside an in-memory Solana Virtual Machine (LiteSVM 1.5.0)—running in sub-second time with zero devnet flakiness and zero gas cost.*

*ShadowGate proves real fault handling, deterministic restarts, and client recovery—ensuring that whenever money moves, the product delivers.”*

---

## Submission Checklist

- [x] All 42 checks passing across Hono, Express, and Weather Service targets.
- [x] Zero TypeScript compilation or linter warnings (`tsc --noEmit`).
- [x] Clean-install verification passes from scratch (`npm ci && npm test`).
- [x] Headless release gate exits with code 0 on recovered profile and code 1 on baseline.
- [x] Interactive Mission Control dashboard active on port 4173 with downloadable evidence bundles (JSON, JUnit XML, standalone HTML).
- [x] Full HD demo video rendered in `demo/shadowgate-demo.mp4` (ignored in `.gitignore`).
- [x] Pinned commit proof for the external `x402-foundation/x402` dependency (`7f2b2f1`).
