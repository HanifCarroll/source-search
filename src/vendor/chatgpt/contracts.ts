export const CHATGPT_EXPORT_MANIFEST_VERSION = 1 as const;
export type ChatGptManifestFile = {
  path: string;
  size: number;
  sha256?: string;
  role?: "manifest" | "conversation-shard" | "asset-name-map" | "attachment" | "other";
};

export type ChatGptExportManifestV1 = {
  version: typeof CHATGPT_EXPORT_MANIFEST_VERSION;
  files: readonly ChatGptManifestFile[];
  logicalFiles?: {
    conversations?: { files: readonly string[]; shardCount?: number };
    assetNameMap?: { files: readonly string[] };
  };
  raw?: Record<string, unknown>;
};

export type ChatGptExportAssetMetadata = {
  sourceAssetId: string;
  filename?: string;
  mimeType?: string;
  byteSize?: number;
  path?: string;
  sourcePointer?: string;
  metadata: Record<string, unknown>;
};

export type ChatGptExportAssetNameMap = Map<string, ChatGptExportAssetMetadata>;
