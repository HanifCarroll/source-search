import type { Config } from '../platform/config';
import { contextRequestSchema, listEntitiesSchema, matchEntities, type EntityLink, type AmbiguousLink } from '../domain/context';
import { querySchema, type Query, type Ref, type RecordData, type Page } from '../domain/contracts';
import { assertVersion, errorData, fail, now, stableJson } from '../domain/identity';
import { assertPacket, packetBytes } from '../domain/results';
import { compactRecord, excerpt, annotateDuplicates } from '../domain/presentation';
import { sourceKind } from '../domain/source-catalog';
import { boundedMap } from './concurrency';
type Access = {
    read: (ref: Ref) => Promise<{
        record: RecordData;
    }>;
    search: (query: Query) => Promise<Page>;
};
type Reason = {
    via: 'meeting' | 'saved-record' | 'saved-query';
    entity?: string;
    query?: number;
};
type Candidate = {
    ref: Ref;
    reasons: Reason[];
    focus?: string;
};
type Gap = {
    code: string;
    message: string;
    entity?: string;
    source?: string;
    ref?: Ref;
    query?: Query;
};
type Evidence = {
    ref: Ref;
    title: string;
    type: string;
    occurredAt?: string;
    author?: string;
    conversation?: string;
    observedAt: string;
    excerpt: string;
    excerptTruncated: boolean;
    task?: RecordData['task'];
    metadata?: RecordData['metadata'];
    warnings: string[];
    reasons: Reason[];
    links: EntityLink[];
    ambiguous: AmbiguousLink[];
    read: {
        ref: Ref;
        focus?: string;
    };
};
const key = (ref: Ref) => JSON.stringify([ref.source, ref.id, ref.version]);
const MAX_QUERIES = 8;
const MAX_ENTITIES = 16;
/** Coordinates existing readers. Configuration owns mappings; this module stores nothing. */
export function contextTools(config: Pick<Config, 'contextEntities' | 'enabledSources' | 'sources'>, access: Access) {
    const entities = config.contextEntities;
    async function list_context_entities(input: unknown = {}) {
        const q = listEntitiesSchema.parse(input), all = Object.entries(entities).sort(([a], [b]) => a.localeCompare(b)).filter(([id, e]) => (!q.kind || e.kind === q.kind) && `${id} ${e.label}`.toLowerCase().includes(q.query.toLowerCase()));
        const start = q.cursor ? all.findIndex(([id]) => id === q.cursor) + 1 : 0;
        if (q.cursor && !start)
            fail('STALE_CURSOR', 'Entity selection changed; list again without a cursor');
        const page = all.slice(start, start + q.limit);
        const result = { entities: page.map(([id, e]) => ({ id, kind: e.kind, label: e.label, people: e.people, identifierCount: e.identifiers.length, recordCount: e.records.length, querySources: [...new Set(e.queries.map(q => q.source))] })), total: all.length, nextCursor: start + page.length < all.length ? page.at(-1)?.[0] : undefined };
        assertPacket(result);
        return result;
    }
    async function build_context(input: unknown) {
        const request = contextRequestSchema.parse(input), selected = new Set(request.sources), gaps: Gap[] = [], startedAt = now();
        for (const source of selected) {
            if (!config.enabledSources.includes(source))
                fail('SOURCE_DISABLED', 'Enable the requested source in local configuration: ' + source);
            if (['library', 'documents'].includes(sourceKind(source, config)))
                fail('UNSUPPORTED_SOURCE', 'Context uses original sources. Search the library separately and use its original references.');
        }
        if (request.entity && entities[request.entity]?.kind !== 'project')
            fail('UNKNOWN_ENTITY', 'Choose a configured project from list_context_entities');
        if (request.meeting && !selected.has(request.meeting.source))
            fail('SOURCE_NOT_SELECTED', 'Include the meeting source in sources');
        const chosen = new Set<string>(request.entity ? [request.entity] : []), candidates = new Map<string, Candidate>(), opened = new Map<string, Promise<RecordData>>();
        const readOriginal = async (ref: Ref) => {
            const id = key(ref);
            let promise = opened.get(id);
            if (!promise) {
                promise = access.read(ref).then(({ record }) => {
                    if (record.ref.source !== ref.source || record.ref.id !== ref.id)
                        fail('INVALID_PROVIDER_RESPONSE', 'Reader returned a different original');
                    return record;
                });
                opened.set(id, promise);
            }
            const record = await promise;
            assertVersion(ref, record.ref.version || '');
            return record;
        };
        const add = (ref: Ref, reason: Reason, focus?: string) => {
            const existing = candidates.get(key(ref));
            if (existing)
                existing.reasons.push(reason);
            else
                candidates.set(key(ref), { ref, reasons: [reason], focus });
        };
        // The anchor is a required original; an absent/stale meeting must not yield a plausible brief.
        if (request.meeting) {
            const record = await readOriginal(request.meeting);
            if (record.type !== 'calendar-event')
                fail('INVALID_REQUEST', 'Meeting preparation requires a calendar event');
            add(record.ref, { via: 'meeting' });
            for (const link of matchEntities(record, entities).links)
                chosen.add(link.entity);
        }
        for (const id of [...chosen])
            for (const person of entities[id]!.people)
                chosen.add(person);
        if (chosen.size > MAX_ENTITIES) {
            gaps.push({ code: 'ENTITY_LIMIT', message: `${chosen.size - MAX_ENTITIES} linked entities were omitted; prepare those separately` });
            for (const id of [...chosen].slice(MAX_ENTITIES))
                chosen.delete(id);
        }
        const plans: {
            query: Query;
            entities: string[];
        }[] = [], planKeys = new Map<string, number>();
        for (const id of chosen) {
            const entity = entities[id]!;
            for (const ref of entity.records) {
                if (selected.has(ref.source))
                    add(ref, { via: 'saved-record', entity: id });
                else
                    gaps.push({ code: 'SOURCE_NOT_SELECTED', message: 'A mapped record was excluded by this request', entity: id, source: ref.source });
            }
            for (const saved of entity.queries) {
                const query = querySchema.parse({ ...saved, limit: Math.min(5, request.limit) });
                if (!selected.has(query.source)) {
                    gaps.push({ code: 'SOURCE_NOT_SELECTED', message: 'A saved search was excluded by this request', entity: id, source: query.source });
                    continue;
                }
                const k = stableJson(query), index = planKeys.get(k);
                if (index !== undefined)
                    plans[index]!.entities.push(id);
                else {
                    planKeys.set(k, plans.length);
                    plans.push({ query, entities: [id] });
                }
            }
        }
        for (const plan of plans.slice(MAX_QUERIES))
            gaps.push({ code: 'QUERY_LIMIT', message: 'Run this saved search separately', query: plan.query });
        const searches = await boundedMap(plans.slice(0, MAX_QUERIES), async (plan) => {
            try {
                return { plan, page: await access.search(plan.query) };
            }
            catch (error) {
                return { plan, page: { source: plan.query.source, status: 'error', items: [], warnings: [], observedAt: now(), error: errorData(error) } as Page };
            }
        });
        for (const [index, { plan, page }] of searches.entries())
            for (const item of page.items) {
                if (!selected.has(item.ref.source)) {
                    gaps.push({ code: 'SOURCE_NOT_SELECTED', message: 'A search returned a record outside the selected sources', source: item.ref.source });
                    continue;
                }
                for (const entity of plan.entities)
                    add(item.ref, { via: 'saved-query', entity, query: index }, item.focus);
            }
        const evidence: Evidence[] = [], pending: {
            ref: Ref;
            reason: string;
        }[] = [];
        const selectedCandidates = [...candidates.values()].slice(0, request.limit);
        for (const candidate of [...candidates.values()].slice(request.limit))
            pending.push({ ref: candidate.ref, reason: 'Record limit; open this reference separately' });
        const reads = await boundedMap(selectedCandidates, async (candidate) => {
            try {
                const record = await readOriginal(candidate.ref);
                if (record.metadata?.derived)
                    fail('DERIVED_RECORD', 'Use original references for context evidence');
                const match = matchEntities(record, entities), compact = compactRecord(record), query = candidate.reasons.find(r => r.query !== undefined)?.query;
                const text = excerpt(compact.body, query === undefined ? '' : searches[query]!.plan.query.query);
                // Keep structured dates/task state and source caveats; never synthesize decisions from prose.
                return { evidence: { ref: record.ref, title: record.title.slice(0, 200), type: record.type, occurredAt: record.occurredAt, author:record.author?.slice(0,200), conversation:record.conversation, observedAt: record.observedAt, excerpt: text, excerptTruncated: text !== compact.body, task: record.task,
                        metadata: Object.fromEntries(Object.entries(compact.metadata || {}).filter(([k]) => ['openLink', 'historical', 'dateKind', 'endedAt', 'allDay', 'snapshotAt', 'direction'].includes(k))),
                        warnings: record.warnings || [], reasons: candidate.reasons, ...match, read: { ref: record.ref, focus: candidate.focus } } satisfies Evidence };
            }
            catch (error) {
                return { gap: { ...errorData(error), ref: candidate.ref, source: candidate.ref.source } satisfies Gap };
            }
        });
        for (const read of reads)
            if (read.evidence) {
                const existing = evidence.find(e => key(e.ref) === key(read.evidence!.ref));
                if (existing)
                    existing.reasons.push(...read.evidence.reasons);
                else
                    evidence.push(read.evidence);
            }
            else if (read.gap)
                gaps.push(read.gap);
        annotateDuplicates(evidence);
        for (const id of chosen)
            if (!entities[id]!.records.length && !entities[id]!.queries.length)
                gaps.push({ code: 'NO_RETRIEVAL_PLAN', message: 'Add saved records or source-specific queries to retrieve more evidence', entity: id });
        if (request.meeting && !chosen.size)
            gaps.push({ code: 'NO_CONFIRMED_LINKS', message: 'No configured person or project matched the meeting; add confirmed mappings or choose a project' });
        for (const source of selected)
            if (!searches.some(s => s.plan.query.source === source) && !selectedCandidates.some(c => c.ref.source === source))
                gaps.push({ code: 'NO_RETRIEVAL_PLAN', message: 'No mapped record or saved query selects this source', source });
        const queryResults = searches.map(({ plan, page }, index) => ({ index, entities: plan.entities, query: plan.query, status: page.status, observedAt: page.observedAt, totalMatches: page.totalMatches, coverage: page.coverage, warnings: [...page.warnings, ...page.sourceWarnings || []], error: page.error, nextCursor: page.nextCursor, returned: page.items.length }));
        const result = { mode: request.mode, entity: request.entity, startedAt, finishedAt: now(), entities: [...chosen].map(id => ({ id, kind: entities[id]!.kind, label: entities[id]!.label })), evidence, searches: queryResults, gaps, pending,
            coverage: { sources: request.sources, planComplete: false, description: 'Completion covers only this configured retrieval plan, not all available history. Query matches are candidates, not confirmed relationships. Read cited originals before drawing conclusions.' } };
        while (evidence.length && packetBytes(result) > 42 * 1024) {
            const removed = evidence.pop()!;
            pending.push({ ref: removed.ref, reason: 'Response byte limit; open this reference separately' });
        }
        result.coverage.planComplete = !gaps.length && !pending.length && evidence.length > 0 && evidence.every(e => !e.ambiguous.length) && queryResults.every(q => q.status === 'ok' && !q.nextCursor);
        assertPacket(result);
        return result;
    }
    return { list_context_entities, build_context };
}
