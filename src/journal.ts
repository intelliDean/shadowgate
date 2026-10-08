import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface PaidArtifact {
  artifact: 'paid-result:shadowgate';
  artifactId: string;
  content: { title: string; result: string };
}

export interface JournalEntry {
  messageHash: string;
  signature: string;
  payer: string;
  merchant: string;
  mint: string;
  amount: string;
  network: string;
  route: 'GET /paid';
  artifact: PaidArtifact;
  state: 'prepared' | 'confirmed';
  preparedAt: string;
  confirmedAt?: string;
}

export function messageDigest(message: Uint8Array): string {
  return createHash('sha256').update(message).digest('hex');
}

export function artifactFor(messageHash: string): PaidArtifact {
  return {
    artifact: 'paid-result:shadowgate',
    artifactId: messageHash,
    content: { title: 'ShadowGate paid analysis', result: 'This result belongs to the exact verified payment message.' },
  };
}

/** Single-process journal. Every prepared artifact is fsynced before any broadcast. */
export class PaymentJournal {
  private entries: Record<string, JournalEntry> = Object.create(null);

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) return;
    const file = JSON.parse(readFileSync(path, 'utf8'));
    if (file.version !== 1 || !Array.isArray(file.entries)) throw new Error('Unsupported or corrupt payment journal');
    for (const entry of file.entries) {
      if (!/^[a-f0-9]{64}$/.test(entry.messageHash) || !entry.signature || !entry.payer || entry.route !== 'GET /paid') {
        throw new Error('Invalid payment journal entry');
      }
      this.entries[entry.messageHash] = entry;
    }
  }

  get(messageHash: string): JournalEntry | undefined { return this.entries[messageHash]; }

  prepare(entry: JournalEntry): JournalEntry {
    const old = this.entries[entry.messageHash];
    if (old) {
      if (old.signature !== entry.signature || old.payer !== entry.payer || old.merchant !== entry.merchant || old.mint !== entry.mint || old.amount !== entry.amount || old.network !== entry.network) {
        throw new Error('Conflicting payment journal identity');
      }
      return old;
    }
    this.entries[entry.messageHash] = entry;
    this.flush();
    return entry;
  }

  confirm(messageHash: string): void {
    const entry = this.entries[messageHash];
    if (!entry) throw new Error('Cannot confirm an unprepared payment');
    if (entry.state === 'confirmed') return;
    entry.state = 'confirmed';
    entry.confirmedAt = new Date().toISOString();
    this.flush();
  }

  private flush(): void {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, entries: Object.values(this.entries) }, null, 2));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, this.path);
    const directory = openSync(dirname(this.path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
