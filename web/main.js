import { Station, statusColor, paintFor } from './station.js';
import { initialSource, tryAgent, forgetAgent, DEFAULT_AGENT } from './source.js';
import { DemoSource } from './demo.js';

const $ = (id) => document.getElementById(id);
const POLL_MS = 1500;

const state = {
  src: null,
  snap: null,
  items: [],
  selected: null,
  busyKeys: new Map(), // key -> 'stopping' | 'starting'
  filter: 'all',
  query: '',
  udp: false,
  failures: 0,
  timer: null,
};

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function duration(s) {
  if (s == null) return '—';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}

function memory(kb) {
  if (!kb) return '—';
  return kb > 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`;
}

function ago(ms) {
  return `${duration(Math.max(0, Math.round((Date.now() - ms) / 1000)))} ago`;
}

function statusOf(item) {
  if (item.kind === 'parked') return item.status === 'starting' ? 'starting' : item.status === 'failed' ? 'failed' : 'off';
  return item.connectionCount > 0 ? 'busy' : 'idle';
}

const STATUS_TEXT = { busy: 'In use', idle: 'Idle', off: 'Off', starting: 'Starting…', failed: "Didn't start" };

// ---------- data -> items ----------

function buildItems(snap) {
  const items = [];
  const live = new Set();
  for (const p of snap.ports) {
    live.add(p.key);
    items.push({ ...p });
  }
  for (const rec of snap.parked) {
    for (const pp of rec.ports) {
      const key = `${pp.proto}:${pp.port}`;
      if (live.has(key)) continue;
      live.add(key);
      items.push({
        key, port: pp.port, proto: pp.proto, kind: 'parked', parkedId: rec.id, parkedKind: rec.kind,
        status: rec.status, error: rec.error, log: rec.log, stoppedAt: rec.stoppedAt,
        process: { name: rec.name, user: rec.user, cmd: rec.cmd, pid: rec.pid },
        connectionCount: 0, connections: [], addresses: [],
      });
    }
  }
  return items.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}

const visibleInScene = (item) => state.udp || item.proto === 'tcp';

function matchesList(item) {
  if (!visibleInScene(item)) return false;
  const s = statusOf(item);
  if (state.filter === 'busy' && s !== 'busy') return false;
  if (state.filter === 'idle' && s !== 'idle') return false;
  if (state.filter === 'off' && !['off', 'starting', 'failed'].includes(s)) return false;
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  return [String(item.port), item.process?.name, item.process?.user, item.process?.cmd]
    .some((v) => v && String(v).toLowerCase().includes(q));
}

// ---------- rendering ----------

function renderStats() {
  const shown = state.items.filter(visibleInScene);
  const count = (fn) => shown.filter(fn).length;
  $('sBusy').textContent = count((i) => statusOf(i) === 'busy');
  $('sIdle').textContent = count((i) => statusOf(i) === 'idle');
  $('sOff').textContent = count((i) => i.kind === 'parked');
  $('sConns').textContent = shown.reduce((n, i) => n + (i.connectionCount || 0), 0);
}

function renderList() {
  const ul = $('portList');
  const rows = state.items.filter(matchesList);
  ul.replaceChildren(...rows.map((item) => {
    const s = statusOf(item);
    return el('li', {},
      el('button', {
        type: 'button',
        class: 'row',
        'aria-current': item.key === state.selected ? 'true' : null,
        onclick: () => select(item.key),
      },
      el('i', { class: 'dot', style: `--c:${hex(statusColor(item))}` }),
      el('b', { class: 'row-port' }, String(item.port)),
      el('span', { class: 'row-name' }, item.process?.name || 'hidden owner',
        item.proto === 'udp' ? el('em', {}, 'UDP') : null),
      el('span', { class: `row-state s-${s}` }, s === 'busy' ? String(item.connectionCount) : STATUS_TEXT[s])));
  }));
  if (!rows.length) ul.append(el('li', { class: 'empty' }, state.items.length ? 'Nothing matches.' : 'No open ports yet.'));
}

function renderHeader() {
  const snap = state.snap;
  const demo = state.src?.mode === 'demo';
  $('demoBanner').hidden = !demo || sessionStorageGet('ps.bannerClosed');
  document.body.classList.toggle('is-demo', demo);
  const offline = state.failures >= 2;
  $('connDot').dataset.state = demo ? 'demo' : offline ? 'offline' : 'live';
  $('connText').textContent = demo ? 'Demo station' : offline ? 'Helper offline' : `Live · ${snap?.host || ''}`;
  $('hostLine').textContent = demo
    ? 'Every open port on a computer, parked in its own garage'
    : `${snap?.host || 'This computer'} · ${snap?.user || ''}${snap?.elevated ? ' (admin)' : ''}${snap?.readOnly ? ' · read-only' : ''}`;
}

function sessionStorageGet(k) {
  try { return sessionStorage.getItem(k) === '1'; } catch { return false; }
}

function powerReason(item) {
  if (state.snap?.readOnly) return 'The helper was started with --read-only, so it only watches.';
  if (item.kind === 'agent') return 'This is the helper itself. Stop it with Ctrl+C in its terminal.';
  if (item.kind !== 'parked' && !item.process) return 'The owner is hidden from the helper. Start the helper with sudo (or as administrator) to see and control it.';
  return null;
}

function detail(label, value, mono = false) {
  return [el('dt', {}, label), el('dd', { class: mono ? 'mono' : null }, value)];
}

// long command lines (Electron apps) collapse to a few lines until tapped
function commandDetail(cmd) {
  const dd = el('dd', { class: 'mono clamp', title: 'Show the whole command', tabindex: '0' }, cmd);
  const toggle = () => dd.classList.toggle('open');
  dd.addEventListener('click', toggle);
  dd.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  return [el('dt', {}, 'Command'), dd];
}

function renderPanel() {
  const panel = $('panel');
  const item = state.items.find((i) => i.key === state.selected);
  if (!item) {
    panel.hidden = true;
    document.body.classList.remove('has-panel');
    return;
  }
  panel.hidden = false;
  document.body.classList.add('has-panel');

  const s = statusOf(item);
  const pending = state.busyKeys.get(item.key);
  const on = item.kind !== 'parked';
  const reason = powerReason(item);
  const proc = item.process;
  const beacon = item.kind === 'beacon' || item.parkedKind === 'beacon';
  const paint = beacon ? 'var(--beacon)' : `#${paintFor(proc?.name).getHexString()}`;

  let powerText;
  if (pending === 'stopping') powerText = 'Stopping…';
  else if (pending === 'starting' || s === 'starting') powerText = 'Starting…';
  else if (on) powerText = item.connectionCount ? `On · ${item.connectionCount} connected` : 'On · nobody connected';
  else if (s === 'failed') powerText = "Off · didn't come back";
  else powerText = `Off · stopped ${ago(item.stoppedAt)}`;

  const toggle = el('button', {
    type: 'button',
    role: 'switch',
    class: 'switch',
    'aria-checked': String(on),
    'aria-label': `Power for port ${item.port}`,
    disabled: !!reason || !!pending || s === 'starting',
    onclick: () => (on ? stopItem(item) : startItem(item)),
  }, el('span', { class: 'knob' }));

  const conns = item.connections || [];
  const connList = conns.length
    ? el('ul', { class: 'conns' }, conns.map((c) => el('li', {},
      el('b', {}, c.client?.name || (c.fromThisComputer ? 'a program here' : 'another device')),
      el('span', { class: 'mono' }, c.peer),
      c.fromThisComputer ? null : el('em', {}, 'network'))))
    : el('p', { class: 'muted' }, on ? 'Nobody is connected right now.' : 'It is off, so nobody can connect.');

  const exposure = item.exposure === 'network'
    ? 'This computer and other devices on your network'
    : item.exposure === 'local' ? 'Only this computer' : '—';

  panel.replaceChildren(...[
    el('header', { class: 'pp-head' },
      el('div', {},
        el('p', { class: 'pp-proto' }, `${item.proto.toUpperCase()} port`),
        el('h2', { class: 'pp-port' }, String(item.port))),
      el('span', { class: `chip-status s-${s}` }, item.kind === 'beacon' ? 'Beacon' : STATUS_TEXT[s]),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close details', onclick: () => select(null) }, icon('x'))),

    el('div', { class: 'pp-proc' },
      el('i', { class: 'swatch', style: `--c:${paint}` }),
      el('div', {},
        el('b', {}, proc?.name || 'Hidden owner'),
        el('span', {}, proc ? [proc.user ? `run by ${proc.user}` : null, proc.pid ? `pid ${proc.pid}` : null].filter(Boolean).join(' · ') || '—' : 'The helper is not allowed to see who owns this port'))),

    el('div', { class: `power${on ? ' is-on' : ''}` },
      el('div', {}, el('b', {}, 'Power'), el('span', {}, powerText)),
      toggle),
    reason ? el('p', { class: 'pp-note' }, reason) : null,
    item.error ? el('p', { class: 'pp-note error' }, item.error) : null,

    el('dl', { class: 'pp-grid' },
      on ? detail('Listening on', item.addresses.join(', '), true) : null,
      on ? detail('Reachable from', exposure) : null,
      on && proc?.uptime != null ? detail('Running for', duration(proc.uptime)) : null,
      on && proc?.rssKB ? detail('Memory', memory(proc.rssKB)) : null,
      on && proc?.workers > 1 ? detail('Processes', `${proc.workers} share this port`) : null,
      proc?.cmd ? commandDetail(proc.cmd) : null),

    el('h3', {}, 'Who is connected', conns.length ? el('span', {}, ` · ${item.connectionCount}`) : null),
    connList,
    item.connectionCount > conns.length ? el('p', { class: 'muted small' }, `Showing ${conns.length} of ${item.connectionCount}.`) : null,

    el('div', { class: 'pp-actions' },
      on && item.proto === 'tcp' && state.src.mode === 'agent'
        ? el('a', { class: 'btn ghost', href: `http://localhost:${item.port}`, target: '_blank', rel: 'noopener' }, 'Open in browser', icon('ext'))
        : null,
      !on && s !== 'starting' ? el('button', { type: 'button', class: 'btn ghost', onclick: () => forgetItem(item) }, 'Remove from station') : null),
  ].filter(Boolean));
}

function render() {
  renderHeader();
  renderStats();
  renderList();
  renderPanel();
}

// ---------- toasts ----------

let toastTimer = null;
function toast(message, { action, onAction, error = false } = {}) {
  const t = $('toast');
  t.replaceChildren(el('span', {}, message));
  if (action) t.append(el('button', { type: 'button', class: 'toast-btn', onclick: () => { t.hidden = true; onAction(); } }, action));
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, error ? 9000 : 6500);
}

