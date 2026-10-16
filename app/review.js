import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createTwoFilesPatch } from './vendor/diff/libesm/index.js';

const MAX_PREVIEW_LINES = 400;
const SETTINGS = ['appDetails', 'relativeTo'];
const key = (id) => `stat:session:${id}:current`;
const digest = (data) => createHash('sha256').update(data).digest('hex');
const bytes = (value) => {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
  throw new Error('资源接口未返回可识别的原始字节');
};
const isChildSession = (session) => /[\\/]subagent-sessions[\\/]/i.test(session?.sessionPath ?? '');

/** 使用 Git 的增删口径，预览截断不影响统计。 */
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

/** 仅保存每个主对话最新的展示投影，不提供历史批次或文件恢复接口。 */
export async function createReview(sdk) {
  const store = sdk.storage.global;
  const activeTurns = new Map(), operations = new Map(), locks = new Map();
  const locked = (id, work) => {
    const previous = locks.get(id) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(work);
    locks.set(id, task);
    task.finally(() => { if (locks.get(id) === task) locks.delete(id); }).catch(() => {});
    return task;
  };
  const settings = async () => {
    const values = {};
    for (const name of SETTINGS) values[name] = await sdk.config.get(name);
    values.appDetails ??= true;
    return values;
  };
  const findSession = async (session) => {
    // 当前宿主的 session:get 路径解析不一致，仅查询轻量主会话目录。
    const result = await sdk.sessions.list({ scope: 'all', lifecycle: 'active' });
    const locator = path.resolve(session.sessionPath).replace(/\\/g, '/').toLowerCase();
    const matches = result.sessions.filter((item) => item.sessionId && path.resolve(item.path).replace(/\\/g, '/').toLowerCase() === locator);
    if (matches.length !== 1) throw new Error('主对话未在宿主目录中唯一登记');
    return matches[0];
  };
  async function started({ session }) {
    if (!session?.sessionPath) throw new Error('用户输入事件缺少会话定位');
    if (isChildSession(session)) return;
    const owner = await findSession(session);
    const turnId = randomUUID();
    activeTurns.set(session.sessionPath, {
      owner, id: digest(Buffer.from(`${owner.sessionId}:${turnId}`)), at: Date.now(), files: [],
    });
    operations.delete(session.sessionPath);
    await sdk.logger.info(`diff-stat: 主对话 ${owner.sessionId} 已登记本轮差异`);
  }
  const inputTarget = (input, owner, config) => {
    if (input.resource) return input.resource;
    if (input.fileId) return { kind: 'session-file', fileId: input.fileId };
    if (typeof input.path !== 'string') throw new Error('文件工具未提供路径或资源引用');
    return { kind: 'local-file', path: path.isAbsolute(input.path) ? input.path : path.resolve(owner.cwd || config.relativeTo, input.path) };
  };
  const readText = async (resource) => {
    const stat = await sdk.resources.stat(resource);
    if (!stat.exists) return '';
    if (stat.isDirectory) throw new Error('目标是目录，无法展示文本差异');
    const result = await sdk.resources.read(resource);
    return bytes(result.content).toString('utf8');
  };
  const displayName = (input, resource, owner, config) => {
    const p = resource.path || input.path || input.fileId || '文件';
    if (resource.kind !== 'local-file') return String(p).replace(/\\/g, '/');
    return path.relative(owner.cwd || config.relativeTo, p).replace(/\\/g, '/');
  };
  const publish = async (turn) => {
    const prefs = await settings();
    await store.set(key(turn.owner.sessionId), {
      id: turn.id, at: turn.at, updatedAt: turn.updatedAt, sessionId: turn.owner.sessionId,
      appDetails: prefs.appDetails !== false,
      files: turn.files.map(({ id, file, added, removed, lines, truncated }) => ({ id, file, added, removed, lines, truncated })),
    });
  };

  async function before({ toolName, input, session }) {
    if (!['edit', 'write'].includes(toolName) || !session?.sessionPath || isChildSession(session)) return;
    const turn = activeTurns.get(session.sessionPath);
    if (!turn) throw new Error('尚未收到本轮用户输入事件，未猜测差异归属');
    const config = await settings();
    const op = { toolName, rawPath: input.path, turn, created: Date.now() };
    try {
      op.resource = inputTarget(input, turn.owner, config);
      op.file = displayName(input, op.resource, turn.owner, config);
      // 改前文本仅在内存中用于合并同轮差异，不写入磁盘或展示存储。
      op.original = await readText(op.resource);
    } catch (e) {
      op.error = `未能读取改前文本：${e.message}`;
      op.file = input.path || input.fileId || input.resource?.path || '文件';
    }
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
      await sdk.logger.warn('diff-stat: 工具结果无法唯一匹配改前文本，未更新差异');
      return;
    }
    const op = matches[0];
    operations.set(session.sessionPath, bucket.filter((item) => item !== op));
    if (isError) return;
    let updated;
    try { if (op.resource) updated = await readText(op.resource); }
    catch (e) { op.error = `未能读取改后文本：${e.message}`; }
    await locked(op.turn.owner.sessionId, async () => {
      // 新输入已经建立下一轮时，不让上一轮迟到的结果覆盖当前差异。
      if (activeTurns.get(session.sessionPath) !== op.turn) return;
      let file = op.turn.files.find((f) => f.file === op.file);
      if (!file) {
        file = { id: randomUUID(), file: op.file, original: op.original };
        op.turn.files.push(file);
      }
      let patch = details?.patch;
      if (file.original !== undefined && updated !== undefined) {
        patch = createTwoFilesPatch(file.file, file.file, file.original, updated, undefined, undefined, { context: 4 });
      }
      if (patch) Object.assign(file, parsePatch(patch));
      else Object.assign(file, { added: 0, removed: 0, lines: [{ k: 'notice', t: op.error || '缺少可用差异' }], truncated: false });
      op.turn.updatedAt = Date.now();
      await publish(op.turn);
      await sdk.logger.info(`diff-stat: 已更新 ${op.turn.owner.sessionId} 的最新差异，${op.turn.files.length} 个文件`);
    });
  }

  return { started, before, after, settings };
}
