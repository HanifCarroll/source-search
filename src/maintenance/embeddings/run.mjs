// Stable installed entry point; maintenance uses the public search SDK.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const result=spawnSync(process.env.SOURCE_SEARCH_BUN || 'bun',[fileURLToPath(new URL('../../cli.ts',import.meta.url)),'index','--library','--embed-only'],{stdio:'inherit',env:process.env});
if(result.error)throw result.error;
process.exitCode=result.status??1;
