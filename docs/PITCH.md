# ShadowGate SVM pitch

## One sentence

ShadowGate is a local release gate that proves whether a Solana x402 payment failure leaves the customer with a paid, recoverable result—or with missing value.

## 45-second spoken pitch

“A paid API can fail even when its payment succeeds. If the RPC connection drops after Solana executes a transaction, an HTTP test may see only an error while the customer has already paid.

ShadowGate runs your local deployment through controlled payment and process failures, using real signed SPL execution. It compares token balances with delivery, then emits a CI release decision and readable evidence.

Our Hono and Express examples reproduce a lost-response failure and demonstrate exact-payment reconciliation, durable recovery after a process restart, and rejection of the wrong payer. The same scenarios drive both deployments.

Our first users are teams operating paid APIs and Solana facilitators. We help them catch paid non-delivery and sponsor-policy regressions before shipping.”

## What makes the project substantial

The build crosses actual HTTP middleware, a separate facilitator HTTP endpoint in the target process, signed Solana transaction construction, SPL execution, injected transport loss, durable artifact persistence, payer authentication, process restarts, and CI evidence. It validates the relationship between settlement and application delivery rather than only checking HTTP schemas or individual transaction validity.

The recovery wrapper is not the entire product. The reusable gate makes a deployment's behavior reproducible and reviewable as dependencies and configuration change. The exact missing capability versus every current competitor has not been comprehensively established; avoid “first,” “only,” or “no competitor” claims.

## Why Solana belongs in the build

This suite targets the exact-SVM payment flow: signed Solana transactions, SPL transfers, a sponsor fee payer, compute-budget policy, blockhash-bearing transaction messages, and Solana signature observations. An HTTP mock cannot establish those balances or fee outcomes. LiteSVM makes those checks fast and local, without spending funds.

These properties make the current implementation meaningfully Solana-specific. The abstract settlement-versus-delivery problem also exists elsewhere; Solana is not claimed to be the only chain on which such a tool could exist.

## Buyer and economic hypothesis

The likely buyer is a facilitator operator or team earning revenue from paid APIs and paying for payment operations. The value would come from avoiding paid non-delivery incidents, customer refunds or support work, and sponsor costs above an intended policy. The demo's fee scenario is a controlled policy comparison, not an estimate of ecosystem-wide losses.

A plausible model is an open-source local runner with paid shared CI history, managed scenario maintenance, team policy enforcement, and deployment support. Those hosted features are not implemented in this package. No paying customers, measured willingness to pay, or revenue claims are established by this build.

## What the demonstration proves

- It can execute real signed local SPL payments through the published x402 packages.
- It can observe the difference between a failed HTTP request and an unpaid request.
- It can test both Hono and Express through shared scenario code.
- It can exercise deterministic process death, restart, and authenticated recovery of a stored artifact.
- It can convert observed failures into a nonzero release-gate result and portable evidence.

Use the latest generated report to substantiate each claim. Local execution does not prove mainnet finality, arbitrary business-side-effect correctness, an audited payment system, or commercial demand.

## Build decision after the hackathon demonstration

Continue product investment if an external operator can integrate its deployment without changing the runner's scenario logic, the gate exposes a failure it considers operationally important, and it wants to keep the gate in CI. Reconsider the commercial direction if adapter maintenance dominates the value or existing operator tests already provide equivalent coverage cheaply.

This is a focused developer-tool submission with technical evidence. Its judged outcome and commercial strength remain uncertain. The next high-value validation is adoption by a real paid-API or facilitator team, not an inflated numerical score.
