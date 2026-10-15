import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { applyPatch, createTwoFilesPatch } from './vendor/diff/libesm/index.js';

const MAX_PREVIEW_LINES = 400;
const SETTINGS = ['appDetails', 'relativeTo'];
const key = (id, slot) => `stat:session:${id}:${slot}`;
const digest = (data) => createHash('sha256').update(data).digest('hex');
const bytes = (value) => {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
  throw new Error('资源接口未返回可识别的原始字节，未生成快照');
};
const isChildSession = (session) => /[\\/]subagent-sessions[\\/]/i.test(session?.sessionPath ?? '');

/** 使用 Git 同样的增删口径，显示截断不会影响统计与回滚原文。 */
export function parsePatch(patch) {
  const out = { added: 0, removed: 0, lines: [], truncated: false };
  let active = false, oldNo = 0, newNo = 0;
  const push = (line) => {
    if (out.lines.length < MAX_PREVIEW_LINES) out.lines.push(line);
    else out.truncated = true;
  };
  for (const text of patch.split('\n')) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (match) {
      active = true;
      oldNo = Number(match[1]); newNo = Number(match[2]);
      push({ k: 'hunk', t: text });
    } else if (active && text.startsWith('+')) {
      out.added++; push({ k: 'add', o: null, n: newNo++, t: text.slice(1) });
    } else if (active && text.startsWith('-')) {
      out.removed++; push({ k: 'del', o: oldNo++, n: null, t: text.slice(1) });
    } else if (active && text.startsWith(' ')) {
      push({ k: 'ctx', o: oldNo++, n: newNo++, t: text.slice(1) });
    } else if (active && text.startsWith('\\')) {
      push({ k: 'notice', t: text.slice(2) });
    }
  }
  return out;
}

