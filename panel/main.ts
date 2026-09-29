/**
 * OpenChamber Queue — rail panel and background frame.
 *
 * Two data modes:
 *  - `backend`: the `contributes.service` grant exists and the service is
 *    reachable. The service owns the queue and keeps dispatching with no
 *    client open.
 *  - `local`: no service grant. The panel drives with host APIs while open.
 *
 * Panel copy follows the OpenChamber language (`ctx.locale`); see `src/i18n.ts`.
 */

import { HostRequestError, connectHost, type HostClient } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountEmpty,
  mountSeparator,
  mountSwitch,
  mountTextField,
} from '@openchamber/sdk/ui';

import {
  ACTIVE_GRACE_MS,
  clearTasks,
  completeTask,
  countTasks,
  deriveTitle,
  editTask,
  emptyState,
  ensureQueue,
  getQueue,
  hashKey,
  isOccupied,
  makeTask,
  markFailed,
  markRunning,
  moveTask,
  planTick,
  registerProject,
  releaseTask,
  removeTask,
  retryTask,
  type ActiveRun,
  type ProjectInfo,
  type ProjectQueue,
  type QueueState,
  type QueueTask,
  type SessionActivity,
} from '../src/core.ts';
import { createTranslator, type Translator } from '../src/i18n.ts';

const PROVIDER_ID = 'queue';
const STORAGE_PREFIX = 'openchamber-queue';
const REFRESH_MS = 2000;
const MAX_STEPS_PER_TICK = 4;

type Mode = 'backend' | 'local' | 'unknown';

const host: HostClient = connectHost();
const root = document.querySelector('#root') as HTMLElement;

let t: Translator = createTranslator('en');
let localeTag = 'en';
let mode: Mode = 'unknown';
let project: ProjectInfo | null = null;
let directory: string | null = null;
let queue: ProjectQueue = { enabled: false, completed: 0, tasks: [], active: null };
let renderKey = '';
let panelMounted = false;
let backgroundMounted = false;
let directoryRef: string | null = null;
let editingId: string | null = null;
let draftText = '';

const modeLabel = (value: Mode): string => t(`mode.${value}`);

// ---------------------------------------------------------------------------
// Backend client (serviceRequest)
// ---------------------------------------------------------------------------

const isNoService = (error: unknown): boolean =>
  error instanceof HostRequestError && (error.code === 'NO_SERVICE' || error.code === 'DISABLED');

const backend = {
  async request<T>(method: string, path: string, query?: Record<string, string>, body?: string): Promise<T> {
    const result = await host.serviceRequest({
      method: method as never,
      path,
      ...(query ? { query } : {}),
      ...(body ? { body } : {}),
    });
    return JSON.parse(result.body) as T;
  },
  health(): Promise<void> {
    return this.request<void>('GET', '/health');
  },
  async load(projectId: string): Promise<ProjectQueue> {
    const data = await this.request<{ queue: ProjectQueue }>('GET', '/state', { projectId });
    return data.queue;
  },
  async command(projectId: string, command: Record<string, unknown>): Promise<void> {
    await this.request('POST', '/cmd', undefined, JSON.stringify({ ...command, projectId }));
  },
};

// ---------------------------------------------------------------------------
// Local storage (no service grant)
// ---------------------------------------------------------------------------

let localState: QueueState = emptyState();
const indexKey = `${STORAGE_PREFIX}/index`;
const queueKey = (projectId: string) => `${STORAGE_PREFIX}/q/${hashKey(projectId)}`;

const loadLocal = async (): Promise<void> => {
  localState = emptyState();
  const index = (await host.storage.get(indexKey)) as { projects?: Record<string, ProjectInfo> } | undefined;
  for (const [id, info] of Object.entries(index?.projects ?? {})) {
    localState.projects[id] = info;
    const stored = (await host.storage.get(queueKey(id))) as ProjectQueue | undefined;
    localState.queues[id] = stored ?? { enabled: false, completed: 0, tasks: [], active: null };
  }
};

const saveIndex = (): Promise<void> => host.storage.set(indexKey, { projects: localState.projects } as never);
const saveQueue = (projectId: string): Promise<void> =>
  host.storage.set(queueKey(projectId), localState.queues[projectId] as never);

