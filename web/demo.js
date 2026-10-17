// A made-up computer for visitors who haven't started the helper. Same shape as the agent's data.
const ME = 'you';

const PROGRAMS = [
  { port: 22, name: 'sshd', user: 'root', cmd: 'sshd: /usr/sbin/sshd -D', exposure: 'network', traffic: 0.15, clients: ['192.168.1.24'] },
  { port: 631, name: 'cupsd', user: 'root', cmd: '/usr/sbin/cupsd -l', traffic: 0 },
  { port: 3000, name: 'node', user: ME, cmd: 'node server.js', traffic: 0.9, clients: ['chrome', 'chrome', 'curl'] },
  { port: 5173, name: 'vite', user: ME, cmd: 'node node_modules/.bin/vite --port 5173', traffic: 0.7, clients: ['chrome', 'firefox'] },
  { port: 5432, name: 'postgres', user: 'postgres', cmd: '/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main', traffic: 0.8, clients: ['node', 'node', 'python3', 'psql'] },
  { port: 6379, name: 'redis-server', user: 'redis', cmd: '/usr/bin/redis-server 127.0.0.1:6379', traffic: 0.6, clients: ['node', 'node'] },
  { port: 8000, name: 'python3', user: ME, cmd: 'python3 -m http.server 8000', traffic: 0.1, clients: ['chrome'] },
  { port: 8080, name: 'java', user: ME, cmd: 'java -jar build/libs/api-0.3.1.jar', exposure: 'network', traffic: 0.4, clients: ['192.168.1.31', 'node'] },
  { port: 9229, name: 'node', user: ME, cmd: 'node --inspect server.js', traffic: 0 },
  { port: 11434, name: 'ollama', user: 'ollama', cmd: '/usr/local/bin/ollama serve', traffic: 0.25, clients: ['python3'] },
  { port: 27017, name: 'mongod', user: 'mongodb', cmd: '/usr/bin/mongod --config /etc/mongod.conf', traffic: 0.3, clients: ['node'] },
  { port: 6463, name: 'Discord', user: ME, cmd: '/usr/share/discord/Discord', traffic: 0 },
  { port: 57621, name: 'spotify', user: ME, cmd: '/usr/share/spotify/spotify', exposure: 'network', traffic: 0.05, clients: ['192.168.1.40'] },
  { port: 46065, name: null, traffic: 0.2 },
  { port: 5353, proto: 'udp', name: 'avahi-daemon', user: 'avahi', cmd: 'avahi-daemon: running [demo.local]', exposure: 'network', traffic: 0 },
  { port: 53, proto: 'udp', name: 'systemd-resolve', user: 'systemd-resolve', cmd: '/usr/lib/systemd/systemd-resolved', traffic: 0 },
];

const rand = (n) => Math.floor(Math.random() * n);
const id = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

export class DemoSource {
  constructor() {
    this.mode = 'demo';
    this.start0 = Date.now();
    let pid = 1200;
    this.live = PROGRAMS.map((p) => ({
      ...p,
      proto: p.proto || 'tcp',
      pid: p.name ? (pid += 37 + rand(400)) : null,
      startedAt: Date.now() - (3600 + rand(86400 * 3)) * 1000,
      rssKB: 20000 + rand(400000),
      conns: [],
    }));
    this.parked = [{
      id: id(), name: 'next-server', user: ME, pid: 4410, cmd: 'node node_modules/.bin/next dev -p 4000',
      ports: [{ port: 4000, proto: 'tcp' }], stoppedAt: Date.now() - 600000, status: 'stopped', error: null, kind: 'process',
    }];
    this.live.forEach((p) => this.churn(p, true));
  }

  churn(p, fill = false) {
    if (!p.clients?.length) return;
    const target = Math.random() < p.traffic ? 1 + rand(p.clients.length * 2) : 0;
    if (fill || Math.random() < 0.35) {
      p.conns = Array.from({ length: target }, () => {
        const c = p.clients[rand(p.clients.length)];
        const remote = /^\d/.test(c);
        return {
          peer: `${remote ? c : '127.0.0.1'}:${40000 + rand(25000)}`,
          fromThisComputer: !remote,
          client: remote ? null : { pid: 2000 + rand(30000), name: c },
        };
      });
    }
  }

  async snapshot() {
    this.live.forEach((p) => this.churn(p));
    const now = Date.now();
    for (const rec of this.parked) {
      if (rec.status === 'starting' && now - rec.startedAt > 1400) {
        this.parked = this.parked.filter((r) => r !== rec);
        this.live.push({ ...rec.prog, startedAt: now, conns: [], pid: 3000 + rand(20000) });
      }
    }
    return {
      app: 'port-station',
      demo: true,
      host: 'demo-laptop',
      platform: 'linux',
      user: ME,
      readOnly: false,
      time: now,
      ports: this.live
        .map((p) => ({
          key: `${p.proto}:${p.port}`,
          port: p.port,
          proto: p.proto,
          addresses: p.exposure === 'network' ? ['0.0.0.0'] : ['127.0.0.1'],
          exposure: p.exposure || 'local',
          kind: p.beacon ? 'beacon' : 'process',
          process: p.name ? {
            pid: p.pid, name: p.name, user: p.user, cmd: p.cmd,
            uptime: Math.round((now - p.startedAt) / 1000), rssKB: p.rssKB, cpu: p.conns.length ? +(Math.random() * 12).toFixed(1) : 0, workers: 1,
          } : null,
          connectionCount: p.conns.length,
          connections: p.conns,
        }))
        .sort((a, b) => a.port - b.port),
      parked: this.parked.map(({ prog, ...r }) => r),
    };
  }

  async stop(key) {
    const p = this.live.find((x) => `${x.proto}:${x.port}` === key);
    if (!p) throw new Error('Nothing is open there any more.');
    if (!p.name) throw new Error(`The program on port ${p.port} is hidden from the helper. On a real computer, run the helper with sudo to control it.`);
    await new Promise((r) => setTimeout(r, 450));
    this.live = this.live.filter((x) => x !== p);
    const rec = {
      id: id(), name: p.name, user: p.user, pid: p.pid, cmd: p.cmd, ports: [{ port: p.port, proto: p.proto }],
      stoppedAt: Date.now(), status: 'stopped', error: null, kind: p.beacon ? 'beacon' : 'process', prog: p,
    };
    this.parked.push(rec);
    return rec;
  }

  async start(recId) {
    const rec = this.parked.find((r) => r.id === recId);
    if (!rec) throw new Error('That stopped port is no longer on the list.');
    rec.prog ||= { port: rec.ports[0].port, proto: rec.ports[0].proto, name: rec.name, user: rec.user, cmd: rec.cmd, traffic: 0.6, clients: ['chrome'], rssKB: 90000 };
    rec.status = 'starting';
    rec.startedAt = Date.now();
    return rec;
  }

  async forget(recId) {
    this.parked = this.parked.filter((r) => r.id !== recId);
    return { ok: true };
  }

  async open(port, proto) {
    port = Number(port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Pick a port number from 1 to 65535.');
    if (this.live.some((p) => p.port === port && p.proto === proto)) throw new Error(`Port ${port} is already taken.`);
    if (port < 1024) throw new Error('Ports below 1024 need sudo or administrator rights.');
    this.live.push({ port, proto, name: 'beacon', user: ME, cmd: `Port Station beacon on ${proto.toUpperCase()} ${port}`, beacon: true,
      pid: 7777, startedAt: Date.now(), rssKB: 48000, traffic: 0, conns: [] });
    return { ok: true, key: `${proto}:${port}` };
  }
}
