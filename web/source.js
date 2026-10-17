// Where the port data comes from: the agent running on this computer, or the demo station.
import { DemoSource } from './demo.js';

const STORE_KEY = 'port-station.agent';
export const DEFAULT_AGENT = 'http://127.0.0.1:7777';

// The page only ever talks to an agent on this machine, so a crafted link can't point it elsewhere.
export function cleanAgentUrl(raw) {
  let url;
  try { url = new URL(String(raw).trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
  return url.origin;
}

function store(cfg) {
  try {
    if (cfg) localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(STORE_KEY);
  } catch {}
}

function stored() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
}

export function agentSource(url, token, { sameOrigin = false } = {}) {
  async function call(path, body) {
    let res;
    try {
      res = await fetch(url + path, {
        method: body ? 'POST' : 'GET',
        headers: { 'X-Port-Station-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(body ? 15000 : 6000),
      });
    } catch {
      throw new Error(`Can't reach the helper at ${url}. Is it still running?`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `The helper answered ${res.status}.`), { status: res.status });
    return data;
  }
  return {
    mode: 'agent',
    url,
    token,
    sameOrigin,
    snapshot: () => call('/api/ports'),
    stop: (key) => call('/api/stop', { key }),
    start: (id) => call('/api/start', { id }),
    forget: (id) => call('/api/forget', { id }),
    open: (port, proto) => call('/api/open', { port, proto }),
  };
}

export async function tryAgent(rawUrl, token) {
  const url = cleanAgentUrl(rawUrl);
  if (!url) throw new Error('The helper address must be on this computer, like http://127.0.0.1:7777.');
  if (!token) throw new Error('Paste the token the helper printed.');
  const src = agentSource(url, token.trim());
  const first = await src.snapshot();
  store({ url, token: token.trim() });
  return { src, first };
}

export function forgetAgent() {
  store(null);
}

// Picks a source on load: the agent that served this page, a link from the agent, a saved
// connection, or the demo.
export async function initialSource() {
  const meta = document.querySelector('meta[name="port-station-token"]')?.content;
  if (meta && !meta.startsWith('__')) {
    const src = agentSource(location.origin, meta, { sameOrigin: true });
    return { src, first: await src.snapshot() };
  }

  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('token')) {
    const url = hash.get('agent') || DEFAULT_AGENT;
    const token = hash.get('token');
    history.replaceState(null, '', location.pathname + location.search);
    try { return await tryAgent(url, token); }
    catch (e) { return { src: new DemoSource(), first: null, error: e.message, pending: { url, token } }; }
  }

  const saved = stored();
  if (saved?.url && saved?.token) {
    try { return await tryAgent(saved.url, saved.token); }
    catch (e) { return { src: new DemoSource(), first: null, error: e.status === 401 ? 'The saved token no longer works. The helper may have made a new one.' : null, pending: saved }; }
  }
  return { src: new DemoSource(), first: null };
}
