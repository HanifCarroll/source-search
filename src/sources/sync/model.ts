import type {RecordData} from '../../domain/contracts';
import type {SourceSnapshot} from '../../domain/snapshots';
export type {SourceSnapshot} from '../../domain/snapshots';
export interface SourceProvider {
  lists?():Promise<{id:string;name:string}[]>;
  sync(previous?:unknown):Promise<SourceSnapshot>;
  read(id:string,previous?:unknown):Promise<RecordData>;
}
