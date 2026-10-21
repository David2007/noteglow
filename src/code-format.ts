import { scanNativeCode, type NativeCodeBlock } from "./native-code-colors.ts";

export type CodeLanguage = "go" | "python" | "java";
export interface FormatTarget { block: NativeCodeBlock; language: CodeLanguage; inferred: boolean }
export interface FormatEdit { from: number; to: number; insert: string; cursor: number }

/** 只识别明确特征；无特征或多语言冲突时不猜测，显式语言始终优先。 */
export function codeLanguage(code: string, label: string): CodeLanguage | null {
  if (label.trim()) return new Map<string, CodeLanguage>([["go", "go"], ["golang", "go"], ["python", "python"], ["py", "python"], ["java", "java"]]).get(label.trim().toLowerCase()) ?? null;
  // 字符串和注释里的示例关键字不构成语言证据。
  code = code.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|`[^`]*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|#[^\r\n]*/g, (value) => value.replace(/[^\r\n]/g, " "));
  const candidates: CodeLanguage[] = [];
  if (/^\s*(?:package\s+\w+\s*$|func\s+(?:\([^\n]*\)\s*)?\w+\s*\(|(?:\w+\s*,\s*)*\w+\s*:=)|\bfmt\.(?:Print|Sprintf)/m.test(code)) candidates.push("go");
  if (/^\s*(?:(?:async\s+)?def\s+\w+\s*\([^\n]*\)\s*(?:->[^\n:]+)?\s*:|from\s+[\w.]+\s+import\s|if\s+__name__\s*==|class\s+\w+(?:\([^\n]*\))?\s*:)|^\s*print\s*\([^\n]*\)\s*$/m.test(code)) candidates.push("python");
  if (/\b(?:public|private|protected)\s+(?:(?:static|final|abstract)\s+)*(?:class|interface|enum|void|int|String|boolean|double|long)\b|\bSystem\.out\.print(?:ln|f)?\s*\(|^\s*(?:import\s+java\.|(?:class|interface|enum)\s+\w+\s*\{)/m.test(code)) candidates.push("java");
  return candidates.length === 1 ? candidates[0] : null;
}

/** 粘贴只能涉及同一块正文；颜色快照不能被重排，跨围栏粘贴沿用原生行为。 */
export function findFormatTarget(text: string, from: number, to: number): FormatTarget | null {
  if (from < 0 || to < from || to > text.length) return null;
  const block = scanNativeCode(text).find((item) => item.supported && from >= item.codeFrom && to <= item.codeTo);
  if (!block || block.status !== "none" || !block.code.trim()) return null;
  const label = block.opening.replace(/^(`{3,}|~{3,})/, "").trim();
  const language = codeLanguage(block.code, label);
  if (!language || Buffer.byteLength(block.code, "utf8") > (language === "java" ? 20_000 : 200_000)) return null;
  return { block, language, inferred: !label };
}

/** 结果不得关闭原围栏；一次事务写回语言和正文，光标留在格式化正文末尾。 */
export function formattedEdit(target: FormatTarget, result: string): FormatEdit | null {
  const { block, language, inferred } = target;
  if (!result.trim() || Buffer.byteLength(result, "utf8") > 400_000 || result.includes("\0")) return null;
  result = result.replace(/\r\n|\r/g, "\n");
  const fence = /^(`{3,}|~{3,})/.exec(block.opening)![1];
  if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`, "m").test(result)) return null;
  const code = result.replace(/\r\n|\r|\n/g, "\n").replace(/\n*$/, "\n").replace(/\n/g, block.eol);
  const opening = inferred ? fence + language + block.eol : block.opening;
  const insert = opening + code;
  if (insert === block.opening + block.code) return null;
  return { from: block.from, to: block.codeTo, insert, cursor: block.from + insert.length - block.eol.length };
}
