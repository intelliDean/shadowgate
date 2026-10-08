import {fork,type ChildProcess} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {getTransactionDecoder} from '@solana/kit';
import {Keypair,TransactionMessage,VersionedTransaction,ComputeBudgetProgram} from '@solana/web3.js';
import {ExactSvmScheme as ClientExact} from '@x402/svm/exact/client';
import {getAdapter} from './adapter.js';
import {createFixture} from './fixture.js';
import {saveReport} from './reports.js';
import type {Adapter,CaseResult,DeliveryContext,Profile,RunReport} from './types.js';

type Mode='baseline'|'recovered';
type Scenario='normal'|'lost-send-response'|'prebroadcast-failure'|'confirmation-failure'|'process-restart'|'fee-policy'|'wrong-payer'|'recovery-replay';
const scenarios:Scenario[]=['normal','lost-send-response','prebroadcast-failure','confirmation-failure','process-restart','fee-policy'];
const titles:Record<Scenario,string>={
  normal:'Successful payment and delivery',
  'lost-send-response':'RPC response lost after settlement',
  'prebroadcast-failure':'Failure before broadcast',
  'confirmation-failure':'Confirmation observation failure',
  'process-restart':'Process dies after settlement',
  'fee-policy':'Sponsor compute-budget policy',
  'wrong-payer':'Wrong wallet attempts recovery',
  'recovery-replay':'Repeated authorized recovery'
};
const decoder=getTransactionDecoder();

async function launch(config:any,trace:any[],target?:string){
  const child=fork(target?resolve(target):fileURLToPath(new URL('./target.ts',import.meta.url)),[],{
    execArgv:['--import','tsx'],
    stdio:['ignore','pipe','pipe','ipc'],
    env:{...process.env,NODE_NO_WARNINGS:'1'}
  });
  let stderr='';
  child.stderr?.on('data',b=>{stderr=(stderr+b.toString()).slice(-2000);});
  child.stdout?.resume();
  child.on('message',(m:any)=>{if(m?.type==='trace')trace.push({source:'target',...m.event});});
  const ready=await new Promise<{url:string,pid:number}>((resolveReady,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Target initialization timed out'));},25000);
    const onExit=(code:number|null)=>{clearTimeout(timer);reject(new Error(`Target exited before ready (${code}): ${stderr}`));};
    child.once('exit',onExit);
    child.on('message',(m:any)=>{
      if(m?.type==='ready'){clearTimeout(timer);child.off('exit',onExit);resolveReady(m);}
      if(m?.type==='error'){clearTimeout(timer);child.kill();reject(new Error(m.message));}
    });
    child.send({type:'init',config});
  });
  trace.push({event:'target-started',adapter:config.adapter,pid:ready.pid});
  return {child,url:ready.url,close:()=>stop(child)};
}

async function stop(child:ChildProcess){
  if(child.exitCode!==null||child.signalCode!==null)return;
  await new Promise<void>(resolveStop=>{
    const timer=setTimeout(()=>child.kill('SIGKILL'),1000);
    child.once('exit',()=>{clearTimeout(timer);resolveStop();});
    child.kill('SIGTERM');
  });
}

async function request(url:string,options:RequestInit={}){
  try {
    const r=await fetch(url,{...options,signal:AbortSignal.timeout(10000)});
    const text=await r.text();
    let body:any;
    try{body=JSON.parse(text);}catch{body={text:text.slice(0,300)};}
    return {status:r.status,body,headers:r.headers};
  } catch {
    return {status:0,body:{error:'Transport disconnected or timed out'},headers:undefined};
  }
}

