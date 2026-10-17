import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModels } from "../src/models.ts";

test("model reader preserves visible model ids and ignores hidden or malformed rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-notes-models-"));
  try {
    const file = join(directory, "catalog.json");
    writeFileSync(file, JSON.stringify({ models: [
      { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list" },
      { slug: "hidden", visibility: "hide" },
      { slug: "bad\nname", visibility: "list" },
      { slug: 1, visibility: "list" },
      { slug: "gpt-6-luna", visibility: "list" }
    ] }));
    assert.deepEqual(readModels(file), [
      { slug: "gpt-6.1-sol", displayName: "GPT-6.1-Sol" },
      { slug: "gpt-6-luna", displayName: "gpt-6-luna" }
    ]);
    writeFileSync(file, "{}");
    assert.throws(() => readModels(file), /模型目录格式不正确/);
    writeFileSync(file, "not json");
    assert.throws(() => readModels(file), SyntaxError);
    assert.throws(() => readModels(join(directory, "absent.json")), /ENOENT/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
