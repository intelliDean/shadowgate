export type Adapter = 'hono' | 'express' | 'weather' | string;
export type Profile = 'baseline' | 'recovered' | 'all';
export type Balances = {payer:string; merchant:string; sponsorLamports?:string};

export interface DeliveryContext {
  payload: any;
  messageHash: string;
  expectedArtifactId?: string;
  tx?: any;
}

export interface JournalInspection {
  prepared: boolean;
  artifact: any;
  entryCount: number;
}

export interface RecoveryRequest {
  body: any;
  headers?: Record<string, string>;
  method?: string;
}

export interface IntegrationAdapter {
  name: string;
  title?: string;
  paidRoute: string;
  recoveryRoute: string;
  defaultTarget?: string;
  startupCommand?: string;
  isDelivered(response: { status: number; body: any; headers?: any }, context: DeliveryContext): boolean;
  matchesArtifact(recoveredBody: any, oracleBody: any, context: DeliveryContext): boolean;
  inspectJournal(journalPath: string, context: DeliveryContext): Promise<JournalInspection> | JournalInspection;
  createRecoveryProof(payload: any, key: any, context: DeliveryContext): Promise<RecoveryRequest> | RecoveryRequest;
  launch?(config: any, trace: any[], target?: string): Promise<{ child: any; url: string; close: () => Promise<void> }>;
}

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

