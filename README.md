# Port Station

See every open port on your computer as a street of garages. Each port has its own garage with the port number over the door, and a car parks inside while the port is open. You can see which ports are busy and which are idle, which program owns each one and who is connected to it, and you can switch any of them off and back on.

![Port Station showing a demo computer: rows of neon garages along streets, each with a port number over the door and a car parked inside, glowing violet garages with signal rings for busy ports, dim ones for idle ports, a row of empty spare garages, an empty red pad where a switched-off port's garage flew away, and the Ports list on the left](docs/screenshot.jpg)

## What you see

| In the station | What it means |
|---|---|
| A car parked in a garage | A program is listening on that port. The number over the door is the port. |
| Pink glow, rings rising from the roof antenna | **In use**: something is connected right now. More connections make the rings faster. |
| Cyan glow, faint wire | **Idle**: the port is open, but nobody is connected. |
| Empty red pad with a barrier, no garage | **Off**: you stopped it from Port Station. It can be switched back on. |
| Green sports car | A **beacon** you opened yourself (see below). |
| Grey car, "hidden owner" | Another user (often the system) owns the port, so the helper can't see which program it is. |

Cars come in three shapes: sedan, sports car and truck. Every program gets its own paint color and shape, so all of `node`'s ports look alike. Empty garages marked FREE wait at the end of the street. When a port opens, a car drives down the street into a garage, which now shows that port number. When you switch a port off, the car backs out and drives away, then the garage flies off on its thrusters. Switch it back on and the garage lands again and the car returns.

## How to use it

### 1. Look around

Open the site and you see a **demo station**: a made-up laptop with a typical developer's ports (a web server, Postgres, Redis and so on). Everything works there, switches included, so you can try it without installing anything.

Drag to move around, scroll or pinch to zoom, and click a garage (or a row in the **Ports** list) to open its details:

- **Power**: the on/off switch.
- **Listening on / Reachable from**: whether only your computer can reach the port, or other devices on your network too.
- **Running for, Memory, Command**: how long the program has run, how much memory it uses, and the exact command that started it. Tap a long command to show all of it.
- **Who is connected**: each connection with the program on the other end (`chrome`, `psql`, `node`…) or "another device" when it comes from the network.

Use the list's search box to find a port, program or user. The chips filter by In use, Idle or Off, and **UDP** adds UDP ports, which are hidden by default because most of them are background chatter.

### 2. Connect your computer

A website can't see your ports by itself, so Port Station has a small helper: one JavaScript file with no install and no dependencies. Press **Connect my computer** and follow the steps:

1. Install [Node.js](https://nodejs.org) 18 or newer.
2. Copy the command shown in the dialog into a terminal. It downloads `port-station.mjs` and starts it.
3. The helper prints a link. Open it, and the station switches from the demo to your real ports. You can also paste the printed token into the dialog.

The helper keeps running until you press Ctrl+C. Next time, start it again with `node port-station.mjs` and reopen the site. It remembers you.

**Browsers:** in Chrome or Edge, the site may ask to reach devices on your local network. Choose **Allow**, because that is how it talks to the helper. Firefox works directly. Safari blocks public sites from talking to the helper, so on Safari open the `http://127.0.0.1:7777` page the helper prints, which shows the same station.

### 3. Switch ports off and on

- **Off**: flip the switch. Port Station stops the program that owns the port (a polite stop first, then a forced one after 3 seconds if it ignores that). The toast has an **Undo** button.
- **On**: flip it back. Port Station starts the program again with the same command, in the same folder. On Linux it also uses the same environment variables. Anything the program prints goes to a log file in `~/.port-station/logs/`, which the panel names if the restart fails.
- **Remove from station**: forgets a stopped port without starting it.

Stopping a program closes **all** of its ports, not just the one you clicked. The toast tells you when that happens.

### 4. Open a port

**Open a port** parks a beacon: a tiny listener inside the helper that answers "hello" on the port you choose. Use it to check that a firewall rule works, to hold a port free for later, or just to watch a car arrive. Beacons close when the helper stops.

## Helper options

```
node port-station.mjs --port 7778       # run the helper on another port
node port-station.mjs --read-only       # watch only; the switches are disabled
node port-station.mjs --origin https://your-site.example   # only accept this site
node port-station.mjs --new-token       # make a new token so old links stop working
sudo node port-station.mjs              # also see and control other users' ports
```

## Safety

The helper is built so that other websites can't use it, even while it's running:

- It only listens on `127.0.0.1`, so other devices on your network can't reach it.
- Every request needs a secret token, which lives in `~/.port-station/token` (readable only by you). The link the helper prints carries the token after a `#`, which browsers never send to any server. The page removes it from the address bar right away.
- It refuses requests addressed to any name other than `127.0.0.1`, `localhost` or `[::1]`, which blocks DNS-rebinding tricks. Its own page can't be embedded in another site, so nobody can trick you into clicking the switches.
- It won't stop itself or the system's first process, and it can only stop programs your user account is allowed to stop. Root-owned services need `sudo`.
- The page only ever connects to a helper on your own computer. A crafted link can't point it anywhere else.

To restart programs, the helper saves their command line and folder (and on Linux their environment variables) in `~/.port-station/parked.json`. Only your user can read that file, and an entry is deleted once its port is running again.

## How it works

- **Reading ports.** The helper runs the system's own tools: `ss` on Linux, `lsof` on macOS, `netstat` + `tasklist` on Windows. It merges IPv4 and IPv6 listeners of the same port into one car. To find out who is connected, it matches each connection's far end against the other connections on the machine, so a browser tab talking to your dev server shows up as `chrome`. Program details come from `/proc` on Linux and `ps` on macOS. The page asks for a fresh list every 1.5 seconds.
- **The station** is [three.js](https://threejs.org) with an orthographic camera tilted down at about 35°, so it reads as a semi-2D drawing: rows stay straight and every garage is the same size on screen. Garages sit in rows of 7 (5 on narrow screens, 3 on phones in portrait), each row with its own street, and the station always keeps at least two FREE garages. A port keeps its garage while it exists. Cars follow a path along the street, turn in and back out again. The glow comes from a bloom pass, and the ground grid and pulse rings are drawn by one shader.
- **The site itself** is plain HTML, CSS and JavaScript with no build step. The helper file you download is the same one that serves the station at `http://127.0.0.1:7777`.

Works on Linux and macOS. Windows support is best effort and untested so far: it shows ports, who is connected and stops and starts them, but it doesn't show which user runs a program or how long it has been running.

## License

MIT
