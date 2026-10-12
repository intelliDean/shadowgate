import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CaseResult, RunReport } from './types.js';

/** IDs are file names, never paths. Shared by the local report API. */
export function isReportId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
    && !value.includes('..');
}

const PRIVATE_FIELD = /(?:private[_-]?key|secret|seed[_-]?phrase|mnemonic|authorization|payment[_-]?signature|payment[_-]?payload|signed[_-]?transaction|raw[_-]?transaction|serialized[_-]?transaction)/i;

/** Defense in depth: export evidence, not credentials or reusable payment payloads. */
export function publicReport<T>(value: T): T {
  const seen = new WeakSet<object>();
  function visit(input: unknown, depth: number): unknown {
    if (depth > 30) return '[depth limit]';
    if (typeof input === 'bigint') return input.toString();
    if (input === null || typeof input !== 'object') return input;
    if (seen.has(input)) return '[circular]';
    seen.add(input);
    const result = Array.isArray(input) ? input.map(item => visit(item, depth + 1))
      : Object.fromEntries(Object.entries(input).map(([key, item]) => [
      key, PRIVATE_FIELD.test(key) ? '[redacted]' : visit(item, depth + 1),
    ]));
    seen.delete(input);
    return result;
  }
  return visit(value, 0) as T;
}

function escape(value: unknown): string {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? '';
}

