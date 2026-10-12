# ShadowGate SVM pitch

## One sentence

ShadowGate is a local release gate that proves whether a Solana x402 payment failure leaves the customer with a paid, recoverable result—or with missing value.

## 45-second spoken pitch

“A paid API can fail even when its payment succeeds. If an RPC connection drops or a server process terminates immediately after Solana settles a transaction, an HTTP test sees only a timeout while the customer's wallet has already been debited.

ShadowGate runs your local deployment through controlled transport and process faults, using genuine signed SPL execution inside LiteSVM. It compares on-chain token balances with actual HTTP delivery, emitting a deterministic CI release decision and portable audit evidence.

Through our reusable IntegrationAdapter, the exact same failure matrix drives official Hono and Express middleware, as well as an independently developed x402 Weather Service. It proves exact-payment reconciliation, durable recovery after a process restart (exit 86), and rejection of wrong-wallet replays—without double-charging the customer.

Our first users are teams operating paid APIs and Solana facilitators, helping them block paid non-delivery and fee-policy regressions before release.”

## What makes the project substantial

The build crosses actual HTTP middleware, a separate facilitator HTTP endpoint in the target process, signed Solana transaction construction, SPL execution, injected transport loss, durable artifact persistence, payer authentication, process restarts, and CI evidence. It validates the relationship between settlement and application delivery rather than only checking HTTP schemas or individual transaction validity.

The runner is decoupled from sample routes and journal schemas via the `IntegrationAdapter` interface. Any third-party application can configure its startup command, payment route, result checks, and recovery interface while preserving the core payment-to-delivery invariants.

The recovery wrapper is not the entire product. The reusable gate makes a deployment's behavior reproducible and reviewable as dependencies and configuration change. The exact missing capability versus every current competitor has not been comprehensively established; avoid “first,” “only,” or “no competitor” claims.

## Why Solana belongs in the build

This suite targets the exact-SVM payment flow: signed Solana transactions, SPL transfers, a sponsor fee payer, compute-budget policy, blockhash-bearing transaction messages, and Solana signature observations. An HTTP mock cannot establish those balances or fee outcomes. LiteSVM makes those checks fast and local, without spending funds.

These properties make the current implementation meaningfully Solana-specific. The abstract settlement-versus-delivery problem also exists elsewhere; Solana is not claimed to be the only chain on which such a tool could exist.

## Buyer and economic hypothesis

The likely buyer is a facilitator operator or team earning revenue from paid APIs and paying for payment operations. The value would come from avoiding paid non-delivery incidents, customer refunds or support work, and sponsor costs above an intended policy. The demo's fee scenario is a controlled policy comparison, not an estimate of ecosystem-wide losses.

A plausible model is an open-source local runner with paid shared CI history, managed scenario maintenance, team policy enforcement, and deployment support. Those hosted features are not implemented in this package. No paying customers, measured willingness to pay, or revenue claims are established by this build.

## What the demonstration proves

- It executes real signed local SPL payments through published x402 packages in sub-second time.
- It observes the difference between a failed HTTP transport response and an unpaid request.
- It drives 42 automated verification checks across three distinct adapters (Hono, Express, and the independent Weather Service pinned to commit `7f2b2f1`).
- It catches unsafe baseline behavior (release gate exits 1) and verifies corrected durable recovery (release gate exits 0).
- It exercises deterministic process death (exit code 86), restart, and authenticated Ed25519 recovery without double-debiting the customer (`counters.executed === 1`).
- It produces portable evidence bundles (JSON, JUnit XML, standalone HTML).

Use the latest generated report to substantiate each claim. Local execution does not prove mainnet finality, arbitrary business-side-effect correctness, an audited payment system, or commercial demand.

## Build decision after the hackathon demonstration

Continue product investment if an external operator can integrate its deployment without changing the runner's scenario logic, the gate exposes a failure it considers operationally important, and it wants to keep the gate in CI. Reconsider the commercial direction if adapter maintenance dominates the value or existing operator tests already provide equivalent coverage cheaply.

This is a focused developer-tool submission with technical evidence. Its judged outcome and commercial strength remain uncertain. The next high-value validation is adoption by a real paid-API or facilitator team, not an inflated numerical score.
