import { AsyncLocalStorage } from 'node:async_hooks';
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { paymentMiddleware } from '@x402/express';
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { x402Facilitator } from '@x402/core/facilitator';
import { ExactSvmScheme as FacilitatorExact } from '@x402/svm/exact/facilitator';
import { ExactSvmScheme as ServerExact } from '@x402/svm/exact/server';
import { SOLANA_DEVNET_CAIP2, toFacilitatorSvmSigner } from '@x402/svm';
import { createKeyPairSignerFromBytes, getSignatureFromTransaction, getTransactionDecoder } from '@solana/kit';
import { PublicKey } from '@solana/web3.js';
import { messageDigest, PaymentJournal, type JournalEntry } from '../../src/journal.js';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

type TargetConfig = {
  adapter: string;
  mode: 'baseline' | 'recovered';
  rpcUrl: string;
  feeSecret: number[];
  merchant: string;
  mint: string;
  amount: string;
  journalPath: string;
  port?: number;
  fault: 'none' | 'before-send' | 'confirm' | 'crash-after-send';
  caps: boolean;
};

const NETWORK = SOLANA_DEVNET_CAIP2;
const decoder = getTransactionDecoder();
const context = new AsyncLocalStorage<{ messageHash: string; payer: string }>();
const servers: any[] = [];
let initialized = false;

function trace(event: any): void {
  process.send?.({ type: 'trace', event: { at: new Date().toISOString(), ...event } });
}

function decoded(payload: any): any {
  if (typeof payload?.payload?.transaction !== 'string' || payload.payload.transaction.length > 32_768) {
    throw new Error('Missing or oversized payment transaction');
  }
  return decoder.decode(Buffer.from(payload.payload.transaction, 'base64'));
}

function hashPayload(payload: any): string {
  return messageDigest(decoded(payload).messageBytes);
}

async function statusOf(rpcUrl: string, signature: string): Promise<any> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getSignatureStatuses',
      params: [[signature], { searchTransactionHistory: true }],
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Status RPC returned ${response.status}`);
  const body: any = await response.json();
  if (body.error) throw new Error('Status RPC error');
  return body.result?.value?.[0] ?? null;
}

function confirmed(status: any): boolean {
  return status?.err === null && ['confirmed', 'finalized'].includes(status.confirmationStatus);
}

async function listenHono(app: Hono, port = 0): Promise<string> {
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
  servers.push(server);
  if (!server.listening) await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as any).port}`;
}

export function weatherArtifact(): any {
  return {
    report: {
      weather: 'sunny',
      temperature: 70,
    },
  };
}

function validateConfig(config: TargetConfig): void {
  if (!['baseline', 'recovered'].includes(config.mode)) throw new Error('Invalid target mode');
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(config.rpcUrl)) throw new Error('Fixture RPC must be local');
  if (!/^\d+$/.test(config.amount) || BigInt(config.amount) <= 0n) throw new Error('Invalid payment amount');
}

function verifyPayerSignature(payer: string, messageHash: string, nonce: unknown, signature: unknown): boolean {
  if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/i.test(nonce) || typeof signature !== 'string') {
    return false;
  }
  try {
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), new PublicKey(payer).toBuffer()]),
      format: 'der',
      type: 'spki',
    });
    const proof = Buffer.from(signature, 'base64');
    return proof.length === 64 && verifySignature(null, Buffer.from(`shadowgate-recover:v1:${messageHash}:${nonce}`), key, proof);
  } catch {
    return false;
  }
}

