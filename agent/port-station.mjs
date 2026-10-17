#!/usr/bin/env node
// Port Station agent. Reads which ports are open on this computer, who owns them and who is
// connected, and stops or restarts them when the Port Station page asks. One file, no dependencies.
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VERSION = '1.0.0';
const SITE = process.env.PORT_STATION_SITE || 'https://port-station.vercel.app';
const DATA_DIR = path.join(os.homedir(), '.port-station');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const PARKED_FILE = path.join(DATA_DIR, 'parked.json');
const TOKEN_FILE = path.join(DATA_DIR, 'token');
const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const START_TIMEOUT_MS = 25_000;
const MAX_LISTED_CONNECTIONS = 40;

// ---------- parsing ----------

export function splitAddr(text) {
  if (!text) return null;
  const i = text.lastIndexOf(':');
  if (i < 0) return null;
  const host = text.slice(0, i).replace(/^\[|\]$/g, '').replace(/%.*$/, '') || '*';
  const portText = text.slice(i + 1);
  const port = portText === '*' ? 0 : Number(portText);
  if (!Number.isInteger(port)) return null;
  return { host, port };
}

function normState(s) {
  const v = String(s).toUpperCase();
  if (v === 'LISTEN' || v === 'LISTENING' || v === 'UNCONN') return 'LISTEN';
  if (v.startsWith('ESTAB')) return 'ESTAB';
  return v;
}

// `ss -H -tanp` / `ss -H -uanp` (Linux)
export function parseSs(text, proto) {
  const out = [];
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const [state, , , local, peer, ...rest] = cols;
    const l = splitAddr(local);
    if (!l) continue;
    const owners = [...rest.join(' ').matchAll(/\("((?:[^"\\]|\\.)*)",pid=(\d+)/g)]
      .map((m) => ({ pid: Number(m[2]), name: m[1] }));
    out.push({ proto, state: normState(state), local: l, peer: splitAddr(peer) || { host: '*', port: 0 }, owners });
  }
  return out;
}

// `lsof -nP -iTCP -iUDP -FpcLfPnT` (macOS)
export function parseLsof(text) {
  const out = [];
  let proc = null;
  let fd = null;
  const flush = () => {
    if (!fd || !fd.n || !proc) return;
    const [a, b] = fd.n.split('->');
    const local = splitAddr(a);
    if (!local) return;
    const proto = (fd.P || '').toLowerCase();
    if (proto !== 'tcp' && proto !== 'udp') return;
    const state = proto === 'udp' ? (b ? 'ESTAB' : 'LISTEN') : normState(fd.T || '');
    out.push({ proto, state, local, peer: splitAddr(b) || { host: '*', port: 0 }, owners: [{ pid: proc.pid, name: proc.c, user: proc.L }] });
  };
  for (const line of text.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') { flush(); fd = null; proc = { pid: Number(val) }; }
    else if (tag === 'f') { flush(); fd = {}; }
    else if (tag === 'T') { if (fd && val.startsWith('ST=')) fd.T = val.slice(3); }
    else if (fd && (tag === 'P' || tag === 'n')) fd[tag] = val;
    else if (proc && (tag === 'c' || tag === 'L')) proc[tag] = val;
  }
  flush();
  return out;
}

// `netstat -ano` (Windows)
export function parseNetstat(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    const proto = (cols[0] || '').toLowerCase();
    if (proto === 'tcp' && cols.length >= 5) {
      const [, local, peer, state, pid] = cols;
      const l = splitAddr(local);
      if (l) out.push({ proto, state: normState(state), local: l, peer: splitAddr(peer) || { host: '*', port: 0 }, owners: [{ pid: Number(pid) }] });
    } else if (proto === 'udp' && cols.length >= 4) {
      const [, local, , pid] = cols;
      const l = splitAddr(local);
      if (l) out.push({ proto, state: 'LISTEN', local: l, peer: { host: '*', port: 0 }, owners: [{ pid: Number(pid) }] });
    }
  }
  return out;
}

// `ps -o pid=,etime=,rss=,%cpu=,args=`
export function parsePs(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
    if (m) map.set(Number(m[1]), { uptime: parseEtime(m[2]), rssKB: Number(m[3]), cpu: Number(m[4]), cmd: m[5] });
  }
  return map;
}