function renderCaseCard(result: CaseResult): string {
  return `<article class="case ${result.gatePassed ? 'safe' : 'unsafe'}">
    <div class="case-top"><span class="eyebrow">${escape(result.adapter)} / ${escape(result.scenario)}</span>
      <span class="badge ${result.gatePassed ? 'pass' : 'fail'}">${result.gatePassed ? 'Gate passed' : 'Gate failed'}</span></div>
    <h2>${escape(result.title)}</h2>
    <p class="experiment">Experiment assertion: <strong>${result.passed ? 'matched the expected outcome' : 'DID NOT match the expected outcome'}</strong></p>
    <dl><dt>Expected</dt><dd>${escape(result.expected)}</dd><dt>Observed</dt><dd>${escape(result.observed)}</dd></dl>
    <div class="metrics"><div><span>HTTP</span><b>${escape(result.httpStatus)}</b></div><div><span>Payment transferred</span><b>${result.paymentTransferred ? 'Yes' : 'No'}</b></div><div><span>Resource delivered</span><b>${result.resourceDelivered ? 'Yes' : 'No'}</b></div><div><span>Fee (lamports)</span><b>${escape(result.feeLamports)}</b></div></div>
    <table><caption>Token balance evidence (raw units)</caption><thead><tr><th>Account</th><th>Before</th><th>After</th></tr></thead><tbody><tr><th>Payer</th><td>${escape(result.before.payer)}</td><td>${escape(result.after.payer)}</td></tr><tr><th>Merchant</th><td>${escape(result.before.merchant)}</td><td>${escape(result.after.merchant)}</td></tr></tbody></table>
    ${result.limitations?.length ? `<ul class="limits">${result.limitations.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : ''}
    <details><summary>Execution trace (${result.trace.length} events)</summary><pre>${escape(pretty(result.trace))}</pre></details>
  </article>`;
}

const REPORT_STYLES = `:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#091013;color:#ecf4f4}*{box-sizing:border-box}body{margin:0;padding:40px 24px 72px}main{max-width:1040px;margin:auto}header{margin-bottom:30px}.eyebrow{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#9fb7bd}h1{font-size:clamp(30px,5vw,52px);letter-spacing:-.05em;line-height:1.04;margin:14px 0}h2{font-size:22px;letter-spacing:-.03em;margin:14px 0}p{line-height:1.65;color:#b6c9cc}.intro{max-width:760px}.summary,.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.summary>div,.metrics>div{padding:16px;background:#132025;border:1px solid #26383f;border-radius:10px}b{display:block;margin-top:5px;font-size:24px}.summary span,.metrics span{font-size:12px;color:#a7bec5}.metadata{overflow-wrap:anywhere;font-size:12px}.case{padding:24px;margin-top:18px;border:1px solid #2a3e45;border-left:4px solid #4bc8a2;border-radius:12px;background:#101a1e}.case.unsafe{border-left-color:#ef856d}.case-top{display:flex;justify-content:space-between;align-items:center;gap:12px}.badge{font-size:11px;white-space:nowrap;border-radius:30px;padding:6px 10px}.pass{color:#8bf0c5;background:#19382d}.fail{color:#ffb5a5;background:#42261e}.experiment{font-size:13px}.experiment strong{color:#dce9eb}dl{display:grid;grid-template-columns:84px 1fr;gap:10px;font-size:13px;line-height:1.6}dt{color:#8da7b0}dd{margin:0;overflow-wrap:anywhere}.metrics{margin:20px 0}.metrics b{font-size:17px}table{width:100%;border-collapse:collapse;font-size:13px;margin:18px 0}caption{text-align:left;margin:10px 0;color:#91adb5;font-size:12px}th,td{text-align:left;border-bottom:1px solid #26383f;padding:10px 8px;overflow-wrap:anywhere}thead th{font-weight:500;color:#91adb5}.limits{font-size:12px;line-height:1.7;color:#b5bbc6;padding-left:20px}details{margin-top:20px}summary{cursor:pointer;font-size:13px;color:#84d8c2}pre{padding:18px;background:#091013;border-radius:8px;font-size:11px;line-height:1.7;overflow:auto;max-height:480px;white-space:pre-wrap;overflow-wrap:anywhere}.notice{padding:18px;border:1px solid #494137;background:#221e17;border-radius:10px;font-size:13px;margin-top:24px}footer{font-size:12px;color:#8ca4ad;margin-top:28px}@media(max-width:640px){body{padding:22px 14px}.summary,.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.case{padding:18px}dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:10px}.case-top{align-items:flex-start}}`;

export function renderHtml(input: RunReport): string {
  const report = publicReport(input);
  const safe = report.results.filter(result => result.gatePassed).length;
  const unsafe = report.results.length - safe;
  const cards = report.results.map(renderCaseCard).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ShadowGate evidence · ${escape(report.id)}</title>
  <style>${REPORT_STYLES}</style></head><body><main>
  <header><div class="eyebrow">ShadowGate SVM / Reproducible local evidence</div><h1>Payment landed.<br>Did the result arrive?</h1><p class="intro">This report compares actual local Solana token execution with the HTTP result the payer received. Experiment success means the expected behavior was reproduced. A gate failure remains unsafe even when the experiment correctly detected it.</p><p class="metadata">Run ${escape(report.id)} · ${escape(report.createdAt)} · Profile ${escape(report.profile)} · ${escape(report.durationMs)} ms</p></header>
  <section class="summary" aria-label="Run summary"><div><span>Experiment assertions passed</span><b>${escape(report.summary.passed)} / ${escape(report.summary.total)}</b></div><div><span>Gate checks passed</span><b>${safe}</b></div><div><span>Gate checks failed</span><b>${unsafe}</b></div><div><span>Runtime</span><b style="font-size:14px">${escape(typeof report.runtime === 'string' ? report.runtime : pretty(report.runtime))}</b></div></section>
  <div class="notice">Local execution with valueless tokens. LiteSVM evidence does not establish mainnet consensus, finality, production security, or a complete payment-system audit. A safe result applies only to the scenarios and pinned deployment tested.</div>
  ${report.limitations?.length ? `<ul class="limits">${report.limitations.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : ''}
  ${cards}<footer>Generated by ShadowGate SVM. This file is standalone. Its observations are evidence of a particular test run, not a security certification.</footer></main></body></html>`;
}

export function renderJunit(input: RunReport): string {
  const report = publicReport(input);
  const failures = report.results.filter(result => !result.gatePassed).length;
  const cases = report.results.map(result => {
    const detail = pretty({ expected: result.expected, observed: result.observed,
      experimentAssertionPassed: result.passed, gatePassed: result.gatePassed,
      httpStatus: result.httpStatus, paymentTransferred: result.paymentTransferred,
      resourceDelivered: result.resourceDelivered, feeLamports: result.feeLamports,
      before: result.before, after: result.after, trace: result.trace, limitations: result.limitations });
    return `<testcase classname="shadowgate.${escape(result.adapter)}" name="${escape(result.id)}: ${escape(result.title)}">${!result.gatePassed ? `<failure type="PaymentDeliveryInvariant" message="${escape(result.observed)}">${escape(detail)}</failure>` : ''}<system-out>${escape(detail)}</system-out></testcase>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="ShadowGate SVM" tests="${report.results.length}" failures="${failures}" errors="0" time="${(report.durationMs / 1000).toFixed(3)}"><testsuite name="${escape(report.profile)}" tests="${report.results.length}" failures="${failures}" errors="0" timestamp="${escape(report.createdAt)}" time="${(report.durationMs / 1000).toFixed(3)}"><properties><property name="runId" value="${escape(report.id)}"/><property name="experimentAssertionsPassed" value="${report.summary.passed}"/><property name="experimentAssertionsFailed" value="${report.summary.failed}"/><property name="scope" value="Local LiteSVM execution; valueless tokens; not production certification"/></properties>\n${cases}\n</testsuite></testsuites>\n`;
}

export async function saveReport(input: RunReport, outputDir = 'evidence') {
  if (!isReportId(input.id)) throw new Error('Report ID must be a safe file name.');
  const report = publicReport(input);
  const directory = resolve(outputDir);
  await mkdir(directory, { recursive: true });
  const paths = { json: join(directory, `${report.id}.json`), html: join(directory, `${report.id}.html`), junit: join(directory, `${report.id}.xml`) };
  // JSON is committed last, so the API will not list a half-written report bundle.
  for (const [path, body] of [[paths.html, renderHtml(report)], [paths.junit, renderJunit(report)], [paths.json, `${pretty(report)}\n`]]) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  }
  return paths;
}
