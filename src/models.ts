import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexModel { slug: string; displayName: string; }

export function readModels(catalogFile?: string): CodexModel[] {
  // 只读取 Codex 已登录账号的模型元数据；认证仍由 CLI 自己处理。
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  const catalog: unknown = JSON.parse(readFileSync(catalogFile ?? join(home, "models_cache.json"), "utf8"));
  if (!catalog || typeof catalog !== "object" || !("models" in catalog) || !Array.isArray(catalog.models)) {
    throw new Error("Codex 模型目录格式不正确，请在 Codex 中刷新模型列表。");
  }
  return catalog.models.flatMap((model: unknown) => {
    if (!model || typeof model !== "object" || !("slug" in model) || !("visibility" in model)
      || typeof model.slug !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(model.slug) || model.visibility !== "list") return [];
    const name = "display_name" in model && typeof model.display_name === "string" ? model.display_name : model.slug;
    return [{ slug: model.slug, displayName: name }];
  });
}
