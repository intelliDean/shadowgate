import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getTransactionDecoder } from '@solana/kit';
import { Keypair } from '@solana/web3.js';
import type { IntegrationAdapter, JournalInspection, RecoveryRequest } from './types.js';

const decoder = getTransactionDecoder();
const MARKER = 'paid-result:shadowgate';

function createEd25519PrivateKey(secretKey: Uint8Array) {
  return createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(secretKey.slice(0, 32)),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function defaultRecoveryProof(payload: any, key: Keypair): RecoveryRequest {
  const tx = decoder.decode(Buffer.from(payload.payload.transaction, 'base64'));
  const messageHash = createHash('sha256').update(Buffer.from(tx.messageBytes)).digest('hex');
  const nonce = randomBytes(32).toString('hex');
  const secret = createEd25519PrivateKey(key.secretKey);
  const signature = sign(null, Buffer.from(`shadowgate-recover:v1:${messageHash}:${nonce}`), secret).toString('base64');
  return {
    body: { paymentPayload: payload, nonce, signature },
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  };
}

export async function defaultInspectJournal(journalPath: string): Promise<JournalInspection> {
  const content = await readFile(journalPath, 'utf8');
  const journal = JSON.parse(content);
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const entry = entries[0];
  return {
    prepared: entry?.state === 'prepared',
    artifact: entry?.artifact,
    entryCount: entries.length,
  };
}

export function createStandardFixtureAdapter(name: 'hono' | 'express'): IntegrationAdapter {
  return {
    name,
    title: `Official x402 ${name === 'hono' ? 'Hono' : 'Express'} Fixture`,
    paidRoute: '/paid',
    recoveryRoute: '/recover',
    defaultTarget: fileURLToPath(new URL('./target.ts', import.meta.url)),
    isDelivered(response) {
      return response.body?.artifact === MARKER;
    },
    matchesArtifact(recoveredBody, oracleBody, context) {
      if (recoveredBody?.artifact !== MARKER) return false;
      if (context.expectedArtifactId && recoveredBody?.artifactId !== context.expectedArtifactId) return false;
      if (oracleBody && JSON.stringify(recoveredBody) !== JSON.stringify(oracleBody)) return false;
      return true;
    },
    inspectJournal(journalPath) {
      return defaultInspectJournal(journalPath);
    },
    createRecoveryProof(payload, key) {
      return defaultRecoveryProof(payload, key);
    },
  };
}

export const honoAdapter = createStandardFixtureAdapter('hono');
export const expressAdapter = createStandardFixtureAdapter('express');

export const weatherAdapter: IntegrationAdapter = {
  name: 'weather',
  title: 'x402 Weather Service (x402-foundation/x402)',
  paidRoute: '/weather',
  recoveryRoute: '/recover',
  defaultTarget: fileURLToPath(new URL('../integrations/weather/target.ts', import.meta.url)),
  isDelivered(response) {
    return response.status === 200 && response.body?.report?.weather === 'sunny' && typeof response.body?.report?.temperature === 'number';
  },
  matchesArtifact(recoveredBody, oracleBody) {
    if (!recoveredBody?.report || recoveredBody.report.weather !== 'sunny') return false;
    if (oracleBody?.report) {
      return recoveredBody.report.weather === oracleBody.report.weather &&
             recoveredBody.report.temperature === oracleBody.report.temperature;
    }
    return true;
  },
  inspectJournal(journalPath) {
    return defaultInspectJournal(journalPath);
  },
  createRecoveryProof(payload, key) {
    return defaultRecoveryProof(payload, key);
  },
};

const registry = new Map<string, IntegrationAdapter>([
  ['hono', honoAdapter],
  ['express', expressAdapter],
  ['weather', weatherAdapter],
]);

export function registerAdapter(adapter: IntegrationAdapter): void {
  registry.set(adapter.name, adapter);
}

async function loadCustomAdapterModule(path: string): Promise<IntegrationAdapter | undefined> {
  const mod = await import(path);
  const candidate = mod.default || mod.adapter || mod;
  if (candidate && typeof candidate === 'object' && 'paidRoute' in candidate && 'isDelivered' in candidate) {
    return candidate as IntegrationAdapter;
  }
  return undefined;
}

export async function getAdapter(nameOrPath: string): Promise<IntegrationAdapter> {
  const existing = registry.get(nameOrPath.toLowerCase());
  if (existing) return existing;

  // Support path to custom adapter module
  if (nameOrPath.includes('/') || nameOrPath.endsWith('.ts') || nameOrPath.endsWith('.js')) {
    const custom = await loadCustomAdapterModule(nameOrPath);
    if (custom) return custom;
  }

  throw new Error(`Unknown or invalid adapter: "${nameOrPath}". Available: ${Array.from(registry.keys()).join(', ')}`);
}
