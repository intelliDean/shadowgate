import {parseArgs} from 'node:util';
import {runSuite} from './runner.js';
import type {Adapter,Profile} from './types.js';

const {values,positionals}=parseArgs({allowPositionals:true,options:{profile:{type:'string'},adapter:{type:'string'},output:{type:'string'},target:{type:'string'},help:{type:'boolean'}}});
const command=positionals[0]??'gate';
if(values.help){console.log('ShadowGate SVM\n  npm run compare\n  npm run gate -- --profile recovered --adapter hono\n  npm run gate -- --profile recovered --adapter weather\n  npm run gate -- --profile baseline\nOptions: --adapter hono|express|weather|all|<custom> --output evidence --target ./custom-target.ts\nBaseline gate intentionally exits 1 when unsafe behavior is observed. Compare exits 0 only when all experiment expectations hold.');}
else{
  if(!['gate','compare'].includes(command))throw new Error('Command must be gate or compare');
  const profile=(values.profile??(command==='compare'?'all':'recovered')) as Profile;
  if(!['baseline','recovered','all'].includes(profile))throw new Error('Unknown profile');
  const adapters = values.adapter === 'all'
    ? ['hono', 'express', 'weather']
    : values.adapter
    ? [values.adapter as Adapter]
    : undefined;
  const report=await runSuite({profile,adapters,outputDir:values.output,targetEntrypoint:values.target});
  console.log(`\n${report.summary.passed}/${report.summary.total} experiment checks passed. ${report.summary.gateFailed} release-gate failures.\nReport: ${values.output??'evidence'}/${report.id}.html`);
  process.exitCode=command==='compare'?(report.summary.failed?1:0):(report.results.every(r=>r.gatePassed)&&report.summary.failed===0?0:1);
}