// ---------------------------------------------------------------------------
// Local driver: the same tick rule, driven by host session snapshots
// ---------------------------------------------------------------------------

const activeStatusFor = (active: ActiveRun, sessions: any[]): 'running' | 'idle' | 'gone' | 'question' => {
  const session = sessions.find((entry) => entry.id === active.sessionId);
  if (!session) {
    // The snapshot may not include a just-created session yet.
    return Date.now() - active.startedAt >= ACTIVE_GRACE_MS ? 'gone' : 'running';
  }
  if (session.archivedAt) return 'gone';
  if (session.activity === 'waiting-question') return 'question';
  return session.activity === 'idle' ? 'idle' : 'running';
};

const localTick = async (projectId: string): Promise<boolean> => {
  const info = localState.projects[projectId];
  if (!info) return false;
  let mutated = false;

  for (let step = 0; step < MAX_STEPS_PER_TICK; step += 1) {
    const current = getQueue(localState, projectId);
    if (!current.active && (!current.enabled || current.tasks.length === 0)) break;

    let sessions: any[];
    try {
      const snapshot = await host.listSessions(projectId);
      // An unready snapshot must never pass for "nothing is running".
      if (snapshot?.state !== 'ready') break;
      sessions = (snapshot.sessions ?? []).filter((session) => session.archivedAt === null);
    } catch {
      break;
    }

    const decision = planTick(current, {
      projectBusy: sessions.some((session) => isOccupied(session.activity as SessionActivity)),
      activeStatus: current.active ? activeStatusFor(current.active, sessions) : 'idle',
    });

    if (decision.kind === 'wait' || decision.kind === 'idle') break;
    if (decision.kind === 'complete') {
      completeTask(localState, projectId, decision.taskId);
      mutated = true;
      continue;
    }
    if (decision.kind === 'release') {
      releaseTask(localState, projectId, decision.taskId);
      mutated = true;
      continue;
    }

    const task = current.tasks.find((entry) => entry.id === decision.taskId);
    if (!task) break;
    try {
      const result = await host.startSession({
        providerId: PROVIDER_ID,
        id: task.id,
        title: deriveTitle(task.text, t('task.untitled')),
        url: '',
        text: task.text,
        projectId,
        navigation: 'preserve',
      });
      if (result.sessionId && result.sent === 'sent') {
        markRunning(localState, projectId, task.id, result.sessionId);
      } else if (result.sessionId) {
        markFailed(localState, projectId, task.id, result.sent === 'no-model' ? t('reason.noModel') : t('reason.sendFailed', { sent: result.sent }));
      } else {
        markFailed(localState, projectId, task.id, t('reason.createFailed'));
      }
    } catch (error) {
      markFailed(localState, projectId, task.id, error instanceof Error ? error.message : String(error));
    }
    mutated = true;
    break;
  }
  return mutated;
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const localCommand = (projectId: string, command: Record<string, unknown>): void => {
  switch (command.op) {
    case 'enqueue': {
      const text = String(command.text ?? '').trim();
      if (text) ensureQueue(localState, projectId).tasks.push(makeTask(text));
      break;
    }
    case 'edit':
      editTask(localState, projectId, String(command.taskId), String(command.text ?? ''));
      break;
    case 'remove':
      removeTask(localState, projectId, String(command.taskId));
      break;
    case 'move':
      moveTask(localState, projectId, String(command.taskId), command.direction as never);
      break;
    case 'retry':
      retryTask(localState, projectId, String(command.taskId));
      break;
    case 'clear':
      clearTasks(localState, projectId);
      break;
    case 'set-enabled':
      ensureQueue(localState, projectId).enabled = command.enabled === true;
      break;
    default:
      break;
  }
};

const pushCommand = async (command: Record<string, unknown>): Promise<void> => {
  if (!project || mode === 'unknown') return;
  if (mode === 'backend') {
    await backend.command(project.id, command);
  } else {
    localCommand(project.id, command);
    await saveQueue(project.id);
    if (await localTick(project.id)) await saveQueue(project.id);
  }
  await refresh();
};

const registerProjectEverywhere = async (info: ProjectInfo): Promise<void> => {
  if (mode === 'unknown') return;
  if (mode === 'backend') {
    await backend.command(info.id, { op: 'register', directory: info.directory, name: info.name });
    return;
  }
  localState.projects[info.id] = info;
  registerProject(localState, info);
  await saveIndex();
  await saveQueue(info.id);
};

// ---------------------------------------------------------------------------
// Mode detection, polling, local driver wiring
// ---------------------------------------------------------------------------

const detectMode = async (): Promise<void> => {
  try {
    await backend.health();
    mode = 'backend';
  } catch (error) {
    if (isNoService(error)) {
      mode = 'local';
      await loadLocal();
    } else {
      mode = 'unknown';
    }
  }
};

let pollTimer: number | null = null;
let sessionUnsubscribe: (() => void) | null = null;

const refresh = async (): Promise<void> => {
  if (!project) {
    render();
    return;
  }
  try {
    queue = mode === 'backend' ? await backend.load(project.id) : getQueue(localState, project.id);
  } catch (error) {
    if (isNoService(error)) {
      await detectMode();
      queue = mode === 'local' ? getQueue(localState, project.id) : queue;
    }
  }
  await host.setBadge(countTasks(queue).pending);
  render();
};

const startPolling = (): void => {
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => void refresh(), REFRESH_MS);
};

