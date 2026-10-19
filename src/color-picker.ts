import { normalizeColor } from "./color-ranges.ts";

interface ColorPickerOptions {
  document: Document;
  anchor: { left: number; top: number; bottom: number };
  label: string;
  colors: readonly string[];
  initialColor: string;
  apply(color: string): Promise<void>;
  closed(): void;
  failedAfterClose(error: unknown): void;
  cancelledByEscape?(): void;
}

/** 预设即提交；自定义色仅 Enter 提交。关闭不回写、不抢回焦点，也不撤销已开始的事务。 */
export function createColorPicker(options: ColorPickerOptions): { close(): void } {
  const doc = options.document;
  const panel = doc.createElement("div"); panel.className = "codex-notes-color-popover";
  panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", options.label);
  const title = doc.createElement("div"); title.className = "codex-notes-color-label"; title.textContent = options.label; panel.appendChild(title);
  const palette = doc.createElement("div"); palette.className = "codex-notes-color-presets"; panel.appendChild(palette);
  const custom = doc.createElement("div"); custom.className = "codex-notes-color-custom-row"; panel.appendChild(custom);
  const input = doc.createElement("input"); input.type = "text"; input.maxLength = 7; input.value = options.initialColor; input.placeholder = "#fff88f";
  input.setAttribute("aria-label", "自定义颜色，#RGB 或 #RRGGBB，按 Enter 应用"); custom.appendChild(input);
  const hint = doc.createElement("span"); hint.textContent = "Enter 应用"; custom.appendChild(hint);
  const error = doc.createElement("div"); error.className = "codex-notes-color-error"; error.setAttribute("role", "alert"); error.hidden = true; panel.appendChild(error);
  const buttons: HTMLButtonElement[] = [];
  let dismissed = false, pending = false;
  const close = (): void => {
    if (dismissed) return;
    dismissed = true;
    doc.removeEventListener("pointerdown", outside, true);
    doc.removeEventListener("keydown", keydown, true);
    panel.remove(); options.closed();
  };
  const submit = async (value: string): Promise<void> => {
    if (dismissed || pending) return;
    const color = normalizeColor(value);
    if (!color) { error.textContent = "请输入单个 #RGB 或 #RRGGBB，如 #fff88f"; error.hidden = false; input.focus(); return; }
    pending = true; error.hidden = true; input.disabled = true;
    for (const button of buttons) button.disabled = true;
    try { await options.apply(color); close(); }
    catch (failure) {
      // 关闭或切换笔记后，异步失败不得重新打开浮层或把焦点抢回旧输入框。
      if (dismissed) options.failedAfterClose(failure);
      else {
        error.textContent = failure instanceof Error ? failure.message : String(failure); error.hidden = false;
        input.disabled = false; for (const button of buttons) button.disabled = false;
      }
    } finally { pending = false; }
  };
  for (const color of options.colors) {
    const button = doc.createElement("button"); button.type = "button"; button.className = "codex-notes-color-preset";
    button.style.backgroundColor = color; button.title = color; button.setAttribute("aria-label", `应用颜色 ${color}`);
    button.addEventListener("click", () => { void submit(color); }); palette.appendChild(button); buttons.push(button);
  }
  input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); void submit(input.value); } });
  function outside(event: Event): void { if (!panel.contains(event.target as Node)) close(); }
  function keydown(event: KeyboardEvent): void {
    if (event.key === "Escape") { event.preventDefault(); close(); options.cancelledByEscape?.(); }
    else if (event.key === "Tab") {
      const controls: HTMLElement[] = [...buttons, input].filter((control) => !control.disabled);
      const current = controls.indexOf(doc.activeElement as HTMLElement);
      if (controls.length && ((event.shiftKey && current <= 0) || (!event.shiftKey && current === controls.length - 1))) {
        event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0].focus();
      }
    }
  }
  doc.body.appendChild(panel);
  const width = doc.defaultView?.innerWidth ?? 1024, height = doc.defaultView?.innerHeight ?? 768;
  panel.style.left = `${Math.max(8, Math.min(options.anchor.left, width - panel.offsetWidth - 8))}px`;
  const below = options.anchor.bottom + 6;
  panel.style.top = `${Math.max(8, below + panel.offsetHeight <= height - 8 ? below : options.anchor.top - panel.offsetHeight - 6)}px`;
  doc.addEventListener("pointerdown", outside, true); doc.addEventListener("keydown", keydown, true);
  // 同步聚焦，不安排会在关闭后再次触发的计时器。
  (buttons[0] ?? input).focus();
  return { close };
}
