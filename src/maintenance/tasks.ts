import {configuredSourceIds,requireMaintenance,requireSource,sourceEnabled,type Config} from '../platform/config';
import {taskProvider} from '../sources/tasks';
import {syncSnapshots} from './snapshots';
import {fail} from '../domain/identity';
export async function syncTasks(c:Config,selected?:string,factory=taskProvider){
  requireMaintenance(c);
  if(selected){requireSource(c,selected);if(c.sources[selected]?.adapter!=='tasks')fail('INVALID_SOURCE','sync-tasks requires a tasks source');}
  const sources=selected?[selected]:configuredSourceIds(c).filter(s=>sourceEnabled(c,s)&&c.sources[s]?.adapter==='tasks');
  return syncSnapshots(c,sources,factory,'task-snapshots');
}