export function parseEtime(s) {
  const [days, rest] = s.includes('-') ? s.split('-') : ['0', s];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function parseCsvLine(line) {
  return [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
}

// ---------- process info ----------

function run(cmd, args, { allowFail = false, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 64 << 20, windowsHide: true }, (err, stdout) => {
      if (err && !(allowFail && typeof err.code === 'number')) return reject(err);
      resolve(String(stdout));
    });
  });
}

let passwd = null;
function userName(uid) {
  if (!passwd) {
    passwd = new Map();
    try {
      for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
        const [name, , id] = line.split(':');
        if (name && id) passwd.set(Number(id), name);
      }
    } catch {}
  }
  return passwd.get(uid) ?? `uid ${uid}`;
}

function linuxProc(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const field = (k) => status.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1] ?? '';
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const cmd = argv.join(' ');
    // Name is the main thread's name, which runtimes like Node rename ("MainThread"); argv[0] is what people recognise.
    const exe = argv[0] ? path.basename(argv[0].split(/\s/)[0]).replace(/:$/, '') : '';
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const startTicks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    const sysUptime = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    return {
      name: exe || field('Name'),
      user: userName(Number(field('Uid').split(/\s+/)[0])),
      cmd: cmd || `[${field('Name')}]`,
      uptime: Math.max(0, Math.round(sysUptime - startTicks / 100)),
      rssKB: parseInt(field('VmRSS'), 10) || 0,
    };
  } catch {
    return null;
  }
}

async function procInfo(pids) {
  const map = new Map();
  if (!pids.length) return map;
  if (process.platform === 'linux') {
    for (const pid of pids) { const p = linuxProc(pid); if (p) map.set(pid, p); }
  } else if (process.platform === 'win32') {
    const text = await run('tasklist', ['/fo', 'csv', '/nh'], { allowFail: true }).catch(() => '');
    const wanted = new Set(pids);
    for (const line of text.split('\n')) {
      const [name, pid, , , mem] = parseCsvLine(line);
      if (wanted.has(Number(pid))) map.set(Number(pid), { name: name.replace(/\.exe$/i, ''), cmd: name, rssKB: parseInt((mem || '').replace(/\D/g, ''), 10) || 0 });
    }
  } else {
    const text = await run('ps', ['-o', 'pid=,etime=,rss=,%cpu=,args=', '-p', pids.join(',')], { allowFail: true }).catch(() => '');
    for (const [pid, info] of parsePs(text)) map.set(pid, info);
  }
  return map;
}

async function readSockets() {
  if (process.platform === 'linux') {
    const [tcp, udp] = await Promise.all([run('ss', ['-H', '-tanp']), run('ss', ['-H', '-uanp'])]);
    return [...parseSs(tcp, 'tcp'), ...parseSs(udp, 'udp')];
  }
  if (process.platform === 'win32') return parseNetstat(await run('netstat', ['-ano']));
  return parseLsof(await run('lsof', ['-nP', '-iTCP', '-iUDP', '-FpcLfPnT'], { allowFail: true }));
}

// ---------- building the snapshot ----------

const isLoopback = (h) => h === 'localhost' || h === '::1' || h.startsWith('127.');
const plainHost = (h) => h.replace(/^::ffff:/i, '');
const endpoint = (a) => (a.host.includes(':') ? `[${a.host}]:${a.port}` : `${a.host}:${a.port}`);

