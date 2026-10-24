import type {RecordData} from './contracts';

// A successful synchronization describes the complete selected snapshot, even
// when a provider fetched only changes since its opaque checkpoint.
export type SourceSnapshot={records:RecordData[];checkpoint?:unknown;coverage:string;strategy:string;warnings:string[];coverageWindow?:{from:string;to:string}};
export type SourceCache=SourceSnapshot & {version:1;scope:string;checkedAt:string;lastError?:{code:string;message:string};lastAttemptAt?:string};