async function createInstrumentedSigner(config: TargetConfig, journal: PaymentJournal | undefined) {
  const secret = Uint8Array.from(config.feeSecret);
  const key = await createKeyPairSignerFromBytes(secret);
  secret.fill(0);
  config.feeSecret.fill(0);
  const stockSigner = toFacilitatorSvmSigner(key, { defaultRpcUrl: config.rpcUrl });
  const signer: any = { ...stockSigner };
  let firstConfirmation = true;

  signer.sendTransaction = async (wire: string, network: any) => {
    const transaction: any = decoder.decode(Buffer.from(wire, 'base64'));
    const messageHash = messageDigest(transaction.messageBytes);
    const signature = getSignatureFromTransaction(transaction);
    const verified = context.getStore();

    if (journal) {
      if (!verified?.payer || verified.messageHash !== messageHash) {
        throw new Error('Send has no bound verified payment');
      }
      journal.prepare({
        messageHash,
        signature,
        payer: verified.payer,
        merchant: config.merchant,
        mint: config.mint,
        amount: config.amount,
        network: NETWORK,
        route: 'GET /weather',
        artifact: weatherArtifact() as any,
        state: 'prepared',
        preparedAt: new Date().toISOString(),
      });
      trace({ phase: 'journal_prepared', messageHash, signature, artifactPersisted: true });
    }

    if (config.fault === 'before-send') {
      trace({ phase: 'before_send_failure', signature });
      throw new Error('CONTROLLED_PREBROADCAST_FAILURE');
    }

    let sent: any;
    try {
      sent = await stockSigner.sendTransaction(wire, network);
    } catch (error) {
      if (!journal) throw error;
      const status = await statusOf(config.rpcUrl, signature);
      trace({ phase: 'ambiguous_send_reconciliation', signature, status });
      if (!confirmed(status)) throw error;
      journal.confirm(messageHash);
      sent = signature;
    }

    if (config.fault === 'crash-after-send') {
      await new Promise<void>(resolve => {
        if (!process.send) {
          resolve();
          return;
        }
        process.send(
          {
            type: 'trace',
            event: { at: new Date().toISOString(), phase: 'crash_after_send', signature, messageHash },
          },
          undefined,
          undefined,
          () => resolve()
        );
      });
      process.exit(86);
    }
    return sent;
  };

  if (config.fault === 'confirm') {
    signer.confirmTransaction = async (...args: any[]) => {
      if (firstConfirmation) {
        firstConfirmation = false;
        trace({ phase: 'confirm_observation_failure' });
        throw new Error('CONTROLLED_CONFIRM_OBSERVATION_FAILURE');
      }
      return (stockSigner.confirmTransaction as any)(...args);
    };
  }

  return signer;
}

function createFacilitatorApp(
  config: TargetConfig,
  journal: PaymentJournal | undefined,
  facilitator: x402Facilitator
): Hono {
  const facilitatorApp = new Hono();
  facilitatorApp.get('/supported', c => c.json(facilitator.getSupported() as any));

  const matchesConfig = (r: any) =>
    r?.scheme === 'exact' &&
    r.network === NETWORK &&
    r.payTo === config.merchant &&
    r.asset === config.mint &&
    r.amount === config.amount;

  for (const method of ['verify', 'settle'] as const) {
    facilitatorApp.post(`/${method}`, async c => {
      const body: any = await c.req.json();
      if (!matchesConfig(body.paymentRequirements)) {
        return c.json({ error: 'Fixture accepts only configured requirements' }, 400);
      }
      let result: any;
      if (method === 'settle' && journal) {
        const messageHash = hashPayload(body.paymentPayload);
        const prior = journal.get(messageHash);
        if (prior && confirmed(await statusOf(config.rpcUrl, prior.signature))) {
          journal.confirm(messageHash);
          result = { success: true, network: NETWORK, transaction: prior.signature, payer: prior.payer };
          trace({ phase: 'settlement_retry_reconciled', messageHash, signature: prior.signature });
          trace({ phase: method, result });
          return c.json(result);
        }
        const verification = await facilitator.verify(body.paymentPayload, body.paymentRequirements);
        if (!verification.isValid || !verification.payer) {
          result = {
            success: false,
            errorReason: verification.invalidReason ?? 'missing_verified_payer',
            transaction: '',
            network: NETWORK,
            payer: verification.payer ?? '',
          };
        } else {
          result = await context.run({ messageHash, payer: verification.payer }, () =>
            facilitator.settle(body.paymentPayload, body.paymentRequirements)
          );
          if (result.success) journal.confirm(messageHash);
        }
      } else {
        result = await facilitator[method](body.paymentPayload, body.paymentRequirements);
      }
      trace({ phase: method, result });
      return c.json(result);
    });
  }

  return facilitatorApp;
}

function checkRequiresRecovery(journal: PaymentJournal | undefined, header: string | undefined): boolean {
  if (!journal || !header) return false;
  try {
    const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    return Boolean(journal.get(hashPayload(payload)));
  } catch {
    return false;
  }
}