export function buildPorts(sockets, procs, selfPid = process.pid) {
  const ports = new Map();
  for (const s of sockets) {
    if (s.state !== 'LISTEN' || !s.local.port) continue;
    const key = `${s.proto}:${s.local.port}`;
    let e = ports.get(key);
    if (!e) ports.set(key, (e = { key, port: s.local.port, proto: s.proto, addresses: [], owners: new Map(), connections: [] }));
    const host = s.local.host === '*' ? '0.0.0.0' : plainHost(s.local.host);
    if (!e.addresses.includes(host)) e.addresses.push(host);
    for (const o of s.owners) if (o.pid && !e.owners.has(o.pid)) e.owners.set(o.pid, o);
  }

  const established = sockets.filter((s) => s.proto === 'tcp' && s.state === 'ESTAB');
  const ownerAt = new Map(established.map((s) => [`${plainHost(s.local.host)}:${s.local.port}`, s.owners[0]]));
  for (const s of established) {
    const e = ports.get(`tcp:${s.local.port}`);
    if (!e) continue;
    const peerHost = plainHost(s.peer.host);
    const client = ownerAt.get(`${peerHost}:${s.peer.port}`);
    const info = client && procs.get(client.pid);
    e.connections.push({
      peer: endpoint({ host: peerHost, port: s.peer.port }),
      fromThisComputer: isLoopback(peerHost) || !!client,
      client: client ? { pid: client.pid, name: info?.name || client.name || null } : null,
    });
  }

  return [...ports.values()]
    .map((e) => {
      const [first] = e.owners.values();
      const info = first ? procs.get(first.pid) : null;
      const proc = first ? {
        pid: first.pid,
        name: info?.name || first.name || `pid ${first.pid}`,
        user: info?.user || first.user || null,
        cmd: info?.cmd || null,
        uptime: info?.uptime ?? null,
        rssKB: info?.rssKB ?? null,
        cpu: info?.cpu ?? null,
        workers: e.owners.size,
      } : null;
      return {
        key: e.key,
        port: e.port,
        proto: e.proto,
        addresses: e.addresses,
        exposure: e.addresses.every(isLoopback) ? 'local' : 'network',
        process: proc,
        kind: proc?.pid === selfPid ? 'agent' : 'process',
        connectionCount: e.connections.length,
        connections: e.connections.slice(0, MAX_LISTED_CONNECTIONS),
      };
    })
    .sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}

// ---------- state: parked (stopped) ports and beacons ----------

const parked = new Map();
const beacons = new Map();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function loadParked() {
  try {
    for (const rec of JSON.parse(fs.readFileSync(PARKED_FILE, 'utf8'))) {
      if (rec.status === 'starting') rec.status = 'stopped';
      parked.set(rec.id, rec);
    }
  } catch {}
}

function saveParked() {
  ensureDir(DATA_DIR);
  // Holds the stopped programs' environment, so only this user may read it.
  fs.writeFileSync(PARKED_FILE, JSON.stringify([...parked.values()].filter((r) => r.launch.kind !== 'beacon'), null, 2), { mode: 0o600 });
}

function publicParked(rec) {
  const { launch, ...rest } = rec;
  return { ...rest, kind: launch.kind === 'beacon' ? 'beacon' : 'process' };
}

let latest = null;
let scanning = null;

async function scan() {
  const sockets = await readSockets();
  const pids = [...new Set(sockets.flatMap((s) => s.owners.map((o) => o.pid)).filter(Boolean))];
  const procs = await procInfo(pids);
  const ports = buildPorts(sockets, procs);
  for (const p of ports) {
    if (beacons.has(p.key)) {
      p.kind = 'beacon';
      p.process.name = 'beacon';
      p.process.cmd = `Port Station beacon on ${p.proto.toUpperCase()} ${p.port}`;
    }
  }

  const live = new Set(ports.map((p) => p.key));
  let changed = false;
  for (const rec of parked.values()) {
    if (rec.ports.some((p) => live.has(`${p.proto}:${p.port}`))) {
      parked.delete(rec.id);
      changed = true;
    } else if (rec.status === 'starting' && Date.now() - rec.startedAt > START_TIMEOUT_MS) {
      rec.status = 'failed';
      rec.error = `It started, but nothing opened port ${rec.ports[0].port} within ${START_TIMEOUT_MS / 1000} s. See ${rec.log}`;
      changed = true;
    }
  }
  if (changed) saveParked();

  return {
    app: 'port-station',
    version: VERSION,
    host: os.hostname(),
    platform: process.platform,
    user: os.userInfo().username,
    elevated: typeof process.getuid === 'function' ? process.getuid() === 0 : null,
    readOnly: options.readOnly,
    time: Date.now(),
    ports,
    parked: [...parked.values()].map(publicParked),
  };
}

