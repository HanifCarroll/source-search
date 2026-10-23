import {defaultConfig as productionDefaults} from "../../src/platform/config";
import { sourceIds } from "../../src/domain/contracts";
export const defaultConfig = () => ({...productionDefaults(), enabledSources:[...sourceIds], maintenanceEnabled:true, mailAccounts:{"mail-personal":{account:"person@example.test",email:"person@example.test",aliases:[]},"mail-consulting":{account:"dev",email:"work@example.test",aliases:[]},"mail-fastmail":{account:"fastmail",email:"person@fastmail.example",aliases:[]}}});
export {loadConfig,type Config} from "../../src/platform/config";
