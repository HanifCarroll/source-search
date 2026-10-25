import {z} from 'zod';

const envelope=z.object({id:z.number().int().positive(),result:z.unknown().optional(),error:z.string().optional()});
type Child=ReturnType<typeof Bun.spawn< 'pipe','pipe','pipe'>>;
type Options={idleMs?:number;timeoutMs?:number;maxBytes?:number;env?:Record<string,string|undefined>};
const owned=new Set<JsonWorker>();
const closeOwned=()=>{for(const worker of owned)worker.close();};
const terminate=()=>{closeOwned();process.exit(143);};
const interrupt=()=>{closeOwned();process.exit(130);};

// A single serialized JSON-lines worker. The owner chooses its command and
// lifetime; callers get bounded requests, cancellation and restart after failure.
export class JsonWorker {
  private child?:Child;
  private active?:{id:number;resolve:(value:unknown)=>void;reject:(error:Error)=>void};
  private sequence=0;
  private queued=0;
  private tail:Promise<unknown>=Promise.resolve();
  private idle?:ReturnType<typeof setTimeout>;
  private stderr='';
  private disposed=false;
  get busy(){return this.queued>0;}
  constructor(private command:string[],private options:Options={}){
    if(!owned.size){process.once('exit',closeOwned);process.once('SIGTERM',terminate);process.once('SIGINT',interrupt);}
    owned.add(this);
  }
  private stop(error:Error){
    clearTimeout(this.idle);this.idle=undefined;
    const child=this.child;this.child=undefined;
    this.active?.reject(error);this.active=undefined;
    if(child){try{child.stdin.end();}catch{}child.kill();}
  }
  close(){
    this.disposed=true;this.stop(new Error('Worker closed'));
    owned.delete(this);
    if(!owned.size){process.removeListener('exit',closeOwned);process.removeListener('SIGTERM',terminate);process.removeListener('SIGINT',interrupt);}
  }
  private start(){
    if(this.child)return this.child;
    const child=Bun.spawn(this.command,{stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{...process.env,...this.options.env}});
    this.child=child;this.stderr='';
    void (async()=>{
      for await(const part of child.stderr){if(this.child===child)this.stderr=(this.stderr+new TextDecoder().decode(part)).slice(-2000);}
    })().catch(()=>{});
    void (async()=>{
      const decoder=new TextDecoder();let buffer='',bytes=0;
      for await(const part of child.stdout){
        if(this.child!==child)return;
        bytes+=part.length;buffer+=decoder.decode(part,{stream:true});
        if(bytes>(this.options.maxBytes??4*1024*1024))throw Error('Worker response exceeded its output budget');
        for(let at;(at=buffer.indexOf('\n'))>=0;){
          const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
          // Native dependencies may write diagnostics; only framed replies are results.
          if(!line.startsWith('SOURCE_SEARCH_REPLY '))continue;
          const reply=envelope.parse(JSON.parse(line.slice(20)));
          if(reply.id!==this.active?.id)throw Error('Worker replied to an unknown request');
          const active=this.active;this.active=undefined;bytes=Buffer.byteLength(buffer);
          if(reply.error)active.reject(new Error(reply.error));else active.resolve(reply.result);
        }
      }
      if(this.child===child){const code=await child.exited;this.stop(new Error(`Worker exited (${code}): ${this.stderr.slice(-900)}`));}
    })().catch(error=>{if(this.child===child)this.stop(error);});
    return child;
  }
  request(input:unknown,{signal,timeoutMs=this.options.timeoutMs??240000}:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<unknown>{
    if(this.disposed)return Promise.reject(new Error('Worker closed'));
    if(signal?.aborted)return Promise.reject(signal.reason||new Error('Request cancelled'));
    if(this.queued>=16)return Promise.reject(new Error('Search worker is busy; retry shortly'));
    const encoded=JSON.stringify(input);
    if(Buffer.byteLength(encoded)>(this.options.maxBytes??4*1024*1024))return Promise.reject(new Error('Worker request exceeds its input budget'));
    this.queued++;
    const task=this.tail.catch(()=>{}).then(async()=>{
      if(this.disposed)throw Error('Worker closed');
      signal?.throwIfAborted();clearTimeout(this.idle);
      const child=this.start(),id=++this.sequence;
      let timer:ReturnType<typeof setTimeout>|undefined;
      const cancel=()=>this.stop(new Error('Request cancelled'));
      try{return await new Promise((resolve,reject)=>{
        this.active={id,resolve,reject};
        timer=setTimeout(()=>this.stop(new Error('Worker request timed out; retry or narrow the request')),timeoutMs);
        signal?.addEventListener('abort',cancel,{once:true});
        try{child.stdin.write(`{"id":${id},"input":${encoded}}\n`);void Promise.resolve(child.stdin.flush()).catch(error=>this.stop(error));}catch(error){this.stop(error as Error);}
      });}finally{
        clearTimeout(timer);signal?.removeEventListener('abort',cancel);
        if(this.child){this.idle=setTimeout(()=>this.stop(new Error('Worker idle')),this.options.idleMs??300000);this.idle.unref();}
      }
    });
    this.tail=task;
    const finished=task.finally(()=>this.queued--);
    if(!signal)return finished;
    let abort:()=>void;
    const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(new Error('Request cancelled'));signal.addEventListener('abort',abort,{once:true});});
    return Promise.race([finished,cancelled]).finally(()=>signal.removeEventListener('abort',abort));
  }
}
