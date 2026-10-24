import { z } from "zod";
export const sourceId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).refine(id=>id!=="constructor","Reserved source ID");
export const sectionKind = z.enum(["primary", "quoted", "generated", "manual", "review", "metadata"]);
export type SectionKind = z.infer<typeof sectionKind>;
export type TextSection = { kind: SectionKind; start: number; end: number };
export type MatchInfo = { field: "body" | "title" | "provider" | "browse"; section?: SectionKind; start?: number; end?: number; explanation?: string };
export const taskFilterSchema=z.object({
  status:z.enum(['open','completed','canceled']).optional(),
  dueFrom:z.iso.date().optional(),dueBefore:z.iso.date().optional(),
  projectId:z.string().min(1).max(500).optional(),projectName:z.string().min(1).max(1000).optional(),
}).strict().refine(t=>!t.dueFrom||!t.dueBefore||t.dueFrom<t.dueBefore,'dueFrom must precede dueBefore');
export type TaskFields={status:'open'|'completed'|'canceled';project?:{id?:string;name:string};dueDate?:string;invalidDueDate?:true;trashed?:boolean};
export type SnapshotCoverage={kind:'synchronized-snapshot'|'historical-archive';asOf:string;syncedAt?:string;description:string;window?:{from:string;to:string};lastAttemptAt?:string;lastError?:{code:string;message:string};unclassifiedTasks?:number;invalidDueDates?:number};
export const querySchema = z.object({
  source: sourceId, query: z.string().max(1000),
  from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
  conversation: z.string().min(1).max(500).optional(), cursor: z.string().max(8192).optional(),
  mode: z.enum(["lexical", "semantic", "hybrid"]).optional(),
  match: z.enum(["words", "phrase"]).optional(),
  sections: z.array(sectionKind).min(1).max(6).optional(),
  sort: z.enum(["relevance", "newest", "oldest", "due"]).optional(),
  task:taskFilterSchema.optional(),
  types: z.array(z.string().min(1).max(100)).max(20).optional(),
  roles: z.array(z.string().min(1).max(100)).max(10).optional(),
  contentTypes: z.array(z.string().min(1).max(100)).max(20).optional(),
  selectedBranch: z.boolean().optional(),
  folders: z.array(z.string().min(1).max(200)).max(20).optional(),
  excludeSpamTrash: z.boolean().optional(),
  limit: z.number().int().min(1).max(25).default(10)
}).strict().refine(q => !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to), "from must precede to");
export const selectionSchema = z.object({...querySchema.shape,source:sourceId}).strict().refine(q=>!q.from || !q.to || Date.parse(q.from)<Date.parse(q.to),"from must precede to");
export const searchSchema = z.object({ queries: z.array(selectionSchema).min(1).max(100) }).strict()
  .refine(r => new Set(r.queries.map(q => q.source)).size === r.queries.length, "Search each source at most once per request");
export const refSchema = z.object({ source: sourceId, id: z.string().min(1).max(16000), version: z.string().max(100).optional() }).strict();
export const readSchema = z.object({ ref: refSchema, cursor: z.string().max(4000).optional(), focus:z.string().max(1000).optional(), preview:z.boolean().default(false), context: z.boolean().default(false), details: z.boolean().default(false) }).strict();
export type Query = z.infer<typeof querySchema>;
export type Ref = z.infer<typeof refSchema>;
export type RecordData = {
  adapter?: string; ref: Ref; title: string; body: string; type: string; locator: string;
  occurredAt?: string; observedAt: string; author?: string; conversation?: string;
  metadata?: Record<string, unknown>; warnings?: string[]; sections?: TextSection[];
  task?:TaskFields;
};
export type Hit = Omit<RecordData, "body" | "locator" | "observedAt"> & { locator?:string; excerpt: string; cursorAfter: string; match: MatchInfo; focus?: string };
export type Page = { retrieval?: { requestedMode: string; effectiveMode: string | null; fallbackReason?: string | null }; source: Query["source"]; status: "ok" | "partial" | "error"; items: Hit[]; nextCursor?: string; warnings: string[]; error?: { code: string; message: string }; observedAt: string; totalMatches?: number; coverage?:SnapshotCoverage; budgetReduced?:boolean; reduction?: { requested:number; returned:number; reason:string }; scan?: {checked:number; undecodable:number; missingText?:number; exhausted:boolean; dateSpan?: {from?:string;to?:string}; workLimit?:string}; progress?: { returned:number; hasMore:boolean; totalMatches:number|null; continuation:string }; query?: Record<string,unknown>; sourceWarnings?: string[] };
