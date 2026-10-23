import {createHash} from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { sourceId, fail } from "./shared";
import { readFile } from "node:fs/promises";

const home = homedir();
const path = z.string().refine(isAbsolute, "Source paths must be absolute");
const state = join(home, ".cache/source-search");
const schema = z.object({
  enabledSources: z.array(sourceId).default([]),
  maintenanceEnabled: z.boolean().default(false),
  mailAccounts: z.partialRecord(z.enum(["mail-personal","mail-consulting","mail-fastmail"]), z.object({account:z.string().min(1).max(200).refine(s=>!s.startsWith("-") && !s.includes("\0")),email:z.email(),aliases:z.array(z.email()).default([])})).default({}),
  journals: path.default(join(home, ".config/source-search/unconfigured/journals")),
  things: path.default(join(home, ".config/source-search/unconfigured/things")),
  messages: path.default(join(home, "Library/Messages/chat.db")),
  index: path.default(join(state, "archive-index.sqlite")),
  whatsapp: path.default(join(home, "Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite")),
  muesli: path.default(join(home, "Library/Application Support/Muesli/muesli.db")),
  voiceNotes: path.optional(),
  callNotes: path.default(join(home, ".config/source-search/unconfigured/calls")),
  chromeProfiles: z.array(path).max(20).default([]),
  pimHelper: path.default(join(home, ".local/share/source-search/native/Context macOS PIM Helper.app/Contents/MacOS/context-macos-pim-helper")),
  pimLauncher: path.default(join(home, ".local/share/source-search/native/context-macos-pim-disclaim")),
  chatgpt: z.array(path).max(20).default([]),
  takeout: z.array(path).max(20).default([]),
  linkedin: z.array(path).max(20).default([]),
  twitter: z.array(path).max(20).default([]),
  mailbridgeBinary: path.default(join(home, ".cargo/bin/mailbridge")),
  bunBinary: path.default(process.execPath),
  nodeBinary: path.default(join(home, ".local/bin/node")),
  qmdPackage: path.default(join(home, ".bun/install/global/node_modules/@tobilu/qmd")),
  tesseractBinary: path.default("/opt/homebrew/bin/tesseract"),
  transcribeBinary: path.default(join(home, ".local/bin/transcribe-audio")),
  previews: path.default(join(state, "previews")),
  gmailBinary: path.default(join(home, ".local/bin/gog")),
  qmdBinary: path.default(join(home, ".bun/bin/qmd")),
  qmdIndex: z.string().regex(/^[a-zA-Z0-9_-]+$/).default("source-search"),
  qmdDatabase: path.default(join(state, "vault.sqlite")),
  qmdModels: z.array(path).default([]),
  qmdRoots: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), path).default({}),
  libraryEnabled: z.boolean().default(false),
  libraryRoot: path.default(join(state, "library")),
  libraryIndex: z.string().regex(/^[a-zA-Z0-9_-]+$/).default("source-search-library"),
  libraryDatabase: path.default(join(state, "library-qmd.sqlite")),
  documentRoots: z.array(path).default([]),
  extractorPython: path.default(join(home, ".local/share/source-search/extract-env/bin/python")),
  cassBinary: path.default(join(home, ".local/bin/cass")),
  cassData: path.default(join(home, ".local/share/cass"))
}).strict().transform(config=>({...config,voiceNotes:config.voiceNotes || config.journals}));
export type Config = z.infer<typeof schema>;
export const defaultConfig = () => schema.parse({});
export async function loadConfig(): Promise<Config> {
  const path = configPath();
  try { return schema.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT" && !process.env.SOURCE_SEARCH_CONFIG_FILE) return schema.parse({}); throw e; }
}

export const configPath = () => process.env.SOURCE_SEARCH_CONFIG_FILE || join(home, ".config/source-search/config.json");
export const sourceEnabled = (config:Config, source:string) => config.enabledSources.includes(source as typeof config.enabledSources[number]);
export function requireSource(config:Config, source:string) { if(!sourceEnabled(config,source)) fail("SOURCE_DISABLED", "Enable this source in local configuration"); }
export function requireMaintenance(config:Config) { if(!config.maintenanceEnabled) fail("MAINTENANCE_DISABLED", "Enable maintenance in local configuration to build caches"); }

// Bind derived text to the selected locations/accounts, not just a stable source ID.
export function sourceScope(config:Config,source:string):string {
  const fields:Record<string,string[]>={
    "things-archive":["things"],"chatgpt-archive":["chatgpt"],"takeout-archive":["takeout"],"linkedin-archive":["linkedin"],"twitter-archive":["twitter"],
    messages:["messages"],whatsapp:["whatsapp"],calls:["muesli"],documents:["documentRoots","takeout","mailAccounts","enabledSources"]
  };
  const value=source.startsWith("mail-") ? config.mailAccounts[source as keyof typeof config.mailAccounts] : Object.fromEntries((fields[source]||[]).map(key=>[key,(config as any)[key]]));
  return createHash("sha256").update(JSON.stringify(value)||"unconfigured").digest("hex");
}
