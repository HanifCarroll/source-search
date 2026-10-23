import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AttachmentReference } from "../source-types";
import type { ChatGptExportAssetNameMap, ChatGptManifestFile } from "./contracts";
import { normalizeExportRelativePath } from "./manifest";

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const stringValue = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const integerValue = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const fail = (code: string, message: string): Error => new Error(`[${code}] ${message}`);
const TEXT_KEYS: Readonly<Record<string, true>> = {
  body: true,
  caption: true,
  chunks: true,
  content: true,
  description: true,
  parts: true,
  summary: true,
  text: true,
  transcript: true,
};
const BINARY_KEYS: Readonly<Record<string, true>> = {
  base64: true,
  binary: true,
  bytes: true,
  contentBytes: true,
  content_bytes: true,
  data: true,
  imageData: true,
  image_data: true,
  thumbnail: true,
  thumbnailImageData: true,
  thumbnail_data: true,
};
const IGNORED_TEXT_KEYS: Readonly<Record<string, true>> = {
  asset_id: true,
  asset_pointer: true,
  file_id: true,
  url: true,
};

const POINTER_KEYS = [
  "asset_pointer",
  "asset_id",
  "assetId",
  "file_id",
  "fileId",
  "id",
  "pointer",
  "name",
] as const;
const ATTACHMENT_ID_KEYS = [
  "asset_id",
  "assetId",
  "file_id",
  "fileId",
  "attachment_id",
  "attachmentId",
  "id",
] as const;
const ATTACHMENT_POINTER_KEYS = [
  "asset_pointer",
  "audio_asset_pointer",
  "video_container_asset_pointer",
] as const;
const ATTACHMENT_MARKER_KEYS: Readonly<Record<string, true>> = {
  asset_pointer: true,
  audio_asset_pointer: true,
  video_container_asset_pointer: true,
  asset_id: true,
  assetId: true,
  file_id: true,
  fileId: true,
  attachment_id: true,
  attachmentId: true,
  filename: true,
  file_name: true,
  fileName: true,
};
const ATTACHMENT_MARKER_FIELDS = Object.keys(ATTACHMENT_MARKER_KEYS);

function declaredPath(
  value: string | undefined,
  declaredFiles: ReadonlyMap<string, ChatGptManifestFile> | undefined,
): string | undefined {
  if (!value || !declaredFiles) {
    return undefined;
  }
  try {
    const normalized = normalizeExportRelativePath(value);
    return declaredFiles.has(normalized) ? normalized : undefined;
  } catch {
    return undefined;
  }
}

export type ChatGptParsedMessage = {
  nodeId: string; messageId: string; parentId: string | null; childIds: string[]; selectedBranch: boolean;
  role: string; contentType: string; rawNode: JsonRecord; rawMessage: JsonRecord;
  contentText?: string; attachments: AttachmentReference[]; occurredAt?: Date; updatedAt?: Date;
  sourceCreateTime: unknown; sourceUpdateTime: unknown; modelSlug?: string; status?: string;
};
export type ChatGptParsedConversation = {
  conversationId: string; title?: string; createTime?: Date; updateTime?: Date;
  sourceCreateTime: unknown; sourceUpdateTime: unknown; currentNode: string | null; isArchived?: boolean;
  mapping: Map<string, { nodeId: string; message: JsonRecord | null; parentId: string | null; childIds: string[]; childrenDeclared: boolean; rawNode: JsonRecord }>;
  messages: ChatGptParsedMessage[]; shardPath: string; rawConversation: JsonRecord;
};
export type ChatGptParseOptions = {
  shardPath: string; sourceAccountId: string; snapshotFingerprint?: string; exportRoot?: string;
  assetNameMap?: ChatGptExportAssetNameMap | undefined; declaredFiles?: ReadonlyMap<string, ChatGptManifestFile>; maxNearbyItems?: number; maxNearbyChars?: number;
};

