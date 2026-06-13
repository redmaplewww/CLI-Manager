let state = null;
let selectedTaskId = null;
let selectedTaskRevision = '';
let lastSessionRenderKey = '';
let inspectorRequestId = 0;
const collapsedManagers = new Set();
const manualGroups = new Set();
let discoveredSessions = [];
let selectedSessionCli = 'all';
const CHAT_STORAGE_KEY = 'aura-butler-chat-history-v1';

const $ = id => document.getElementById(id);

function addMessage(role, text) {
  appendMessage(role, text);
  saveChatHistory();
}

function appendMessage(role, text) {
  const log = $('chatLog');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function loadChatHistory() {
  const raw = localStorage.getItem(CHAT_STORAGE_KEY);
  if (!raw) return false;
  try {
    const messages = JSON.parse(raw);
    if (!Array.isArray(messages)) return false;
    for (const message of messages) {
      if (!message || typeof message.role !== 'string' || typeof message.text !== 'string') continue;
      appendMessage(message.role, message.text);
    }
    return messages.length > 0;
  } catch {
    return false;
  }
}

function saveChatHistory() {
  const messages = [...document.querySelectorAll('#chatLog .msg')].map(node => ({
    role: node.classList.contains('user') ? 'user' : 'butler',
    text: node.textContent ?? '',
  }));
  localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages.slice(-200)));
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function refresh() {
  state = await api('/api/state');
  renderTopbar();
  renderTasks();
  renderArchivedTasks();
  renderProjects();
  renderMonitor().catch(() => {});
  if (!selectedTaskId && state.latestTaskId) selectedTaskId = state.latestTaskId;
  if (selectedTaskId) await renderInspector(selectedTaskId, { force: false });
}

async function renderMonitor() {
  const root = $('monitorLog');
  if (!root) return;
  const data = await api('/api/monitor');
  root.innerHTML = '';
  for (const item of data.items) {
    const div = document.createElement('div');
    div.className = 'monitor-item';
    div.textContent = `${item.taskId} | ${item.status} | 巡检:${item.inspectionEnabled ? '开' : '关'} | ${item.verdict ?? '-'}\n${item.title}\n${item.summary}\n${item.updatedAt ?? ''}`;
    root.appendChild(div);
  }
  if (!data.items.length) root.textContent = '暂无巡检通报。';
}

async function loadLlmConfig() {
  const cfg = await api('/api/config/llm');
  $('llmEnabled').checked = cfg.enabled;
  $('llmBaseUrl').value = cfg.baseUrl || '';
  $('llmModel').value = cfg.model || '';
  $('llmApiKeyEnv').value = cfg.apiKeyEnv || 'OPENAI_API_KEY';
  $('llmConfigHint').textContent = cfg.hasApiKey ? '已检测到 API Key' : '未检测到 API Key';
}

async function renderSessions() {
  const root = $('sessionsList');
  if (!root) return;
  root.textContent = '扫描中...';
  const data = await api('/api/sessions');
  discoveredSessions = data.sessions;
  renderSessionTabs();
  renderSessionList();
}

function renderSessionTabs() {
  const root = $('sessionTabs');
  if (!root) return;
  const groups = ['all', ...new Set(discoveredSessions.map(s => s.cli))];
  root.innerHTML = '';
  for (const cli of groups) {
    const count = cli === 'all' ? discoveredSessions.length : discoveredSessions.filter(s => s.cli === cli).length;
    const button = document.createElement('button');
    button.className = cli === selectedSessionCli ? 'active-tab' : '';
    button.textContent = `${cli} (${count})`;
    button.onclick = () => { selectedSessionCli = cli; renderSessionTabs(); renderSessionList(); };
    root.appendChild(button);
  }
}

function renderSessionList() {
  const root = $('sessionsList');
  const sessions = selectedSessionCli === 'all'
    ? discoveredSessions
    : discoveredSessions.filter(s => s.cli === selectedSessionCli);
  root.innerHTML = '';
  for (const s of sessions) {
    const card = document.createElement('label');
    card.className = 'session-pick card';
    const objective = inferObjective(s.title || s.summary || s.lastPrompt || '');
    card.innerHTML = `<input type="checkbox" value="${s.sessionId}" /> <strong>${escapeHtml(objective || '未知任务')}</strong><div>${escapeHtml(s.cli)} · ${s.isLive ? 'live' : 'stored'} · ${s.lastActiveAt ?? '-'}</div><div class="session-id">${escapeHtml(s.sessionId)}</div><div class="session-summary">${escapeHtml(s.summary || s.title || '')}</div>`;
    root.appendChild(card);
  }
  if (!sessions.length) root.textContent = '未发现 session。';
}

