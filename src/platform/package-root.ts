import {fileURLToPath} from 'node:url';
// The reloadable MCP bundle lives outside the checkout.
declare const SOURCE_SEARCH_PACKAGE_ROOT:string;
export const packageRoot=typeof SOURCE_SEARCH_PACKAGE_ROOT==='string'?SOURCE_SEARCH_PACKAGE_ROOT:fileURLToPath(new URL('../../',import.meta.url));