async function runCase(adapterName:Adapter,mode:Mode,scenario:Scenario,target?:string):Promise<CaseResult>{
  const started=Date.now();const trace:any[]=[];const requests:any[]=[];
  const fixture=await createFixture();const dir=await mkdtemp(join(tmpdir(),'shadowgate-'));
  const adapter=await getAdapter(adapterName);
  const targetEntry=target?resolve(target):(adapter.defaultTarget?resolve(adapter.defaultTarget):undefined);
  let child:Awaited<ReturnType<typeof launch>>|undefined;
  const crash=['process-restart','wrong-payer','recovery-replay'].includes(scenario);
  const config={
    adapter:adapter.name,
    mode,
    rpcUrl:fixture.ledger.url,
    feeSecret:Array.from(fixture.feePayer.secretKey),
    merchant:fixture.merchant.publicKey.toBase58(),
    mint:fixture.mint.publicKey.toBase58(),
    amount:'10000',
    journalPath:join(dir,'journal.json'),
    caps:mode==='recovered',
    fault:crash?'crash-after-send':scenario==='prebroadcast-failure'?'before-send':scenario==='confirmation-failure'?'confirm':'none'
  };
  const before=fixture.balances();

  try {
    child=adapter.launch?await adapter.launch(config,trace,targetEntry):await launch(config,trace,targetEntry);
    const challengeResponse=await fetch(`${child.url}${adapter.paidRoute}`,{signal:AbortSignal.timeout(10000)});
    const challengeHeader=challengeResponse.headers.get('PAYMENT-REQUIRED');
    if(challengeResponse.status!==402||!challengeHeader){
      throw new Error(`Target must expose x402 v2 challenge on GET ${adapter.paidRoute}`);
    }
    const challenge=JSON.parse(Buffer.from(challengeHeader,'base64').toString());
    const requirements=challenge.accepts[0];
    const client=new ClientExact(fixture.payerSigner,{rpcUrl:fixture.ledger.url});
    const partial=await client.createPaymentPayload(2,requirements);
    const payload:any={...partial,accepted:requirements,resource:challenge.resource};

    if(scenario==='fee-policy'){
      const tx=VersionedTransaction.deserialize(Buffer.from(payload.payload.transaction,'base64'));
      const message=TransactionMessage.decompile(tx.message);
      message.instructions=[
        ComputeBudgetProgram.setComputeUnitLimit({units:1_000_000}),
        ComputeBudgetProgram.setComputeUnitPrice({microLamports:1_000_000}),
        ...message.instructions.filter(ix=>!ix.programId.equals(ComputeBudgetProgram.programId))
      ];
      const changed=new VersionedTransaction(message.compileToV0Message());
      changed.sign([fixture.payer]);
      payload.payload.transaction=Buffer.from(changed.serialize()).toString('base64');
    }
    if(scenario==='lost-send-response')fixture.ledger.dropNextSendResponse();

    const decodedTx=decoder.decode(Buffer.from(payload.payload.transaction,'base64'));
    const messageHash=createHash('sha256').update(Buffer.from(decodedTx.messageBytes)).digest('hex');
    const expectedArtifactId=messageHash;
    const deliveryContext:DeliveryContext={payload,messageHash,expectedArtifactId,tx:decodedTx};
    const headers={'PAYMENT-SIGNATURE':Buffer.from(JSON.stringify(payload)).toString('base64')};

    let responseRaw=await request(`${child.url}${adapter.paidRoute}`,{headers});
    let delivered=adapter.isDelivered(responseRaw,deliveryContext);
    let response={...responseRaw,delivered};
    requests.push({step:'paid-request',...response});

    let unsafeDelivery=false, recoveryStable=true, storedArtifact:any;

    if(scenario==='prebroadcast-failure'&&mode==='recovered'){
      const proof=await adapter.createRecoveryProof(payload,fixture.payer,deliveryContext);
      const deniedRaw=await request(`${child.url}${adapter.recoveryRoute}`,{
        method:proof.method??'POST',
        headers:proof.headers??{'content-type':'application/json'},
        body:typeof proof.body==='string'?proof.body:JSON.stringify(proof.body)
      });
      const deniedDelivered=adapter.isDelivered(deniedRaw,deliveryContext);
      const denied={...deniedRaw,delivered:deniedDelivered};
      requests.push({step:'unpaid-journal-recovery',...denied});
      unsafeDelivery=deniedDelivered||denied.status!==409;
    }

    if(crash){
      await child.close();
      trace.push({event:'target-process-terminated',exitCode:child.child.exitCode,signal:child.child.signalCode});
      if(response.status!==0||child.child.exitCode!==86||!trace.some(e=>e.phase==='crash_after_send')){
        throw new Error('The target did not hit the required crash-after-send boundary');
      }
      if(mode==='recovered'){
        const inspection=await adapter.inspectJournal(config.journalPath,deliveryContext);
        if(!inspection.prepared||inspection.entryCount!==1){
          throw new Error('Missing durable prepared journal at crash boundary');
        }
        storedArtifact=inspection.artifact;
        trace.push({event:'durable-journal-observed-before-restart',entries:inspection.entryCount,state:'prepared',artifactPersisted:!!storedArtifact});
      }
      child=adapter.launch?await adapter.launch({...config,fault:'none'},trace,targetEntry):await launch({...config,fault:'none'},trace,targetEntry);

      if(scenario==='wrong-payer'){
        const publicReplayRaw=await request(`${child.url}${adapter.paidRoute}`,{headers});
        const publicDelivered=adapter.isDelivered(publicReplayRaw,deliveryContext);
        const publicReplay={...publicReplayRaw,delivered:publicDelivered};
        requests.push({step:'public-payment-replay',...publicReplay});
        unsafeDelivery=publicDelivered||publicReplay.status!==409;

        const wrongProof=await adapter.createRecoveryProof(payload,Keypair.generate(),deliveryContext);
        const wrongRaw=await request(`${child.url}${adapter.recoveryRoute}`,{
          method:wrongProof.method??'POST',
          headers:wrongProof.headers??{'content-type':'application/json'},
          body:typeof wrongProof.body==='string'?wrongProof.body:JSON.stringify(wrongProof.body)
        });
        const wrongDelivered=adapter.isDelivered(wrongRaw,deliveryContext);
        const wrong={...wrongRaw,delivered:wrongDelivered};
        requests.push({step:'wrong-wallet-recovery',...wrong});
        unsafeDelivery=unsafeDelivery||wrongDelivered||wrong.status!==403;
      }

      const proof=await adapter.createRecoveryProof(payload,fixture.payer,deliveryContext);
      const recoverResponseRaw=await request(`${child.url}${adapter.recoveryRoute}`,{
        method:proof.method??'POST',
        headers:proof.headers??{'content-type':'application/json'},
        body:typeof proof.body==='string'?proof.body:JSON.stringify(proof.body)
      });
      delivered=adapter.isDelivered(recoverResponseRaw,deliveryContext);
      response={...recoverResponseRaw,delivered};
      requests.push({step:'payer-recovery-after-restart',...response});

      if(mode==='recovered'&&!adapter.matchesArtifact(response.body,storedArtifact,deliveryContext)){
        recoveryStable=false;
      }

      if(scenario==='recovery-replay'){
        const repeatRaw=await Promise.all(Array.from({length:3},()=>request(`${child!.url}${adapter.recoveryRoute}`,{
          method:proof.method??'POST',
          headers:proof.headers??{'content-type':'application/json'},
          body:typeof proof.body==='string'?proof.body:JSON.stringify(proof.body)
        })));
        const repeat=repeatRaw.map(r=>({...r,delivered:adapter.isDelivered(r,deliveryContext)}));
        requests.push(...repeat.map(r=>({step:'repeat-recovery',...r})));
        recoveryStable=recoveryStable&&repeat.every(r=>r.status===200&&r.delivered&&adapter.matchesArtifact(r.body,storedArtifact,deliveryContext));
      }
    } else if(scenario==='lost-send-response'&&mode==='baseline'){
      const retryRaw=await request(`${child.url}${adapter.paidRoute}`,{headers});
      const retryDelivered=adapter.isDelivered(retryRaw,deliveryContext);
      requests.push({step:'identical-retry',...retryRaw,delivered:retryDelivered});
    }

    const after=fixture.balances();
    const transferred=after.merchant==='10000'&&after.payer==='0';
    const untouched=after.merchant==='0'&&after.payer==='10000';
    const fee=(BigInt(before.sponsorLamports)-BigInt(after.sponsorLamports)).toString();
    let expected='',passed=false,gatePassed=false;

    if(scenario==='prebroadcast-failure'){
      expected='No payment and no protected result, including authenticated recovery';
      passed=untouched&&!response.delivered&&response.status!==200&&!unsafeDelivery;
      gatePassed=passed;
    } else if(scenario==='fee-policy'){
      expected=mode==='baseline'?'Uncapped fixture accepts compute budget above sponsor policy':'Configured SDK cap rejects before payment';
      passed=mode==='baseline'?transferred&&response.delivered&&BigInt(fee)>100_000n:untouched&&!response.delivered&&response.status!==200;
      gatePassed=untouched&&!response.delivered&&BigInt(fee)<=100_000n;
    } else if(mode==='baseline'&&['lost-send-response','process-restart'].includes(scenario)){
      const retryDelivered=requests.some(r=>r.step==='identical-retry'&&r.delivered&&r.status===200&&adapter.matchesArtifact(r.body,storedArtifact,deliveryContext));
      expected='Detect settled payment with no delivered result, including attempted recovery';
      passed=transferred&&!response.delivered&&response.status!==200&&!retryDelivered;
      gatePassed=transferred&&((response.delivered&&adapter.matchesArtifact(response.body,storedArtifact,deliveryContext))||retryDelivered);
    } else {
      expected=scenario==='wrong-payer'?'Reject wrong wallet; rightful payer recovers stored result':scenario==='recovery-replay'?'Repeated recovery returns same artifact without another debit':'One payment produces one recoverable protected result';
      const artifactMatch=adapter.matchesArtifact(response.body,storedArtifact,deliveryContext);
      passed=transferred&&response.delivered&&response.status===200&&artifactMatch&&!unsafeDelivery&&recoveryStable&&fixture.ledger.counters.executed===1;
      gatePassed=passed;
    }

    return {
      id:`${adapter.name}-${mode}-${scenario}`,
      adapter:adapter.name,
      mode,
      scenario,
      title:titles[scenario],
      expected,
      observed:`HTTP ${response.status||'disconnected'} · payer ${before.payer}→${after.payer} · merchant ${before.merchant}→${after.merchant} · artifact ${response.delivered?'delivered':'withheld'}`,
      passed,
      gatePassed,
      httpStatus:response.status,
      paymentTransferred:transferred,
      resourceDelivered:response.delivered,
      feeLamports:fee,
      before,
      after,
      requests,
      trace:[...trace,...fixture.ledger.events.map(event=>({source:'rpc',...event}))],
      durationMs:Date.now()-started,
      limitations:scenario==='fee-policy'?['Compute-limit rejection proven; signature-count and price caps are configured but not independently exercised.']:[]
    };
  } catch(error) {
    const after=fixture.balances();
    return {
      id:`${adapter.name}-${mode}-${scenario}`,
      adapter:adapter.name,
      mode,
      scenario,
      title:titles[scenario],
      expected:'Complete scenario and inspect actual ledger and result',
      observed:String(error),
      error:String(error),
      passed:false,
      gatePassed:false,
      httpStatus:0,
      paymentTransferred:after.merchant==='10000',
      resourceDelivered:false,
      feeLamports:(BigInt(before.sponsorLamports)-BigInt(after.sponsorLamports)).toString(),
      before,
      after,
      trace:[...trace,...fixture.ledger.events],
      requests,
      durationMs:Date.now()-started
    };
  } finally {
    if(child)await child.close();
    await fixture.ledger.close();
    await rm(dir,{recursive:true,force:true});
  }
}