function renderTopbar() {
  const daemon = $('daemonBadge');
  daemon.textContent = state.daemon.alive ? 'daemon 运行中' : 'daemon 未运行';
  daemon.className = `badge ${state.daemon.alive ? 'ok' : 'bad'}`;
  const llm = $('llmBadge');
  llm.textContent = state.llm.enabled
    ? `LLM ${state.llm.model}`
    : state.llm.configEnabled && !state.llm.hasApiKey
      ? `LLM 缺少 ${state.llm.apiKeyEnv}`
      : 'LLM 未启用';
  llm.className = `badge ${state.llm.enabled ? 'ok' : 'bad'}`;
}

function renderTasks() {
  const root = $('tasks');
  root.innerHTML = '';
  const parents = state.tasks.filter(t => !t.parentTaskId);
  const groupedParents = new Map();
  for (const group of manualGroups) groupedParents.set(group, []);
  for (const task of parents) {
    const group = task.taskGroup || '未分组';
    if (!groupedParents.has(group)) groupedParents.set(group, []);
    groupedParents.get(group).push(task);
  }
  const childrenByParent = new Map();
  for (const child of state.tasks.filter(t => t.parentTaskId)) {
    if (!childrenByParent.has(child.parentTaskId)) childrenByParent.set(child.parentTaskId, []);
    childrenByParent.get(child.parentTaskId).push(child);
  }
  for (const [group, tasks] of groupedParents.entries()) {
    const groupBox = document.createElement('div');
    groupBox.className = 'task-group';
    groupBox.dataset.group = group;
    groupBox.innerHTML = `<div class="task-group-title">${escapeHtml(group)} <span>${tasks.length}</span></div>`;
    groupBox.ondragover = event => event.preventDefault();
    groupBox.ondrop = async event => {
      event.preventDefault();
      const taskId = event.dataTransfer.getData('text/task-id');
      if (taskId) await moveTaskToGroup(taskId, group === '未分组' ? null : group);
    };
    root.appendChild(groupBox);
    for (const task of tasks) {
      renderTaskCard(groupBox, task, childrenByParent.get(task.id) ?? [], false);
      const children = childrenByParent.get(task.id) ?? [];
      if (!collapsedManagers.has(task.id)) {
        for (const child of children) renderTaskCard(groupBox, child, [], true);
      }
    }
  }
  for (const orphan of state.tasks.filter(t => t.parentTaskId && !state.tasks.some(p => p.id === t.parentTaskId))) {
    renderTaskCard(root, orphan, [], false);
  }
  if (!state.tasks.length) root.textContent = '暂无任务';
}

function renderTaskCard(root, task, children, isChild) {
    const card = document.createElement('div');
    card.draggable = true;
    card.className = `card ${task.taskKind === 'manager' ? 'manager-task' : 'session-task'} ${isChild ? 'child-card' : ''} ${selectedTaskId === task.id ? 'selected' : ''}`;
    const label = task.displayName || task.title || task.prompt || '未命名任务';
    const objective = task.displayName ? (task.title || task.prompt || '') : inferObjective(task.prompt || task.title || '');
    const fold = children.length ? `<button class="fold-button" data-task="${task.id}">${collapsedManagers.has(task.id) ? '展开' : '折叠'} ${children.length}</button>` : '';
    const inspectLabel = task.inspectionEnabled ? '巡检开' : '巡检关';
    card.innerHTML = `<div class="title"><span class="status-${task.status}">${task.id}</span> <span class="kind">${task.taskKind ?? 'session'}</span> ${fold} <button class="inspect-toggle" data-task="${task.id}" data-enabled="${task.inspectionEnabled ? '1' : '0'}">${inspectLabel}</button></div><div class="task-label">${escapeHtml(label)}</div><div class="task-objective">${escapeHtml(objective)}</div>`;
    card.onclick = () => {
      if (selectedTaskId === task.id) return;
      selectedTaskId = task.id;
      selectedTaskRevision = '';
      lastSessionRenderKey = '';
      $('judgeResult').textContent = '';
      renderTasks();
      renderInspector(task.id, { force: true });
    };
    card.ondragstart = event => event.dataTransfer.setData('text/task-id', task.id);
    const foldButton = card.querySelector('.fold-button');
    if (foldButton) {
      foldButton.onclick = event => {
        event.stopPropagation();
        if (collapsedManagers.has(task.id)) collapsedManagers.delete(task.id);
        else collapsedManagers.add(task.id);
        renderTasks();
      };
    }
    const inspectButton = card.querySelector('.inspect-toggle');
    if (inspectButton) {
      inspectButton.onclick = async event => {
        event.stopPropagation();
        const newEnabled = inspectButton.dataset.enabled !== '1';
        await api(`/api/tasks/${task.id}/inspection`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: newEnabled }) });
        await refresh();
      };
    }
    root.appendChild(card);
}

