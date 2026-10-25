import {z} from 'zod';
import {hitSchema,searchSchema,contextSchema,healthSchema,onboardingSchema} from './schemas';
import { homedir } from "node:os";
import { isAbsolute, normalize, sep, join } from "node:path";

import {
  DEFAULT_ARCHIVED_SESSIONS_PATH,
  DEFAULT_CASS_BINARY_PATH,
  type CassChatGptExportPlan,
  type CassContextRequest,
  type CassContextResult,
  type CassExportFormat,
  type CassHealthReport,
  type CassHitProvenance,
  type CassOnboardingReport,
  type CassOnboardingProvider,
  type CassReadinessReport,
  type CassRunner,
  type CassRunnerResult,
  type CassSearchHit,
  type CassSearchMode,
  type CassSearchRequest,
  type CassSearchResult,
} from "./contracts.ts";
import { runLocalCass } from "./runner.ts";

const DEFAULTS = {
  searchTimeoutMs: 10_000,
  slowSearchTimeoutMs: 120_000,
  viewTimeoutMs: 10_000,
  healthTimeoutMs: 5_000,
  onboardingTimeoutMs: 15_000,
  maxOutputBytes: 1_000_000,
  maxResults: 50,
  defaultResults: 20,
  maxSnippetChars: 1_200,
  maxTitleChars: 240,
  maxTokens: 10_000,
  maxQueryChars: 2_000,
  maxFilterValues: 16,
  maxFilterChars: 512,
  maxContextLines: 10,
} as const;

const SEARCH_FIELDS = [
  "source_path",
  "line_number",
  "agent",
  "workspace",
  "workspace_original",
  "title",
  "snippet",
  "score",
  "created_at",
  "match_type",
  "source_id",
  "origin_kind",
  "origin_host",
].join(",");

const CASS_TIMEOUT_GRACE_MS = 2_000;

export type CassProviderErrorCode =
  | "invalid_request"
  | "invalid_cursor"
  | "not_found"
  | "unavailable"
  | "timed_out"
  | "output_limit_exceeded"
  | "command_failed"
  | "invalid_response"
  | "remote_source_rejected"
  | "unsupported_export";

export class CassProviderError extends Error {
  readonly code: CassProviderErrorCode;
  readonly operation: string;
  readonly exitCode: number | null;
  readonly retryable: boolean;

  constructor(
    code: CassProviderErrorCode,
    operation: string,
    message: string,
    details: { exitCode?: number | null; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "CassProviderError";
    this.code = code;
    this.operation = operation;
    this.exitCode = details.exitCode ?? null;
    this.retryable = details.retryable ?? false;
  }
}

export type CassProviderOptions = {
  runner?: CassRunner;
  binaryPath?: string;
  dataDir?: string;
  archivedSessionsPath?: string;
  searchTimeoutMs?: number;
  slowSearchTimeoutMs?: number;
  viewTimeoutMs?: number;
  healthTimeoutMs?: number;
  onboardingTimeoutMs?: number;
  maxOutputBytes?: number;
  maxResults?: number;
  maxSnippetChars?: number;
  maxTokens?: number;
  maxQueryChars?: number;
};

export type CassChatGptExportOptions = {
  format?: CassExportFormat;
  outputPath?: string;
  includeTools?: boolean;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(operation: string, field: string): CassProviderError {
  return new CassProviderError(
    "invalid_response",
    operation,
    `CASS ${operation} returned an invalid machine-readable response (${field}).`,
  );
}

function parseResponse<T>(schema:z.ZodType<T>, raw:unknown, operation:string):T {
  const result=schema.safeParse(raw);
  if(!result.success)throw invalidResponse(operation,result.error.issues[0]?.path.join('.') || 'root');
  return result.data;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function truncate(value: string | null, maxChars: number): string | null {
  if (value === null) return null;
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function validateAbsolutePath(value: string, field: string): string {
  if (!isAbsolute(value) || value.includes("\0") || value.length > 4_096) {
    throw new CassProviderError("invalid_request", "configuration", `${field} must be an absolute local path.`);
  }
  return normalize(value);
}

function validatePositiveInteger(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new CassProviderError("invalid_request", "configuration", `${field} is outside its safe limit.`);
  }
  return value;
}

function validateTimeFilter(value: string, field: string): string {
  const relativeValue = /^-\d+(?:m|h|d|w)$/.test(value);
  const keywordValue = value === "today" || value === "yesterday" || value === "now";
  const isoValue = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value);
  if (!relativeValue && !keywordValue && !isoValue) {
    throw new CassProviderError("invalid_request", "search", `${field} is not a supported CASS time filter.`);
  }
  return value;
}

function validateFilterList(values: readonly string[] | undefined, field: string): readonly string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > DEFAULTS.maxFilterValues) {
    throw new CassProviderError("invalid_request", "search", `${field} has too many values.`);
  }
  return values.map((value) => {
    if (typeof value !== "string" || value.length === 0 || value.length > DEFAULTS.maxFilterChars || value.includes("\0")) {
      throw new CassProviderError("invalid_request", "search", `${field} contains an invalid value.`);
    }
    return value;
  });
}