function parseTimestamp(
  value: unknown,
  label: string,
  required: boolean,
): Date | undefined {
  if (value === null || value === undefined || value === "") {
    if (required) {
      throw fail("INVALID_TIMESTAMP", `${label} is required.`);
    }
    return undefined;
  }

  let date: Date;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw fail("INVALID_TIMESTAMP", `${label} is not finite.`);
    }
    date = new Date(
      Math.abs(value) < 100_000_000_000 ? value * 1000 : value,
    );
  } else if (typeof value === "string") {
    const numericValue = Number(value);
    const trimmedValue = value.trim();
    date =
      trimmedValue && Number.isFinite(numericValue)
        ? new Date(
            Math.abs(numericValue) < 100_000_000_000
              ? numericValue * 1000
              : numericValue,
          )
        : new Date(value);
  } else {
    throw fail(
      "INVALID_TIMESTAMP",
      `${label} must be a number or ISO string.`,
    );
  }
  if (Number.isNaN(date.getTime())) {
    throw fail("INVALID_TIMESTAMP", `${label} is invalid.`);
  }
  return date;
}

function collectText(
  value: unknown,
  key: string | undefined,
  chunks: string[],
  seen: Set<object>,
): void {
  if (typeof value === "string") {
    if (!key || TEXT_KEYS[key] === true) {
      chunks.push(value);
    }
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectText(entry, key, chunks, seen);
    }
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    if (
      BINARY_KEYS[childKey] === true ||
      IGNORED_TEXT_KEYS[childKey] === true
    ) {
      continue;
    }
    collectText(childValue, childKey, chunks, seen);
  }
}

/** Supports text, multimodal_text, reasoning_recap, and thoughts (including thoughts[].chunks). */
export function extractChatGptText(
  content: unknown,
  _contentType?: string,
): string | undefined {
  if (content === null || content === undefined) {
    return undefined;
  }

  const chunks: string[] = [];
  collectText(content, undefined, chunks, new Set());
  const seen = new Set<string>();
  const result: string[] = [];
  for (const chunk of chunks) {
    const text = chunk.trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  }
  return result.length ? result.join("\n") : undefined;
}

function pointerString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return stringValue(value);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of POINTER_KEYS) {
    const result = stringValue(value[key]);
    if (result) {
      return result;
    }
  }
  return undefined;
}

function pointerCandidates(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  const base = value.split("://").at(-1) ?? value;
  const candidates = [value, base, base.split("/").at(-1) ?? base];
  const last = candidates.at(-1)!;
  candidates.push(`${last}.dat`);
  if (last.startsWith("file-")) {
    candidates.push(last.slice(5), `${last.slice(5)}.dat`);
  } else {
    candidates.push(`file-${last}.dat`);
  }
  return [...new Set(candidates)];
}

function looksLikeAttachment(
  value: JsonRecord,
  key?: string,
): boolean {
  const type = (stringValue(value.content_type) ?? "").toLowerCase();
  if (type === "audio_transcription") {
    return false;
  }
  if (
    type.includes("asset") ||
    type.includes("attachment") ||
    type.includes("file")
  ) {
    return true;
  }
  if (
    type.includes("image") &&
    (value.asset_pointer !== undefined || value.file_id !== undefined)
  ) {
    return true;
  }

  const hasAttachmentMarker = ATTACHMENT_MARKER_FIELDS.some(
    (field) => value[field] !== undefined,
  );
  return (
    hasAttachmentMarker ||
    (value.id !== undefined && value.name !== undefined) ||
    key === "attachments" ||
    key === "files"
  );
}

function scalarMetadata(value: JsonRecord): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      BINARY_KEYS[key] === true ||
      child === null ||
      typeof child === "object"
    ) {
      continue;
    }
    if (
      typeof child === "string" ||
      typeof child === "number" ||
      typeof child === "boolean"
    ) {
      result[key] = child;
    }
  }
  return result;
}

function attachmentId(value: JsonRecord): string | undefined {
  for (const key of ATTACHMENT_ID_KEYS) {
    const result = stringValue(value[key]);
    if (result) {
      return result;
    }
  }
  const path = stringValue(value.path) ?? stringValue(value.file_path);
  return path
    ? `path:${createHash("sha256").update(path).digest("hex").slice(0, 24)}`
    : undefined;
}

