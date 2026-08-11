/* global console, process */
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const required = [
  "README.md", "user-guide.md", "cli-reference.md", "web-ui.md",
  "environment-definition.md", "simulation-model.md", "supervisor-api.md",
  "security-and-storage.md", "development.md", "user/README.md", "user/status.md",
  "developer/README.md", "developer/architecture.md", "adr/README.md"
];
const failures = [];

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return extname(entry.name) === ".md" ? [path] : [];
  }));
  return nested.flat();
}

for (const relative of required) {
  try { await access(resolve(root, relative)); }
  catch { failures.push(`Missing required document: ${relative}`); }
}

for (const file of await markdownFiles(root)) {
  const text = await readFile(file, "utf8");
  const relativeFile = file.slice(root.length + 1).replaceAll("\\", "/");
  const headings = text.match(/^#\s+.+$/gm) ?? [];
  if (headings.length !== 1) failures.push(`${relativeFile}: expected exactly one H1, found ${headings.length}`);
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1]?.trim().replace(/^<|>$/g, "") ?? "";
    if (!raw || raw.startsWith("#") || /^(?:https?:|mailto:)/.test(raw)) continue;
    const path = decodeURIComponent(raw.split("#")[0] ?? "");
    try { await access(resolve(dirname(file), path)); }
    catch { failures.push(`${relativeFile}: broken relative link ${raw}`); }
  }
}

if (failures.length) {
  console.error(`Documentation check failed:\n${failures.map((item) => `- ${item}`).join("\n")}`);
  process.exit(1);
}
console.log("Documentation OK: required guides, ADRs, H1 structure and relative links are valid.");
