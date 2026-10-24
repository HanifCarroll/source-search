import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import type {Secret} from '../../platform/source-settings';
import {fail} from '../../domain/identity';

export async function readSecret(secret:Secret):Promise<string> {
  let value:string;
  try {
    if('env' in secret)value=process.env[secret.env] || '';
    else if('file' in secret){
      const file=await open(secret.file,constants.O_RDONLY|constants.O_NONBLOCK);
      try {const stat=await file.stat();if(!stat.isFile() || stat.size>65536)fail('CREDENTIAL_UNAVAILABLE','Credential file must be a small regular file');value=await file.readFile('utf8');}
      finally {await file.close();}
    }else{
      const child=Bun.spawn(secret.command,{stdin:'ignore',stdout:'pipe',stderr:'ignore'});
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        value=await Promise.race([
          (async()=>{let text='';for await(const chunk of child.stdout){text+=Buffer.from(chunk).toString();if(Buffer.byteLength(text)>65536)fail('CREDENTIAL_UNAVAILABLE','Credential command output is too large');}if(await child.exited)fail('CREDENTIAL_UNAVAILABLE','Credential command failed');return text;})(),
          new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Credential command timed out'),{code:'CREDENTIAL_UNAVAILABLE'})),10000);}),
        ]);
      }finally {clearTimeout(timer);child.kill();}
    }
    value=value.trim();
    if(!value || value.length>65536 || /[\r\n\0]/.test(value))fail('CREDENTIAL_UNAVAILABLE','Credential must contain a single nonempty value');
    return value;
  }catch {return fail('CREDENTIAL_UNAVAILABLE','Could not load mail credentials; check the configured environment variable, file or command');}
}