function extractAttachments(
  value: unknown,
  options: ChatGptParseOptions,
  output: AttachmentReference[],
  seen: Set<object>,
  key?: string,
): void {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      extractAttachments(entry, options, output, seen, key);
    }
    return;
  }

  const record = value as JsonRecord;
  if (looksLikeAttachment(record, key)) {
    const pointers: string[] = [];
    for (const pointerKey of ATTACHMENT_POINTER_KEYS) {
      const pointer = pointerString(record[pointerKey]);
      if (pointer && !pointers.includes(pointer)) {
        pointers.push(pointer);
      }
    }
    if (Array.isArray(record.frames_asset_pointers)) {
      for (const framePointerValue of record.frames_asset_pointers) {
        const framePointer = pointerString(framePointerValue);
        if (framePointer && !pointers.includes(framePointer)) {
          pointers.push(framePointer);
        }
      }
    }

    const fallbackId = attachmentId(record);
    const references = pointers.length
      ? pointers
      : fallbackId
        ? [fallbackId]
        : [];
    for (const reference of references) {
      const mapped = pointerCandidates(reference)
        .map((candidate) => options.assetNameMap?.get(candidate))
        .find(
          (candidate): candidate is NonNullable<typeof candidate> =>
            Boolean(candidate),
        );
      const filename =
        stringValue(record.filename) ??
        stringValue(record.file_name) ??
        stringValue(record.fileName) ??
        stringValue(record.name) ??
        mapped?.filename;
      const path =
        mapped?.path ??
        stringValue(record.path) ??
        stringValue(record.file_path);
      const sourceAssetId = mapped?.sourceAssetId ?? reference;
      const mimeType =
        stringValue(record.mime_type) ??
        stringValue(record.mimeType) ??
        mapped?.mimeType;
      const byteSize =
        integerValue(record.byte_size) ??
        integerValue(record.size_bytes) ??
        integerValue(record.byteSize) ??
        integerValue(record.size) ??
        mapped?.byteSize;
      const safePath = declaredPath(path, options.declaredFiles);
      const localPath =
        safePath && options.exportRoot
          ? join(options.exportRoot, safePath)
          : undefined;
      const attachment: AttachmentReference = {
        sourceAttachmentId: sourceAssetId,
        ...(filename ? { filename } : {}),
        ...(mimeType !== undefined ? { mimeType } : {}),
        ...(byteSize !== undefined ? { byteSize } : {}),
        metadata: {
          ...(mapped?.metadata ?? {}),
          ...scalarMetadata(record),
          sourcePointer: mapped?.sourcePointer ?? reference,
          declared: Boolean(safePath),
          contentAvailable: Boolean(localPath),
          contentRead: false,
          ...(safePath ? { declaredPath: safePath } : {}),
        },
        ...(localPath ? { localPath } : {}),
      };
      const existing = output.find(
        (entry) => entry.sourceAttachmentId === attachment.sourceAttachmentId,
      );
      if (!existing) {
        output.push(attachment);
        continue;
      }
      if (existing.filename === undefined && attachment.filename !== undefined) {
        existing.filename = attachment.filename;
      }
      if (existing.mimeType === undefined && attachment.mimeType !== undefined) {
        existing.mimeType = attachment.mimeType;
      }
      if (existing.byteSize === undefined && attachment.byteSize !== undefined) {
        existing.byteSize = attachment.byteSize;
      }
      if (existing.localPath === undefined && attachment.localPath !== undefined) {
        existing.localPath = attachment.localPath;
      }
      if (existing.sourceUrl === undefined && attachment.sourceUrl !== undefined) {
        existing.sourceUrl = attachment.sourceUrl;
      }
      if (existing.contentHash === undefined && attachment.contentHash !== undefined) {
        existing.contentHash = attachment.contentHash;
      }
      const sourcePointer =
        existing.metadata?.sourcePointer ?? attachment.metadata?.sourcePointer;
      existing.metadata = {
        ...(existing.metadata ?? {}),
        ...(attachment.metadata ?? {}),
        ...(sourcePointer === undefined ? {} : { sourcePointer }),
      };
    }
  }

  for (const [childKey, childValue] of Object.entries(record)) {
    if (BINARY_KEYS[childKey] !== true) {
      extractAttachments(childValue, options, output, seen, childKey);
    }
  }
}