async function snapshot(maxAge = 900) {
  if (latest && Date.now() - latest.time < maxAge) return latest;
  if (!scanning) scanning = scan().then((s) => (latest = s)).finally(() => (scanning = null));
  return scanning;
}

class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

async function captureLaunch(pid, fallbackCmd) {
  const launch = { kind: 'process', cwd: os.homedir() };
  if (process.platform === 'linux') {
    try { launch.argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch {}
    try { launch.cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch {}
    try {
      launch.env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
        .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
    } catch {}
  } else if (process.platform === 'darwin') {
    launch.shell = (await run('ps', ['-o', 'args=', '-p', String(pid)], { allowFail: true }).catch(() => '')).trim();
    const cwd = (await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { allowFail: true }).catch(() => ''))
      .split('\n').find((l) => l.startsWith('n'));
    if (cwd) launch.cwd = cwd.slice(1);
  } else if (process.platform === 'win32') {
    launch.shell = (await run('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { allowFail: true }).catch(() => '')).trim();
  }
  if (!launch.argv?.length && !launch.shell) launch.shell = fallbackCmd;
  return launch;
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

async function waitGone(pid, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
}

async function killPid(pid, name, user) {
  if (process.platform === 'win32') {
    try { await run('taskkill', ['/PID', String(pid), '/T', '/F']); }
    catch { throw new UserError(`Windows wouldn't stop ${name}. Run the agent from an administrator terminal to control it.`, 403); }
    return;
  }
  try { process.kill(pid, 'SIGTERM'); }
  catch (e) {
    if (e.code === 'ESRCH') return;
    if (e.code === 'EPERM') throw new UserError(`${name} belongs to ${user || 'another user'}, so the agent isn't allowed to stop it. Run the agent with sudo to control it.`, 403);
    throw e;
  }
  if (await waitGone(pid, 3000)) return;
  try { process.kill(pid, 'SIGKILL'); } catch {}
  if (!(await waitGone(pid, 1500))) throw new UserError(`${name} (pid ${pid}) ignored the stop signal.`, 500);
}

async function stopPort(key) {
  const snap = await snapshot(0);
  const entry = snap.ports.find((p) => p.key === key);
  if (!entry) throw new UserError(`Nothing is open on ${key.replace(':', ' ')} any more.`, 404);
  const proto = entry.proto.toUpperCase();

  if (entry.kind === 'beacon') {
    const b = beacons.get(key);
    beacons.delete(key);
    await new Promise((r) => b.close(() => r()));
    const rec = { id: crypto.randomUUID(), name: 'beacon', user: snap.user, pid: process.pid, cmd: `Port Station beacon on ${proto} ${entry.port}`,
      ports: [{ port: entry.port, proto: entry.proto }], stoppedAt: Date.now(), status: 'stopped', error: null, launch: { kind: 'beacon' } };
    parked.set(rec.id, rec);
    latest = null;
    return publicParked(rec);
  }
  if (entry.kind === 'agent') throw new UserError('That port is the agent itself. Stop it with Ctrl+C in its terminal.', 400);
  if (!entry.process) throw new UserError(`The program on ${proto} ${entry.port} is hidden from the agent. Run the agent with sudo (or as administrator) to see and control it.`, 403);

  const { pid, name, user, cmd } = entry.process;
  if (pid <= 1) throw new UserError(`${name} is the system's first process and can't be stopped.`, 400);
  const launch = await captureLaunch(pid, cmd);
  await killPid(pid, name, user);

  const rec = {
    id: crypto.randomUUID(), name, user, pid, cmd: launch.argv?.join(' ') || launch.shell || cmd,
    ports: snap.ports.filter((p) => p.process?.pid === pid).map((p) => ({ port: p.port, proto: p.proto })),
    stoppedAt: Date.now(), status: 'stopped', error: null, launch,
  };
  parked.set(rec.id, rec);
  saveParked();
  latest = null;
  return publicParked(rec);
}

async function startParked(id) {
  const rec = parked.get(id);
  if (!rec) throw new UserError('That stopped port is no longer on the list.', 404);
  if (rec.status === 'starting') return publicParked(rec);

  if (rec.launch.kind === 'beacon') {
    parked.delete(id);
    await openBeacon(rec.ports[0].port, rec.ports[0].proto);
    return { ...publicParked(rec), status: 'started' };
  }

  ensureDir(LOG_DIR);
  rec.log = path.join(LOG_DIR, `${rec.name.replace(/[^\w.-]+/g, '_')}-${rec.ports[0].port}.log`);
  const out = fs.openSync(rec.log, 'a');
  fs.writeSync(out, `\n--- started by Port Station ${new Date().toISOString()} ---\n`);
  const { argv, shell, env } = rec.launch;
  const cwd = fs.existsSync(rec.launch.cwd) ? rec.launch.cwd : os.homedir();
  const opts = { cwd, env: env ? { ...env } : process.env, detached: true, stdio: ['ignore', out, out], windowsHide: true };
  const child = argv?.length ? spawn(argv[0], argv.slice(1), opts) : spawn(shell, { ...opts, shell: true });
  fs.closeSync(out);

  rec.status = 'starting';
  rec.error = null;
  rec.startedAt = Date.now();
  child.on('error', (e) => { rec.status = 'failed'; rec.error = `Couldn't start it: ${e.message}`; latest = null; });
  child.on('exit', (code, signal) => {
    if (rec.status !== 'starting' || !parked.has(rec.id)) return;
    if (code === 0) return; // launchers that fork and exit are fine; the scan decides when the port is back
    rec.status = 'failed';
    rec.error = `It quit right away (${signal || `exit code ${code}`}). See ${rec.log}`;
    latest = null;
  });
  child.unref();
  latest = null;
  return publicParked(rec);
}

function forgetParked(id) {
  if (!parked.delete(id)) throw new UserError('That stopped port is no longer on the list.', 404);
  saveParked();
  latest = null;
  return { ok: true };
}

async function openBeacon(port, proto = 'tcp') {
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError('Pick a port number from 1 to 65535.');
  if (proto !== 'tcp' && proto !== 'udp') throw new UserError('Protocol must be TCP or UDP.');
  const key = `${proto}:${port}`;
  const explain = (e) => {
    if (e.code === 'EADDRINUSE') return new UserError(`Port ${port} is already taken.`, 409);
    if (e.code === 'EACCES') return new UserError(`Ports below 1024 need sudo or administrator rights.`, 403);
    return e;
  };
  let handle;
  if (proto === 'tcp') {
    handle = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nPort Station beacon on port ${port}\n`);
    });
    await new Promise((resolve, reject) => {
      handle.once('error', (e) => reject(explain(e)));
      handle.listen(port, '127.0.0.1', resolve);
    });
  } else {
    handle = dgram.createSocket('udp4');
    await new Promise((resolve, reject) => {
      handle.once('error', (e) => reject(explain(e)));
      handle.bind(port, '127.0.0.1', resolve);
    });
  }
  beacons.set(key, handle);
  latest = null;
  return { ok: true, key };
}

// ---------- HTTP server ----------

const options = { port: 7777, readOnly: false, origins: [], newToken: false };
let token = '';

function parseArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') options.port = Number(argv[++i]);
    else if (a === '--read-only') options.readOnly = true;
    else if (a === '--origin') options.origins.push(argv[++i].replace(/\/$/, ''));
    else if (a === '--new-token') options.newToken = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Port Station agent ${VERSION}

  node port-station.mjs [options]

  --port <n>       Port for the agent itself (default 7777)
  --read-only      Show ports, but never stop or start anything
  --origin <url>   Only accept pages from this site (repeatable); default accepts any site that has the token
  --new-token      Make a new token, so old links stop working`);
      process.exit(0);
    }
  }
  if (process.env.PORT_STATION_PORT) options.port = Number(process.env.PORT_STATION_PORT);
}

function loadToken() {
  ensureDir(DATA_DIR);
  if (!options.newToken) {
    try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); if (t.length >= 20) return t; } catch {}
  }
  const t = crypto.randomBytes(18).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}