function displayPath(path: string): string {
  const home = normalize(homedir());
  if (home && (path === home || path.startsWith(`${home}${sep}`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function pathStringRepresents(value: string, target: string): boolean {
  const home = normalize(homedir());
  const tildeTarget = home && target.startsWith(`${home}${sep}`) ? `~${target.slice(home.length)}` : null;
  if (value === target || (tildeTarget !== null && value === tildeTarget)) return true;
  if (value.includes(target) || (tildeTarget !== null && value.includes(tildeTarget))) return true;
  if (value.startsWith("file://")) return normalize(value.slice("file://".length)) === target;
  return false;
}

function containsPathRepresentation(value: unknown, target: string, depth = 0): boolean {
  if (depth > 8) return false;
  if (typeof value === "string") return pathStringRepresents(value, target);
  if (Array.isArray(value)) return value.some((item) => containsPathRepresentation(item, target, depth + 1));
  if (!isObject(value)) return false;
  return Object.values(value).some((item) => containsPathRepresentation(item, target, depth + 1));
}

function buildViewArgs(provenance: {
  sourcePath: string;
  sourceId: string;
  lineNumber: number | null;
  dataDir: string | null;
}): readonly string[] {
  const args = [
    "--color=never",
    ...(provenance.dataDir === null ? [] : ["--db", join(provenance.dataDir,"agent_search.db")]),
    "view",
    provenance.sourcePath,
    `--source=${provenance.sourceId}`,
    "--robot-format=json",
  ];
  if (provenance.lineNumber !== null) args.push("--message-index", String(provenance.lineNumber));
  return args;
}

function parseHit(value: unknown, provider: CassProvider, operation = "search"): CassSearchHit {
  const raw = parseResponse(hitSchema,value,operation);
  if (raw.origin_kind !== "local") {
    throw new CassProviderError("remote_source_rejected",operation,
      "CASS returned a non-local hit; Context only accepts local CASS provenance.");
  }
  const provenance: CassHitProvenance = {
    sourcePath:raw.source_path,lineNumber:raw.line_number,agent:raw.agent,sourceId:raw.source_id,
    originKind:raw.origin_kind,originHost:raw.origin_host,workspace:raw.workspace,
    workspaceOriginal:raw.workspace_original,createdAt:raw.created_at,matchType:raw.match_type,
    viewArgs:buildViewArgs({sourcePath:raw.source_path,sourceId:raw.source_id,lineNumber:raw.line_number,dataDir:provider.dataDir}),
  };
  return {title:truncate(raw.title,provider.maxTitleChars),snippet:truncate(raw.snippet,provider.maxSnippetChars),score:raw.score,provenance};
}

function parseSearch(value:unknown,provider:CassProvider,context:{limit:number;offset:number;query:string}):CassSearchResult {
  const raw=parseResponse(searchSchema(provider.maxQueryChars),value,'search');
  const hits=raw.hits.slice(0,context.limit).map(hit=>parseHit(hit,provider));
  return {
    query:raw.query ?? context.query,hits,count:hits.length,totalMatches:raw.total_matches ?? hits.length,
    limit:Math.min(raw.limit ?? context.limit,context.limit),offset:raw.offset ?? context.offset,
    nextCursor:raw._meta.next_cursor,hitsClamped:(raw.hits_clamped ?? false)||raw.hits.length>context.limit,
    budget:{elapsedMs:raw.budget.elapsed_ms,budgetMs:raw.budget.budget_ms,timedOut:raw.budget.timed_out ?? false},
    meta:{searchMode:raw._meta.search_mode,requestedSearchMode:raw._meta.requested_search_mode,
      fallbackTier:raw._meta.fallback_tier,fallbackReason:raw._meta.fallback_reason,semanticRefinement:raw._meta.semantic_refinement},
    warnings:raw._warning === null ? [] : [raw._warning],
  };
}

function parseContext(value:unknown,provider:CassProvider,hit:CassSearchHit):CassContextResult {
  const raw=parseResponse(contextSchema,value,'view');
  if(normalize(raw.path)!==normalize(hit.provenance.sourcePath))throw invalidResponse('view','path does not match the selected search result');
  return {hit,path:raw.path,targetLine:raw.target_line,context:raw.context,totalLines:raw.total_lines,
    sourceExists:raw.source_exists,archiveOnly:raw.archive_only,
    lines:raw.lines.map(line=>({...line,content:truncate(line.content,provider.maxSnippetChars)!}))};
}

function parseHealth(value: unknown): CassHealthReport {
  const raw=parseResponse(healthSchema,value,'health');
  const {index,database,rebuild}=raw;
  const stalled=rebuild.stalled===true || raw.status==='stalled';
  const rebuilding=rebuild.active===true || raw.status==='rebuilding' || stalled;
  const incompatible=index.engine_incompatible===true;
  const initialized=raw.initialized ?? (database.exists===true && index.exists===true ? true : null);
  // A refresh can leave the last completed lexical index usable. Preserve
  // these CASS-specific readiness rules separately from response validation.
  const readableDuringRefresh=rebuilding && initialized===true && database.exists===true && database.opened===true
    && index.exists===true && index.engine_incompatible===false && index.documents!==null && index.documents>0
    && index.hollow!==true && index.partial!==true && index.checkpoint.completed===true
    && raw.errors.every(error=>['index stale','index rebuild in progress'].includes(error)||error.startsWith('index rebuild stalled'));
  return {
    checkedAt:new Date().toISOString(),status:raw.status,healthy:raw.healthy,initialized,healthLevel:raw.health_level,
    explanation:raw.explanation ?? index.reason,recommendedAction:raw.recommended_action ?? index.recommended_action,
    dataDir:raw.data_dir,readyForSearch:readableDuringRefresh || (raw.healthy && initialized===true && !rebuilding && !incompatible && database.opened!==false && database.exists!==false && index.exists!==false),
    rebuilding,stalled,incompatible,warnings:raw.warnings,errors:raw.errors,
    index:{exists:index.exists,status:index.status,fresh:index.fresh,stale:index.stale,reason:index.reason,
      databaseFingerprint:index.fingerprint.current_db_fingerprint,checkpointFingerprint:index.fingerprint.checkpoint_fingerprint,documents:index.documents},
    database:{exists:database.exists,opened:database.opened,conversations:database.conversations,messages:database.messages},
  };
}

function parseOnboarding(value:unknown,provider:CassProvider):CassOnboardingReport {
  const raw=parseResponse(onboardingSchema,value,'onboarding');
  const providers:CassOnboardingProvider[]=raw.providers.map(p=>({name:p.name,readiness:p.readiness,estimatedSessions:p.estimated_sessions}));
  const exactPathReported=containsPathRepresentation(value,provider.archivedSessionsPath);
  const codexProviderDiscovered=providers.some(p=>p.name.toLowerCase()==='codex');
  const warning=exactPathReported ? null : `CASS onboarding did not represent ${displayPath(provider.archivedSessionsPath)} in its discovery output; Codex archive coverage is unverified.`;
  return {checkedAt:new Date().toISOString(),dataDir:raw.data_dir,providers,excludedProviders:raw.excluded_providers,
    estimatedIndexSessions:raw.estimated_index_sessions,indexedConversationCount:raw.indexed_conversation_count,
    semanticReady:raw.semantic_ready,mutationFree:raw.mutation_free,recommendedAction:raw.recommended_action,
    archivedSessions:{archivedSessionsPath:provider.archivedSessionsPath,status:exactPathReported?'represented':'not-represented',exactPathReported,codexProviderDiscovered,warning},
    warnings:unique([...raw.warnings,...(warning===null?[]:[warning])])};
}

export class CassProvider {
  readonly binaryPath: string;
  readonly dataDir: string | null;
  readonly archivedSessionsPath: string;
  readonly maxSnippetChars: number;
  readonly maxTitleChars = DEFAULTS.maxTitleChars;
  readonly maxQueryChars: number;

  private readonly runner: CassRunner;
  private readonly searchTimeoutMs: number;
  private readonly slowSearchTimeoutMs: number;
  private readonly viewTimeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly onboardingTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly maxResults: number;
  private readonly maxTokens: number;
  private readonly defaultResults: number;

  constructor(options: CassProviderOptions = {}) {
    this.binaryPath = validateAbsolutePath(options.binaryPath ?? DEFAULT_CASS_BINARY_PATH, "binaryPath");
    this.dataDir = options.dataDir === undefined ? null : validateAbsolutePath(options.dataDir, "dataDir");
    this.archivedSessionsPath = validateAbsolutePath(
      options.archivedSessionsPath ?? DEFAULT_ARCHIVED_SESSIONS_PATH,
      "archivedSessionsPath",
    );
    this.searchTimeoutMs = validatePositiveInteger(
      options.searchTimeoutMs ?? DEFAULTS.searchTimeoutMs,
      "searchTimeoutMs",
      180_000,
    );
    this.slowSearchTimeoutMs = validatePositiveInteger(
      options.slowSearchTimeoutMs ?? DEFAULTS.slowSearchTimeoutMs,
      "slowSearchTimeoutMs",
      180_000,
    );
    this.viewTimeoutMs = validatePositiveInteger(
      options.viewTimeoutMs ?? DEFAULTS.viewTimeoutMs,
      "viewTimeoutMs",
      180_000,
    );
    this.healthTimeoutMs = validatePositiveInteger(
      options.healthTimeoutMs ?? DEFAULTS.healthTimeoutMs,
      "healthTimeoutMs",
      60_000,
    );
    this.onboardingTimeoutMs = validatePositiveInteger(
      options.onboardingTimeoutMs ?? DEFAULTS.onboardingTimeoutMs,
      "onboardingTimeoutMs",
      60_000,
    );
    this.maxOutputBytes = validatePositiveInteger(
      options.maxOutputBytes ?? DEFAULTS.maxOutputBytes,
      "maxOutputBytes",
      16_000_000,
    );
    this.maxResults = validatePositiveInteger(options.maxResults ?? DEFAULTS.maxResults, "maxResults", 100);
    this.defaultResults = Math.min(DEFAULTS.defaultResults, this.maxResults);
    this.maxSnippetChars = validatePositiveInteger(
      options.maxSnippetChars ?? DEFAULTS.maxSnippetChars,
      "maxSnippetChars",
      10_000,
    );
    this.maxQueryChars = validatePositiveInteger(
      options.maxQueryChars ?? DEFAULTS.maxQueryChars,
      "maxQueryChars",
      10_000,
    );
    this.maxTokens = validatePositiveInteger(options.maxTokens ?? DEFAULTS.maxTokens, "maxTokens", 100_000);
    this.runner = options.runner ?? runLocalCass;
  }

  async search(request: CassSearchRequest): Promise<CassSearchResult> {
    const query = this.validateQuery(request.query);
    const limit = request.limit ?? this.defaultResults;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxResults) {
      throw new CassProviderError("invalid_request", "search", `limit must be between 1 and ${this.maxResults}.`);
    }
    const offset = request.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
      throw new CassProviderError("invalid_request", "search", "offset is outside its safe limit.");
    }
    if (request.source !== undefined && request.source !== "local") {
      throw new CassProviderError(
        "remote_source_rejected",
        "search",
        "Context only permits the local CASS source.",
      );
    }
    const agents = validateFilterList(request.agents, "agents");
    const workspaces = validateFilterList(request.workspaces, "workspaces");
    const since = request.since === undefined ? null : validateTimeFilter(request.since, "since");
    const until = request.until === undefined ? null : validateTimeFilter(request.until, "until");
    const cursor = request.cursor;
    if (cursor !== undefined && (cursor.length === 0 || cursor.length > 4_096 || cursor.includes("\0"))) {
      throw new CassProviderError("invalid_request", "search", "cursor is outside its safe limit.");
    }
    const mode = request.mode ?? "semantic";
    if (!["lexical", "semantic", "hybrid"].includes(mode)) {
      throw new CassProviderError("invalid_request", "search", "mode is not supported by CASS.");
    }
    const timeoutMs = mode === "semantic" ? this.searchTimeoutMs : this.slowSearchTimeoutMs;

    const args = [
      "--color=never",
      "search",
      "--robot-format=json",
      "--robot-meta",
      "--no-daemon",
      "--no-maintenance",
      "--source=local",
      `--limit=${limit}`,
      `--offset=${offset}`,
      `--max-content-length=${this.maxSnippetChars}`,
      `--max-tokens=${this.maxTokens}`,
      `--timeout=${timeoutMs}`,
      `--fields=${SEARCH_FIELDS}`,
      `--mode=${mode}`,
      ...(cursor === undefined ? [] : [`--cursor=${cursor}`]),
      ...(since === null ? [] : [`--since=${since}`]),
      ...(until === null ? [] : [`--until=${until}`]),
      ...agents.flatMap((agent) => ["--agent", agent]),
      ...workspaces.flatMap((workspace) => ["--workspace", workspace]),
      ...this.dataDirArgs(),
      "--",
      query,
    ] as const;

    const raw = await this.executeJson("search", args, timeoutMs + CASS_TIMEOUT_GRACE_MS);
    return parseSearch(raw, this, { limit, offset, query });
  }

  async context(request: CassContextRequest): Promise<CassContextResult> {
    if (!Number.isSafeInteger(request.result) || request.result < 1 || request.result > this.maxResults) {
      throw new CassProviderError(
        "invalid_request",
        "view",
        `result must be between 1 and ${this.maxResults}.`,
      );
    }
    const context = request.context ?? 5;
    if (!Number.isSafeInteger(context) || context < 0 || context > DEFAULTS.maxContextLines) {
      throw new CassProviderError(
        "invalid_request",
        "view",
        `context must be between 0 and ${DEFAULTS.maxContextLines}.`,
      );
    }
    const search = await this.search({ ...request, limit: request.result });
    const hit = search.hits[request.result - 1];
    if (!hit) {
      throw new CassProviderError("not_found", "view", "CASS search result was not found.");
    }
    if(hit.provenance.lineNumber===null)throw new CassProviderError("unavailable","view","CASS hit has no canonical message index; original context cannot be selected safely.");
    const raw = await this.executeJson(
      "view",
      [...hit.provenance.viewArgs, "--context", String(context)],
      this.viewTimeoutMs,
    );
    return parseContext(raw, this, hit);
  }

  async health(): Promise<CassHealthReport> {
    const raw = await this.executeJson(
      "health",
      ["--color=never", "health", "--robot-format=json", "--robot-meta", ...this.dataDirArgs()],
      this.healthTimeoutMs,
    );
    const report = parseHealth(raw);
    if (!report.readyForSearch && !report.rebuilding && report.initialized !== false && report.database.exists !== false) {
      try {
        const status = await this.executeJson("status", ["--color=never", "status", "--robot-format=json", "--robot-meta", ...this.dataDirArgs()], this.healthTimeoutMs);
        return parseHealth(status);
      } catch(error) {
        if(!(error instanceof CassProviderError))throw error;
        return {...report,warnings:[...report.warnings,`Full CASS status unavailable: ${error.message}; readiness remains false.`]};
      }
    }
    return report;
  }

  async onboarding(): Promise<CassOnboardingReport> {
    const raw = await this.executeJson(
      "onboarding",
      ["--color=never", "onboarding", "--robot-format=json", ...this.dataDirArgs()],
      this.onboardingTimeoutMs,
    );
    return parseOnboarding(raw, this);
  }

  async readiness(): Promise<CassReadinessReport> {
    const [health, onboarding] = await Promise.all([this.health(), this.onboarding()]);
    const warnings = unique([
      ...health.warnings,
      ...health.errors.map((error) => `CASS health: ${error}`),
      ...onboarding.warnings,
    ]);
    const searchableArchive =
      health.initialized === true &&
      health.database.opened !== false &&
      (onboarding.indexedConversationCount ?? 0) > 0;
    const readyForSearch = searchableArchive && health.readyForSearch;
    return {
      health,
      onboarding,
      readyForSearch,
      warnings,
    };
  }

  /**
   * Build, but do not execute, the later ChatGPT export route. The caller must
   * make an explicit decision before passing this argv array to a runner.
   */
  planChatGptExport(hit: CassSearchHit, options: CassChatGptExportOptions = {}): CassChatGptExportPlan {
    if (hit.provenance.agent.toLowerCase() !== "chatgpt" || hit.provenance.originKind !== "local") {
      throw new CassProviderError(
        "unsupported_export",
        "export",
        "The planned export route only accepts a local ChatGPT CASS hit.",
      );
    }
    const format = options.format ?? "json";
    if (!["markdown", "text", "json", "html"].includes(format)) {
      throw new CassProviderError("invalid_request", "export", "format is not supported by CASS.");
    }
    if (options.outputPath !== undefined) validateAbsolutePath(options.outputPath, "outputPath");

    const args = [
      "--color=never",
      ...(this.dataDir === null ? [] : ["--data-dir", this.dataDir]),
      "export",
      hit.provenance.sourcePath,
      "--source",
      hit.provenance.sourceId,
      "--format",
      format,
      ...(options.outputPath === undefined ? [] : ["--output", options.outputPath]),
      ...(options.includeTools === true ? ["--include-tools"] : []),
    ] as const;

    return {
      agent: "chatgpt",
      sourcePath: hit.provenance.sourcePath,
      sourceId: hit.provenance.sourceId,
      format,
      args,
      executed: false,
      requiresExplicitExecution: true,
    };
  }

  private validateQuery(query: string): string {
    if (typeof query !== "string" || query.trim().length === 0 || query.length > this.maxQueryChars || query.includes("\0")) {
      throw new CassProviderError("invalid_request", "search", "query is empty or outside its safe limit.");
    }
    return query;
  }

  private dataDirArgs(): readonly string[] {
    return this.dataDir === null ? [] : ["--data-dir", this.dataDir];
  }

  private async executeJson(
    operation: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<unknown> {
    let result: CassRunnerResult;
    try {
      result = await this.runner({
        binaryPath: this.binaryPath,
        args,
        timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
      });
    } catch {
      throw new CassProviderError(
        "unavailable",
        operation,
        `CASS ${operation} could not be started locally.`,
        { retryable: true },
      );
    }
    if (result.timedOut) {
      throw new CassProviderError(
        "timed_out",
        operation,
        `CASS ${operation} exceeded its ${timeoutMs}ms timeout.`,
        { exitCode: result.exitCode, retryable: true },
      );
    }
    if (result.outputLimitExceeded) {
      throw new CassProviderError(
        "output_limit_exceeded",
        operation,
        `CASS ${operation} exceeded the configured output limit.`,
        { exitCode: result.exitCode },
      );
    }
    // `cass health` documents exit 1 as the normal unhealthy result. Its JSON
    // body is still the read-only health report Context needs to show.
    const isReportableUnhealthyHealth = (operation === "health" || operation === "status") && result.exitCode === 1;
    if (result.exitCode !== 0 && !isReportableUnhealthyHealth) {
      for (const output of [result.stdout, result.stderr]) {
        try {
          const errorResponse = JSON.parse(output);
          if (
            operation === "search" &&
            isObject(errorResponse) &&
            isObject(errorResponse.error) &&
            typeof errorResponse.error.kind === "string" &&
            errorResponse.error.kind.startsWith("cursor")
          ) {
            throw new CassProviderError("invalid_cursor", operation, "CASS search cursor is invalid.");
          }
        } catch (error) {
          if (error instanceof CassProviderError) throw error;
        }
      }
      throw new CassProviderError(
        "command_failed",
        operation,
        `CASS ${operation} exited without a machine-readable success response.`,
        { exitCode: result.exitCode, retryable: result.exitCode === null },
      );
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new CassProviderError(
        "invalid_response",
        operation,
        `CASS ${operation} returned invalid JSON.`,
      );
    }
  }
}

export function createCassProvider(options: CassProviderOptions = {}): CassProvider {
  return new CassProvider(options);
}