function inferObjective(text) {
  const clean = String(text || '').replace(/Completion criteria:.*/is, '').replace(/\s+/g, ' ').trim();
  const material = clean.match(/\b(Cu|Al|Fe|Ni|Mg|Zr|Ti|MoS2|RuO2)\b/i)?.[1];
  if (/单晶拉伸|tensile/i.test(clean) && material) return `${material} 单晶拉伸试算`;
  if (/论文|paper|doi|复现/i.test(clean)) return clean.slice(0, 90);
  if (/体系|system|吸附|adsorption|计算|模拟|lammps/i.test(clean)) return clean.slice(0, 90);
  return clean.slice(0, 90);
}

async function moveTaskToGroup(taskId, group) {
  await api(`/api/tasks/${taskId}/group`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ group }) });
  await refresh();
}

function renderProjects() {
  const root = $('projects');
  root.innerHTML = '';
  for (const project of state.projects) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<div class="title">${project.id} ${project.status} (${project.iteration}/${project.maxIterations})</div><div>${escapeHtml(project.goal)}</div><div class="meta">${escapeHtml(project.lastNotification ?? project.errorMessage ?? '')}</div>`;
    root.appendChild(card);
  }
  if (!state.projects.length) root.textContent = '暂无自主项目';
}

function renderArchivedTasks() {
  const root = $('archivedTasks');
  root.innerHTML = '';
  for (const task of state.archivedTasks ?? []) {
    const card = document.createElement('div');
    card.className = `card archived-task ${selectedTaskId === task.id ? 'selected' : ''}`;
    card.innerHTML = `<div class="title"><span class="status-${task.status}">${task.id}</span> <span class="kind">${task.taskKind ?? 'session'}</span></div><div class="task-label">${escapeHtml(task.displayName || task.title)}</div>`;
    card.onclick = () => {
      selectedTaskId = task.id;
      selectedTaskRevision = '';
      lastSessionRenderKey = '';
      $('judgeResult').textContent = '';
      renderTasks();
      renderArchivedTasks();
      renderInspector(task.id, { force: true });
    };
    root.appendChild(card);
  }
  if (!(state.archivedTasks ?? []).length) root.textContent = '暂无归档';
}

async function renderInspector(taskId, options = {}) {
  const requestId = ++inspectorRequestId;
  $('selectedTitle').textContent = `当前任务：${taskId}`;
  const task = [...state.tasks, ...(state.archivedTasks ?? [])].find(t => t.id === taskId);
  const revision = task ? `${task.id}:${task.updatedAt}:${task.completionCriteria ?? ''}:${task.status}` : taskId;
  const criteriaFocused = document.activeElement === $('criteriaInput');
  if (options.force || selectedTaskRevision !== revision) {
    if (!criteriaFocused || options.force) $('criteriaInput').value = task?.completionCriteria ?? '';
    if (task && $('displayNameInput')) $('displayNameInput').value = task.displayName || task.title || '';
    selectedTaskRevision = revision;
  }
  renderChildTasks(taskId);
  $('toggleInspection').textContent = task?.inspectionEnabled ? '巡检：开启' : '巡检：关闭';
  $('progressReport').textContent = task?.progressSummary
    ? `${task.progressSummary}\n\n判定：${task.completionVerdict ?? '-'}\n更新时间：${task.progressUpdatedAt ?? '-'}\n\n${task.completionReason ?? ''}`
    : '暂无进度通报。';
  const worker = state.workers.find(w => w.taskId === taskId)?.worker;
  $('workerInfo').textContent = worker ? `Worker: ${worker.id}\n状态: ${worker.status}\nPID: ${worker.pid ?? '-'}\n命令: ${worker.command}\n目录: ${worker.cwd}\nstdout: ${worker.stdoutPath}\nstderr: ${worker.stderrPath}` : '暂无 worker';
  const events = await api(`/api/tasks/${taskId}/events`);
  if (requestId !== inspectorRequestId || taskId !== selectedTaskId) return;
  $('events').textContent = events.formatted;
  const result = await api(`/api/tasks/${taskId}/result`);
  if (requestId !== inspectorRequestId || taskId !== selectedTaskId) return;
  $('result').textContent = result.formatted;
  await renderSession(taskId, { force: options.force, requestId });
}

function renderChildTasks(taskId) {
  const root = $('childTasks');
  const children = state.tasks.filter(t => t.parentTaskId === taskId);
  if (!children.length) {
    root.textContent = '暂无子 session task';
    return;
  }
  root.innerHTML = '';
  for (const child of children) {
    const item = document.createElement('button');
    item.className = 'child-task';
    item.textContent = `${child.id} ${child.status} ${child.cliSessionId ?? ''}`;
    item.onclick = () => {
      selectedTaskId = child.id;
      selectedTaskRevision = '';
      lastSessionRenderKey = '';
      $('judgeResult').textContent = '';
      renderTasks();
      renderInspector(child.id, { force: true });
    };
    root.appendChild(item);
  }
}

async function renderSession(taskId, options = {}) {
  const root = $('sessionHistory');
  if (options.force) root.dataset.loaded = '';
  if (!root.dataset.loaded) root.textContent = '读取 session 历史中...';
  const data = await api(`/api/tasks/${taskId}/session`);
  if (options.requestId && options.requestId !== inspectorRequestId) return;
  if (taskId !== selectedTaskId) return;
  if (!data.session && !data.history.length) {
    if (lastSessionRenderKey === `${taskId}:empty`) return;
    lastSessionRenderKey = `${taskId}:empty`;
    root.dataset.loaded = '1';
    root.textContent = '该 task 暂无绑定 session 历史。';
    return;
  }
  const last = data.history[data.history.length - 1];
  const renderKey = `${taskId}:${data.history.length}:${last?.timestamp ?? ''}:${last?.type ?? ''}:${String(last?.text ?? '').length}`;
  if (!options.force && lastSessionRenderKey === renderKey) return;
  lastSessionRenderKey = renderKey;
  const wasNearBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 80;
  root.innerHTML = '';
  for (const item of data.history) {
    const div = document.createElement('div');
    div.className = `session-line ${item.type}`;
    div.textContent = `[${item.type}] ${item.text ?? ''}`;
    root.appendChild(div);
  }
  root.dataset.loaded = '1';
  if (options.force || wasNearBottom) root.scrollTop = root.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

$('chatForm').onsubmit = async event => {
  event.preventDefault();
  const input = $('chatInput');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  addMessage('user', message);
  addMessage('butler', '管家正在思考...');
  try {
    const res = await api('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
    document.querySelector('#chatLog .msg.butler:last-child').textContent = res.reply;
    saveChatHistory();
  } catch (err) {
    document.querySelector('#chatLog .msg.butler:last-child').textContent = `错误：${err.message}`;
    saveChatHistory();
  }
  await refresh();
};

$('chatInput').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('chatForm').requestSubmit();
  }
});

$('saveLlmConfig').onclick = async () => {
  const res = await api('/api/config/llm/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enabled: $('llmEnabled').checked,
      baseUrl: $('llmBaseUrl').value,
      model: $('llmModel').value,
      apiKeyEnv: $('llmApiKeyEnv').value,
      apiKey: $('llmApiKey').value,
    }),
  });
  $('llmApiKey').value = '';
  $('llmConfigHint').textContent = res.message || '已保存';
  await refresh();
};

$('newGroupForm').onsubmit = event => {
  event.preventDefault();
  const name = $('newGroupName').value.trim();
  if (!name) return;
  manualGroups.add(name);
  $('newGroupName').value = '';
  renderTasks();
};

$('saveCriteria').onclick = async () => {
  if (!selectedTaskId) return;
  await api(`/api/tasks/${selectedTaskId}/criteria`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ completionCriteria: $('criteriaInput').value }) });
  await renderInspector(selectedTaskId, { force: true });
};

$('saveDisplayName').onclick = async () => {
  if (!selectedTaskId) return;
  await api(`/api/tasks/${selectedTaskId}/rename`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName: $('displayNameInput').value }) });
  await refresh();
};

$('scanSessions').onclick = renderSessions;

$('bindSessions').onclick = async () => {
  const ids = [...document.querySelectorAll('#sessionsList input:checked')].map(input => input.value);
  if (!ids.length) return alert('请先选择要绑定的 session');
  const res = await api('/api/sessions/bind', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionIds: ids }) });
  addMessage('butler', `已绑定 ${res.bound.length} 个 session：${res.bound.join(', ')}`);
  await refresh();
};

$('judgeDone').onclick = async () => {
  if (!selectedTaskId) return;
  const res = await api(`/api/tasks/${selectedTaskId}/judge`);
  $('judgeResult').textContent = res.ok ? `判定：${res.verdict}\n完成：${res.done}\n${res.reason}\n\n最近输出：\n${res.lastOutput}` : `错误：${res.error}`;
};

$('scanProgress').onclick = async () => {
  const res = await api('/api/progress/scan', { method: 'POST' });
  if (!res?.ok) alert(res?.error ?? '进度扫描失败');
  await refresh();
};

$('toggleInspection').onclick = async () => {
  if (!selectedTaskId) return;
  const task = [...state.tasks, ...(state.archivedTasks ?? [])].find(t => t.id === selectedTaskId);
  await api(`/api/tasks/${selectedTaskId}/inspection`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !task?.inspectionEnabled }) });
  await refresh();
};

$('enableAllInspection').onclick = async () => {
  await api('/api/inspection/all', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  await refresh();
};

$('disableAllInspection').onclick = async () => {
  await api('/api/inspection/all', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  await refresh();
};

$('refreshMonitor').onclick = async () => {
  await api('/api/progress/scan', { method: 'POST' });
  await renderMonitor();
};

$('archiveTask').onclick = async () => {
  if (!selectedTaskId) return;
  await api(`/api/tasks/${selectedTaskId}/archive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: '用户确认完成' }) });
  await refresh();
};

