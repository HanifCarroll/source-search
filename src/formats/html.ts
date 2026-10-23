import {compile} from 'html-to-text';

// Shared by mail, calendar and archive adapters. Preserve readable boundaries;
// the source adapters own record and attachment selection.
export const stripHtml = compile({
  wordwrap:false,
  limits:{maxInputLength:16*1024*1024,maxDepth:1000,maxChildNodes:1000000,ellipsis:' [HTML text truncated] '},
  selectors:[
    {selector:'table',format:'dataTable'},
    {selector:'table[role=presentation]',format:'block'},
    {selector:'a',options:{hideLinkHrefIfSameAsText:true}},
    ...['h1','h2','h3','h4','h5','h6'].map(selector=>({selector,options:{uppercase:false}})),
    {selector:'img',format:'skip'},
  ],
});
export function readableHtml(value:string){
  return /<(?:html|body|div|table|p|span|a|br|b|strong|ul|li|h[1-6])\b[^>]*>/i.test(value) ? stripHtml(value) : value;
}
