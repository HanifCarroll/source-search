import { homedir } from "node:os";
import { join } from "node:path";

export const CASS_VERSION = "0.7.1" as const;
export const DEFAULT_CASS_BINARY_PATH = "/opt/homebrew/bin/cass" as const;
export const DEFAULT_ARCHIVED_SESSIONS_PATH = join(homedir(), ".codex", "archived_sessions");

export type CassSearchMode = "lexical" | "semantic" | "hybrid";
export type CassExportFormat = "markdown" | "text" | "json" | "html";

export type CassSearchRequest = {
  query: string;
  limit?: number;
  offset?: number;
  cursor?: string;
  agents?: readonly string[];
  workspaces?: readonly string[];
  since?: string;
  until?: string;
  mode?: CassSearchMode;
  /** CASS is deliberately constrained to its local source in this wave. */
  source?: "local";
};

export type CassHitProvenance = {
  sourcePath: string;
  lineNumber: number | null;
  agent: string;
  sourceId: string;
  originKind: "local";
  originHost: string | null;
  workspace: string | null;
  workspaceOriginal: string | null;
  createdAt: string | number | null;
  matchType: string | null;
  /** Argument array for a later `cass view` call. No shell command is built. */
  viewArgs: readonly string[];
};

export type CassSearchHit = {
  title: string | null;
  snippet: string | null;
  score: number | null;
  provenance: CassHitProvenance;
};

export type CassSearchResult = {
  query: string;
  hits: readonly CassSearchHit[];
  count: number;
  totalMatches: number;
  limit: number;
  offset: number;
  nextCursor: string | null;
  hitsClamped: boolean;
  budget: {
    elapsedMs: number | null;
    budgetMs: number | null;
    timedOut: boolean;
  };
  meta: {
    searchMode: string | null;
    requestedSearchMode: string | null;
    fallbackTier: string | null;
    fallbackReason: string | null;
    semanticRefinement: boolean | null;
  };
  warnings: readonly string[];
};

export type CassContextRequest = Omit<CassSearchRequest, "limit" | "offset"> & {
  /** One-based position in the reproduced search results. */
  result: number;
  /** Lines before and after the matching line. */
  context?: number;
};

export type CassContextResult = {
  hit: CassSearchHit;
  path: string;
  targetLine: number | null;
  context: number;
  lines: readonly {
    line: number;
    content: string;
    highlighted: boolean;
  }[];
  totalLines: number;
  sourceExists: boolean;
  archiveOnly: boolean;
};

export type CassHealthReport = {
  checkedAt: string;
  status: string | null;
  healthy: boolean;
  initialized: boolean | null;
  healthLevel: string | null;
  explanation: string | null;
  dataDir: string | null;
  readyForSearch: boolean;
  warnings: readonly string[];
  errors: readonly string[];
  rebuilding?: boolean;
  stalled?: boolean;
  incompatible?: boolean;
  index: {
    exists: boolean | null;
    status: string | null;
    fresh: boolean | null;
    stale: boolean | null;
    reason?: string | null;
    databaseFingerprint?: string | null;
    checkpointFingerprint?: string | null;
    documents: number | null;
  };
  recommendedAction?: string | null;
  database: {
    exists: boolean | null;
    opened: boolean | null;
    conversations: number | null;
    messages: number | null;
  };
};

export type CassOnboardingProvider = {
  name: string;
  readiness: string | null;
  estimatedSessions: number | null;
};

export type CassArchivedSessionsCoverage = {
  archivedSessionsPath: string;
  status: "represented" | "not-represented";
  exactPathReported: boolean;
  codexProviderDiscovered: boolean;
  warning: string | null;
};

export type CassOnboardingReport = {
  checkedAt: string;
  dataDir: string | null;
  providers: readonly CassOnboardingProvider[];
  excludedProviders: readonly string[];
  estimatedIndexSessions: number | null;
  indexedConversationCount: number | null;
  semanticReady: boolean | null;
  mutationFree: boolean | null;
  recommendedAction: string | null;
  archivedSessions: CassArchivedSessionsCoverage;
  warnings: readonly string[];
};

export type CassReadinessReport = {
  health: CassHealthReport;
  onboarding: CassOnboardingReport;
  readyForSearch: boolean;
  warnings: readonly string[];
};

export type CassChatGptExportPlan = {
  agent: "chatgpt";
  sourcePath: string;
  sourceId: string;
  format: CassExportFormat;
  args: readonly string[];
  executed: false;
  requiresExplicitExecution: true;
};

export type CassRunnerRequest = {
  binaryPath: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
};

export type CassRunnerResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
};

export type CassRunner = (request: CassRunnerRequest) => Promise<CassRunnerResult>;