$('unarchiveTask').onclick = async () => {
  if (!selectedTaskId) return;
  await api(`/api/tasks/${selectedTaskId}/unarchive`, { method: 'POST' });
  await refresh();
};

$('deleteTask').onclick = async () => {
  if (!selectedTaskId) return;
  if (!confirm(`确认删除 ${selectedTaskId}？这会删除 Butler ledger 中的 task 记录和事件，但不会删除原始 session transcript 文件。`)) return;
  await api(`/api/tasks/${selectedTaskId}/delete`, { method: 'POST' });
  selectedTaskId = null;
  selectedTaskRevision = '';
  lastSessionRenderKey = '';
  await refresh();
};

$('sessionForm').onsubmit = async event => {
  event.preventDefault();
  if (!selectedTaskId) return;
  const input = $('sessionInput');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  const res = await api(`/api/tasks/${selectedTaskId}/session/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
  if (!res.ok) alert(res.error ?? '发送失败');
  else addMessage('butler', res.message ?? '已发送 resume 请求');
  await renderSession(selectedTaskId);
};

$('sessionInput').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('sessionForm').requestSubmit();
  }
});

$('refresh').onclick = refresh;
$('startDaemon').onclick = async () => { await api('/api/daemon/start', { method: 'POST' }); await refresh(); };
$('stopDaemon').onclick = async () => { await api('/api/daemon/stop', { method: 'POST' }); await refresh(); };

if (!loadChatHistory()) addMessage('butler', 'Aura Butler 网页控制台已启动。你可以直接和我对话，我会在需要时分派 CLI worker。');
loadLlmConfig().catch(() => {});
refresh();
setInterval(refresh, 2000);
