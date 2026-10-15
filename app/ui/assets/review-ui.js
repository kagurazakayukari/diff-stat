import { createHanaAppUiSdk } from './sdk.js';

// 页面自行同步宿主的实际主题样式，包含初始快照和后续切换。
const hana = createHanaAppUiSdk({ followHostTheme: false });

const el = (id) => document.getElementById(id);
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let sessionId = null, records = { current: null }, details = true;
let generation = 0, busy = false, offActive = null, confirmation = null;
let currentBatchId = null, applicationBatchId = null;
const expanded = new Map();

function status(message, error = false) {
  el('status').textContent = message;
  el('status').classList.toggle('error', error);
}
async function api(route, data) {
  const response = await hana.api.fetch(route, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
  return result;
}
function lineHtml(line) {
  if (line.k === 'hunk' || line.k === 'notice') return `<div class="${line.k}">${esc(line.t)}</div>`;
  return `<div class="ln ${line.k}"><span class="num">${line.o ?? ''}</span><span class="num">${line.n ?? ''}</span><span class="sign">${line.k === 'add' ? '+' : line.k === 'del' ? '-' : ' '}</span><span class="code">${esc(line.t)}</span></div>`;
}
function render() {
  const record = records.current, files = record?.files ?? [];
  el('sum').innerHTML = files.length ? `<span class="summary-label"><strong>${files.length}</strong> 个文件</span><span class="summary-value add">+${files.reduce((n, f) => n + f.added, 0)}<small>新增</small></span><span class="summary-value del">−${files.reduce((n, f) => n + f.removed, 0)}<small>删除</small></span>` : '';
  el('rollback-round').disabled = busy || record?.id !== currentBatchId || !files.some((f) => f.rollbackAvailable);
  if (!files.length) {
    el('list').innerHTML = `<div class="empty"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z M14 3v6h6 M8 13h8 M8 17h5"/></svg><strong>${sessionId ? '暂无可显示的审阅记录' : '选择一个对话查看改动'}</strong><p>${sessionId ? '文件改动完成后，本轮差异会显示在这里。' : '记录按对话保存，可随时查看历史批次。'}</p></div>`;
    return;
  }
  el('list').innerHTML = files.map((file) => {
    const open = expanded.get(`${record.id}:${file.id}`) ?? details;
    const canRestore = record.id === currentBatchId && file.rollbackAvailable && !busy;
    const reason = record.id !== currentBatchId ? '历史批次仅供查看，只能恢复最近一轮' : file.rollbackReason || (!file.rollbackAvailable ? '这条旧记录没有改前快照，不能安全回滚' : '');
    const reasonHtml = !canRestore && reason ? `<div class="restore-reason">${esc(reason)}</div>` : '';
    return `<section class="file"><div class="fhead"><button class="filename" data-expand="${esc(file.id)}" aria-expanded="${open}" title="${esc(file.file)}"><svg class="file-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg><span class="filepath">${esc(file.file)}</span></button><span class="stats"><span class="add">+${file.added}</span><span class="del">-${file.removed}</span></span><button class="restore hs-button" data-restore="${esc(file.id)}" ${canRestore ? '' : 'disabled'} title="${esc(reason || '恢复该文件改前版本')}">${file.restored ? '已恢复' : '回滚此文件'}</button></div>${reasonHtml}<div class="diff" ${open ? '' : 'hidden'}><div class="diff-lines">${(file.lines || []).map(lineHtml).join('')}${file.truncated ? '<div class="notice">预览已截断；原始快照完整保留。</div>' : ''}</div></div></section>`;
  }).join('');
  for (const button of document.querySelectorAll('[data-expand]')) button.onclick = () => {
    const id = `${record.id}:${button.dataset.expand}`;
    expanded.set(id, !(expanded.get(id) ?? details));
    render();
  };
  for (const button of document.querySelectorAll('[data-restore]')) button.onclick = () => prepareRollback(button.dataset.restore);
}
async function load() {
  const mine = ++generation, owner = sessionId;
  if (!owner) { records = { current: null }; render(); return; }
  try {
    const prefix = `stat:session:${owner}:`;
    const [current, history] = await Promise.all(['current', 'history'].map((slot) => hana.storage.global.get(`${prefix}${slot}`)));
    if (mine !== generation) return;
    currentBatchId = current.value?.id ?? null;
    const batches = history.value ?? [], picker = el('batch-select');
    const selectedId = applicationBatchId ?? batches.at(-1)?.id ?? currentBatchId;
    picker.innerHTML = [...batches].reverse().map((batch) => `<option value="${esc(batch.id)}">${esc(new Date(batch.at).toLocaleString())} · ${esc(batch.id.slice(0, 8))}</option>`).join('');
    picker.value = selectedId ?? '';
    const selected = selectedId && selectedId !== currentBatchId ? await hana.storage.global.get(`${prefix}batch:${selectedId}`) : current;
    if (mine !== generation) return;
    records = { current: selected.value };
    const prefs = await api('/preferences');
    if (mine !== generation) return;
    details = prefs.appDetails !== false;
    status(applicationBatchId ? `查看历史批次 ${applicationBatchId.slice(0, 8)}` : '跟随当前选中的对话 · 最新批次');
    render();
  } catch (error) {
    if (mine !== generation) return;
    status(`读取失败：${error.message}`, true);
  }
}
function selectSession(id) {
  if (id !== sessionId) {
    sessionId = id;
    currentBatchId = null;
    applicationBatchId = null;
    expanded.clear();
    records = { current: null };
    render();
  }
  void load();
}
async function refreshActive() {
  try {
    const active = await hana.sessions.getActive();
    selectSession(active?.sessionId ?? null);
  } catch (error) { status(`当前对话读取失败：${error.message}`, true); }
}
function contextChanged(context) {
  if (!context || offActive) return;
  // 本页面只承担应用面板。旧 iframe 不再通过最新记录猜测消息内容。
  if (context.embeddedSessionId) {
    status('此旧版审阅卡没有固定正文。请在应用面板查看历史记录。', true);
    return;
  }
  document.body.dataset.surface = 'application';
  el('application-toolbar').hidden = false;
  el('history-toolbar').hidden = false;
  offActive = hana.sessions.onActiveChanged(({ current }) => {
    selectSession(current?.sessionId ?? null);
  }, (error) => {
    offActive = null;
    status(`会话切换监听失败：${error.message}。可点击“刷新当前对话”。`, true);
  });
  void refreshActive();
}
async function prepareRollback(fileId = null) {
  if (!sessionId || busy || !records.current || records.current.id !== currentBatchId) return;
  busy = true; render();
  try {
    confirmation = await api('/rollback/prepare', { sessionId, batchId: records.current.id, fileId });
    el('confirm-message').textContent = confirmation.message;
    el('confirm-files').textContent = '恢复：\n' + confirmation.files.join('\n') + (confirmation.skipped?.length ? '\n\n保留不动：\n' + confirmation.skipped.join('\n') : '');
    el('confirm-files').style.whiteSpace = 'pre-wrap';
    el('confirm-dialog').showModal();
  } catch (error) { status(error.message, true); }
  finally { busy = false; render(); }
}
el('batch-select').onchange = () => {
  if (!sessionId) return;
  const selectedId = el('batch-select').value;
  applicationBatchId = selectedId === currentBatchId ? null : selectedId || null;
  void load();
};
el('rollback-round').onclick = () => prepareRollback();
el('cancel-rollback').onclick = () => { confirmation = null; el('confirm-dialog').close(); };
el('confirm-rollback').onclick = async () => {
  if (!confirmation || busy) return;
  busy = true; el('confirm-rollback').disabled = true;
  const token = confirmation.token;
  confirmation = null;
  try {
    const result = await api('/rollback/commit', { token });
    el('confirm-dialog').close();
    await load();
    status(result.ok ? `已恢复 ${result.restored.length} 个文件。${result.skipped?.length ? `保留不动：${result.skipped.join('、')}` : ''}` : `已恢复：${result.restored.join('、') || '无'}；停止原因：${result.error}；未恢复：${result.remaining.join('、')}`, !result.ok);
  } catch (error) { el('confirm-dialog').close(); status(`未完成恢复：${error.message}`, true); }
  finally { busy = false; el('confirm-rollback').disabled = false; render(); }
};
el('refresh').onclick = () => { void refreshActive(); };

hana.ready();
let themeGeneration = 0;
async function applyTheme(snapshot) {
  const mine = ++themeGeneration;
  try {
    if (!snapshot.cssUrl) throw new Error('宿主未提供主题样式地址');
    const response = await fetch(snapshot.cssUrl, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`主题样式请求失败 (${response.status})`);
    const css = await response.text();
    if (!/--bg-card\s*:/.test(css) || !/--text\s*:/.test(css)) throw new Error('宿主主题样式缺少背景或文字变量');
    // 较慢的旧主题请求不能覆盖用户后来选择的主题。
    if (mine !== themeGeneration) return;
    let style = document.querySelector('style[data-review-theme]');
    if (!style) { style = document.createElement('style'); style.dataset.reviewTheme = ''; }
    style.textContent = css;
    document.head.appendChild(style);
    const appearance = snapshot.appearance;
    if (appearance === 'light' || appearance === 'dark') document.documentElement.dataset.mode = appearance;
    else {
      // 只在新样式已经应用后读取亮度，避免从旧背景推断新主题。
      const color = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g);
      if (!color || color.length < 3) throw new Error('主题背景色无法识别');
      const luminance = Number(color[0]) * .2126 + Number(color[1]) * .7152 + Number(color[2]) * .0722;
      document.documentElement.dataset.mode = luminance < 128 ? 'dark' : 'light';
    }
    document.documentElement.dataset.theme = snapshot.theme ?? '';
    // 仅记录无凭据的颜色诊断，供宿主读取当前面板的实际主题状态。
    const context = hana.surface.getContext();
    if (context?.cardInstanceId && !context.embeddedSessionId) {
      const computed = getComputedStyle(document.body);
      await hana.state.set('theme', { theme: snapshot.theme ?? null, appearance: document.documentElement.dataset.mode, background: computed.backgroundColor, text: computed.color });
    }
  } catch (error) {
    if (mine === themeGeneration) status(`主题同步失败：${error.message}`, true);
  }
}
hana.theme.subscribe((snapshot) => { void applyTheme(snapshot); });
hana.surface.onContextChanged(contextChanged);
hana.storage.global.onChanged((keys) => {
  if (sessionId && keys.some((k) => k.startsWith(`stat:session:${sessionId}:`))) void load();
});
window.addEventListener('pagehide', () => { offActive?.(); }, { once: true });