function tokenOk(given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Only answer requests addressed to this machine by name, which stops DNS-rebinding pages.
function hostOk(host) {
  return [`127.0.0.1:${options.port}`, `localhost:${options.port}`, `[::1]:${options.port}`].includes(host);
}

function corsHeaders(origin) {
  if (!origin) return {};
  if (options.origins.length && !options.origins.includes(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) reject(new UserError('Request too large.', 413)); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new UserError('Bad JSON.')); } });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.ico': 'image/x-icon' };

const PAGE_HEADERS = { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };

function serveStatic(req, res, pathname) {
  const hasWeb = fs.existsSync(path.join(WEB_DIR, 'index.html'));
  if (!hasWeb) {
    const link = `${SITE}/#agent=http://127.0.0.1:${options.port}&token=${token}`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...PAGE_HEADERS });
    return res.end(`<!doctype html><meta charset="utf-8"><title>Port Station agent</title><body style="font:16px system-ui;background:#05060f;color:#e8ecff;padding:40px">
<h1>Port Station agent is running</h1><p><a style="color:#38e1ff" href="${link}">Open your station</a></p></body>`);
  }
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return send(res, 404, { error: 'Not found' });
  }
  const ext = path.extname(file);
  if (rel === 'index.html') {
    const html = fs.readFileSync(file, 'utf8').replace('__PORT_STATION_TOKEN__', token);
    res.writeHead(200, { 'Content-Type': MIME['.html'], ...PAGE_HEADERS });
    return res.end(html);
  }
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  if (!hostOk(req.headers.host)) return send(res, 421, { error: 'Use http://127.0.0.1 to reach the agent.' });
  const url = new URL(req.url, 'http://127.0.0.1');
  const isApi = url.pathname.startsWith('/api/');
  const cors = isApi ? corsHeaders(req.headers.origin) : {};

  if (req.method === 'OPTIONS' && isApi) {
    res.writeHead(204, {
      ...cors,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Port-Station-Token',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }
  if (!isApi) return serveStatic(req, res, url.pathname);
  if (url.pathname === '/api/hello') return send(res, 200, { app: 'port-station', version: VERSION }, cors);
  if (!tokenOk(req.headers['x-port-station-token'])) {
    return send(res, 401, { error: 'The token is missing or wrong. Use the link the agent printed in its terminal.' }, cors);
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/ports') return send(res, 200, await snapshot(), cors);
    if (req.method !== 'POST') return send(res, 404, { error: 'Not found' }, cors);
    const body = await readBody(req);
    if (options.readOnly) throw new UserError('The agent was started with --read-only, so it only watches.', 403);
    let result;
    if (url.pathname === '/api/stop') result = await stopPort(String(body.key));
    else if (url.pathname === '/api/start') result = await startParked(String(body.id));
    else if (url.pathname === '/api/forget') result = forgetParked(String(body.id));
    else if (url.pathname === '/api/open') result = await openBeacon(body.port, body.proto);
    else return send(res, 404, { error: 'Not found' }, cors);
    return send(res, 200, result, cors);
  } catch (e) {
    if (e instanceof UserError) return send(res, e.status, { error: e.message }, cors);
    console.error(e);
    return send(res, 500, { error: e.message || 'Something went wrong in the agent.' }, cors);
  }
}

function main() {
  parseArgs(process.argv.slice(2));
  token = loadToken();
  loadParked();
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, { error: 'Agent error' }); });
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${options.port} is taken. Is the agent already running? Try --port 7778.`);
    else console.error(e.message);
    process.exit(1);
  });
  server.listen(options.port, '127.0.0.1', () => {
    const local = `http://127.0.0.1:${options.port}`;
    const hasWeb = fs.existsSync(path.join(WEB_DIR, 'index.html'));
    console.log(`\n  Port Station agent ${VERSION} is running on ${os.hostname()}\n`);
    if (hasWeb) console.log(`  Open on this computer:  ${local}`);
    console.log(`  Open the public site:   ${SITE}/#agent=${local}&token=${token}`);
    console.log(`  Token (if it asks):     ${token}\n`);
    if (options.readOnly) console.log('  Read-only: ports can be watched but not switched.\n');
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      console.log('  Ports owned by other users (like root) show without a name. Run with sudo to see and control them.\n');
    }
    console.log('  Press Ctrl+C to stop the agent.\n');
  });
  const quit = () => { for (const b of beacons.values()) b.close(); process.exit(0); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main();