const startLocalDriver = async (): Promise<void> => {
  sessionUnsubscribe?.();
  sessionUnsubscribe = null;
  if (!project || mode !== 'local') return;
  const projectId = project.id;
  try {
    sessionUnsubscribe = await host.onSessions(projectId, () => {
      void (async () => {
        if (mode !== 'local' || project?.id !== projectId) return;
        if (await localTick(projectId)) await saveQueue(projectId);
        await refresh();
      })();
    });
  } catch {
    sessionUnsubscribe = null;
  }
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const statusLabel = (status: QueueTask['status']): string => t(`status.${status}`);

const el = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const disposables: Array<{ dispose: () => void }> = [];
const clearDisposables = (): void => {
  while (disposables.length > 0) disposables.pop()?.dispose();
};

const beginEdit = (task: QueueTask): void => {
  editingId = task.id;
  draftText = task.text;
  renderKey = '';
  render();
};

const endEdit = (): void => {
  editingId = null;
  draftText = '';
  renderKey = '';
  render();
};

const render = (): void => {
  if (!panelMounted) return;
  // While a card is open for editing, ignore queue updates so the textarea
  // keeps focus and the caret.
  const key = JSON.stringify({
    localeTag,
    mode,
    project: project?.id ?? null,
    editingId,
    queue: editingId !== null ? 'editing' : queue,
  });
  if (key === renderKey) return;
  renderKey = key;

  clearDisposables();
  root.textContent = '';

  const counts = countTasks(queue);

  const header = root.appendChild(el('div', 'qx-header'));
  const titleRow = header.appendChild(el('div', 'qx-title-row'));
  titleRow.appendChild(el('span', 'qx-title', t('title')));
  titleRow.appendChild(el('span', 'qx-project', project?.name ?? project?.directory ?? t('noProject')));
  disposables.push(mountBadge(titleRow, {
    label: modeLabel(mode),
    tone: mode === 'backend' ? 'info' : mode === 'local' ? 'warning' : 'neutral',
  }));

  if (project) {
    const countsRow = titleRow.appendChild(el('div', 'qx-counts'));
    disposables.push(mountBadge(countsRow, { label: t('count.pending', { n: counts.pending }), tone: 'neutral' }));
    disposables.push(mountBadge(countsRow, { label: t('count.running', { n: counts.running }), tone: 'primary' }));
    disposables.push(mountBadge(countsRow, { label: t('count.completed', { n: counts.completed }), tone: 'success' }));
  }

  if (mode === 'local') {
    disposables.push(mountBanner(root, {
      tone: 'warning',
      title: t('banner.local.title'),
      body: t('banner.local.body'),
    }));
  } else if (mode === 'unknown') {
    disposables.push(mountBanner(root, { tone: 'error', title: t('banner.error.title'), body: t('banner.error.body') }));
  }

  if (!project) {
    disposables.push(mountEmpty(root, { title: t('empty.noProject.title'), body: t('empty.noProject.body') }));
    return;
  }

  const switchHost = root.appendChild(el('div', 'qx-switch'));
  disposables.push(mountSwitch(switchHost, {
    label: t('switch.label'),
    description: queue.enabled ? t('switch.on') : t('switch.off'),
    checked: queue.enabled,
    onChange: (next) => void pushCommand({ op: 'set-enabled', enabled: next }),
  }));

  const composer = root.appendChild(el('div', 'qx-composer'));
  let draft = '';
  const field = mountTextField(composer, {
    label: t('composer.label'),
    value: draft,
    placeholder: t('composer.placeholder'),
    multiline: true,
    rows: 3,
    onChange: (value) => {
      draft = value;
      field.update({ value });
    },
  });
  disposables.push(field);
  const composerActions = composer.appendChild(el('div', 'qx-composer-actions'));
  disposables.push(mountButton(composerActions, {
    label: t('composer.add'),
    onClick: () => {
      void (async () => {
        if (!draft.trim()) return;
        await pushCommand({ op: 'enqueue', text: draft });
        draft = '';
        field.update({ value: '' });
      })();
    },
  }));

  disposables.push(mountSeparator(root, {}));

  const listHost = root.appendChild(el('div', 'qx-list'));
  if (queue.tasks.length === 0) {
    disposables.push(mountEmpty(listHost, {
      title: t('list.empty.title'),
      body: queue.completed > 0 ? t('list.empty.bodyCompleted', { n: queue.completed }) : t('list.empty.body'),
    }));
  } else {
    queue.tasks.forEach((task, index) => listHost.appendChild(renderTask(task, index + 1)));
  }

  if (!queue.enabled) {
    const footer = root.appendChild(el('div', 'qx-footer'));
    disposables.push(mountButton(footer, {
      label: t('footer.clear'),
      variant: 'ghost',
      size: 'sm',
      onClick: () => {
        if (queue.tasks.length === 0) return;
        endEdit();
        void pushCommand({ op: 'clear' });
      },
    }));
  }
};

const renderTask = (task: QueueTask, position: number): HTMLElement => {
  if (editingId === task.id) return renderEditor(task);
  const row = el('div', `qx-row qx-row-${task.status}${queue.enabled ? '' : ' qx-row-editable'}`);
  row.appendChild(el('span', `qx-dot qx-dot-${task.status}`));
  row.appendChild(el('span', 'qx-pos', String(position)));

  const body = row.appendChild(el('div', 'qx-row-body'));
  body.appendChild(el('div', 'qx-row-text', deriveTitle(task.text, t('task.untitled'))));
  const subtitle = [
    statusLabel(task.status),
    task.status === 'running' ? t('row.waiting') : '',
    task.error ?? '',
    queue.enabled ? '' : t('row.clickToEdit'),
  ].filter(Boolean).join(' · ');
  body.appendChild(el('div', 'qx-row-sub', subtitle));

  const actions = row.appendChild(el('div', 'qx-row-actions'));
  // Buttons must not open the editor.
  actions.addEventListener('click', (event) => event.stopPropagation());
  if (task.sessionId) {
    disposables.push(mountButton(actions, {
      label: t('row.session'),
      size: 'xs',
      variant: 'ghost',
      onClick: () => void host.openSession(task.sessionId as string),
    }));
  }
  if (task.status === 'pending') {
    disposables.push(mountButton(actions, {
      label: t('row.top'),
      size: 'xs',
      variant: 'ghost',
      onClick: () => void pushCommand({ op: 'move', taskId: task.id, direction: 'top' }),
    }));
  }
  if (task.status === 'failed') {
    disposables.push(mountButton(actions, {
      label: t('row.retry'),
      size: 'xs',
      variant: 'outline',
      onClick: () => void pushCommand({ op: 'retry', taskId: task.id }),
    }));
  }
  disposables.push(mountButton(actions, {
    label: t('row.delete'),
    size: 'xs',
    variant: 'ghost',
    onClick: () => void pushCommand({ op: 'remove', taskId: task.id }),
  }));

  row.addEventListener('click', () => {
    if (queue.enabled) {
      void host.toast({ kind: 'info', message: t('toast.locked') });
      return;
    }
    beginEdit(task);
  });
  return row;
};

const renderEditor = (task: QueueTask): HTMLElement => {
  const card = el('div', 'qx-edit');
  const field = mountTextField(card, {
    value: draftText,
    multiline: true,
    rows: 4,
    onChange: (value) => {
      draftText = value;
      field.update({ value });
    },
  });
  disposables.push(field);

  const actions = card.appendChild(el('div', 'qx-edit-actions'));
  disposables.push(mountButton(actions, {
    label: t('edit.save'),
    size: 'sm',
    disabled: !draftText.trim(),
    onClick: () => {
      const text = draftText.trim();
      if (!text) return;
      const id = task.id;
      endEdit();
      void pushCommand({ op: 'edit', taskId: id, text });
    },
  }));
  disposables.push(mountButton(actions, {
    label: t('edit.cancel'),
    size: 'sm',
    variant: 'ghost',
    onClick: () => endEdit(),
  }));
  return card;
};

// ---------------------------------------------------------------------------
// Background frame: enqueue from a message action or the `/queue` command
// ---------------------------------------------------------------------------

type Target = { projectId: string; directory: string; name: string };

const resolveTarget = async (dir: string | null): Promise<Target | null> => {
  if (!dir) return null;
  try {
    const snapshot = await host.listProjects();
    const match = snapshot.projects.find((entry) => entry.directory === dir);
    if (match) return { projectId: match.id, directory: match.directory, name: match.name };
  } catch {
    // fall through to a synthetic id
  }
  return { projectId: `dir:${dir}`, directory: dir, name: dir };
};

const enqueueAnywhere = async (target: Target, text: string): Promise<void> => {
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    await backend.health();
    await backend.command(target.projectId, { op: 'register', directory: target.directory, name: target.name });
    await backend.command(target.projectId, { op: 'enqueue', text: trimmed });
    return;
  } catch (error) {
    if (!isNoService(error)) throw error;
  }
  await loadLocal();
  localState.projects[target.projectId] = { id: target.projectId, directory: target.directory, name: target.name };
  ensureQueue(localState, target.projectId).tasks.push(makeTask(trimmed));
  await saveIndex();
  await saveQueue(target.projectId);
};

