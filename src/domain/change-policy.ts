import {adapterKinds,sourceDefinitions} from './source-catalog';
export const snapshotKinds:readonly string[]=adapterKinds.filter(kind=>sourceDefinitions[kind].tracking==='snapshot');
export const directKinds:readonly string[]=adapterKinds.filter(kind=>sourceDefinitions[kind].tracking!==null&&sourceDefinitions[kind].tracking!=='snapshot');
