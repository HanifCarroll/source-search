export function jmapFixture(){
  const mail='urn:ietf:params:jmap:mail',core='urn:ietf:params:jmap:core';
  const boxes=[{id:'inbox',name:'Inbox',role:'inbox'},{id:'sent',name:'Sent',role:'sent'},{id:'junk',name:'Junk',role:'junk'},{id:'trash',name:'Trash',role:'trash'}];
  const emails=Array.from({length:7},(_,i)=>({id:'m'+i,threadId:'t1',mailboxIds:{inbox:true},receivedAt:`2026-10-${String(i+1).padStart(2,'0')}T12:00:00Z`,subject:'Planning '+i,from:[{name:'Alice',email:'alice@example.test'}],to:[{name:null,email:'bob@example.test'}],preview:'Preview '+i,textBody:[{partId:'1'}],htmlBody:[],bodyValues:{'1':{value:'Body '+i,isTruncated:false}},attachments:[{name:'agenda.pdf',type:'application/pdf',blobId:'blob',size:13}]}));
  const state={changes:[] as any[],version:'state1',status:200,delay:0,methodError:'',wrongAccount:false,missing:false,reverse:true,primary:'one',maxGet:3,queryPageSize:500,requests:[] as any[],auth:[] as string[],blob:'invented file',blobStatus:200,downloads:[] as string[],emails,boxes};
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req):Promise<Response>{
    if(new URL(req.url).pathname==='/.well-known/jmap')return new Response(null,{status:307,headers:{location:'/session'}});
    state.auth.push(req.headers.get('authorization')||'');
    if(state.delay)await Bun.sleep(state.delay);
    if(state.status!==200)return new Response('Do not disclose provider data',{status:state.status});
    if(new URL(req.url).pathname.startsWith('/download/')){state.downloads.push(req.url);return new Response(state.blob,{status:state.blobStatus});}
    if(req.method==='GET')return Response.json({downloadUrl:`http://127.0.0.1:${server.port}/download/{accountId}/{blobId}/{name}?type={type}`,apiUrl:`http://127.0.0.1:${server.port}/api`,capabilities:{[core]:{maxObjectsInGet:state.maxGet},[mail]:{}},accounts:{one:{accountCapabilities:{[mail]:{}}},two:{accountCapabilities:{[mail]:{}}}},primaryAccounts:state.primary?{[mail]:state.primary}:{}});
    const request=await req.json() as any;
    const [method,args,tag]=request.methodCalls[0];state.requests.push({method,args});
    if(state.methodError)return Response.json({methodResponses:[['error',{type:state.methodError},tag]]});
    if(!['Mailbox/get','Email/query','Email/get','Thread/get','Email/changes'].includes(method))return new Response('Write attempted',{status:400});
    let result:any={accountId:state.wrongAccount?'wrong':args.accountId,state:state.version};
    if(method==='Email/changes'){
      const change=state.changes.find(c=>c.oldState===args.sinceState);
      if(change)Object.assign(result,change);
      else if(args.sinceState===state.version)Object.assign(result,{oldState:state.version,newState:state.version,hasMoreChanges:false,created:[],updated:[],destroyed:[]});
      else return Response.json({methodResponses:[['error',{type:'cannotCalculateChanges'},tag]]});
    }
    if(method==='Mailbox/get')result.list=state.boxes;
    if(method==='Email/query'){
      const matching=(e:any,f:any):boolean=>!f || (f.operator==='AND'?f.conditions.every((x:any)=>matching(e,x)):f.operator==='OR'?f.conditions.some((x:any)=>matching(e,x)):f.operator==='NOT'?!f.conditions.some((x:any)=>matching(e,x)):f.inMailbox?!!e.mailboxIds[f.inMailbox]:f.after?Date.parse(e.receivedAt)>=Date.parse(f.after):f.before?Date.parse(e.receivedAt)<Date.parse(f.before):true);
      const found=state.emails.filter(e=>matching(e,args.filter)).sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt)*(args.sort[0].isAscending?1:-1));
      Object.assign(result,{ids:found.slice(args.position,args.position+Math.min(args.limit,state.queryPageSize)).map(e=>e.id),position:args.position,queryState:state.version,total:found.length});
    }
    if(method==='Email/get'){
      if(args.ids.length>state.maxGet)return Response.json({methodResponses:[['error',{type:'tooManyObjects'},tag]]});
      result.list=state.emails.filter(e=>args.ids.includes(e.id));if(state.reverse)result.list.reverse();
      result.notFound=state.missing?[args.ids[0]]:args.ids.filter((id:string)=>!state.emails.some(e=>e.id===id));
    }
    if(method==='Thread/get')result.list=[{id:'t1',emailIds:state.emails.map(e=>e.id)}];
    return Response.json({methodResponses:[[method,result,tag]]});
  }});
  return {state,url:`http://127.0.0.1:${server.port}/session`,stop:()=>server.stop(true)};
}