async function handleRecoveryRequest(
  body: any,
  config: TargetConfig,
  journal: PaymentJournal | undefined
): Promise<{ status: number; body: any }> {
  if (!journal) return { status: 404, body: { error: 'Recovery not enabled' } };
  let messageHash: string;
  try {
    messageHash = hashPayload(body.paymentPayload);
  } catch {
    return { status: 400, body: { error: 'Malformed payment payload' } };
  }
  const entry: JournalEntry | undefined = journal.get(messageHash);
  if (!entry) return { status: 404, body: { error: 'No prepared artifact for this payment' } };

  const authenticated = verifyPayerSignature(entry.payer, messageHash, body?.nonce, body?.signature);
  if (!authenticated) {
    trace({ phase: 'recovery_auth_rejected', messageHash });
    return { status: 403, body: { error: 'Payer signature required' } };
  }

  let status: any;
  try {
    status = await statusOf(config.rpcUrl, entry.signature);
  } catch {
    return { status: 503, body: { error: 'Payment observation unavailable; retry safely' } };
  }

  if (!confirmed(status)) return { status: 409, body: { error: 'Payment is not confirmed', paid: false } };
  journal.confirm(messageHash);
  trace({ phase: 'artifact_recovered', messageHash, signature: entry.signature, payerAuthenticated: true });
  return { status: 200, body: entry.artifact };
}

function createWeatherApp(
  config: TargetConfig,
  resourceCore: any,
  routes: any,
  journal: PaymentJournal | undefined
): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true, app: 'weather-express', mode: config.mode }));

  if (config.mode === 'recovered') {
    app.post('/recover', async (req, res, next) => {
      try {
        const result = await handleRecoveryRequest(req.body, config, journal);
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(result.status).json(result.body);
      } catch (error) {
        next(error);
      }
    });

    app.get('/weather', (req, res, next) => {
      if (checkRequiresRecovery(journal, req.header('PAYMENT-SIGNATURE'))) {
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(409).json({ error: 'Payment already prepared; use payer-authenticated /recover' });
        return;
      }
      next();
    });
  }

  app.use(paymentMiddleware(routes, resourceCore));

  app.get('/weather', (_req, res) => {
    res.json(weatherArtifact());
  });

  return app;
}

async function initialize(config: TargetConfig): Promise<void> {
  validateConfig(config);

  const journal = config.mode === 'recovered' ? new PaymentJournal(config.journalPath) : undefined;
  const signer = await createInstrumentedSigner(config, journal);

  const scheme = new FacilitatorExact(
    signer,
    undefined,
    config.caps
      ? {
          maxComputeUnits: 60_000,
          maxRequiredSignatures: 2,
          maxPriorityFeeMicroLamports: 1_000,
        }
      : undefined
  );
  const facilitator = new x402Facilitator().register(NETWORK, scheme);
  const facilitatorApp = createFacilitatorApp(config, journal, facilitator);
  const facilitatorUrl = await listenHono(facilitatorApp);

  const resourceCore = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl })).register(
    NETWORK,
    new ServerExact({ rpcUrl: config.rpcUrl })
  );

  const routes: any = {
    'GET /weather': {
      accepts: [
        {
          scheme: 'exact',
          network: NETWORK,
          payTo: config.merchant,
          price: { asset: config.mint, amount: config.amount },
        },
      ],
      description: 'Weather data from x402-foundation example',
      mimeType: 'application/json',
    },
  };

  const app = createWeatherApp(config, resourceCore, routes, journal);
  const server = app.listen(config.port ?? 0, '127.0.0.1');
  servers.push(server);
  if (!server.listening) await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as any).port}`;

  process.send?.({ type: 'ready', url, pid: process.pid });
}

process.on('message', message => {
  const data: any = message;
  if (data?.type === 'init' && !initialized) {
    initialized = true;
    initialize(data.config).catch(error => {
      process.send?.({ type: 'error', message: String(error), stack: error?.stack });
      process.exitCode = 1;
      for (const server of servers) {
        server.closeAllConnections?.();
        server.close();
      }
      process.disconnect?.();
    });
  } else if (data?.type === 'stop') {
    for (const server of servers) {
      server.closeAllConnections?.();
      server.close();
    }
    process.disconnect?.();
  }
});

process.on('disconnect', () => {
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
});
