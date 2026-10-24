import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
// The reloadable MCP bundle lives outside the checkout.
declare const SOURCE_SEARCH_PACKAGE_ROOT:string;
function isInstallation(root:string) {
  try{return JSON.parse(readFileSync(join(root,'package.json'),'utf8')).name==='source-search';}
  catch(error){if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code||''))return false;throw error;}
}
function installationRoot() {
  const sourceRoot=fileURLToPath(new URL('../../',import.meta.url));
  if(isInstallation(sourceRoot))return sourceRoot;
  // Gateways started before root injection was added still reload this module.
  // Their main entry stays in the checkout even though this bundle is temporary.
  for(let root=dirname(Bun.main);;root=dirname(root)){
    if(isInstallation(root))return root;
    if(dirname(root)===root)break;
  }
  throw Error('Source Search installation not found; reconnect MCP using the installed src/mcp.ts entrypoint');
}
export const packageRoot=typeof SOURCE_SEARCH_PACKAGE_ROOT==='string'?SOURCE_SEARCH_PACKAGE_ROOT:installationRoot();
