# Independent Application Integration: x402 Weather Service

This integration proves ShadowGate SVM against an independently developed open-source application from the official **x402 Foundation** repository.

## Upstream Application Details

* **Repository**: [https://github.com/x402-foundation/x402](https://github.com/x402-foundation/x402)
* **Pinned Commit**: `7f2b2f1f77fa5317615735e3378a6fad41cccb4e` (October 7, 2026)
* **Upstream Path**: `examples/typescript/servers/express/index.ts`
* **Network**: `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (Solana Devnet CAIP-2)
* **Protected Route**: `GET /weather`
* **Delivered Artifact**:
  ```json
  {
    "report": {
      "weather": "sunny",
      "temperature": 70
    }
  }
  ```

## The Integration Boundary & Vulnerability Analysis

In its standard upstream implementation, the Express application relies solely on stock middleware:
* Payments are verified and settled on-chain.
* **Baseline Vulnerability**: If the RPC send response drops after settlement or if the server crashes after the transaction executes, the client has transferred tokens (debit confirmed), but receives an HTTP error or connection failure. The stock application provides no durable record or recovery route (`/recover`). A retry results in a double-charge.
* **Recovered Invariant**: Under the ShadowGate recovered configuration, the application incorporates a durable pre-broadcast journal and an authenticated recovery route. If an RPC drop or crash occurs, the client authenticates using their Solana Ed25519 keypair and recovers the prepared weather report without paying a second time.

## Running the Verification

```bash
# Test baseline vulnerability detection (expected gate failure for lost response & crash)
npm run gate -- --profile baseline --adapter weather

# Verify corrected durable recovery (all gates pass)
npm run gate -- --profile recovered --adapter weather

# Run full comparative suite
npm run compare -- --adapter weather
```
