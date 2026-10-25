import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {getMailState,setMailState,getProjectionState,setProjectionState} from '../src/platform/cache-state';
import {imapCheckpointSchema,jmapCheckpointSchema} from '../src/sources/mail/checkpoints';

test('legacy mail checkpoints migrate without projection writes changing them',()=>{
  const db=new Database(':memory:');
  try {
    db.exec('CREATE TABLE states(source TEXT PRIMARY KEY,data TEXT)');
    db.query('INSERT INTO states VALUES(?,?)').run('inbox',JSON.stringify({
      state:'ready',accountSignature:'account',dirty:true,gmailHistory:'123',
      publishedAt:'before',chunks:4,syncCheckpoint:{kind:'jmap',boxes:'boxes',state:'s1'},
    }));
    const checkpoint=getMailState(db,'inbox');
    expect(checkpoint.gmailHistory).toBe('123');
    expect(checkpoint).not.toHaveProperty('chunks');
    expect(getProjectionState(db,'inbox')).not.toHaveProperty('syncCheckpoint');
    expect(db.query("SELECT name FROM sqlite_master WHERE name='mail_states'").get()).toBeNull();
    db.exec('CREATE TABLE mail_states(source TEXT PRIMARY KEY,data TEXT)');
    setMailState(db,'inbox',checkpoint);
    setProjectionState(db,'inbox',{state:'error',chunks:7,publishedAt:'after'});
    expect(getMailState(db,'inbox')).toEqual(checkpoint);
    setMailState(db,'inbox',{...checkpoint,dirty:false,gmailHistory:'456'});
    expect(getProjectionState(db,'inbox')).toMatchObject({state:'error',chunks:7});
    expect(()=>setMailState(db,'inbox',{pending:[{id:4}]})).toThrow('malformed');
    expect(getMailState(db,'inbox').gmailHistory).toBe('456');
  } finally {db.close();}
});

test('mail checkpoint schemas reject corrupt inventories before resuming or pruning',()=>{
  expect(imapCheckpointSchema.safeParse({kind:'imap',boxes:{},visible:{},pending:['one']}).success).toBe(true);
  expect(imapCheckpointSchema.safeParse({kind:'imap',boxes:{},visible:[]}).success).toBe(false);
  expect(jmapCheckpointSchema.safeParse({kind:'jmap',boxes:'boxes',pending:{ids:['one'],offset:2}}).success).toBe(false);
  expect(jmapCheckpointSchema.safeParse({kind:'jmap',boxes:'boxes',inventory:{ids:[],position:-1}}).success).toBe(false);
  expect(jmapCheckpointSchema.safeParse({kind:'jmap',boxes:'boxes',state:'s1',pending:{ids:['one'],offset:0}}).success).toBe(true);
});
