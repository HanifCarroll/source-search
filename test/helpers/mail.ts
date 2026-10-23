import * as provider from "../../src/sources/mail/index";
import {defaultConfig} from "./config";
export * from "../../src/sources/mail/index";
export const searchMail = (q:Parameters<typeof provider.searchMail>[0],run?:provider.Run,previews?:provider.PreviewBudget) => provider.searchMail(q,run,previews,defaultConfig());
export const readMail = (source:provider.MailSource,id:string,run?:provider.Run) => provider.readMail(source,id,run,defaultConfig());
export const mailContext = (record:Parameters<typeof provider.mailContext>[0],run?:provider.Run) => provider.mailContext(record,run,defaultConfig());
