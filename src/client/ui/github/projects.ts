import { h, openModal, toast } from '../dom';
import { store } from '../../state';
import type { Net } from '../../net';

export interface ProjectEntry {
  id?: string;
  name: string;
  url: string;
  token?: string;
}

export function openProjectsSettings(net: Net) {
  const body = h('div.body');
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const footer = h('footer');
  const el = h(
    'div.modal',
    { role: 'dialog', 'aria-label': 'GitHub & GitLab Projects', style: 'width:min(720px,95vw);' },
    h('header', {}, h('h2', {}, '⚙️ GitHub & GitLab Projects'), close),
    body,
    footer,
  );

  const modal = openModal(el, { doing: 'configuring git projects' });
  close.addEventListener('click', () => modal.close());

  let projects: ProjectEntry[] = [];
  const listEl = h('div.projects-list', { style: 'margin-bottom:16px;' });
  const msgEl = h('p.setting-note', { style: 'margin:8px 0;' });

  const nameInput = h('input', { type: 'text', placeholder: 'Name (e.g. frontend)', 'aria-label': 'Project name', style: 'flex:1;' }) as HTMLInputElement;
  const urlInput = h('input', { type: 'text', placeholder: 'Repository URL (https://github.com/owner/repo)', 'aria-label': 'Repository URL', style: 'flex:2;' }) as HTMLInputElement;
  const tokenInput = h('input', { type: 'password', placeholder: 'Token (optional for private repos)', 'aria-label': 'Token', style: 'flex:1;' }) as HTMLInputElement;
  const addBtn = h('button.btn.primary', { type: 'button' }, '➕ Add');

  const addRow = h('div', { style: 'display:flex;gap:8px;align-items:center;margin-top:12px;' }, nameInput, urlInput, tokenInput, addBtn);

  const currentFloor = store.currentFloor();
  const floorName = currentFloor?.name ?? store.project?.name ?? 'this project';
  const floorId = store.floor ?? currentFloor?.id ?? '';

  const saveBtn = h('button.btn.primary', { type: 'button' }, 'Save projects');
  footer.append(h('span.grow', {}, `Configuration saved strictly per project for ${floorName}.`), saveBtn);

  const paint = () => {
    listEl.replaceChildren();
    if (!projects.length) {
      listEl.append(h('p.setting-note', {}, 'No multi-repository projects configured yet. The board shows issues from the main checkout or configured repositories.'));
      return;
    }
    const table = h('table', { style: 'width:100%;border-collapse:collapse;font-size:13px;' });
    const thead = h('thead', {}, h('tr', {},
      h('th', { style: 'text-align:left;padding:6px 8px;border-bottom:2px solid var(--ink);' }, 'Name'),
      h('th', { style: 'text-align:left;padding:6px 8px;border-bottom:2px solid var(--ink);' }, 'Repository URL'),
      h('th', { style: 'text-align:left;padding:6px 8px;border-bottom:2px solid var(--ink);' }, 'Token'),
      h('th', { style: 'padding:6px 8px;border-bottom:2px solid var(--ink);width:60px;' }, ''),
    ));
    const tbody = h('tbody');
    projects.forEach((p, idx) => {
      const removeBtn = h('button.btn.btn-warn', { type: 'button', style: 'padding:2px 8px;font-size:12px;' }, '🗑');
      removeBtn.addEventListener('click', () => {
        projects.splice(idx, 1);
        paint();
      });
      const tr = h('tr', { style: 'border-bottom:1px solid rgba(0,0,0,0.1);' },
        h('td', { style: 'padding:6px 8px;font-weight:700;' }, p.name || '—'),
        h('td', { style: 'padding:6px 8px;word-break:break-all;' }, p.url),
        h('td', { style: 'padding:6px 8px;' }, p.token ? '••••••••' : h('span', { style: 'color:var(--muted);' }, 'None')),
        h('td', { style: 'padding:6px 8px;text-align:right;' }, removeBtn),
      );
      tbody.append(tr);
    });
    table.append(thead, tbody);
    listEl.append(table);
  };

  addBtn.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!url) return urlInput.focus();
    const name = nameInput.value.trim() || url.split('/').pop()?.replace(/\.git$/, '') || 'repo';
    const token = tokenInput.value.trim() || undefined;
    projects.push({ id: name, name, url, token });
    nameInput.value = '';
    urlInput.value = '';
    tokenInput.value = '';
    paint();
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const res = await fetch(`/api/plugins/git-projects/projects?floor=${encodeURIComponent(floorId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projects }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        msgEl.textContent = data.error || 'Failed to save projects';
        msgEl.style.color = '#c62828';
        return;
      }
      toast('Projects saved. Refreshing board…', 'info');
      net.send({ t: 'gh.refresh' });
      modal.close();
    } catch (err) {
      msgEl.textContent = (err as Error).message;
      msgEl.style.color = '#c62828';
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save projects';
    }
  });

  body.append(
    h('p.setting-note', { style: 'margin:0 0 12px;' }, `Connect multiple repositories for ${floorName} (frontend, backend, BFF...) to synchronize Issues and Pull Requests into this board.`),
    listEl,
    h('h4', { style: 'margin:12px 0 6px;' }, 'Add repository'),
    addRow,
    msgEl,
  );

  fetch(`/api/plugins/git-projects/projects?floor=${encodeURIComponent(floorId)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d?.projects && Array.isArray(d.projects)) {
        projects = d.projects;
        paint();
      }
    })
    .catch(() => paint());
  paint();
}
