# Integrate a local deployment

ShadowGate starts a controlled child process so it can inject failures and restart it reproducibly. `--target` is a JavaScript or TypeScript **entry point**, not a remote service URL. The runner loads it using Node's `--import tsx`. Only run target code you trust: it executes locally with your user's permissions.

```bash
npm run gate -- --profile recovered --adapter hono --target ./my-target.ts
```

Start from `src/target.ts`. Keep the IPC, HTTP, artifact, and journal contract; replace the framework startup, facilitator wiring, and actual application artifact handling with your deployment. You must explicitly connect local RPC, credentials, policies, persistent storage, and the fault hooks. The current recovered crash oracle directly inspects a prepared JSON journal at `journalPath`. A deployment with different persistence needs a compatible fixture representation or an explicitly adapted oracle. ShadowGate does not inject these into an arbitrary unmodified application automatically.

## Initialization protocol

The parent forks the entry point with an IPC channel and sends:

```ts
{
  type: 'init',
  config: {
    adapter: 'hono' | 'express',
    mode: 'baseline' | 'recovered',
    rpcUrl: string,        // Fresh local bridge; use for every chain operation.
    feeSecret: number[],  // Ephemeral sponsor key bytes; never log or persist.
    merchant: string,    // Recipient public key.
    mint: string,        // Ephemeral SPL mint, six decimal places.
    amount: '10000',     // Raw units; payer holds exactly one payment.
    journalPath: string, // Same path is supplied when this case restarts.
    caps: boolean,
    fault: 'none' | 'before-send' | 'confirm' | 'crash-after-send'
  }
}
```

The provided fixture uses the Solana devnet CAIP-2 identifier as the SDK network identifier **while overriding every RPC to the local bridge**. This does not connect to devnet. Do not fall back to a public RPC or external facilitator.

Bind the resource server to `127.0.0.1` on an available port. Once it is ready:

```ts
process.send?.({ type: 'ready', url: 'http://127.0.0.1:PORT', pid: process.pid });
```

On initialization failure send `{type:'error', message:'...'}` and close resources. The runner allows 25 seconds for startup. Trace messages use `{type:'trace', event:{phase:'...', ...publicEvidence}}`. Never include private keys, signed payment payloads, bearer tokens, or other credentials in trace fields. Child stdout is not published in reports; this is not permission to log secrets there.

The parent stops the child with SIGTERM and can escalate to SIGKILL. Release listeners on parent IPC disconnection. For restart cases a new child receives the same deployment binding and journal path, with `fault:'none'`.

## HTTP contract

| Request | Required behavior |
| --- | --- |
| `GET /paid` without payment | HTTP 402 with a base64 JSON `PAYMENT-REQUIRED` header containing an x402 v2 exact-SVM offer for the configured payment |
| `GET /paid` with `PAYMENT-SIGNATURE` | Verify, settle, and return the protected artifact according to the implementation under test |
| `GET /paid` replaying an already-paid payload after restart | In recovered mode, return 409 without the artifact; public payment data is not recovery authorization |
| `POST /recover` | In recovered mode, authenticate the rightful payer and return the persisted artifact only after exact-payment reconciliation |

The supplied scenario oracle recognizes the artifact marker and requires the exact payment-bound artifact ID for successful payment/recovery cases:

```json
{
  "artifact": "paid-result:shadowgate",
  "artifactId": "lowercase SHA-256 hex digest of decoded transaction.messageBytes"
}
```

Decode the original base64 payment transaction and hash its message bytes, not its wire bytes or transaction signature. Return that digest as `artifactId`. After a recovered crash, the response body must also equal the artifact read from disk before restart. The runner currently compares these bodies using `JSON.stringify`, so preserve the same JSON property order as well as values. Repeated recovery must retain the exact artifact ID. The current oracle is specialized to this paid-artifact contract. To test another response model, deliberately adapt the oracle and add appropriate assertions; a superficial marker is not proof that arbitrary application work is correct.

Recovery body:

```ts
{
  paymentPayload: object, // Original payment, including its transaction.
  nonce: string,          // 64 hex characters.
  signature: string       // Base64 Ed25519 proof, not transaction signature.
}
```