/** 快照文件只写入 App 私有数据目录，应用面板只获得不包含原文快照的展示投影。 */
export async function createReview(sdk) {
  const root = path.join(sdk.dataDir, 'review-v1');
  await mkdir(root, { recursive: true });
  const locks = new Map(), operations = new Map(), confirmations = new Map(), activeTurns = new Map();
  const store = sdk.storage.global;
  const statePath = (id) => path.join(root, `${digest(Buffer.from(id))}.json`);
  // 清掉早期版本写入的全局大快照，避免旧实现把应用存储推过软上限。
  try {
    if (typeof store.keys === 'function') for (const storageKey of await store.keys()) {
      if (storageKey === 'stat:latest' || storageKey === 'stat:prev' || /^stat:[0-9a-f]{64}$/.test(storageKey)) await store.delete(storageKey);
    }
  } catch (error) {
    await sdk.logger.warn(`diff-stat: 清理旧存储失败 ${error.message}`);
  }
  const locked = (id, work) => {
    const previous = locks.get(id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(work);
    locks.set(id, task);
    task.finally(() => { if (locks.get(id) === task) locks.delete(id); }).catch(() => {});
    return task;
  };
  const load = async (id) => {
    try { return JSON.parse(await readFile(statePath(id), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; return { pending: null, current: null, prev: null, history: [] }; }
  };
  const save = async (id, state) => {
    const target = statePath(id), tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(state), 'utf8');
    await rename(tmp, target);
  };
  // 在应用自己的私有数据目录内清除旧版生成的审阅正文，保留 diff 和回滚快照。
  for (const name of await readdir(root)) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    const target = path.join(root, name);
    const state = JSON.parse(await readFile(target, 'utf8'));
    if (state.activeTurn?.owner?.path && state.activeTurn.turnId) {
      activeTurns.set(state.activeTurn.owner.path, state.activeTurn);
    }
    let changed = false;
    for (const batch of [state.pending, state.current, state.prev, ...(state.history ?? [])]) {
      if (!batch || !Object.hasOwn(batch, 'conversationContent')) continue;
      delete batch.conversationContent;
      changed = true;
    }
    if (changed) {
      const tmp = `${target}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(state), 'utf8');
      await rename(tmp, target);
    }
  }
  const settings = async () => {
    const values = {};
    for (const name of SETTINGS) values[name] = await sdk.config.get(name);
    values.appDetails ??= true;
    return values;
  };
  const findSession = async (session) => {
    // 钩子中的 sessionId 可能是旧定位器 UUID，由宿主解析路径为稳定身份。
    // 子代理不在当前面板会话目录内，明确排除，不归入其他对话。
    if (isChildSession(session)) return null;
    const result = await sdk.sessions.get({ sessionPath: session.sessionPath, scope: 'all' });
    if (!result.session?.sessionId) throw new Error('宿主无法解析当前主对话的稳定身份');
    return result.session;
  };
  async function started({ session }) {
    if (!session?.sessionPath || isChildSession(session)) return;
    const owner = await findSession(session);
    // 持久化回合标识，工具采集不再读取会话正文或整棵树。
    await locked(owner.sessionId, async () => {
      const state = await load(owner.sessionId);
      const turn = { owner: { ...owner, path: session.sessionPath }, turnId: randomUUID() };
      state.activeTurn = turn;
      await save(owner.sessionId, state);
      activeTurns.set(session.sessionPath, turn);
    });
  }
  const inputTarget = (input, session, config) => {
    if (input.resource) return input.resource;
    if (input.fileId) return { kind: 'session-file', fileId: input.fileId };
    if (typeof input.path !== 'string') throw new Error('文件工具未提供路径或资源引用');
    return { kind: 'local-file', path: path.isAbsolute(input.path) ? input.path : path.resolve(session.cwd || config.relativeTo, input.path) };
  };
  const readSnapshot = async (resource) => {
    const stat = await sdk.resources.stat(resource);
    if (!stat.exists) return { exists: false, data: null, sha256: null, version: null };
    if (stat.isDirectory) throw new Error('目标是目录，不能建立文件快照');
    const read = await sdk.resources.read(resource);
    const data = bytes(read.content);
    return { exists: true, data: data.toString('base64'), sha256: digest(data), version: read.version };
  };
  const displayName = (input, resource, session, config) => {
    const p = resource.path || input.path || input.fileId || '文件';
    if (resource.kind !== 'local-file') return String(p).replace(/\\/g, '/');
    return path.relative(session.cwd || config.relativeTo, p).replace(/\\/g, '/');
  };
  const projection = (batch) => batch && ({
    id: batch.id, at: batch.at, sessionId: batch.sessionId, previousId: batch.previousId ?? null,
    appDetails: batch.appDetails !== false,
    files: batch.files.map((file) => {
      const supported = file.before?.exists && file.after?.exists && !file.error;
      return { id: file.id, file: file.file, added: file.added, removed: file.removed,
        lines: file.lines, truncated: file.truncated, restored: !!file.restored,
        rollbackAvailable: !!supported && !file.restored,
        rollbackReason: file.restored ? '已恢复' : file.error || (!file.before?.exists ? '新建文件首版不自动删除' : (!file.after?.exists ? '文件已不存在' : null)) };
    }),
  });
  const publish = async (id, state) => {
    state.history = (state.history ?? []).slice(-8);
    await store.set(key(id, 'prev'), projection(state.prev));
    await store.set(key(id, 'current'), projection(state.current));
    const keep = new Set([state.current?.id, state.prev?.id, ...state.history.map((batch) => batch.id)]);
    if (typeof store.keys === 'function') for (const storageKey of await store.keys()) {
      const prefix = key(id, 'batch:');
      if (storageKey.startsWith(prefix) && !keep.has(storageKey.slice(prefix.length))) await store.delete(storageKey);
    }
    for (const batch of [state.current, state.prev].filter(Boolean)) {
      await store.set(key(id, `batch:${batch.id}`), projection(batch));
    }
    await store.set(key(id, 'history'), state.history.map((batch) => ({ id: batch.id, at: batch.at })));
  };

  async function before({ toolName, input, session }) {
    if (!['edit', 'write'].includes(toolName) || !session?.sessionPath || isChildSession(session)) return;
    const turn = activeTurns.get(session.sessionPath);
    if (!turn) throw new Error('尚未收到本轮开始事件；等待下一轮建立审阅，未猜测历史批次');
    const { owner, turnId } = turn, config = await settings();
    const op = { id: randomUUID(), toolName, input, owner, turnId, rawPath: input.path, created: Date.now() };
    try {
      op.resource = inputTarget(input, owner, config);
      op.file = displayName(input, op.resource, owner, config);
      op.before = await readSnapshot(op.resource);
    } catch (e) {
      op.error = `未能建立改前快照：${e.message}`;
      op.file = input.path || input.fileId || input.resource?.path || '文件';
    }
    // 工具被取消时可能没有结束事件；过期的配对记录不能用于之后的快照。
    const bucket = (operations.get(session.sessionPath) ?? []).filter((item) => Date.now() - item.created < 300000);
    bucket.push(op);
    operations.set(session.sessionPath, bucket);
  }

  async function after({ toolName, content, details, isError, session }) {
    if (!['edit', 'write'].includes(toolName) || !session?.sessionPath || isChildSession(session)) return;
    const bucket = (operations.get(session.sessionPath) ?? []).filter((item) => Date.now() - item.created < 300000);
    const header = details?.patch?.match(/^--- (.*)$/m)?.[1];
    const output = Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : '';
    let matches = bucket.filter((op) => op.toolName === toolName && (
      (header && header === op.rawPath) || (op.rawPath && output.includes(op.rawPath))
    ));
    if (!matches.length) matches = bucket.filter((op) => op.toolName === toolName);
    if (matches.length !== 1) {
      await sdk.logger.warn('diff-stat: 工具结果无法唯一匹配改前快照，未创建可回滚记录');
      return;
    }
    const op = matches[0];
    operations.set(session.sessionPath, bucket.filter((x) => x !== op));
    if (isError) return;
    try { if (op.resource) op.after = await readSnapshot(op.resource); }
    catch (e) { op.error = `未能读取改后版本：${e.message}`; }
    // 后置钩子读盘前可能已有别的程序改文件；只把本次工具确实写出的结果作为可回滚版本。
    if (op.after?.exists && !op.error) {
      const actual = Buffer.from(op.after.data, 'base64');
      if (toolName === 'write') {
        if (!actual.equals(Buffer.from(op.input.content, 'utf8'))) op.error = '写入后出现其他修改，禁止恢复该文件';
      } else if (op.before?.exists && details?.patch) {
        const normalizeText = (text) => text.replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n');
        const expected = applyPatch(normalizeText(Buffer.from(op.before.data, 'base64').toString('utf8')), details.patch, { fuzzFactor: 0 });
        if (expected === false || normalizeText(expected) !== normalizeText(actual.toString('utf8'))) {
          op.error = '工具补丁与实际改后内容不一致，禁止恢复该文件';
        }
      } else op.error = '缺少可核对的工具补丁，禁止恢复该文件';
    }
    await locked(op.owner.sessionId, async () => {
      const state = await load(op.owner.sessionId);
      // 中断的回合仍保留历史，但不能把它的改前原文并到下一轮恢复范围中。
      if (state.pending && state.pending.turnId !== op.turnId) {
        state.prev = state.current;
        state.current = { ...state.pending, notification: 'interrupted', previousId: state.prev?.id ?? null };
        state.history = [...(state.history ?? []), state.current];
        state.pending = null;
        await publish(op.owner.sessionId, state);
      }
      // 批次由用户回合决定，同一回合后续采集继续更新同一批次，不再发第二张卡。
      const batch = state.pending ?? (state.current?.turnId === op.turnId ? state.current : null)
        ?? { id: digest(Buffer.from(`${op.owner.sessionId}:${op.turnId}`)), at: Date.now(), turnId: op.turnId, sessionId: op.owner.sessionId, files: [] };
      let file = batch.files.find((f) => f.file === op.file);
      if (!file) {
        file = { id: randomUUID(), file: op.file, resource: op.resource, before: op.before };
        batch.files.push(file);
      } else if (file.after?.sha256 !== op.before?.sha256) {
        file.error = '本轮连续编辑之间出现了其他修改，禁止整文件回滚';
      }
      file.after = op.after;
      file.error ||= op.error;
      let patch = details?.patch;
      if (file.before && file.after) {
        const original = file.before.exists ? Buffer.from(file.before.data, 'base64').toString('utf8') : '';
        const updated = file.after.exists ? Buffer.from(file.after.data, 'base64').toString('utf8') : '';
        patch = createTwoFilesPatch(file.file, file.file, original, updated, undefined, undefined, { context: 4 });
      }
      if (patch) Object.assign(file, parsePatch(patch));
      else Object.assign(file, { added: 0, removed: 0, lines: [{ k: 'notice', t: file.error || '缺少可用差异' }], truncated: false });
      state.pending = batch;
      await save(op.owner.sessionId, state);
    });
  }

  async function settled({ session }) {
    if (!session?.sessionPath || isChildSession(session)) return;
    const turn = activeTurns.get(session.sessionPath);
    if (!turn) return;
    const { owner } = turn;
    await locked(owner.sessionId, async () => {
      const state = await load(owner.sessionId);
      if (state.pending) {
        const sameBatch = state.current?.id === state.pending.id;
        if (!sameBatch) state.prev = state.current;
        const prefs = await settings();
        state.current = { ...state.pending, appDetails: prefs.appDetails !== false, notification: 'hidden', previousId: state.prev?.id ?? null };
        state.pending = null;
        state.history = [...(state.history ?? []).filter((batch) => batch.id !== state.current.id), state.current];
        await save(owner.sessionId, state);
        await publish(owner.sessionId, state);
      }
      if (activeTurns.get(session.sessionPath) === turn) {
        activeTurns.delete(session.sessionPath);
        delete state.activeTurn;
        await save(owner.sessionId, state);
      }
    });
  }

  const validateTarget = (state, batchId, fileId) => {
    if (state.pending) throw new Error('当前对话正在产生新一轮改动，等待本轮完成后再恢复');
    if (!state.current || state.current.id !== batchId) throw new Error('该记录已不是最近一轮，请刷新审阅卡');
    // 整轮撤销仅恢复已有且可校验的文件；新建文件保留并在确认清单明确列出。
    const targets = fileId ? state.current.files.filter((f) => f.id === fileId)
      : state.current.files.filter((f) => !f.restored && !f.error && f.before?.exists && f.after?.exists);
    if (!targets.length) throw new Error('没有可恢复的文件');
    for (const file of targets) {
      if (file.restored) throw new Error(`${file.file} 已恢复`);
      if (file.error || !file.before?.exists || !file.after?.exists) throw new Error(`${file.file} 不支持回滚：${file.error || '缺少已有文件快照，新建文件首版不自动删除'}`);
    }
    return targets;
  };
  const preflight = async (targets) => {
    const plan = [];
    for (const file of targets) {
      const current = await readSnapshot(file.resource);
      if (!current.exists || current.sha256 !== file.after.sha256) throw new Error(`${file.file} 在本轮之后又被修改，已拒绝覆盖`);
      // 空对象或仅文件大小不能提供可靠的条件写入保护。
      const version = current.version;
      if (!version || !(typeof version.sha256 === 'string' && version.sha256.length > 0 || typeof version.etag === 'string' && version.etag.length > 0 || Number.isFinite(version.sequence) || Number.isFinite(version.mtimeMs))) {
        throw new Error(`${file.file} 没有可校验的资源版本，已拒绝恢复`);
      }
      plan.push({ file, version: current.version });
    }
    return plan;
  };

  async function prepare(sessionId, batchId, fileId) {
    return locked(sessionId, async () => {
      const state = await load(sessionId);
      const targets = validateTarget(state, batchId, fileId);
      await preflight(targets);
      for (const [token, value] of confirmations) if (value.expires < Date.now()) confirmations.delete(token);
      const token = randomUUID();
      confirmations.set(token, { sessionId, batchId, fileId, expires: Date.now() + 120000 });
      const skipped = fileId ? [] : state.current.files.filter((f) => !f.restored && !targets.some((t) => t.id === f.id)).map((f) => f.file);
      return { token, files: targets.map((f) => f.file), skipped, message: '将恢复到最近一轮修改前；只恢复列出的文件。此操作会覆盖这些文件当前内容。新建文件及不可校验文件保留不动。' };
    });
  }

  async function commit(token) {
    const request = confirmations.get(token);
    confirmations.delete(token);
    if (!request || request.expires < Date.now()) throw new Error('确认已过期，请重新检查');
    return locked(request.sessionId, async () => {
      const state = await load(request.sessionId);
      const targets = validateTarget(state, request.batchId, request.fileId);
      const plan = await preflight(targets);
      const restored = [];
      let error = null;
      for (const { file, version } of plan) {
        try {
          const result = await sdk.resources.writeExpectedVersion(file.resource, Buffer.from(file.before.data, 'base64'), version);
          if (result?.conflict || result?.ok === false) throw new Error('版本冲突，未继续恢复');
          // 写入已发生，先记账；后续校验失败不能报告为“从未写入”。
          file.restored = true;
          restored.push(file.file);
          await save(request.sessionId, state);
          const verify = await readSnapshot(file.resource);
          if (verify.sha256 !== file.before.sha256) throw new Error('恢复已写入，但随后校验不一致，请检查文件');
        } catch (e) { error = `${file.file}：${e.message}`; break; }
      }
      await publish(request.sessionId, state);
      const skipped = request.fileId ? [] : state.current.files.filter((f) => !f.restored && !targets.some((t) => t.id === f.id)).map((f) => f.file);
      return { ok: !error, restored, error, skipped, remaining: targets.filter((f) => !f.restored).map((f) => f.file) };
    });
  }

  async function attachRoutes() {
    await sdk.routes.register((app) => {
      const handle = (work) => async (c) => {
        try { return c.json(await work(c)); }
        catch (e) { return c.json({ error: e.message }, 409); }
      };
      app.get('/preferences', handle(settings));
      app.post('/preferences', handle(async (c) => {
        const { name, value } = await c.req.json();
        if (!SETTINGS.includes(name) || name === 'relativeTo' || typeof value !== 'boolean') throw new Error('无效显示设置');
        await sdk.config.set(name, value);
        return settings();
      }));
      app.post('/rollback/prepare', handle(async (c) => {
        const { sessionId, batchId, fileId } = await c.req.json();
        if (typeof sessionId !== 'string' || typeof batchId !== 'string' || (fileId != null && typeof fileId !== 'string')) throw new Error('无效的恢复目标');
        return prepare(sessionId, batchId, fileId);
      }));
      app.post('/rollback/commit', handle(async (c) => {
        const { token } = await c.req.json();
        return commit(token);
      }));
    });
  }

  return { started, before, after, settled, prepare, commit, attachRoutes, settings };
}