// ---------- actions ----------

async function stopItem(item) {
  state.busyKeys.set(item.key, 'stopping');
  renderPanel();
  try {
    const rec = await state.src.stop(item.key);
    const other = rec.ports.length > 1 ? ` It also had ${rec.ports.length - 1} more port${rec.ports.length > 2 ? 's' : ''}.` : '';
    toast(`Stopped ${rec.name} on port ${item.port}.${other}`, { action: 'Undo', onAction: () => startItem({ ...item, parkedId: rec.id }) });
  } catch (e) {
    toast(e.message, { error: true });
  } finally {
    state.busyKeys.delete(item.key);
    await refresh();
  }
}

async function startItem(item) {
  state.busyKeys.set(item.key, 'starting');
  renderPanel();
  try {
    await state.src.start(item.parkedId);
    toast(`Starting ${item.process?.name || 'it'} on port ${item.port}…`);
  } catch (e) {
    toast(e.message, { error: true });
  } finally {
    state.busyKeys.delete(item.key);
    await refresh();
  }
}

async function forgetItem(item) {
  try {
    await state.src.forget(item.parkedId);
    select(null);
  } catch (e) {
    toast(e.message, { error: true });
  }
  await refresh();
}

function select(key) {
  state.selected = key;
  station.selectedKey = key;
  if (key) station.select(key);
  if (key && window.innerWidth < 760) setList(false);
  renderList();
  renderPanel();
}

