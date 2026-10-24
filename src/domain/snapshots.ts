import type {RecordData,SnapshotCoverage} from './contracts';

// A successful synchronization describes the complete selected snapshot, even
// when a provider fetched only changes since its opaque checkpoint.
export type SourceSnapshot={records:RecordData[];checkpoint?:unknown;coverage:string;strategy:string;warnings:string[];sourceSnapshotAt?:string;coverageWindow?:{from:string;to:string}};
export type SourceCache=SourceSnapshot & {version:1;scope:string;checkedAt:string;lastError?:{code:string;message:string};lastAttemptAt?:string};

export function snapshotCoverage(saved:SourceCache):SnapshotCoverage{
  return {kind:saved.sourceSnapshotAt?'historical-archive':'synchronized-snapshot',asOf:saved.sourceSnapshotAt||saved.checkedAt,syncedAt:saved.checkedAt,
    description:saved.coverage,window:saved.coverageWindow,lastAttemptAt:saved.lastAttemptAt,lastError:saved.lastError};
}
