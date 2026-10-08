import assert from 'node:assert/strict';
import {runSuite} from './runner.js';
import {renderJunit} from './reports.js';

console.log('--- Testing Official Framework Adapters (Hono & Express) ---');
const report=await runSuite({profile:'all', adapters: ['hono', 'express']});
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
console.log(`\nOFFICIAL ADAPTERS PASSED: ${report.summary.passed} experiments; six unsafe baseline outcomes detected, sixteen recovered gates passed.`);

console.log('\n--- Testing Independently Developed Application (x402-foundation Weather Service) ---');
const weatherReport=await runSuite({profile:'all', adapters: ['weather']});
assert.equal(weatherReport.summary.total,14,'Independent application must run the complete 14-scenario matrix (6 baseline + 8 recovered)');
assert.equal(weatherReport.summary.failed,0,'Independent application experiment reproduced all required evidence');
assert.equal(weatherReport.results.filter(r=>!r.gatePassed).length,3,'Independent application baseline exposures must remain visible as failures');
assert(weatherReport.results.filter(r=>r.mode==='recovered').every(r=>r.gatePassed),'Independent application recovered profile passed all gates');

const weatherRestart=weatherReport.results.find(r=>r.adapter==='weather'&&r.mode==='recovered'&&r.scenario==='process-restart')!;
assert(weatherRestart.trace.some(t=>t.event==='target-process-terminated'&&t.exitCode===86),'Weather target process must terminate at crash boundary');
assert(weatherRestart.trace.some(t=>t.event==='durable-journal-observed-before-restart'&&t.state==='prepared'),'Weather recovery must work from durable prepared entry');
assert(weatherReport.results.find(r=>r.adapter==='weather'&&r.mode==='recovered'&&r.scenario==='wrong-payer')!.requests?.some(r=>r.step==='wrong-wallet-recovery'&&r.status===403),'Unrelated wallet must be rejected on weather recovery');
assert(weatherReport.results.find(r=>r.adapter==='weather'&&r.mode==='recovered'&&r.scenario==='wrong-payer')!.requests?.some(r=>r.step==='public-payment-replay'&&r.status===409),'Public payment replay must be rejected on weather service');
assert(weatherReport.results.find(r=>r.adapter==='weather'&&r.mode==='recovered'&&r.scenario==='prebroadcast-failure')!.requests?.some(r=>r.step==='unpaid-journal-recovery'&&r.status===409),'Unpaid weather journal recovery must be rejected');

console.log(`\nALL SELFTESTS PASSED: ${report.summary.passed + weatherReport.summary.passed} experiments across 3 adapters (Hono, Express, Weather). Baseline exposures detected; all recovered gates passed.\n`);
