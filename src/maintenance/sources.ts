import {configuredSourceIds,requireMaintenance,requireSource,sourceEnabled,type Config} from '../platform/config';
import {connectedKinds,sourceKind} from '../domain/source-catalog';
import {taskProvider} from '../sources/tasks';
import {connectedProvider} from '../sources/connected';
import {syncSnapshots} from './snapshots';
import {syncDirect} from './direct';
import {directKinds,snapshotKinds} from '../domain/change-policy';
import {fail} from '../domain/identity';

const kinds=snapshotKinds;
export function snapshotSources(c:Config,selected?:string,allowed=kinds){
  if(selected){
    requireSource(c,selected);
    if(!allowed.includes(sourceKind(selected,c)))fail('INVALID_SOURCE','Select a source supported by this sync command');
    return [selected];
  }
  return configuredSourceIds(c).filter(s=>sourceEnabled(c,s)&&allowed.includes(sourceKind(s,c)));
}
function provider(c:Config,source:string){return sourceKind(source,c)==='tasks'?taskProvider(c,source):connectedProvider(c,source);}
export async function syncSources(c:Config,selected?:string,factory=provider){
  requireMaintenance(c);
  const sources=snapshotSources(c,selected,[...snapshotKinds,...directKinds]);
  const snapshots=await syncSnapshots(c,sources.filter(s=>snapshotKinds.includes(sourceKind(s,c))),factory);
  const direct=await syncDirect(c,sources.filter(s=>directKinds.includes(sourceKind(s,c))));
  return {ok:snapshots.ok&&direct.ok,sources:[...snapshots.sources,...direct.sources]};
}
// Keep the installed task-only command while sharing the writer and selection rules.
export async function syncTasks(c:Config,selected?:string,factory=taskProvider){
  requireMaintenance(c);
  return syncSnapshots(c,snapshotSources(c,selected,['tasks']),factory);
}