export async function runSuite(options:{profile:Profile;adapters?:Adapter[];outputDir?:string;targetEntrypoint?:string}):Promise<RunReport>{
  const start=Date.now();
  const results:CaseResult[]=[];
  for(const adapter of options.adapters??['hono','express']) {
    for(const mode of options.profile==='all'?['baseline','recovered'] as const:[options.profile]) {
      for(const scenario of mode==='recovered'?[...scenarios,'wrong-payer','recovery-replay'] as Scenario[]:scenarios) {
        const result=await runCase(adapter,mode,scenario,options.targetEntrypoint);
        results.push(result);
        console.log(`${result.passed?'CHECK':'ERROR'} ${result.id}: gate ${result.gatePassed?'PASS':'FAIL'} | ${result.observed}`);
      }
    }
  }
  const report:RunReport={
    id:`run-${new Date(start).toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`,
    createdAt:new Date(start).toISOString(),
    durationMs:Date.now()-start,
    profile:options.profile,
    runtime:'LiteSVM 1.5.0, genuine signed SPL execution, bounded local JSON-RPC. Local execution is not validator consensus or finality.',
    summary:{
      passed:results.filter(r=>r.passed).length,
      failed:results.filter(r=>!r.passed).length,
      total:results.length,
      gatePassed:results.filter(r=>r.gatePassed).length,
      gateFailed:results.filter(r=>!r.gatePassed).length
    },
    results,
    versions:{x402:'2.28.0',litesvm:'1.5.0',node:process.version},
    limitations:[
      'Middleware deployments exercise both bundled and external application adapters.',
      'All assets are ephemeral local test tokens; no mainnet or devnet transactions.',
      'Recovery example assumes trusted RPC, single journal writer and stored immutable artifacts.',
      'No arbitrary business-side-effect exactly-once guarantee, chain reorg, blockhash-expiry, database-corruption or distributed-consensus coverage.',
      'A passing release gate covers these scenarios and is not a security audit.'
    ]
  };
  await saveReport(report,options.outputDir??'evidence');
  return report;
}
