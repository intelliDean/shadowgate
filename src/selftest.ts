import assert from 'node:assert/strict';
import {runSuite} from './runner.js';
import {renderJunit} from './reports.js';

const report=await runSuite({profile:'all'});
assert.equal(report.summary.total,28,'Both official framework adapters must run the entire matrix');
assert.equal(report.summary.failed,0,'Experiment did not reproduce its required evidence');
assert.equal(report.results.filter(r=>!r.gatePassed).length,6,'Baseline exposures must remain visible as failures');
assert(report.results.filter(r=>r.mode==='recovered').every(r=>r.gatePassed),'Recovered profile failed a gate');
for(const adapter of ['hono','express']){
  const get=(scenario:string)=>report.results.find(r=>r.adapter===adapter&&r.mode==='recovered'&&r.scenario===scenario)!;
  const restart=get('process-restart');
  assert(restart.trace.some(t=>t.event==='target-process-terminated'&&t.exitCode===86),'A real target process must exit at the fault boundary');
  assert(restart.trace.some(t=>t.event==='durable-journal-observed-before-restart'&&t.state==='prepared'),'Recovery must work from a durable prepared entry');
  assert(get('wrong-payer').requests?.some(r=>r.step==='wrong-wallet-recovery'&&r.status===403),'An unrelated wallet must be denied');
  assert(get('wrong-payer').requests?.some(r=>r.step==='public-payment-replay'&&r.status===409),'A public payment payload must not bypass payer authentication');
  assert(get('prebroadcast-failure').requests?.some(r=>r.step==='unpaid-journal-recovery'&&r.status===409),'An unpaid prepared journal must not grant a result');
}
assert(renderJunit(report).includes('failures="6"'),'JUnit must fail unsafe baseline gates even when experiment assertions pass');
console.log(`\nSELFTEST PASSED: ${report.summary.passed} experiments; six unsafe baseline outcomes detected, sixteen recovered gates passed.`);
