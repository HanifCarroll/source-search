import type {Ref} from './contracts';

// Direct readers retain identities and fingerprints, never another copy of bodies.
export type Observation={ref:Ref;signature:string;input?:string;key?:string};
export type ObservationState={
  checkedAt:string;strategy:string;coverage:string;generation?:string;signature?:string;
  checkpoint?:unknown;granularity?:'records'|'index';initialized?:boolean;
  lastError?:{code:string;message:string};lastAttemptAt?:string;records?:number;
};
