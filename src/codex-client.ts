import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute } from "node:path";
import { MAX_IMAGES } from "./image-attachments.ts";
import { parseCodexEvent } from "./codex-events.ts";
import type { CodexExecutionSettings, CodexRunCallbacks } from "./types";

const MAC_CODEX_CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex"
];

export class CodexClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting = false;
  private cancelled = false;

  async resolveExecutable(configuredPath: string): Promise<string> {
    const configured = configuredPath.trim();
    if (configured && configured !== "codex") {
      if (!isAbsolute(configured)) return configured;
      await access(configured);
      return configured;
    }

    const pathCandidates = (process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => `${directory}/codex`);

    for (const candidate of [...pathCandidates, ...MAC_CODEX_CANDIDATES]) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        // Try the next common installation location.
      }
    }
    return "codex";
  }

  async send(
    prompt: string,
    vaultPath: string,
    settings: CodexExecutionSettings,
    callbacks: CodexRunCallbacks
  ): Promise<string> {
    if (this.running) throw new Error("Codex 正在处理其他请求。");
    const args = buildCodexArgs(settings, vaultPath);
    this.starting = true;
    this.cancelled = false;
    let executable: string;
    try {
      executable = await this.resolveExecutable(settings.codexPath);
      if (this.cancelled) throw new Error("Codex 执行已停止。");
    } catch (error) { this.starting = false; throw error; }
    callbacks.onStatus(settings.sessionId ? "正在继续对话…" : "正在启动 Codex…");

    return await new Promise<string>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: vaultPath,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.child = child;
      this.starting = false;

      let stdoutBuffer = "";
      let stderr = "";
      let finalText = "";

      const consumeLine = (line: string): void => {
        const event = parseCodexEvent(line);
        if (!event) return;

        if (event.threadId) callbacks.onThreadId(event.threadId);
        if (event.finalText) finalText = event.finalText;
        if (event.errorMessage) stderr = `${stderr}\n${event.errorMessage}`.trim();
        if (event.progress) callbacks.onProgress(event.progress);
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-20000);
      });

      child.on("error", (error) => {
        if (this.child === child) this.child = null;
        reject(new Error(`无法启动 Codex CLI：${error.message}`));
      });

      child.on("close", (code, signal) => {
        if (this.child === child) this.child = null;
        if (stdoutBuffer.trim()) consumeLine(stdoutBuffer.trim());
        if (signal) {
          reject(new Error("Codex 执行已停止。"));
        } else if (code !== 0) {
          reject(new Error(cleanError(stderr) || `Codex CLI 退出码：${code}`));
        } else if (!finalText) {
          reject(new Error("Codex 已完成，但没有返回可显示的消息。"));
        } else {
          resolve(finalText);
        }
      });

      // CLI 早退时 stdin 可能报 EPIPE；收集为本次错误，避免未处理事件导致插件崩溃。
      child.stdin.on("error", (error) => { stderr = (stderr + "\n" + error.message).slice(-20000); });
      child.stdin.end(prompt);
    });
  }

  stop(): void {
    this.cancelled = true;
    const child = this.child;
    child?.kill("SIGTERM");
    if (child) {
      // 保留正常退出机会；异常子进程不能无限占住插件的单请求槽位。
      const timer = setTimeout(() => { if (this.child === child) child.kill("SIGKILL"); }, 2000);
      timer.unref();
    }
  }

  get running(): boolean {
    return this.starting || this.child !== null;
  }
}

export function buildCodexArgs(settings: CodexExecutionSettings, vaultPath: string): string[] {
  const model = settings.model ? ["--model", settings.model] : [];
  const images = settings.imagePaths ?? [];
  if (images.length > MAX_IMAGES || images.some((path) => !isAbsolute(path) || path.includes("\0"))) throw new Error("图片发送路径无效。");
  const imageArgs = images.flatMap((path) => ["--image", path]);
  // exec 的 --image 接受多个值；用 -- 明确结束选项，防止 stdin 的 '-' 被当作图片路径。
  const input = images.length ? ["--", "-"] : ["-"];
  if (settings.sessionId) {
    // 续聊也显式传模型并允许非 Git Vault；无需另一个包装脚本修补参数。
    const sandbox = ["-c", `sandbox_mode="${settings.sandboxMode}"`];
    const approvals = ["-c", 'approval_policy="on-request"', "-c",
      `approvals_reviewer="${settings.approveForMe && settings.sandboxMode === "workspace-write" ? "auto_review" : "user"}"`];
    // exec resume 会重新加载全局配置，不能依赖旧会话或本机全局权限来保证当前 Vault 边界。
    return ["exec", "resume", "--json", "--skip-git-repo-check", ...sandbox, ...approvals, ...model, ...imageArgs, settings.sessionId, ...input];
  }

  const approvalArgs = settings.approveForMe && settings.sandboxMode === "workspace-write"
    ? ["--approve-for-me"]
    : ["--sandbox", settings.sandboxMode];

  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    ...model,
    ...approvalArgs,
    "--cd",
    vaultPath,
    ...imageArgs,
    ...input
  ];
}

function cleanError(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => !line.includes("could not create PATH aliases"))
    .join("\n")
    .trim();
}
