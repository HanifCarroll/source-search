import {connectedKinds} from './source-catalog';
export const snapshotKinds:readonly string[]=['tasks',...connectedKinds];
export const directKinds:readonly string[]=['gmail','fastmail','jmap','imap','markdown','messages','whatsapp','muesli','calendar','contacts','ical','vcard','chrome-history','chrome-bookmarks','chrome-downloads','firefox-history','firefox-bookmarks','safari-history','safari-bookmarks','things-archive','chatgpt-archive','takeout-archive','linkedin-archive','twitter-archive','vault','agent-history'];