// ---------- polling ----------

function apply(snap) {
  state.snap = snap;
  state.items = buildItems(snap);
  station.setHost(snap.host || 'localhost');
  station.update(state.items.filter(visibleInScene));
  if (state.selected && !state.items.some((i) => i.key === state.selected)) state.selected = null;
  render();
}

async function refresh() {
  try {
    const snap = await state.src.snapshot();
    if (state.failures >= 2) toast('Back in touch with the helper.');
    state.failures = 0;
    apply(snap);
  } catch (e) {
    state.failures++;
    if (state.failures === 2) toast(e.message, { error: true });
    renderHeader();
  }
}

function startPolling() {
  clearInterval(state.timer);
  state.timer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
}

function useSource(src, first) {
  state.src = src;
  state.failures = 0;
  state.selected = null;
  if (first) apply(first);
  else refresh();
  startPolling();
  render();
}

// ---------- connect dialog ----------

const COMMANDS = {
  unix: (o) => `curl -fsSLO ${o}/port-station.mjs && node port-station.mjs`,
  win: (o) => `iwr ${o}/port-station.mjs -OutFile port-station.mjs; node port-station.mjs`,
};
let cmdOs = /Win/.test(navigator.platform) ? 'win' : 'unix';

function renderCmd() {
  const origin = location.origin.startsWith('http') && !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(location.origin)
    ? location.origin
    : 'https://port-station.vercel.app';
  $('cmd').textContent = COMMANDS[cmdOs](origin);
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.os === cmdOs)));
}

function openConnect(prefill) {
  $('connectError').textContent = '';
  $('disconnectBtn').hidden = state.src?.mode !== 'agent' || state.src.sameOrigin;
  if (prefill?.url) $('agentUrl').value = prefill.url;
  if (prefill?.token) $('agentToken').value = prefill.token;
  if (state.src?.mode === 'agent') {
    $('agentUrl').value = state.src.url;
    $('agentToken').value = state.src.token;
  }
  renderCmd();
  $('connectDlg').showModal();
}

