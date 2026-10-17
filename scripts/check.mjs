// Runs the parsers on sample output, then starts a real agent with a throwaway home folder and
// drives it the way the page does: list, stop a real server, start it again, beacons, security.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSs, parseLsof, parseNetstat, parsePs, parseEtime, splitAddr, buildPorts } from '../agent/port-station.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentFile = path.join(root, 'agent', 'port-station.mjs');
let passed = 0;
const ok = (name) => { passed++; console.log(`  ok  ${name}`); };

// ---------- parsers ----------

assert.deepEqual(splitAddr('[::ffff:127.0.0.1]:8080'), { host: '::ffff:127.0.0.1', port: 8080 });
assert.deepEqual(splitAddr('0.0.0.0%lo:53'), { host: '0.0.0.0', port: 53 });
assert.deepEqual(splitAddr('*:*'), { host: '*', port: 0 });
ok('address parsing');

const ss = parseSs(`LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=42,fd=20))
LISTEN 0 4096 [::]:3000 [::]:* users:(("node",pid=42,fd=21))
ESTAB 0 0 127.0.0.1:3000 127.0.0.1:51000 users:(("node",pid=42,fd=30))
ESTAB 0 0 127.0.0.1:51000 127.0.0.1:3000 users:(("chrome",pid=99,fd=8))
LISTEN 0 4096 127.0.0.1:631 0.0.0.0:*`, 'tcp');
const ports = buildPorts(ss, new Map(), -1);
const p3000 = ports.find((p) => p.port === 3000);
assert.equal(ports.length, 2);
assert.deepEqual(p3000.addresses, ['127.0.0.1', '::']);
assert.equal(p3000.exposure, 'network');
assert.equal(p3000.connectionCount, 1);
assert.equal(p3000.connections[0].client.name, 'chrome');
assert.equal(ports.find((p) => p.port === 631).process, null);
ok('ss: merges v4/v6, counts connections, finds the client program, hides unknown owners');

const lsof = parseLsof(['p501', 'cnode', 'Lhosea', 'f22', 'PTCP', 'n127.0.0.1:5173', 'TST=LISTEN', 'f23', 'PTCP',
  'n127.0.0.1:5173->127.0.0.1:60000', 'TST=ESTABLISHED', 'p77', 'cmDNSResponder', 'L_mdnsresponder', 'f5', 'PUDP', 'n*:5353'].join('\n'));
assert.equal(lsof.length, 3);
assert.deepEqual([lsof[0].state, lsof[1].state, lsof[2].state], ['LISTEN', 'ESTAB', 'LISTEN']);
assert.equal(lsof[0].owners[0].user, 'hosea');
ok('lsof field output (macOS)');

const ns = parseNetstat(`  TCP    0.0.0.0:135      0.0.0.0:0       LISTENING       1188
  TCP    [::]:445         [::]:0          LISTENING       4
  UDP    0.0.0.0:5353     *:*                             2210`);
assert.deepEqual(ns.map((s) => [s.proto, s.local.port, s.state, s.owners[0].pid]), [['tcp', 135, 'LISTEN', 1188], ['tcp', 445, 'LISTEN', 4], ['udp', 5353, 'LISTEN', 2210]]);
ok('netstat (Windows)');

assert.equal(parseEtime('1-02:03:04'), 93784);
assert.equal(parseEtime('05:06'), 306);
assert.equal(parsePs('  42  01:00  2048  1.5 node server.js --port 3000').get(42).cmd, 'node server.js --port 3000');
ok('ps parsing');

// ---------- live agent ----------

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'port-station-check-'));
const agentPort = await freePort();
const agent = spawn(process.execPath, [agentFile, '--port', String(agentPort)], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: 'pipe' });
let agentOut = '';
agent.stdout.on('data', (d) => { agentOut += d; });
agent.stderr.on('data', (d) => { agentOut += d; });

const base = `http://127.0.0.1:${agentPort}`;
let token = '';
let server = null;
const api = async (p, body, headers = {}) => {
  const res = await fetch(base + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Port-Station-Token': token, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
};
const waitFor = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(300); }
  throw new Error('timed out');
};

