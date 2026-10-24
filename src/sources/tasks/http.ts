import {providerHttp,type HttpRead} from '../../platform/http';
import type {Secret} from '../../platform/auth-settings';
export type TaskHttp=HttpRead;
export function taskHttp(origin:string,token:Secret|(()=>Promise<string>),encoding:'json'|'form'='json'):TaskHttp{
  return providerHttp(origin,{token,encoding,timeoutMs:120000}).json;
}