$('connectForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'connect') return;
  e.preventDefault();
  const btn = $('connectSubmit');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  $('connectError').textContent = '';
  try {
    const { src, first } = await tryAgent($('agentUrl').value || DEFAULT_AGENT, $('agentToken').value);
    useSource(src, first);
    $('connectDlg').close();
    toast(`Connected to ${first.host}.`);
  } catch (err) {
    $('connectError').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
});

$('disconnectBtn').addEventListener('click', () => {
  forgetAgent();
  useSource(new DemoSource());
  $('connectDlg').close();
});

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { cmdOs = t.dataset.os; renderCmd(); }));
$('copyCmd').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('cmd').textContent);
    $('copyCmd').textContent = 'Copied';
    setTimeout(() => { $('copyCmd').textContent = 'Copy'; }, 1500);
  } catch {}
});
$('connBtn').addEventListener('click', () => {
  if (state.src?.sameOrigin) return toast(`Connected to ${state.snap?.host || 'this computer'} directly.`);
  openConnect();
});
document.querySelectorAll('[data-open-connect]').forEach((b) => b.addEventListener('click', () => openConnect()));

// ---------- open-a-port dialog ----------

$('openBtn').addEventListener('click', () => {
  $('openError').textContent = '';
  $('openDlg').showModal();
  $('openPort').focus();
});
$('openForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'open') return;
  e.preventDefault();
  const port = Number($('openPort').value);
  const proto = $('openProto').value;
  try {
    const res = await state.src.open(port, proto);
    $('openDlg').close();
    if (proto === 'udp') state.udp = $('showUdp').checked = true;
    await refresh();
    select(res.key);
    toast(`Beacon parked on ${proto.toUpperCase()} ${port}.`);
  } catch (err) {
    $('openError').textContent = err.message;
  }
});

// ---------- list, filters, dock ----------

function setList(open) {
  document.body.classList.toggle('list-closed', !open);
  $('listBtn').setAttribute('aria-pressed', String(open));
}

$('listBtn').addEventListener('click', () => setList(document.body.classList.contains('list-closed')));
$('listClose').addEventListener('click', () => setList(false));
$('search').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
document.querySelectorAll('[data-filter]').forEach((chip) => chip.addEventListener('click', () => {
  state.filter = chip.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
  renderList();
}));
$('showUdp').addEventListener('change', (e) => {
  state.udp = e.target.checked;
  if (state.snap) apply(state.snap);
});
$('viewBtn').addEventListener('click', () => { select(null); station.resetView(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.selected && !document.querySelector('dialog[open]')) select(null);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

// ---------- theme ----------

const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function chosenTheme() {
  try { return localStorage.getItem('ps.theme'); } catch { return null; }
}

function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  document.querySelector('meta[name="theme-color"]').content = name === 'dark' ? '#141218' : '#f5f0e6';
  $('themeBtn').setAttribute('aria-label', name === 'dark' ? 'Switch to light' : 'Switch to dark');
  station.setTheme(name);
  if (state.snap) render();
}

$('themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('ps.theme', next); } catch {}
  applyTheme(next);
});
darkQuery.addEventListener('change', (e) => { if (!chosenTheme()) applyTheme(e.matches ? 'dark' : 'light'); });

// ---------- boot ----------

const station = new Station($('scene'), $('labels'), {
  onSelect: (key) => select(key),
  theme: document.documentElement.dataset.theme,
});
applyTheme(document.documentElement.dataset.theme);
if (window.innerWidth < 760) setList(false);
window.portStation = station; // handy from the dev console

(async () => {
  const res = await initialSource().catch((e) => ({ src: new DemoSource(), first: null, error: e.message }));
  useSource(res.src, res.first);
  $('loader').classList.add('done');
  if (res.error) {
    openConnect(res.pending);
    $('connectError').textContent = res.error;
  }
})();

// a fresh link from the helper pasted into an already-open tab
window.addEventListener('hashchange', async () => {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (!hash.get('token')) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const { src, first } = await tryAgent(hash.get('agent') || DEFAULT_AGENT, hash.get('token'));
    useSource(src, first);
    toast(`Connected to ${first.host}.`);
  } catch (err) {
    openConnect({ url: hash.get('agent'), token: hash.get('token') });
    $('connectError').textContent = err.message;
  }
});

$('demoBanner').addEventListener('click', (e) => {
  if (e.target.closest('[data-close-banner]')) {
    try { sessionStorage.setItem('ps.bannerClosed', '1'); } catch {}
    $('demoBanner').hidden = true;
  }
});
