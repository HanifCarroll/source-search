import {z} from 'zod';

const count = z.number().int().nonnegative();
const summary = z.object({
  message_id: z.string(),
  thread_id: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  from: z.string().nullable().optional(),
  to: z.array(z.string()),
  cc: z.array(z.string()).optional(),
  date: z.string().nullable().optional(),
  snippet: z.string().nullable().optional(),
  folders: z.array(z.object({id:z.string(), name:z.string(), role:z.string().nullable()})),
  messageId: z.string().optional(),
});
const summaries = z.record(z.string(), summary);

export const imapCheckpointSchema = z.object({
  kind: z.literal('imap'),
  boxes: z.record(z.string(), z.object({
    validity: z.string().regex(/^\d+$/),
    modseq: z.string().regex(/^\d+$/).optional(),
    uidNext: count.optional(),
    exists: count.optional(),
    rows: summaries,
  })),
  visible: summaries,
  pending: z.array(z.string()).optional(),
  removed: z.array(z.string()).optional(),
});
export type ImapCheckpoint = z.infer<typeof imapCheckpointSchema>;

export const jmapCheckpointSchema = z.object({
  kind: z.literal('jmap'),
  boxes: z.string(),
  state: z.string().min(1).optional(),
  // Legacy positional checkpoints must restart their inventory.
  position: count.optional(),
  inventory: z.object({ids:z.array(z.string()), position:count, queryState:z.string().optional()}).optional(),
  pending: z.object({ids:z.array(z.string()), offset:count}).refine(p => p.offset <= p.ids.length).optional(),
}).refine(p => !(p.inventory && p.pending));
