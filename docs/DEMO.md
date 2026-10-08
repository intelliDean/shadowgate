# Three-minute demo

Run this against fresh generated evidence. If an outcome differs from the expected experiment, inspect it rather than narrating a result that did not occur.

## Preparation

```bash
npm ci
npm test
npm run demo
```

Open `http://127.0.0.1:4173`. Keep a terminal available for the release-gate command. A full comparison starts fresh local processes and can take time; run it before recording if necessary, then show its actual run ID and timestamp. Do not describe saved evidence as a live run.

## 0:00–0:30 — Show the failure

Say: “An agent pays an API. The payment executes, but an RPC connection drops. Did the API return the paid result? ShadowGate checks the payment ledger and the delivery together.”

Start **Baseline**, or open a recently completed baseline run. Select the lost-send-response case for Hono. Show its timestamp, HTTP result, and balance changes. The intended reproduction is payer 10,000 → 0, merchant 0 → 10,000, with no protected result. Open the trace showing runtime success and the dropped response.

Say: “The experiment detected the failure, so the experiment assertion passes. The release gate still fails.”

## 0:30–1:20 — Prove recovery

Run **Recovered**, or open its actual completed report. Inspect the same scenario. Show the exact-signature reconciliation trace, paid balances, and delivered artifact. Then open the process-restart case and show the two target process IDs, exit code 86, the prepared journal observed on disk before restart, and authenticated recovery of that exact artifact.

Say: “This is a new server process reading a durable record. It checks the exact saved transaction and returns the stored artifact without taking another payment.”

The persistence claim is limited to the single-writer journal and deterministic crash point exercised here.

## 1:20–1:55 — Show negative controls

Inspect wrong-payer recovery: replay of public payment data receives 409, the wrong wallet's request receives 403, and the rightful payer recovers successfully. Inspect the repeat-recovery case: the artifact ID matches the exact payment message across repeated requests, with one successful payment execution. Inspect prebroadcast failure: no payment and no protected result, including a rightful recovery request against the prepared record.

Mention the confirmation-observation control: “The official SDK already recovers this condition; our test preserves that behavior.” This establishes that the demo distinguishes working behavior from failures.

## 1:55–2:25 — Prove reuse and CI

Show Express cases in the same report. Explain that the same runner works across two independently started framework deployments, both using the same official facilitator implementation.

In the terminal:

```bash
npm run gate -- --profile recovered --adapter express
```

Show the exit status and generated report path. Download JSON, HTML, or JUnit from the evidence view. State that the baseline release gate intentionally exits nonzero; a comparison run alone is not a release gate.

## 2:25–3:00 — Product and scope

Say: “Facilitator and paid-API teams need to catch paid non-delivery and sponsor-policy regressions before release. ShadowGate is a reusable local gate with portable evidence. Developers connect their deployment through a controlled adapter. All transactions shown are real signed SPL execution in LiteSVM, using valueless local assets. This proves these fault cases, not mainnet finality or a security audit.”

Close on the side-by-side evidence and release outcome. The value is a repeatable deployment check, not a promise that every payment-system failure is solved.

## Before submission

- Publish the reviewed source repository and make sure clean-install instructions reproduce the gate on a second machine.
- Record a short demo with real run IDs, outcomes, and readable balance evidence.
- Add the repository and demo URLs to the event submission, with a concise scope and attribution statement.
- Verify the event's current eligibility and submission requirements on its official page.

This package does not publish a repository, upload a video, submit the entry, or deploy a mainnet/devnet application. A devnet check could provide additional integration evidence, but it would not replace the controlled local fault tests.
