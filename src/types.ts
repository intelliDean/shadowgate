export type Adapter = 'hono' | 'express';
export type Profile = 'baseline' | 'recovered' | 'all';
export type Balances = {payer:string; merchant:string; sponsorLamports?:string};
export type CaseResult = {
  id:string; adapter:Adapter; mode:'baseline'|'recovered'; scenario:string; title:string;
  expected:string; observed:string; passed:boolean; gatePassed:boolean;
  httpStatus:number; paymentTransferred:boolean; resourceDelivered:boolean; feeLamports:string;
  before:Balances; after:Balances; trace:any[]; limitations?:string[];
  requests?:any[]; durationMs?:number; error?:string;
};
export type RunReport = {
  id:string; createdAt:string; durationMs:number; profile:Profile; runtime:string;
  summary:{passed:number; failed:number; total:number; gatePassed?:number; gateFailed?:number};
  results:CaseResult[]; versions?:Record<string,string>; limitations?:string[];
};
