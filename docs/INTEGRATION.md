# Integrate a local deployment

ShadowGate starts a controlled child process so it can inject failures and restart it reproducibly. `--target` is a JavaScript or TypeScript **entry point**, not a remote service URL. The runner loads it using Node's `--import tsx`. Only run target code you trust: it executes locally with your user's permissions.

```bash
# Run release gate for standard Hono or Express fixtures
npm run gate -- --profile recovered --adapter hono

# Run release gate for the independent weather application
npm run gate -- --profile recovered --adapter weather

# Run release gate with a custom target entry point
npm run gate -- --profile recovered --adapter hono --target ./my-target.ts
```

---

## The Reusable Adapter Contract

ShadowGate decouples the testing engine from sample routes and journal schemas using the `IntegrationAdapter` interface defined in `src/types.ts`:

```ts
export interface IntegrationAdapter {
  name: string;
  title?: string;
  paidRoute: string;        // e.g. '/paid' or '/weather'
  recoveryRoute: string;    // e.g. '/recover'
  defaultTarget?: string;   // Optional default entrypoint file
  startupCommand?: string;  // Optional custom process command

  // Invariant checks
  isDelivered(response: { status: number; body: any; headers?: any }, context: DeliveryContext): boolean;
  matchesArtifact(recoveredBody: any, oracleBody: any, context: DeliveryContext): boolean;
  inspectJournal(journalPath: string, context: DeliveryContext): Promise<JournalInspection> | JournalInspection;
  createRecoveryProof(payload: any, key: Keypair, context: DeliveryContext): Promise<RecoveryRequest> | RecoveryRequest;
  launch?(config: any, trace: any[], target?: string): Promise<{ child: any; url: string; close: () => Promise<void> }>;
}
```

### Decoupled Assumptions

1. **Custom Payment Route**: Applications configure `paidRoute` (such as `GET /weather` instead of `GET /paid`).
2. **Custom Artifact Identity**: `isDelivered` and `matchesArtifact` allow arbitrary response payloads (such as `{ report: { weather: "sunny", temperature: 70 } }`) rather than hardcoded `{ artifact: "paid-result:shadowgate" }` markers.
3. **Pluggable Journal Inspection**: `inspectJournal` abstracts the persistence layer. Applications backed by custom databases, SQLite, or file formats supply their own verification of prepared durable state before process restart.
4. **Pluggable Recovery Interface**: `createRecoveryProof` formats recovery requests according to the target's authentication scheme.

---

## Independent Application Case Study: x402 Foundation Weather Service

As required by the hackathon integration benchmark, ShadowGate has been proven against an independently developed application:

* **Source**: [x402-foundation/x402](https://github.com/x402-foundation/x402)
* **Pinned Commit**: `7f2b2f1f77fa5317615735e3378a6fad41cccb4e` (October 7, 2026)
* **Application Path**: `examples/typescript/servers/express`
* **Route**: `GET /weather`
* **Artifact**: `{ report: { weather: "sunny", temperature: 70 } }`

### Baseline vs. Recovered Behavior

* **Baseline**: The stock example does not persist payment state before broadcast and lacks a `/recover` endpoint. When tested under ShadowGate (`--profile baseline --adapter weather`):
  - Lost RPC responses leave the payer charged without a delivered report (`gate FAIL`).
  - Process termination causes total loss of result (`gate FAIL`).
  - Uncapped fee submissions accept excessive sponsor fees (`gate FAIL`).
* **Recovered**: Attached via `integrations/weather/target.ts` and `integrations/weather/adapter.ts`:
  - Payment and report are prepared durably before transaction broadcast.
  - After process termination (code 86), the payer authenticates with Ed25519 proof to `/recover` and receives their report without double-payment (`gate PASS`).
  - Unrelated wallets are denied (403), public replays are rejected (409), and repeated recovery is idempotent (`gate PASS`).

---

## Initialization Protocol

When launching targets via the standard child process runner, the parent sends:

```ts
{
  type: 'init',
  config: {
    adapter: string,
    mode: 'baseline' | 'recovered',
    rpcUrl: string,        // Loopback LiteSVM JSON-RPC bridge URL
    feeSecret: number[],  // Ephemeral sponsor key bytes
    merchant: string,    // Recipient public key
    mint: string,        // Ephemeral SPL mint
    amount: '10000',     // Raw units
    journalPath: string, // Durable persistence path
    caps: boolean,       // Whether sponsor budget caps are active
    fault: 'none' | 'before-send' | 'confirm' | 'crash-after-send'
  }
}
```

Once the application is listening on `127.0.0.1`:
```ts
process.send?.({ type: 'ready', url: 'http://127.0.0.1:PORT', pid: process.pid });
```

---

## Fault Contracts

- `before-send`: throw before the underlying broadcast. Payer token balance must remain untouched. In recovered mode, an attempt to recover against an unbroadcast/unpaid record must receive HTTP 409.
- `confirm`: fail the first confirmation observation, then allow normal retry to succeed.
- `crash-after-send`: after transaction send succeeds, send IPC trace `{ phase: 'crash_after_send' }` and terminate with exit code **86**.
- `none`: standard execution.

---

## CI & Automated Release Gates

In your GitHub Actions workflow:

```yaml
- name: Verify release gate
  run: |
    npm ci
    npm run gate -- --profile recovered --adapter weather --output evidence/ci
```

A nonzero exit code indicates an unsafe deployment and halts the pipeline.
