import type {RecordData} from '../../domain/contracts';

// A checkpoint is provider-owned, serializable state. A successful sync returns
// a complete selected snapshot, even when it fetched only incremental changes.
export type SourceSnapshot={records:RecordData[];checkpoint?:unknown;coverage:string;strategy:string;warnings:string[]};
export interface SourceProvider {
  lists?():Promise<{id:string;name:string}[]>;
  sync(previous?:unknown):Promise<SourceSnapshot>;
  read(id:string,previous?:unknown):Promise<RecordData>;
}
