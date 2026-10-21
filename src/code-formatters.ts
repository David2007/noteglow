import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { format } from "prettier/standalone";
import java from "prettier-plugin-java";
import type { CodeLanguage } from "./code-format.ts";

export interface FormatterSettings { gofmtPath: string; blackPath: string }
export type FormatResult = { status: "formatted"; code: string } | { status: "unavailable" | "invalid" | "cancelled" | "timeout" | "too-large" };

/** GUI 通常不继承 shell PATH；只解析可执行文件，不启动 shell 或读取笔记目录配置。 */
export function formatterExecutable(name: string, configured: string): string {
  if (configured.trim()) return configured.trim().replace(/^~(?=[/\\])/, homedir());
  const directories = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local/bin"), join(homedir(), "go/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/local/go/bin", join(homedir(), ".go/current/bin")];
  return directories.filter(Boolean).map((directory) => join(directory, name)).find((path) => existsSync(path)) ?? name;
}

/** stdin 传代码、固定参数且 shell=false；有界收集输出，取消/超时立即终止子进程。 */
export function runFormatter(executable: string, args: string[], code: string, signal: AbortSignal, timeoutMs = 3000): Promise<FormatResult> {
  if (signal.aborted) return Promise.resolve({ status: "cancelled" });
  if (Buffer.byteLength(code) > 200_000) return Promise.resolve({ status: "too-large" });
  return new Promise((resolve) => {
    let settled = false, bytes = 0;
    const output: Buffer[] = [];
    const child = spawn(executable, args, { cwd: tmpdir(), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const finish = (result: FormatResult): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", cancel);
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve(result);
    };
    const cancel = (): void => finish({ status: "cancelled" });
    const timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);
    signal.addEventListener("abort", cancel, { once: true });
    child.on("error", () => finish({ status: "unavailable" }));
    child.stdin.on("error", () => { /* 进程提前退出由 close/error 统一处理。 */ });
    child.stdout.on("data", (data: Buffer) => { bytes += data.length; if (bytes > 400_000) finish({ status: "too-large" }); else output.push(data); });
    child.stderr.on("data", (data: Buffer) => { bytes += data.length; if (bytes > 400_000) finish({ status: "too-large" }); });
    child.on("close", (exitCode) => finish(exitCode === 0 ? { status: "formatted", code: Buffer.concat(output).toString("utf8") } : { status: "invalid" }));
    child.stdin.end(code);
  });
}

/** Java 使用随包发布的解析器；包装仅帮助解析方法/语句片段，严格按包装层移除缩进。 */
export async function formatJava(code: string, signal: AbortSignal): Promise<FormatResult> {
  if (Buffer.byteLength(code) > 20_000) return { status: "too-large" };
  for (const wrapper of [0, 1, 2]) {
    if (signal.aborted) return { status: "cancelled" };
    const input = wrapper === 0 ? code : wrapper === 1 ? `class NoteGlowFragment {\n${code}\n}` : `class NoteGlowFragment {\nvoid fragment() {\n${code}\n}\n}`;
    try {
      const result = await format(input, { parser: "java", plugins: [java], tabWidth: 4, printWidth: 100 });
      if (signal.aborted) return { status: "cancelled" };
      if (!wrapper) return { status: "formatted", code: result };
      const lines = result.trimEnd().split("\n");
      // Java 打印器在类首成员前插入空行，属于包装层而不是用户代码。
      if (lines[1] === "") lines.splice(1, 1);
      if (lines[0] !== "class NoteGlowFragment {" || lines.at(-1) !== "}") continue;
      if (wrapper === 2 && (lines[1] !== "    void fragment() {" || lines.at(-2) !== "    }")) continue;
      const body = lines.slice(wrapper, -wrapper), indent = " ".repeat(wrapper * 4);
      if (body.some((line) => line.trim() && !line.startsWith(indent))) continue;
      return { status: "formatted", code: body.map((line) => line.startsWith(indent) ? line.slice(indent.length) : line).join("\n") + "\n" };
    } catch { /* 解析失败再尝试明确的片段包装；不执行代码。 */ }
  }
  return { status: "invalid" };
}

export async function formatCode(language: CodeLanguage, code: string, settings: FormatterSettings, signal: AbortSignal): Promise<FormatResult> {
  if (language === "java") return formatJava(code, signal);
  const executable = formatterExecutable(language === "go" ? "gofmt" : "black", language === "go" ? settings.gofmtPath : settings.blackPath);
  // Black 的空配置明确阻断向父目录查找 pyproject.toml，且不加载项目代码。
  const args = language === "go" ? [] : ["--quiet", "--config", process.platform === "win32" ? "NUL" : "/dev/null", "-"];
  return runFormatter(executable, args, code, signal);
}