export function collectChatGptAttachments(
  value: unknown,
  options: ChatGptParseOptions,
): AttachmentReference[] {
  const result: AttachmentReference[] = [];
  extractAttachments(value, options, result, new Set());
  return result;
}

export function indexChatGptAssetNameMap(
  value: unknown,
): ChatGptExportAssetNameMap {
  if (!isRecord(value) && !Array.isArray(value)) {
    throw fail(
      "INVALID_ASSET_MAP",
      "Asset-name map must be an object or array.",
    );
  }
  const result: ChatGptExportAssetNameMap = new Map();
  if (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  ) {
    for (const [physicalPath, friendlyName] of Object.entries(value)) {
      result.set(physicalPath, {
        sourceAssetId: physicalPath,
        filename: friendlyName as string,
        path: physicalPath,
        metadata: { mapEntry: true },
      });
    }
    return result;
  }

  const visited = new Set<object>();
  const visit = (candidate: unknown, fallback?: string): void => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      visited.has(candidate)
    ) {
      return;
    }
    visited.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item);
      }
      return;
    }

    const record = candidate as JsonRecord;
    const id =
      stringValue(record.asset_id) ??
      stringValue(record.assetId) ??
      stringValue(record.file_id) ??
      stringValue(record.fileId) ??
      stringValue(record.id) ??
      fallback;
    const filename =
      stringValue(record.filename) ??
      stringValue(record.file_name) ??
      stringValue(record.fileName) ??
      stringValue(record.name);
    const path =
      stringValue(record.path) ??
      stringValue(record.file_path) ??
      fallback;
    const mimeType =
      stringValue(record.mime_type) ?? stringValue(record.mimeType);
    const byteSize =
      integerValue(record.byte_size) ??
      integerValue(record.size_bytes) ??
      integerValue(record.byteSize) ??
      integerValue(record.size) ??
      integerValue(record.bytes);

    if (id && (filename || path || mimeType || byteSize !== undefined)) {
      result.set(id, {
        sourceAssetId: id,
        ...(filename ? { filename } : {}),
        ...(path ? { path } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(byteSize !== undefined ? { byteSize } : {}),
        ...(typeof record.source_pointer === "string"
          ? { sourcePointer: record.source_pointer }
          : {}),
        metadata: scalarMetadata(record),
      });
    }
    for (const [key, child] of Object.entries(record)) {
      if (
        BINARY_KEYS[key] !== true &&
        (isRecord(child) || Array.isArray(child))
      ) {
        visit(child, key);
      }
    }
  };
  visit(value);
  return result;
}

function parseNode(
  value: unknown,
  key: string,
): {
  nodeId: string;
  message: JsonRecord | null;
  parentId: string | null;
  childIds: string[];
  childrenDeclared: boolean;
  rawNode: JsonRecord;
} {
  if (!isRecord(value)) {
    throw fail(
      "INVALID_MAPPING_NODE",
      `Mapping node ${key} must be an object.`,
    );
  }
  const nodeId = stringValue(value.id);
  if (!nodeId || nodeId !== key) {
    throw fail(
      "INVALID_MAPPING_NODE",
      `Mapping key ${key} must match node id.`,
    );
  }

  let message: JsonRecord | null;
  if (value.message === null || value.message === undefined) {
    message = null;
  } else if (isRecord(value.message)) {
    message = value.message;
  } else {
    throw fail(
      "INVALID_MESSAGE",
      `Mapping node ${key} has malformed message.`,
    );
  }

  let parentId: string | null = null;
  if (value.parent !== null && value.parent !== undefined) {
    const parsedParentId = stringValue(value.parent);
    if (!parsedParentId) {
      throw fail(
        "INVALID_PARENT",
        `Mapping node ${key} has malformed parent.`,
      );
    }
    parentId = parsedParentId;
  }

  const childrenDeclared = Object.prototype.hasOwnProperty.call(
    value,
    "children",
  );
  const rawChildren =
    value.children === undefined || value.children === null
      ? []
      : value.children;
  if (!Array.isArray(rawChildren)) {
    throw fail(
      "INVALID_CHILDREN",
      `Mapping node ${key} children must be an array.`,
    );
  }
  const childIds: string[] = [];
  for (const child of rawChildren) {
    const childId = stringValue(child);
    if (!childId || childIds.includes(childId)) {
      throw fail(
        "INVALID_CHILDREN",
        `Mapping node ${key} has invalid/duplicate child.`,
      );
    }
    childIds.push(childId);
  }
  return {
    nodeId,
    message,
    parentId,
    childIds,
    childrenDeclared,
    rawNode: value,
  };
}

