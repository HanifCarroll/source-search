import { isAbsolute, resolve } from "node:path";
const fail = (code: string, message: string) => new Error(`[${code}] ${message}`);
export function normalizeExportRelativePath(value: string): string {
  if (!value || value.includes("\0") || isAbsolute(value)) {
    throw fail(
      "UNSAFE_PATH",
      `Path ${JSON.stringify(value)} is not relative.`,
    );
  }
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw fail(
      "UNSAFE_PATH",
      `Path ${JSON.stringify(value)} contains traversal segments.`,
    );
  }
  const normalized = resolve("/", value.replaceAll("\\", "/"))
    .slice(1)
    .replaceAll("\\", "/");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw fail(
      "UNSAFE_PATH",
      `Path ${JSON.stringify(value)} escapes the export root.`,
    );
  }
  return normalized;
}
