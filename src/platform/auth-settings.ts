import {z} from 'zod';
import {isAbsolute} from 'node:path';
const path=z.string().refine(isAbsolute,'Use an absolute path');
export const secretSchema=z.union([
  z.object({env:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)}).strict(),
  z.object({file:path}).strict(),
  z.object({command:z.array(z.string().min(1).max(2000)).min(1).max(20)}).strict(),
]);
export type Secret=z.infer<typeof secretSchema>;
export const microsoftOAuthSchema=z.object({clientId:z.uuid(),tenant:z.union([z.enum(['common','consumers','organizations']),z.uuid()]).default('common'),cache:path}).strict();
export const googleOAuthSchema=z.object({clientId:z.string().min(1).max(500),clientSecret:secretSchema.optional(),cache:path}).strict();
export type GoogleOAuth=z.infer<typeof googleOAuthSchema>;
export type MicrosoftOAuth=z.infer<typeof microsoftOAuthSchema>;
export const googleAuth={token:secretSchema.optional(),oauth:googleOAuthSchema.optional()};
export const microsoftAuth={token:secretSchema.optional(),oauth:microsoftOAuthSchema.optional()};
export const oneCredential=(s:{token?:unknown;oauth?:unknown})=>!!s.token!==!!s.oauth;

// Credential locators can rotate without invalidating saved record references.
// Account identity, endpoints, selected collections and OAuth cache still bind
// a snapshot to the exact configured connection.
export function connectionIdentity(value:unknown):unknown{
  if(Array.isArray(value))return value.map(connectionIdentity);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!['token','password','clientSecret','label','sync'].includes(key)).map(([key,v])=>[key,connectionIdentity(v)]));
}