const mountBackground = (): void => {
  if (backgroundMounted) return;
  backgroundMounted = true;

  host.onAction(async (item) => {
    const target = await resolveTarget(item.directory ?? null);
    if (!target) {
      await host.toast({ kind: 'error', message: t('toast.noDirectory') });
      return;
    }
    const text = item.kind === 'message' ? item.text : '';
    await enqueueAnywhere(target, text);
    await host.toast({ kind: 'success', message: t('toast.enqueued') });
  });

  host.onResolve(async ({ command, args }) => {
    if (command !== 'queue') return null;
    const text = args.trim();
    if (!text) return null;
    const target = await resolveTarget(directoryRef);
    if (!target) return null;
    await enqueueAnywhere(target, text);
    return { providerId: PROVIDER_ID, id: `queue-${Date.now()}`, title: deriveTitle(text, t('task.untitled')), url: '' };
  });
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const preparePanel = async (): Promise<void> => {
  if (directory) {
    const target = await resolveTarget(directory);
    project = target ? { id: target.projectId, directory: target.directory, name: target.name } : null;
  }
  await detectMode();
  if (project) await registerProjectEverywhere(project);
  await refresh();
  startPolling();
  await startLocalDriver();
};

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  localeTag = ctx.locale;
  t = createTranslator(ctx.locale);
  document.body.dataset.surface = ctx.surface;
  document.documentElement.lang = ctx.locale;
  directoryRef = ctx.directory;

  if (ctx.surface === 'background') {
    mountBackground();
    return;
  }
  if (panelMounted) return;
  panelMounted = true;
  directory = ctx.directory;
  void preparePanel();
});

host.onDirectory((next) => {
  directoryRef = next;
  // Background frames only need the ref for `/queue`; the panel logic below
  // must not run there.
  if (!panelMounted) return;
  if (next === directory) return;
  directory = next;
  void (async () => {
    sessionUnsubscribe?.();
    sessionUnsubscribe = null;
    editingId = null;
    draftText = '';
    const target = next ? await resolveTarget(next) : null;
    project = target ? { id: target.projectId, directory: target.directory, name: target.name } : null;
    if (project) await registerProjectEverywhere(project);
    await refresh();
    await startLocalDriver();
  })();
});