The proof signs `shadowgate-recover:v1:<SHA256(transaction.messageBytes)>:<nonce>`. The target must authenticate the payer from its verified payment record, not a caller-supplied payer field. Wrong-payer recovery must return 403. In the before-send case, a valid payer proof against a prepared but unpaid record must return 409 without the artifact. Unavailable payment observation must also withhold the artifact.

## Fault contract

- `before-send`: throw before the underlying broadcast; in recovered mode prepare the recovery record first. No token transfer or protected delivery is acceptable. In recovered mode the runner also attempts authenticated recovery and requires HTTP 409.
- `confirm`: fail the first confirmation observation, then permit the normal implementation to recover. This is a positive control for existing SDK retry behavior.
- `crash-after-send`: after successful broadcast returns, flush an IPC trace with `phase:'crash_after_send'`, then exit the process with code **86** before completing settlement and HTTP delivery. The initial request must disconnect; the runner records transport failure as status `0`. A missing crash trace, another exit code, or an HTTP response fails this experiment. Persist the prepared artifact before broadcast and leave its state `prepared` at this boundary.
- `none`: no target-internal fault.

The runner separately injects lost RPC responses after real execution in its bridge. Do not implement that case by simply pretending the payment happened.

With `caps:true`, the reference target configures `maxComputeUnits:60000`, `maxRequiredSignatures:2`, and `maxPriorityFeeMicroLamports:1000`. The fee-policy case submits one million compute units at one million micro-lamports per unit. It requires rejection without payment for the recovered profile. This case specifically exercises the compute-unit limit.

## Prepared journal contract

Before restarting a recovered crash case, the runner reads `config.journalPath` directly. It requires JSON with **exactly one** entry whose state is `prepared`, saves its artifact as the recovery oracle, and only then starts the replacement process. The reference journal shape is:

```ts
{
  version: 1,
  entries: [{
    messageHash: string,  // SHA-256 of decoded transaction.messageBytes.
    signature: string,    // Exact fully signed transaction signature.
    payer: string,        // Identity from official payment verification.
    merchant: string,
    mint: string,
    amount: '10000',
    network: string,
    route: 'GET /paid',
    artifact: object,     // Full immutable response body, including exact ID.
    state: 'prepared',
    preparedAt: string
  }]
}
```

The reference target needs the binding fields to reload and authenticate recovery; the runner checks entry count, prepared state, and the stored artifact against the eventual response. Merely reconstructing a fresh response after restart does not satisfy this oracle unless it matches the artifact already observed on disk. The recovered case also requires exactly one successful payment execution in the local ledger.

This is a controlled single-writer fixture contract, not a generic database-inspection API. If your deployment uses a different database or artifact layout, implement a truthful compatible fixture snapshot backed by its actual persistence, or replace the journal oracle with one that directly verifies that design. Do not emit an artificial journal merely to pass a test while leaving the real application's persistence unchecked.

## Profiles and results

Baseline means the provided uncapped, nonpersistent deployment configuration. Recovered means the provided persistent recovery and capped configuration. These are fixture configurations, not universal labels applied to every SDK user.

`--adapter hono` and `--adapter express` select the configuration passed to the target. A custom target supporting only one framework should select only that adapter. Both bundled adapters still share the same facilitator SDK implementation.

The gate checks actual payer/merchant token balances and sponsor fees from the fixture. Successful payment requires the payer to move from 10,000 to zero raw token units and the merchant from zero to 10,000. Successful payment/recovery cases additionally require exactly one successful payment execution. Crash-recovery and replay cases reuse the same ledger. The wrong-payer case checks public payment replay (409), a different wallet's recovery proof (403), and then rightful recovery of the persisted artifact.

## CI adoption

Commit the adapter beside your application. Install from the lockfile, run a recovered release gate with your target, and retain its reports:

```bash
npm ci
npm run gate -- --profile recovered --adapter hono --target ./my-target.ts --output evidence/ci
```

Treat a nonzero gate status as a failed release check. Do not use `compare` as the sole release gate: expected unsafe baselines can make the comparison experiment succeed. The supplied workflow runs tests and a recovered gate, then uploads `evidence/` even when a command fails.

The bundled target is a starting implementation, not a drop-in production payment service. Before transferring the recovery pattern into production, design for your artifact lifecycle, persistent database, concurrent workers, RPC trust, authentication lifecycle, and operational failure modes.
