import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { runSuite } from './runner.js';
import { isReportId, publicReport, renderHtml, renderJunit } from './reports.js';
import type { RunReport } from './types.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_DIR = join(PROJECT_ROOT, 'evidence');
const PROFILES = new Set(['baseline', 'recovered', 'all']);

async function readReport(id: string): Promise<RunReport | undefined> {
  if (!isReportId(id)) return undefined;
  try {
    const report = JSON.parse(await readFile(join(EVIDENCE_DIR, `${id}.json`), 'utf8'));
    if (report.id !== id || !Array.isArray(report.results) || !report.summary) return undefined;
    return publicReport(report as RunReport);
  } catch { return undefined; }
}

async function listReports(): Promise<RunReport[]> {
  let names: string[];
  try { names = await readdir(EVIDENCE_DIR); } catch { return []; }
  const ids = names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)).filter(isReportId);
  const reports = await Promise.all(ids.map(readReport));
  return reports.filter((report): report is RunReport => report !== undefined)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** Strict size limit before JSON parsing; do not buffer arbitrary request bodies. */
async function readSmallJson(request: Request): Promise<unknown> {
  const maximum = 2048;
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new Error('body-too-large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid-json');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new Error('body-too-large'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw new Error('invalid-json'); }
}

export async function createDemoApp(port: number) {
  const app = new Hono();
  const initialReports = await listReports();
  let busy = false;
  let latest: RunReport | undefined = initialReports[0];
  let error: string | undefined;
  let jobId: string | undefined;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  app.use('*', async (context, next) => {
    // Binding loopback alone does not prevent browser DNS rebinding or cross-site POSTs.
    if (!allowedHosts.has(context.req.header('host') ?? '')) return context.json({ error: 'Local host only.' }, 403);
    context.header('Cache-Control', 'no-store');
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('Referrer-Policy', 'no-referrer');
    context.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    await next();
  });

  app.get('/', async context => context.html(await readFile(join(PROJECT_ROOT, 'web', 'index.html'), 'utf8')));
  app.get('/api/status', context => context.json({ busy, latest, error, jobId }));
  app.post('/api/run', async context => {
    const origin = context.req.header('origin');
    if ((origin && !allowedOrigins.has(origin)) || context.req.header('sec-fetch-site') === 'cross-site')
      return context.json({ error: 'Cross-origin runs are not allowed.' }, 403);
    if (!(context.req.header('content-type') ?? '').toLowerCase().startsWith('application/json'))
      return context.json({ error: 'Send application/json.' }, 415);
    if (busy) return context.json({ error: 'A run is already in progress.' }, 409);
    let body: unknown;
    try { body = await readSmallJson(context.req.raw); }
    catch (failure) {
      return context.json({ error: failure instanceof Error && failure.message === 'body-too-large' ? 'Request body exceeds 2 KiB.' : 'Invalid JSON body.' }, failure instanceof Error && failure.message === 'body-too-large' ? 413 : 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('profile' in body)
      || typeof body.profile !== 'string' || !PROFILES.has(body.profile)
      || Object.keys(body).some(key => key !== 'profile'))
      return context.json({ error: 'Choose profile: baseline, recovered, or all.' }, 400);
    // Recheck after the body await so simultaneous requests cannot start two suites.
    if (busy) return context.json({ error: 'A run is already in progress.' }, 409);
    const profile = body.profile as 'baseline' | 'recovered' | 'all';
    busy = true;
    error = undefined;
    jobId = randomUUID();
    const acceptedJobId = jobId;
    void Promise.resolve().then(async () => {
      latest = publicReport(await runSuite({ profile, outputDir: EVIDENCE_DIR }));
    }).catch((failure: unknown) => {
      error = failure instanceof Error ? failure.message.slice(0, 500) : 'The local suite failed.';
      console.error(`ShadowGate run failed: ${error}`);
    }).finally(() => { busy = false; });
    return context.json({ jobId: acceptedJobId }, 202);
  });
  app.get('/api/runs', async context => context.json({ runs: (await listReports()).map(report => ({
    id: report.id, createdAt: report.createdAt, passed: report.summary.passed,
    total: report.summary.total, profile: report.profile,
  })) }));
  app.get('/api/runs/:id/download', async context => {
    const report = await readReport(context.req.param('id'));
    if (!report) return context.json({ error: 'Report not found.' }, 404);
    const format = context.req.query('format') ?? 'json';
    if (!['json', 'junit', 'html'].includes(format)) return context.json({ error: 'Choose format: json, junit, or html.' }, 400);
    const extension = format === 'junit' ? 'xml' : format;
    context.header('Content-Disposition', `attachment; filename="shadowgate-${report.id}.${extension}"`);
    if (format === 'html') return context.html(renderHtml(report));
    if (format === 'junit') return context.body(renderJunit(report), 200, { 'Content-Type': 'application/xml; charset=utf-8' });
    return context.body(`${JSON.stringify(report, null, 2)}\n`, 200, { 'Content-Type': 'application/json; charset=utf-8' });
  });
  app.get('/api/runs/:id', async context => {
    const report = await readReport(context.req.param('id'));
    return report ? context.json(report) : context.json({ error: 'Report not found.' }, 404);
  });
  app.notFound(context => context.json({ error: 'Not found.' }, 404));
  app.onError((failure, context) => {
    console.error(`ShadowGate demo error: ${failure.message}`);
    return context.json({ error: 'The local demo encountered an error.' }, 500);
  });
  return app;
}

export async function startDemo() {
  const rawPort = process.env.PORT ?? '4173';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('PORT must be an integer from 1024 to 65535.');
  const app = await createDemoApp(port);
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
    console.log(`ShadowGate SVM demo: http://127.0.0.1:${port}`);
    console.log('Local LiteSVM execution only. All test tokens are valueless.');
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    server.close(() => process.exit(0));
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDemo().catch(failure => { console.error(failure instanceof Error ? failure.message : failure); process.exitCode = 1; });
}
