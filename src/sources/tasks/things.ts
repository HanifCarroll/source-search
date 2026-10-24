import {thingsDatabase} from './things-database';
import {join} from 'node:path';
import {contained,textFile} from '../../platform/source-files';
import {fail,hash,assertVersion} from '../../domain/identity';
import type {Config} from '../../platform/config';
import type {RecordData,Ref,Query} from '../../domain/contracts';
import {taskDueDate} from '../../domain/task-fields';
import {taskPage} from '../../domain/task-query';
export async function thingsRecords(config: Config) {
  if(config.thingsDatabase)return thingsDatabase(config.thingsDatabase);
  const [tasksText, contextText, infoText] = await Promise.all([
    contained(config.things, "tasks.jsonl").then(p => textFile(p, 32 * 1024 * 1024)),
    contained(config.things, "context.json").then(p => textFile(p)),
    contained(config.things, "snapshot-info.json").then(p => textFile(p))
  ]);
  const generation = hash(tasksText + contextText + infoText), context = JSON.parse(contextText), info = JSON.parse(infoText);
  if (!Array.isArray(context.TMTask) || typeof info.exportedAt !== "string") fail("INVALID_ARCHIVE", "Missing Things project context or capture date");
  const records = new Map<string, RecordData>();
  function add(r: RecordData) { if (records.has(r.ref.id)) fail("INVALID_ARCHIVE", "Duplicate Things ID"); records.set(r.ref.id, r); }
  let line = 0;
  for (const text of tasksText.split("\n")) {
    line++; if (!text.trim()) continue;
    const r = JSON.parse(text);
    if (typeof r.uuid !== "string" || typeof r.title !== "string" || !["open", "completed", "canceled"].includes(r.status) || (r.notes !== null && typeof r.notes !== "string")) fail("INVALID_ARCHIVE", "Invalid Things task row");
    const body = [r.title, `Historical status: ${r.status}; in Trash: ${r.trashed}`, `List: ${r.start}`, `Project: ${r.project?.title || "none"}`, `Area: ${r.area?.title || "none"}`, `Dates: ${JSON.stringify(r.dates)}`, `Tags: ${(r.tags || []).map((t: any) => t.title).join(", ")}`, r.notes || ""].join("\n\n");
    add({ ref: { source: "things-archive", id: r.uuid, version: hash(body) }, title: r.title, body, type: "historical-task", locator: join(config.things, "tasks.jsonl") + ":" + line,
      occurredAt: r.dates?.createdAt || undefined, observedAt: info.exportedAt, metadata: { historical: true, dateKind: "created", status: r.status, trashed: r.trashed, project: r.project?.title, archivedAt: info.exportedAt, editedAt: info.archiveEditedAt },
      task:{status:r.status,trashed:!!Number(r.trashed),...taskDueDate(r.dates?.deadline),...(r.project?.title?{project:{id:r.project.id||r.project.uuid,name:r.project.title}}:{})} });
  }
  for (const p of context.TMTask) {
    if (typeof p.uuid !== "string" || typeof p.title !== "string" || (p.notes !== null && typeof p.notes !== "string")) fail("INVALID_ARCHIVE", "Invalid Things project row");
    const body = [p.title, `Historical project; in Trash: ${p.trashed === 1}`, p.notes || ""].join("\n\n");
    add({ ref: { source: "things-archive", id: p.uuid, version: hash(body) }, title: p.title || "(Untitled project)", body, type: "historical-project", locator: join(config.things, "context.json"), observedAt: info.exportedAt,
      occurredAt: p.creationDate ? new Date(p.creationDate * 1000).toISOString() : undefined, metadata: { historical: true, trashed: p.trashed === 1 } });
  }
  if (typeof info.taskCount !== "number" || records.size - context.TMTask.length !== info.taskCount) fail("INVALID_ARCHIVE", "Things task count disagrees with archive metadata");
  return { records, generation, info };
}
export async function searchThingsTasks(config:Config,q:Query){
  const snapshot=await thingsRecords(config);
  return taskPage([...snapshot.records.values()],q,{kind:'historical-archive',asOf:snapshot.info.exportedAt,description:'Tasks in the selected Things export, excluding Trash. Statuses are historical, not current assignments.'});
}
export async function readThings(config: Config, ref: Ref) {
  const { records } = await thingsRecords(config), record = records.get(ref.id);
  if (!record) fail("RECORD_NOT_FOUND", "Task is absent from the current edited archive");
  assertVersion(ref, record.ref.version!); return record;
}
