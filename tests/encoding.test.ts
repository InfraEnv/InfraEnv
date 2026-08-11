import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const textExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".yml", ".yaml", ".css", ".html", ".py", ".sh"]);
const ignored = new Set([".git", "node_modules", "dist", "coverage"]);
const mojibake = /\uFFFD|鈥|脳|鈮|銆|锛|宸茶|鏍囪|鐨勫|鍒嗗竷|妯℃嫙/;

async function textFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await textFiles(path));
    else if (textExtensions.has(extname(entry.name))) output.push(path);
  }
  return output;
}

describe("repository text encoding", () => {
  it("contains valid UTF-8 without replacement characters or typical mojibake", async () => {
    const offenders: string[] = [];
    for (const path of await textFiles(process.cwd())) {
      if (path.endsWith("encoding.test.ts")) continue;
      const text = await readFile(path, "utf8");
      if (mojibake.test(text)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
