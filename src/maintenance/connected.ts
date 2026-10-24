import {configuredSourceIds,requireSource,sourceEnabled,type Config} from '../platform/config';
import {connectedKinds,sourceKind} from '../domain/source-catalog';
import {connectedProvider} from '../sources/connected';
import {syncSnapshots} from './snapshots';
import {fail} from '../domain/identity';
export async function syncConnected(c:Config,selected?:string,factory=connectedProvider){
  if(selected){requireSource(c,selected);if(!connectedKinds.includes(sourceKind(selected,c) as typeof connectedKinds[number]))fail('INVALID_SOURCE','Select a connected source');}
  const sources=selected?[selected]:configuredSourceIds(c).filter(s=>sourceEnabled(c,s)&&connectedKinds.includes(sourceKind(s,c) as typeof connectedKinds[number]));
  return syncSnapshots(c,sources,factory);
}
