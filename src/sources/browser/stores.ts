import type {Database} from 'bun:sqlite';
import {requireColumns} from '../../platform/sqlite';
import {fail} from '../../domain/identity';

export type Browser = 'firefox' | 'safari';
export type BrowserRow = {id:string|number|bigint;title?:string;url:string;time?:number|bigint;folder?:string};
// Each store owns its schema and clock. Shared search only sees native IDs,
// text and timestamps; it never needs to know a browser's table names.
export const stores = {
  firefox: {
    file:'places.sqlite', time:'v.visit_date', id:'v.id',
    select:'SELECT v.id,p.title,p.url,v.visit_date time FROM moz_historyvisits v JOIN moz_places p ON p.id=v.place_id',
    milliseconds:(value:number)=>value/1000,
    check(db:Database){requireColumns(db,'moz_historyvisits',['id','place_id','visit_date']);requireColumns(db,'moz_places',['id','title','url']);},
  },
  safari: {
    file:'History.db', time:'v.visit_time', id:'v.id',
    select:'SELECT v.id,v.title,p.url,v.visit_time time FROM history_visits v JOIN history_items p ON p.id=v.history_item',
    milliseconds:(value:number)=>value*1000+978307200000,
    check(db:Database){requireColumns(db,'history_visits',['id','history_item','visit_time','title']);requireColumns(db,'history_items',['id','url']);},
  },
} satisfies Record<Browser,{file:string;time:string;id:string;select:string;milliseconds:(value:number)=>number;check:(db:Database)=>void}>;

export function firefoxBookmarks(db:Database):BrowserRow[]{
  requireColumns(db,'moz_bookmarks',['id','guid','type','fk','parent','title','dateAdded']);
  requireColumns(db,'moz_places',['id','title','url']);
  const rows=db.query(`SELECT b.guid id,coalesce(b.title,p.title) title,p.url,b.dateAdded time,
    parent.title folder FROM moz_bookmarks b JOIN moz_places p ON p.id=b.fk
    LEFT JOIN moz_bookmarks parent ON parent.id=b.parent WHERE b.type=1 ORDER BY b.id LIMIT 100001`).all() as BrowserRow[];
  if(rows.length>100000)fail('SOURCE_LIMIT','Firefox bookmarks exceed 100,000 records');
  if(rows.some(r=>typeof r.id!=='string'||!r.id))fail('UNSUPPORTED_SCHEMA','Firefox bookmark lacks its stable GUID');
  return rows;
}

export function safariBookmarks(tree:unknown):BrowserRow[]{
  const result:BrowserRow[]=[],seen=new Set<string>();let count=0;
  function visit(value:unknown,folder:string,depth:number){
    if(++count>100000||depth>64)fail('SOURCE_LIMIT','Safari bookmark tree exceeds its work budget');
    if(!value||typeof value!=='object'||Array.isArray(value))fail('UNSUPPORTED_SCHEMA','Invalid Safari bookmark node');
    const node=value as Record<string,any>;
    if(node.WebBookmarkType==='WebBookmarkTypeLeaf'){
      if(typeof node.WebBookmarkUUID!=='string'||!node.WebBookmarkUUID||typeof node.URLString!=='string')fail('UNSUPPORTED_SCHEMA','Safari bookmark lacks UUID or URL');
      if(seen.has(node.WebBookmarkUUID))fail('UNSUPPORTED_SCHEMA','Duplicate Safari bookmark UUID');seen.add(node.WebBookmarkUUID);
      result.push({id:node.WebBookmarkUUID,title:node.URIDictionary?.title||node.Title||node.URLString,url:node.URLString,folder});
    }
    if(node.Children!==undefined){
      if(!Array.isArray(node.Children))fail('UNSUPPORTED_SCHEMA','Invalid Safari bookmark children');
      for(const child of node.Children)visit(child,[folder,node.Title].filter(Boolean).join(' / '),depth+1);
    }
  }
  visit(tree,'',0);return result;
}
