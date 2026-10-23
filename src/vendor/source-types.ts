// Only structural parser output types are retained; there is no canonical store dependency.
export interface Participant { id: string; displayName?: string; role?: "author" | "recipient" | "member" | "owner" | "unknown"; metadata?: Record<string, unknown> }
export interface AttachmentReference { sourceAttachmentId?: string; filename?: string; mimeType?: string; byteSize?: number; localPath?: string; sourceUrl?: string; contentHash?: string; metadata?: Record<string, unknown> }
export interface RawCaptureDraft { sourceRecordId: string; captureType: string; schemaVersion: string; raw: unknown; metadata?: Record<string, unknown> }
export interface ArchivedRawCaptureDraft extends RawCaptureDraft { connectorId: string; sourceKind: string; sourceAccountId: string }
export interface SourceItemDraft {
  connectorId: string; sourceKind: string; sourceAccountId: string; sourceItemId: string; logicalId?: string; physicalId?: string; revisionId?: string;
  isDeleted?: boolean; itemType: string; title?: string; contentText?: string; occurredAt?: Date | string; receivedAt?: Date | string; participants?: Participant[];
  attachments?: AttachmentReference[]; flags?: Record<string, unknown>; metadata?: Record<string, unknown>; rawCapture?: RawCaptureDraft;
}