export function parseChatGptConversation(
  value: unknown,
  shardPath: string,
): ChatGptParsedConversation {
  if (!isRecord(value)) {
    throw fail(
      "INVALID_CONVERSATION",
      `Conversation in ${shardPath} must be an object.`,
    );
  }
  const conversationId =
    stringValue(value.conversation_id) ??
    stringValue(value.conversationId) ??
    stringValue(value.id);
  if (!conversationId) {
    throw fail(
      "INVALID_CONVERSATION_ID",
      `Conversation in ${shardPath} has no ID.`,
    );
  }
  if (!isRecord(value.mapping) || !Object.keys(value.mapping).length) {
    throw fail(
      "INVALID_MAPPING",
      `Conversation ${conversationId} has no mapping.`,
    );
  }

  const mapping = new Map<
    string,
    {
      nodeId: string;
      message: JsonRecord | null;
      parentId: string | null;
      childIds: string[];
      childrenDeclared: boolean;
      rawNode: JsonRecord;
    }
  >();
  for (const [key, node] of Object.entries(value.mapping)) {
    mapping.set(key, parseNode(node, key));
  }
  const roots = [...mapping.values()].filter((node) => node.message === null);
  if (roots.length !== 1 || roots[0]!.parentId !== null) {
    throw fail(
      "INVALID_ROOT",
      `Conversation ${conversationId} must have one null-message root.`,
    );
  }

  const derivedChildren = new Map<string, string[]>();
  for (const node of mapping.values()) {
    derivedChildren.set(node.nodeId, []);
  }
  for (const node of mapping.values()) {
    if (node.parentId === null) {
      continue;
    }
    if (!mapping.has(node.parentId)) {
      throw fail(
        "MISSING_PARENT",
        `Conversation ${conversationId} has a missing parent.`,
      );
    }
    derivedChildren.get(node.parentId)!.push(node.nodeId);
  }
  for (const node of mapping.values()) {
    const derived = derivedChildren.get(node.nodeId)!;
    if (node.childrenDeclared) {
      const declared = [...node.childIds].sort().join("\u001f");
      const derivedPath = [...derived].sort().join("\u001f");
      if (declared !== derivedPath) {
        throw fail(
          "INVALID_CHILD_LINK",
          `Conversation ${conversationId} has children inconsistent with parent links.`,
        );
      }
    }
    node.childIds = derived;
  }
  for (const node of mapping.values()) {
    for (const childId of node.childIds) {
      const child = mapping.get(childId);
      if (!child || child.parentId !== node.nodeId) {
        throw fail(
          "INVALID_CHILD_LINK",
          `Conversation ${conversationId} has invalid child link.`,
        );
      }
    }
  }

  const rootId = roots[0]!.nodeId;
  for (const node of mapping.values()) {
    const seen = new Set<string>();
    let cursor: string | null = node.nodeId;
    while (cursor) {
      if (seen.has(cursor)) {
        throw fail(
          "MAPPING_CYCLE",
          `Conversation ${conversationId} has a parent cycle.`,
        );
      }
      seen.add(cursor);
      if (cursor === rootId) {
        break;
      }
      const nextParentId: string | null | undefined =
        mapping.get(cursor)?.parentId;
      if (!nextParentId) {
        throw fail(
          "DISCONNECTED_MAPPING",
          `Conversation ${conversationId} has a node disconnected from its root.`,
        );
      }
      cursor = nextParentId;
    }
  }

  const currentValue = value.current_node ?? value.currentNode;
  let currentNode: string | null = null;
  if (currentValue !== null && currentValue !== undefined) {
    const parsedCurrentNode = stringValue(currentValue);
    if (!parsedCurrentNode || !mapping.has(parsedCurrentNode)) {
      throw fail(
        "INVALID_CURRENT_NODE",
        `Conversation ${conversationId} current_node is invalid.`,
      );
    }
    currentNode = parsedCurrentNode;
  }
  const selected = new Set<string>();
  let selectedCursor = currentNode;
  while (selectedCursor) {
    selected.add(selectedCursor);
    selectedCursor = mapping.get(selectedCursor)?.parentId ?? null;
  }

  const sourceCreateTime = value.create_time ?? value.createTime;
  const sourceUpdateTime = value.update_time ?? value.updateTime;
  const createTime = parseTimestamp(
    sourceCreateTime,
    `conversation ${conversationId} create_time`,
    false,
  );
  const updateTime = parseTimestamp(
    sourceUpdateTime,
    `conversation ${conversationId} update_time`,
    false,
  );
  const title = stringValue(value.title);
  const messages: ChatGptParsedMessage[] = [];
  const messageIds = new Set<string>();

  for (const node of mapping.values()) {
    if (node.message === null) {
      continue;
    }
    const message = node.message;
    const messageId = stringValue(message.id);
    if (!messageId || messageIds.has(messageId)) {
      throw fail(
        "DUPLICATE_MESSAGE_ID",
        `Conversation ${conversationId} has duplicate message ID.`,
      );
    }
    messageIds.add(messageId);

    const author = message.author;
    if (!isRecord(author)) {
      throw fail("INVALID_AUTHOR", `Message ${messageId} has no author.`);
    }
    const role = stringValue(author.role);
    if (!role) {
      throw fail(
        "UNSUPPORTED_ROLE",
        `Message ${messageId} lacks a role.`,
      );
    }

    const sourceCreate = message.create_time ?? message.createTime;
    const sourceUpdate = message.update_time ?? message.updateTime;
    const occurredAt = parseTimestamp(
      sourceCreate,
      `message ${messageId} create_time`,
      false,
    );
    const updatedAt = parseTimestamp(
      sourceUpdate,
      `message ${messageId} update_time`,
      false,
    );
    const content = message.content;
    const contentType = isRecord(content)
      ? stringValue(content.content_type) ??
        stringValue(content.contentType) ??
        "unknown"
      : "unknown";
    const contentText = extractChatGptText(content, contentType);
    const metadata = isRecord(message.metadata)
      ? message.metadata
      : undefined;
    const modelSlug =
      stringValue(metadata?.model_slug) ??
      stringValue(metadata?.modelSlug) ??
      stringValue(metadata?.model) ??
      stringValue(message.model_slug);
    const status = stringValue(message.status);

    messages.push({
      nodeId: node.nodeId,
      messageId,
      parentId: node.parentId,
      childIds: node.childIds,
      selectedBranch: selected.has(node.nodeId),
      role,
      contentType,
      rawNode: node.rawNode,
      rawMessage: message,
      ...(contentText ? { contentText } : {}),
      attachments: [],
      occurredAt,
      ...(updatedAt ? { updatedAt } : {}),
      sourceCreateTime: sourceCreate,
      sourceUpdateTime: sourceUpdate,
      ...(modelSlug ? { modelSlug } : {}),
      ...(status ? { status } : {}),
    });
  }
  return {
    conversationId,
    ...(title ? { title } : {}),
    ...(createTime ? { createTime } : {}),
    ...(updateTime ? { updateTime } : {}),
    sourceCreateTime,
    sourceUpdateTime,
    currentNode,
    ...(typeof value.is_archived === "boolean"
      ? { isArchived: value.is_archived }
      : {}),
    mapping,
    messages,
    shardPath,
    rawConversation: value,
  };
}

export function parseChatGptConversationShard(
  value: unknown,
  shardPath: string,
): ChatGptParsedConversation[] {
  if (!Array.isArray(value)) {
    throw fail(
      "INVALID_SHARD",
      `Conversation shard ${shardPath} must be an array.`,
    );
  }
  return value.map((entry) => parseChatGptConversation(entry, shardPath));
}
