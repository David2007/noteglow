export interface OutlineHeading { text: string; level: number; line: number }
interface OutlineNode extends OutlineHeading { depth: number; parent: number; children: boolean }

/** 用源码行定位，重名标题也不会跳到第一个同名标题；跳级标题按实际父子关系缩进。 */
export function outlineTree(headings: readonly OutlineHeading[]): OutlineNode[] {
  const nodes: OutlineNode[] = [], stack: number[] = [];
  for (const heading of headings) {
    while (stack.length && nodes[stack[stack.length - 1]].level >= heading.level) stack.pop();
    const parent = stack.at(-1) ?? -1;
    if (parent >= 0) nodes[parent].children = true;
    nodes.push({ ...heading, parent, depth: stack.length, children: false });
    stack.push(nodes.length - 1);
  }
  return nodes;
}

/** DOM 与宿主分离，所有节点和交互只属于传入窗格；不写入笔记、不持久化阅读状态。 */
export function createOutlinePanel(host: HTMLElement, navigate: (line: number) => void) {
  const doc = host.ownerDocument;
  const panel = doc.createElement('nav'); panel.className = 'noteglow-outline';
  panel.setAttribute('aria-label', '笔记目录');
  const header = doc.createElement('div'); header.className = 'noteglow-outline-header';
  const title = doc.createElement('span'); title.textContent = '目录';
  const toggle = doc.createElement('button'); toggle.type = 'button';
  header.append(title, toggle);
  const list = doc.createElement('div'); list.className = 'noteglow-outline-list';
  panel.append(header, list); host.prepend(panel); host.classList.add('noteglow-outline-host');
  let nodes: OutlineNode[] = [], active = -1, collapsed = false, disposed = false, file = '';
  let signature = '';
  const expanded = new Set<number>();
  const rows: HTMLElement[] = [];
  const branches: HTMLButtonElement[] = [];
  const labels: HTMLButtonElement[] = [];
  const refresh = (): void => {
    nodes.forEach((node, index) => {
      let parent = node.parent, visible = true;
      while (parent >= 0) { if (!expanded.has(parent)) visible = false; parent = nodes[parent].parent; }
      rows[index].hidden = !visible;
      rows[index].classList.toggle('is-active', index === active);
      if (index === active) labels[index].setAttribute('aria-current', 'location');
      else labels[index].removeAttribute('aria-current');
      branches[index].textContent = node.children ? (expanded.has(index) ? '⌄' : '›') : '';
      if (node.children) branches[index].setAttribute('aria-expanded', String(expanded.has(index)));
    });
  };
  const revealActiveRow = (): void => {
    // 只滚动目录自身，不使用 scrollIntoView，避免带动正文或其他窗格。
    const row = rows[active];
    if (row && !collapsed) {
      if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
      else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)
        list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
    }
  };  const setActiveLine = (line: number): void => {
    if (disposed) return;
    let next = -1;
    for (let i = 0; i < nodes.length && nodes[i].line <= line; i++) next = i;
    if (next === active) return;
    active = next;
    let parent = nodes[active]?.parent ?? -1;
    while (parent >= 0) { expanded.add(parent); parent = nodes[parent].parent; }
    refresh();
    revealActiveRow();
  };

  const setCollapsed = (): void => {
    list.hidden = collapsed; title.hidden = collapsed;
    host.classList.toggle('noteglow-outline-collapsed', collapsed);
    toggle.textContent = collapsed ? '☷' : '−';
    toggle.setAttribute('aria-label', collapsed ? '展开目录' : '收起目录');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = collapsed ? '展开目录' : '收起目录';
    // 收起时正文仍可滚动；重新展开必须主动露出新的当前章节。
    if (!collapsed) revealActiveRow();
  };
  toggle.onclick = () => { if (!disposed) { collapsed = !collapsed; setCollapsed(); } };
  setCollapsed();
  return {
    setHeadings(path: string, headings: readonly OutlineHeading[]): void {
      if (disposed) return;
      const next = JSON.stringify(headings);
      if (file === path && signature === next) return;
      // 笔记切换恢复默认展开；同篇缓存更新不改变用户手动收起的整个面板状态。
      if (file !== path) { collapsed = false; setCollapsed(); }
      file = path; signature = next; nodes = outlineTree(headings); active = -1;
      expanded.clear(); list.replaceChildren(); rows.length = 0; branches.length = 0; labels.length = 0;
      if (!nodes.length) {
        const empty = doc.createElement('div'); empty.className = 'noteglow-outline-empty';
        empty.textContent = '当前笔记暂无标题'; list.append(empty);
      }
      nodes.forEach((node, index) => {
        // 前两层初始可见，第三层开始由用户或当前章节路径展开。
        if (node.depth === 0) expanded.add(index);
        const row = doc.createElement('div'); row.className = 'noteglow-outline-row';
        row.style.paddingLeft = `${Math.min(node.depth, 5) * 12}px`;
        const branch = doc.createElement('button'); branch.type = 'button'; branch.className = 'noteglow-outline-branch';
        branch.setAttribute('aria-label', `展开或收起 ${node.text}`);
        branch.disabled = !node.children; branch.tabIndex = node.children ? 0 : -1;
        branch.onclick = () => {
          if (disposed || !node.children) return;
          if (expanded.has(index)) expanded.delete(index); else expanded.add(index);
          refresh();
        };
        const label = doc.createElement('button'); label.type = 'button'; label.className = 'noteglow-outline-label';
        label.textContent = node.text; label.title = node.text;
        label.onclick = () => { if (!disposed) { navigate(node.line); setActiveLine(node.line); } };
        row.append(branch, label); list.append(row); rows.push(row); branches.push(branch); labels.push(label);
      });
      refresh();
    },
    setActiveLine,
    destroy(): void {
      if (disposed) return;
      disposed = true; panel.remove();
      host.classList.remove('noteglow-outline-host', 'noteglow-outline-collapsed');
      rows.length = 0; branches.length = 0; labels.length = 0; nodes = [];
    }
  };
}