try {
  await waitFor(() => agentOut.includes('is running'), 8000);
  token = fs.readFileSync(path.join(home, '.port-station', 'token'), 'utf8').trim();
  assert.ok(agentOut.includes(token), 'agent prints its token');

  const hello = await api('/api/hello', null, { Origin: 'https://example.com' });
  assert.equal(hello.data.app, 'port-station');
  assert.equal(hello.headers.get('access-control-allow-origin'), 'https://example.com');
  ok('hello answers other sites with CORS');

  const pre = await fetch(`${base}/api/ports`, { method: 'OPTIONS', headers: { Origin: 'https://example.com', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
  ok('preflight allows private-network access');

  const saved = token;
  token = 'wrong';
  assert.equal((await api('/api/ports')).status, 401);
  token = saved;
  ok('wrong token is refused');

  const rebinding = await new Promise((resolve) => {
    const s = net.connect(agentPort, '127.0.0.1', () => s.write(`GET /api/ports HTTP/1.1\r\nHost: evil.example:${agentPort}\r\nX-Port-Station-Token: ${token}\r\nConnection: close\r\n\r\n`));
    let buf = '';
    s.on('data', (d) => { buf += d; });
    s.on('end', () => resolve(buf.split(' ')[1]));
  });
  assert.equal(rebinding, '421');
  ok('foreign Host header is refused (DNS rebinding)');

  const page = await fetch(base + '/');
  const html = await page.text();
  assert.ok(html.includes(`content="${token}"`), 'token injected into the page');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  ok('page carries the token, cannot be framed, is not readable cross-site');

  const snap = (await api('/api/ports')).data;
  const self = snap.ports.find((p) => p.port === agentPort);
  assert.equal(self.kind, 'agent');
  assert.equal((await api('/api/stop', { key: self.key })).status, 400);
  ok('lists ports, and refuses to stop itself');

  // a real server owned by this user, with a connection held open
  const target = await freePort();
  server = spawn(process.execPath, ['-e', `require('net').createServer(s=>s.on('error',()=>{})).listen(${target},'127.0.0.1')`], { stdio: 'ignore' });
  const live = await waitFor(async () => (await api('/api/ports')).data.ports.find((p) => p.port === target));
  assert.equal(live.process.pid, server.pid);
  if (process.platform === 'linux') assert.equal(live.process.user, os.userInfo().username);
  const client = net.connect(target, '127.0.0.1');
  client.on('error', () => {});
  const busy = await waitFor(async () => (await api('/api/ports')).data.ports.find((p) => p.port === target && p.connectionCount === 1));
  assert.equal(busy.connections[0].client?.name, 'node');
  ok('sees a real server and who is connected to it');

  const stopped = await api('/api/stop', { key: `tcp:${target}` });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.data));
  assert.equal(stopped.data.status, 'stopped');
  assert.ok(stopped.data.cmd.includes('createServer'));
  await waitFor(async () => !(await api('/api/ports')).data.ports.some((p) => p.port === target));
  assert.ok(fs.existsSync(path.join(home, '.port-station', 'parked.json')));
  assert.equal((fs.statSync(path.join(home, '.port-station', 'parked.json')).mode & 0o777).toString(8), process.platform === 'win32' ? '666' : '600');
  ok('stops it, remembers how it was started (file readable only by you)');

  const started = await api('/api/start', { id: stopped.data.id });
  assert.equal(started.data.status, 'starting');
  const back = await waitFor(async () => (await api('/api/ports')).data.ports.find((p) => p.port === target));
  assert.notEqual(back.process.pid, server.pid);
  assert.equal((await api('/api/ports')).data.parked.length, 0);
  ok('starts it again with the same command');
  process.kill(back.process.pid);

  const beaconPort = await freePort();
  assert.equal((await api('/api/open', { port: beaconPort, proto: 'tcp' })).status, 200);
  assert.equal((await api('/api/open', { port: beaconPort, proto: 'tcp' })).status, 409);
  const beacon = (await api('/api/ports')).data.ports.find((p) => p.port === beaconPort);
  assert.equal(beacon.kind, 'beacon');
  const off = await api('/api/stop', { key: beacon.key });
  assert.equal(off.data.kind, 'beacon');
  assert.equal((await api('/api/start', { id: off.data.id })).status, 200);
  assert.ok((await api('/api/ports')).data.ports.some((p) => p.port === beaconPort));
  const off2 = await api('/api/stop', { key: beacon.key });
  assert.equal((await api('/api/forget', { id: off2.data.id })).status, 200);
  assert.equal((await api('/api/ports')).data.parked.length, 0);
  ok('beacons open, refuse a taken port, switch off and on, and can be removed');

  assert.equal((await api('/api/open', { port: 70000, proto: 'tcp' })).status, 400);
  ok('rejects bad port numbers');

  console.log(`\n  ${passed} checks passed`);
} catch (e) {
  console.error('\n  FAILED:', e.message, '\n\n--- agent output ---\n' + agentOut);
  process.exitCode = 1;
} finally {
  agent.kill();
  server?.kill();
  fs.rmSync(home, { recursive: true, force: true });
}
