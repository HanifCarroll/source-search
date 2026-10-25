import type {Ref,RecordData} from './contracts';

// Bodies are retained only for native sources selected for library indexing.
// Change events still contain references only.
export type Observation={ref:Ref;signature:string;input?:string;key?:string;record?:RecordData};
export type ObservedProjection={
  kind:'native'|'archive';revision:string;scope:string;version:number;
  guard:Record<string,unknown>;
  incremental?:{decoded:number;reused:number;removed:number};
};
export type ObservationState={
  checkedAt:string;strategy:string;coverage:string;generation?:string;signature?:string;
  checkpoint?:unknown;granularity?:'records'|'index';initialized?:boolean;
  lastError?:{code:string;message:string};lastAttemptAt?:string;records?:number;
  projection?:ObservedProjection;
};
