// Stable maintenance entry point for existing refresh jobs.
import { syncLibrary } from "./maintenance/library-sync";
import { loadConfig } from "./platform/config";
if (import.meta.main) { process.umask(0o077); await syncLibrary(await loadConfig()); }
