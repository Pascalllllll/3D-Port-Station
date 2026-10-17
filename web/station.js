// The scene, drawn semi-2D: rows of garages along a street, seen from a corner at 45° and from above
// with no perspective, like an isometric drawing. Every port has its own garage with the port number over the door.
// An open port: a car drives down the street and parks in its garage.
// Switched off: the car backs out and drives away, then the garage flies off and leaves a marked pad.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// light: pale ivory and gold. dark: soft black and soft purple.
const PALETTES = {
  light: {
    busy: 0xb8892f, idle: 0x9c9080, off: 0xb4646c, starting: 0xe0b45c, beacon: 0x86997a, vacant: 0xd6cbb6,
    ground: 0xf4efe5, grid: 0xc4a265, wave: 0xd9b46a,
    wall: 0xf3ede2, roof: 0xe6dbc6, floor: 0xe9e0cf, glass: 0x4a4352, wheel: 0x2e2a25,
    head: 0xfff6e0, tail: 0xc4566a, flame: 0xe0a640, select: 0xb8892f,
    road: 0xebe3d3, edge: 0xc9a75e, dash: 0xb79c6c,
    slats: ['#efe7d8', '#fbf7ef', '#d9ccb4'], doorGlow: 0x000000,
    sign: '#fdfaf3', signText: '#3a3328',
    sky: 0xfff8ec, low: 0xcbb994, hemi: 1.7, key: 0xfff0d6, keyI: 1.9, rim: 0xe2bb6c, rimI: 0.35,
    exposure: 1, bloom: 0, blend: THREE.NormalBlending,
    paints: [0xf1e9da, 0xdcc28a, 0xc49a48, 0xa99d8d, 0x8d7150, 0xe8d6ad, 0x6e655a, 0xcdb9a0],
    unknown: 0xb5ab9c, beaconPaint: 0xe9ecdf,
  },
  dark: {
    busy: 0xb69cf0, idle: 0x8b829c, off: 0xd28a9b, starting: 0xdcbf7c, beacon: 0x9dbfa6, vacant: 0x564d6b,
    ground: 0x141218, grid: 0x8f79c9, wave: 0xb69cf0,
    wall: 0x28232f, roof: 0x322b3e, floor: 0x1a1720, glass: 0x0f0d15, wheel: 0x0c0b0f,
    head: 0xf4eefc, tail: 0xd28a9b, flame: 0xdcbf7c, select: 0xcbb8f5,
    road: 0x1c1923, edge: 0x8f79c9, dash: 0xb3a8c8,
    slats: ['#221e2a', '#2e2839', '#15131a'], doorGlow: 0x1a1426,
    sign: '#16141b', signText: '#efeaf6',
    sky: 0x9e8dcc, low: 0x0e0c13, hemi: 0.95, key: 0xe9e2ff, keyI: 1.5, rim: 0xb69cf0, rimI: 0.55,
    exposure: 1.05, bloom: 0.42, blend: THREE.AdditiveBlending,
    paints: [0xb69cf0, 0x7d68a6, 0xd8cbee, 0xdcbf7c, 0x5c5569, 0xa58fba, 0xcec6da, 0x4a3f63],
    unknown: 0x4a4458, beaconPaint: 0x24282a,
  },
};

let theme = PALETTES.dark;

// the status colours of the current theme
export const COLORS = {};
function usePalette(name) {
  theme = PALETTES[name] || PALETTES.dark;
  for (const k of ['busy', 'idle', 'off', 'starting', 'beacon']) COLORS[k] = theme[k];
}
usePalette('dark');
const CAR_KINDS = ['sedan', 'sport', 'truck'];

// garage size, distance between garages, distance between rows (garages + street)
const GW = 5.6;
const GD = 7;
const GH = 3.6;
const DOOR_H = 2.8;
const PITCH = 7.2;
const ROW = 21;
const LANE = 6; // where cars drive, in front of the doors
const INSIDE = -3.4; // a parked car's centre
const SPARE = 2; // empty garages kept ready for new ports
const FLY = 46; // how high a garage flies before it is gone
const TILT = Math.atan(Math.SQRT1_2); // camera angle above the ground: true isometric, about 35°
const YAW = Math.PI / 4; // camera turned 45° around, looking at the garages from a corner
const VIEW = 30; // half the view height in world units at zoom 1

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function paintFor(name) {
  if (!name) return new THREE.Color(theme.unknown);
  return new THREE.Color(theme.paints[hashString(name) % theme.paints.length]);
}

export function statusColor(item) {
  if (item.kind === 'parked') return item.status === 'starting' ? COLORS.starting : COLORS.off;
  if (item.kind === 'beacon' || item.kind === 'agent') return COLORS.beacon;
  return item.connectionCount > 0 ? COLORS.busy : COLORS.idle;
}

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t * t;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ---------- shared assets ----------

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const shared = {};
function assets() {
  if (shared.ready) return shared;
  shared.ready = true;
  shared.glow = canvasTexture(128, 128, (g) => {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  });
  // roll-up door slats, drawn in the theme's colours by paintShared()
  shared.slats = canvasTexture(64, 256, () => {});
  shared.wheel = new THREE.CylinderGeometry(0.4, 0.4, 0.32, 18).rotateZ(Math.PI / 2);
  shared.rim = new THREE.TorusGeometry(0.4, 0.035, 6, 24).rotateY(Math.PI / 2);
  shared.wheelMat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.2 });
  shared.glass = new THREE.MeshStandardMaterial({ metalness: 0.6, roughness: 0.15, emissiveIntensity: 0.4 });
  shared.head = new THREE.MeshBasicMaterial();
  shared.tail = new THREE.MeshBasicMaterial();
  shared.light = new THREE.BoxGeometry(0.42, 0.12, 0.06);
  shared.wall = new THREE.MeshStandardMaterial({ metalness: 0.15, roughness: 0.75 });
  shared.roof = new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.6 });
  shared.floor = new THREE.MeshStandardMaterial({ metalness: 0.1, roughness: 0.9 });
  shared.door = new THREE.MeshStandardMaterial({ map: shared.slats, metalness: 0.2, roughness: 0.6, emissiveIntensity: 0.5 });
  shared.flame = new THREE.ConeGeometry(0.34, 1.8, 14, 1, true).rotateX(Math.PI).translate(0, -0.9, 0);
  shared.ring = new THREE.TorusGeometry(0.45, 0.045, 6, 40).rotateX(Math.PI / 2);
  shared.hit = new THREE.BoxGeometry(PITCH - 0.6, 5, GD + 8);
  shared.hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
  // a 4-sided ring turned 45° is a square frame
  shared.select = new THREE.RingGeometry(3.55, 3.8, 4, 1, Math.PI / 4).rotateX(-Math.PI / 2);
  paintShared();
  return shared;
}

function paintShared() {
  const a = shared;
  a.wheelMat.color.set(theme.wheel);
  a.glass.color.set(theme.glass);
  a.glass.emissive.set(theme.glass);
  a.head.color.set(theme.head);
  a.tail.color.set(theme.tail);
  a.wall.color.set(theme.wall);
  a.roof.color.set(theme.roof);
  a.floor.color.set(theme.floor);
  a.door.emissive.set(theme.doorGlow);
  const c = a.slats.image;
  const g = c.getContext('2d');
  const [base, lit, shade] = theme.slats;
  g.fillStyle = base;
  g.fillRect(0, 0, c.width, c.height);
  for (let y = 0; y < c.height; y += 16) {
    g.fillStyle = lit;
    g.fillRect(0, y, c.width, 2);
    g.fillStyle = shade;
    g.fillRect(0, y + 13, c.width, 3);
  }
  a.slats.needsUpdate = true;
}

// soft halos add light on the dark street, but would wash out to white on the pale one
function glowMaterial(params) {
  const m = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: theme.blend, ...params });
  m.userData.glow = true;
  return m;
}

// ---------- cars ----------

function buildCar(kind, paint, color) {
  const a = assets();
  const car = new THREE.Group();
  const paintMat = new THREE.MeshStandardMaterial({ color: paint, metalness: 0.6, roughness: 0.3, emissive: paint, emissiveIntensity: 0.06 });
  const edgeMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); car.add(m); return m; };
  const wire = (w, h, l, x, y, z) => {
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, l)), edgeMat);
    e.position.set(x, y, z);
    car.add(e);
  };

  const spec = {
    sedan: { w: 1.9, h: 0.62, l: 4.1, y: 0.62, cab: [1.62, 0.55, 2.0, 0.25], wz: 1.3 },
    sport: { w: 2.0, h: 0.46, l: 4.4, y: 0.52, cab: [1.5, 0.42, 1.55, 0.45], wz: 1.45 },
    truck: { w: 2.1, h: 0.7, l: 4.5, y: 0.72, cab: [1.9, 0.8, 1.35, -1.35], wz: 1.5 },
  }[kind];

  add(new RoundedBoxGeometry(spec.w, spec.h, spec.l, 3, 0.16), paintMat, 0, spec.y, 0);
  wire(spec.w + 0.04, spec.h + 0.04, spec.l + 0.04, 0, spec.y, 0);
  const [cw, ch, cl, cz] = spec.cab;
  const cabY = spec.y + spec.h / 2 + ch / 2 - 0.02;
  add(new RoundedBoxGeometry(cw, ch, cl, 3, 0.14), a.glass, 0, cabY, cz);
  wire(cw + 0.03, ch + 0.03, cl + 0.03, 0, cabY, cz);

  if (kind === 'truck') {
    const boxH = 1.25;
    add(new RoundedBoxGeometry(2.05, boxH, 2.6, 2, 0.08), paintMat, 0, spec.y + spec.h / 2 + boxH / 2, 0.85);
    wire(2.09, boxH + 0.04, 2.64, 0, spec.y + spec.h / 2 + boxH / 2, 0.85);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.08, 2.4), edgeMat);
    stripe.position.set(0, spec.y + spec.h / 2 + 0.55, 0.85);
    car.add(stripe);
  }
  if (kind === 'sport') {
    add(new THREE.BoxGeometry(1.9, 0.06, 0.4), paintMat, 0, spec.y + 0.62, spec.l / 2 - 0.25);
    add(new THREE.BoxGeometry(0.08, 0.36, 0.1), a.wheelMat, 0.7, spec.y + 0.42, spec.l / 2 - 0.25);
    add(new THREE.BoxGeometry(0.08, 0.36, 0.1), a.wheelMat, -0.7, spec.y + 0.42, spec.l / 2 - 0.25);
  }

  const rimMat = new THREE.MeshBasicMaterial({ color });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(a.wheel, a.wheelMat, sx * (spec.w / 2 - 0.05), 0.4, sz * spec.wz);
      add(a.rim, rimMat, sx * (spec.w / 2 + 0.12), 0.4, sz * spec.wz);
    }
  }

  // nose points at -z
  for (const sx of [-0.6, 0.6]) {
    add(a.light, a.head, sx, spec.y + 0.05, -spec.l / 2 - 0.01);
    add(a.light, a.tail, sx, spec.y + 0.08, spec.l / 2 + 0.01);
  }

  const glowMat = glowMaterial({ map: a.glow, color, opacity: 0.6 });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(spec.w + 2.4, spec.l + 2.6).rotateX(-Math.PI / 2), glowMat);
  glow.position.y = 0.2;
  car.add(glow);

  car.userData = { paintMat, edgeMat, rimMat, glowMat, kind };
  return car;
}

function disposeCar(car) {
  car.traverse((o) => {
    if (o.geometry && o.geometry !== shared.wheel && o.geometry !== shared.rim && o.geometry !== shared.light) o.geometry.dispose();
  });
  const u = car.userData;
  [u.paintMat, u.edgeMat, u.rimMat, u.glowMat].forEach((m) => m?.dispose());
  car.removeFromParent();
}

// the turn off the street into the garage, and the reverse back out onto it (slot-local x/z)
function pathIn(fromX) {
  const p = new THREE.CurvePath();
  p.add(new THREE.LineCurve(new THREE.Vector2(fromX, LANE), new THREE.Vector2(-4, LANE)));
  p.add(new THREE.QuadraticBezierCurve(new THREE.Vector2(-4, LANE), new THREE.Vector2(0, LANE), new THREE.Vector2(0, 2)));
  p.add(new THREE.LineCurve(new THREE.Vector2(0, 2), new THREE.Vector2(0, INSIDE)));
  return p;
}

function pathOut() {
  const p = new THREE.CurvePath();
  p.add(new THREE.LineCurve(new THREE.Vector2(0, INSIDE), new THREE.Vector2(0, 2)));
  p.add(new THREE.QuadraticBezierCurve(new THREE.Vector2(0, 2), new THREE.Vector2(0, LANE), new THREE.Vector2(-4, LANE)));
  return p;
}

// ---------- garages ----------

function drawSign(tex, item, color) {
  const c = tex.image;
  const g = c.getContext('2d');
  const ink = `#${color.getHexString()}`;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = theme.sign;
  g.beginPath();
  g.roundRect(6, 6, c.width - 12, c.height - 12, 18);
  g.fill();
  g.strokeStyle = ink;
  g.globalAlpha = 0.9;
  g.lineWidth = 5;
  g.stroke();
  g.textBaseline = 'middle';
  g.fillStyle = item ? theme.signText : ink;
  if (!item) {
    g.globalAlpha = 0.8;
    g.textAlign = 'center';
    g.font = '600 52px "JetBrains Mono", ui-monospace, monospace';
    g.fillText('FREE', c.width / 2, c.height / 2 + 2);
  } else {
    g.globalAlpha = 1;
    g.textAlign = 'center';
    g.font = '700 74px "JetBrains Mono", ui-monospace, monospace';
    g.fillText(String(item.port), c.width / 2 - 36, c.height / 2 + 3);
    g.globalAlpha = 1;
    g.fillStyle = ink;
    g.textAlign = 'left';
    g.font = '600 28px "JetBrains Mono", ui-monospace, monospace';
    g.fillText(item.proto.toUpperCase(), c.width - 96, c.height / 2 + 3);
  }
  tex.needsUpdate = true;
}

function portDecal(port, proto) {
  return canvasTexture(512, 192, (g) => {
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '700 118px "JetBrains Mono", ui-monospace, monospace';
    g.fillText(String(port), 256, 86);
    g.font = '600 38px "JetBrains Mono", ui-monospace, monospace';
    g.globalAlpha = 0.7;
    g.fillText(proto.toUpperCase(), 256, 166);
  });
}

function buildGarage() {
  const a = assets();
  const g = new THREE.Group();
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };

  add(new THREE.BoxGeometry(GW, 0.16, GD), a.floor, 0, 0.08, -GD / 2);
  add(new THREE.BoxGeometry(GW, GH, 0.25), a.wall, 0, GH / 2, -GD + 0.125);
  for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.3, GH, GD), a.wall, sx * (GW / 2 - 0.15), GH / 2, -GD / 2);
  add(new THREE.BoxGeometry(GW + 0.5, 0.32, GD + 0.5), a.roof, 0, GH + 0.16, -GD / 2);
  add(new THREE.BoxGeometry(GW, GH - DOOR_H, 0.3), a.wall, 0, (GH + DOOR_H) / 2, -0.15);

  const edgeMat = new THREE.LineBasicMaterial({ color: theme.vacant, transparent: true, opacity: 0.9 });
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(GW + 0.5, GH + 0.32, GD + 0.5)), edgeMat);
  outline.position.set(0, (GH + 0.32) / 2, -GD / 2);
  g.add(outline);
  const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(GW - 0.6, DOOR_H)), edgeMat);
  frame.position.set(0, DOOR_H / 2, 0.02);
  g.add(frame);

  const signTex = canvasTexture(384, 112, () => {});
  const signMat = new THREE.MeshBasicMaterial({ map: signTex, transparent: true });
  add(new THREE.PlaneGeometry(GW - 1, (GW - 1) * 112 / 384), signMat, 0, (GH + DOOR_H) / 2 + 0.05, 0.02);

  // the light inside, so a parked car is lit in its port's colour
  const lightMat = new THREE.MeshBasicMaterial({ color: theme.vacant, transparent: true, opacity: 0.8 });
  add(new THREE.PlaneGeometry(GW - 1.2, 0.18).rotateX(Math.PI / 2), lightMat, 0, GH - 0.05, -GD + 1.4);
  const backMat = glowMaterial({ map: a.glow, color: theme.vacant, opacity: 0.5 });
  add(new THREE.PlaneGeometry(GW * 1.3, GH * 1.4), backMat, 0, GH * 0.55, -GD + 0.27);

  // roll-up door: the pivot sits at the top of the opening and shrinks upward
  const door = new THREE.Group();
  door.position.set(0, DOOR_H, 0.06);
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(GW - 0.6, DOOR_H), a.door);
  panel.position.y = -DOOR_H / 2;
  door.add(panel);
  g.add(door);

  // antenna on the roof: blinks while the port is open, sends out rings while something is connected
  add(new THREE.CylinderGeometry(0.05, 0.05, 1.5, 6), a.wall, GW / 2 - 0.9, GH + 1.07, -1.4);
  const beaconMat = new THREE.MeshBasicMaterial({ color: theme.vacant });
  const tipY = GH + 1.9;
  add(new THREE.SphereGeometry(0.17, 12, 10), beaconMat, GW / 2 - 0.9, tipY, -1.4);
  const rings = [];
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(a.ring, new THREE.MeshBasicMaterial({ color: theme.vacant, transparent: true, opacity: 0, depthWrite: false }));
    m.position.set(GW / 2 - 0.9, tipY, -1.4);
    m.visible = false;
    g.add(m);
    rings.push(m);
  }

  // thrusters under the corners, lit only while flying
  const flameMat = glowMaterial({ color: theme.flame, opacity: 0, side: THREE.DoubleSide });
  const flames = [];
  for (const sx of [-1, 1]) {
    for (const sz of [0.12, 0.88]) {
      add(new THREE.CylinderGeometry(0.4, 0.5, 0.3, 14), a.roof, sx * (GW / 2 - 0.7), -0.1, -GD * sz);
      const f = add(a.flame, flameMat, sx * (GW / 2 - 0.7), -0.25, -GD * sz);
      flames.push(f);
    }
  }

  g.userData = { edgeMat, signMat, signTex, lightMat, backMat, door, beaconMat, rings, flameMat, flames };
  return g;
}

// the marks left on the ground where a garage flew off: dashed outline, barrier, port number
function buildPad() {
  const g = new THREE.Group();
  const mat = new THREE.LineDashedMaterial({ color: COLORS.off, dashSize: 0.5, gapSize: 0.32, transparent: true, opacity: 0 });
  const hw = GW / 2 + 0.25;
  const pts = [[-hw, 0.4], [hw, 0.4], [hw, -GD - 0.25], [-hw, -GD - 0.25], [-hw, 0.4]].map(([x, z]) => new THREE.Vector3(x, 0.04, z));
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
  line.computeLineDistances();
  g.add(line);

  const solid = new THREE.MeshBasicMaterial({ color: COLORS.off, transparent: true, opacity: 0 });
  for (const x of [-hw + 0.1, hw - 0.1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.2, 0.16), solid);
    post.position.set(x, 0.6, 0.4);
    g.add(post);
  }
  const arm = new THREE.Mesh(new THREE.BoxGeometry(GW + 0.3, 0.14, 0.1), solid);
  arm.position.set(0, 1.05, 0.4);
  g.add(arm);

  const decalMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: 0, color: COLORS.off });
  const decal = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 1.58).rotateX(-Math.PI / 2), decalMat);
  decal.position.set(0, 0.05, -GD / 2);
  g.add(decal);
  g.visible = false;
  g.userData = { mat, solid, decalMat };
  return g;
}

// ---------- one garage slot ----------

class Slot {
  constructor(station, index, landing) {
    this.station = station;
    this.index = index;
    this.key = null;
    this.item = null;
    this.releasing = false;
    this.wantGarage = true;
    this.wantCar = false;
    this.carSpec = null;
    this.car = null; // { mesh, sig, phase: wait | in | parked | reverse | away, t, ... }
    this.mode = landing ? 'gone' : 'down'; // down | up | gone | land
    this.modeT = 0;
    this.door = 0;
    this.pad = 0;
    this.conns = 0;
    this.phase = Math.random();
    this.color = new THREE.Color(theme.vacant);

    this.group = new THREE.Group();
    station.lot.add(this.group);

    this.garage = buildGarage();
    this.garage.visible = !landing;
    if (landing) this.garage.position.y = FLY;
    this.group.add(this.garage);
    drawSign(this.garage.userData.signTex, null, this.color);

    this.padGroup = buildPad();
    this.group.add(this.padGroup);

    const a = assets();
    this.hit = new THREE.Mesh(a.hit, a.hitMat);
    this.hit.position.set(0, 2.5, (8 - GD) / 2);
    this.hit.userData.slot = this;
    this.group.add(this.hit);

    this.selectMat = new THREE.MeshBasicMaterial({ color: theme.select, transparent: true, opacity: 0, depthWrite: false });
    this.selectRing = new THREE.Mesh(a.select, this.selectMat);
    this.selectRing.scale.set(1.3, 1, 1.85);
    this.selectRing.position.set(0, 0.06, -GD / 2 + 0.6);
    this.group.add(this.selectRing);

    this.labelEl = document.createElement('div');
    this.labelEl.className = 'tag';
    this.label = new CSS2DObject(this.labelEl);
    this.label.position.set(0, GH + 3, -1);
    this.label.visible = false;
    this.group.add(this.label);
  }

  place(x, z) {
    this.group.position.set(x, 0, z);
  }

  get claimable() {
    return !this.key && !this.releasing && this.mode === 'down' && !this.car;
  }

  assign(key) {
    this.key = key;
  }

  setItem(item) {
    const prev = this.item;
    this.item = item;
    const live = item.kind !== 'parked';
    this.color.set(statusColor(item));

    this.labelEl.innerHTML = '';
    const port = document.createElement('b');
    port.textContent = `:${item.port}`;
    const name = document.createElement('span');
    name.textContent = item.process?.name || 'hidden owner';
    this.labelEl.append(port, name);
    this.labelEl.dataset.status = item.kind === 'parked' ? item.status : item.kind === 'beacon' ? 'beacon' : item.connectionCount > 0 ? 'busy' : 'idle';
    this.label.visible = true;

    if (prev?.port !== item.port || prev?.proto !== item.proto) {
      const d = this.padGroup.userData.decalMat;
      d.map?.dispose();
      d.map = portDecal(item.port, item.proto);
      d.needsUpdate = true;
    }
    this.paint(this.color);

    this.wantGarage = live || item.status === 'starting';
    this.wantCar = live;
    this.conns = live ? item.connectionCount || 0 : 0;
    if (live) {
      const pname = item.process?.name || '';
      const kind = item.kind === 'beacon' ? 'sport' : CAR_KINDS[hashString(pname || item.key) % 3];
      const paint = item.kind === 'beacon' ? new THREE.Color(theme.beaconPaint) : paintFor(pname);
      this.carSpec = { kind, paint, sig: `${kind}|${paint.getHexString()}` };
    }
    if (this.car && this.car.sig === this.carSpec?.sig) this.recolorCar();
  }

  recolorCar() {
    const u = this.car.mesh.userData;
    u.edgeMat.color.copy(this.color);
    u.rimMat.color.copy(this.color);
    u.glowMat.color.copy(this.color);
  }

  // the theme changed: same port, new colours, and the parked car gets a fresh coat in place
  retheme() {
    this.selectMat.color.set(theme.select);
    this.garage.userData.flameMat.color.set(theme.flame);
    this.signKey = null;
    if (!this.item || this.releasing) {
      this.color.set(theme.vacant);
      this.paint(this.color);
      return;
    }
    const oldSig = this.carSpec?.sig;
    this.setItem(this.item);
    if (this.car && this.car.sig === oldSig && this.carSpec) {
      this.car.sig = this.carSpec.sig;
      this.car.mesh.userData.paintMat.color.copy(this.carSpec.paint);
      this.car.mesh.userData.paintMat.emissive.copy(this.carSpec.paint);
      this.recolorCar();
    }
  }

  paint(color) {
    const u = this.garage.userData;
    u.edgeMat.color.copy(color);
    // the sign is only redrawn when its port or colour changes
    const signKey = `${this.item ? `${this.item.port}${this.item.proto}` : 'free'}|${color.getHexString()}`;
    if (signKey !== this.signKey) {
      this.signKey = signKey;
      drawSign(u.signTex, this.item, color);
    }
    u.lightMat.color.copy(color);
    u.backMat.color.copy(color);
    u.beaconMat.color.copy(color);
    for (const r of u.rings) r.material.color.copy(color);
    const p = this.padGroup.userData;
    p.mat.color.copy(color);
    p.solid.color.copy(color);
    p.decalMat.color.copy(color);
  }

  // the port is gone for good: car out, garage off, then a fresh empty garage lands here
  release() {
    this.key = null;
    this.releasing = true;
    this.wantCar = false;
    this.wantGarage = false;
    this.conns = 0;
    this.label.visible = false;
  }

  spawnCar(delay) {
    const { kind, paint, sig } = this.carSpec;
    const mesh = buildCar(kind, paint, this.color);
    mesh.visible = false;
    this.group.add(mesh);
    const from = this.station.streetLeft - this.group.position.x;
    const path = pathIn(from);
    this.car = { mesh, sig, phase: 'wait', t: -delay, path, dur: Math.min(3.4, 1.5 + path.getLength() / 28) };
  }

  pose(path, u, backwards) {
    const p = path.getPointAt(u);
    const t = path.getTangentAt(u);
    const m = this.car.mesh;
    m.position.x = p.x;
    m.position.z = p.y;
    const dx = backwards ? -t.x : t.x;
    const dz = backwards ? -t.y : t.y;
    m.rotation.y = Math.atan2(-dx, -dz);
  }

  tickCar(dt, time) {
    const c = this.car;
    if (!c) return;
    if (c.phase === 'wait') {
      if (!this.wantCar || c.sig !== this.carSpec?.sig) { disposeCar(c.mesh); this.car = null; return; }
      c.t += dt;
      if (c.t >= 0) { c.phase = 'in'; c.t = 0; c.mesh.visible = true; }
      else return;
    }
    if (c.phase === 'in') {
      c.t = Math.min(1, c.t + dt / c.dur);
      this.pose(c.path, 1 - Math.pow(1 - c.t, 2.2), false);
      if (c.t >= 1) { c.phase = 'parked'; c.squash = 0; }
    } else if (c.phase === 'parked') {
      if (!this.wantCar || c.sig !== this.carSpec?.sig) {
        c.phase = 'reverse';
        c.t = 0;
        c.path = pathOut();
        return;
      }
      const busy = this.conns > 0;
      // engine running: busy cars rumble, idle ones breathe
      c.mesh.position.y = busy ? Math.abs(Math.sin(time * 18 + this.phase * 9)) * 0.025 : 0;
      c.squash = Math.min(1, (c.squash ?? 1) + dt * 4);
      const s = Math.sin(c.squash * Math.PI) * 0.05;
      c.mesh.scale.set(1 + s, 1 - s, 1 + s);
      c.mesh.userData.glowMat.opacity = busy ? 0.75 + Math.sin(time * 6 + this.phase * 6) * 0.25 : 0.45 + Math.sin(time * 1.4 + this.phase * 6) * 0.1;
    } else if (c.phase === 'reverse') {
      c.t = Math.min(1, c.t + dt / 1.7);
      this.pose(c.path, easeInOut(c.t), true);
      if (c.t >= 1) {
        c.phase = 'away';
        c.t = 0;
        const x0 = c.mesh.position.x;
        const to = this.station.streetRight - this.group.position.x;
        c.path = new THREE.LineCurve(new THREE.Vector2(x0, LANE), new THREE.Vector2(to, LANE));
        c.dur = Math.min(3, 1 + (to - x0) / 30);
      }
    } else if (c.phase === 'away') {
      c.t = Math.min(1, c.t + dt / c.dur);
      this.pose(c.path, c.t * c.t, false);
      if (c.t >= 1) { disposeCar(c.mesh); this.car = null; }
    }
  }

  tickGarage(dt, time) {
    const carInside = this.car && this.car.phase !== 'away' && this.car.phase !== 'wait';
    if (!this.wantGarage && this.mode === 'down' && !carInside) { this.mode = 'up'; this.modeT = 0; }
    if (this.wantGarage && this.mode === 'gone') { this.mode = 'land'; this.modeT = 0; this.garage.visible = true; }
    // changed its mind halfway: turn around from the same height
    if (this.wantGarage && this.mode === 'up') { this.mode = 'land'; this.modeT = 1 - this.modeT; }
    if (!this.wantGarage && this.mode === 'land') { this.mode = 'up'; this.modeT = 1 - this.modeT; }

    const g = this.garage;
    const u = g.userData;
    let thrust = 0;
    if (this.mode === 'up') {
      // a short shudder on the ground, then lift off
      this.modeT = Math.min(1, this.modeT + dt / 2);
      const lift = Math.max(0, (this.modeT - 0.15) / 0.85);
      g.position.y = FLY * easeIn(lift);
      g.position.x = lift === 0 ? Math.sin(time * 70) * 0.06 : 0;
      g.rotation.z = Math.sin(time * 3 + this.phase * 5) * 0.05 * lift;
      thrust = 0.6 + lift * 0.6;
      if (this.modeT >= 1) { this.mode = 'gone'; g.visible = false; g.rotation.z = 0; }
    } else if (this.mode === 'land') {
      this.modeT = Math.min(1, this.modeT + dt / 1.6);
      g.position.y = FLY * (1 - easeOut(this.modeT));
      g.rotation.z = Math.sin(time * 3 + this.phase * 5) * 0.05 * (1 - this.modeT);
      thrust = 1.2 - this.modeT * 0.8;
      if (this.modeT >= 1) { this.mode = 'down'; g.position.y = 0; g.rotation.z = 0; }
    }
    u.flameMat.opacity = thrust ? Math.min(1, thrust) * (0.75 + Math.sin(time * 40) * 0.25) : 0;
    for (const f of u.flames) {
      f.visible = thrust > 0;
      f.scale.set(1, thrust * (0.85 + Math.sin(time * 33 + f.position.x) * 0.2), 1);
    }

    // door rolls up for a car coming in, going out, or parked inside
    const open = this.car && this.car.phase !== 'away' && (this.car.phase !== 'wait' || this.car.t > -0.6) ? 1 : 0;
    this.door += Math.sign(open - this.door) * Math.min(Math.abs(open - this.door), dt * 1.8);
    u.door.scale.y = 1 - this.door * 0.92;

    const live = this.wantCar && !this.releasing;
    const lit = live ? 0.75 + Math.sin(time * 1.3 + this.phase * 6) * 0.08 : this.item ? 0.5 : 0.18;
    u.lightMat.opacity = lit;
    u.backMat.opacity = live ? (this.conns ? 0.55 + Math.sin(time * 5 + this.phase * 4) * 0.2 : 0.4) : 0.12;
    u.edgeMat.opacity = this.item ? 0.95 : 0.45;
    const blink = this.conns ? 4 + Math.min(this.conns, 10) * 0.6 : 1.2;
    u.beaconMat.color.copy(this.color).multiplyScalar(live ? 0.4 + (Math.sin(time * blink + this.phase * 7) > 0 ? 0.6 : 0) : 0.25);

    // connection rings: more connections, faster rings
    const speed = 0.5 + Math.min(this.conns, 10) * 0.12;
    u.rings.forEach((r, i) => {
      r.visible = this.conns > 0 && this.mode === 'down';
      if (!r.visible) return;
      const k = (time * speed + i / 3 + this.phase) % 1;
      r.scale.setScalar(1 + k * 4.5);
      r.position.y = GH + 1.9 + k * 1.2;
      r.material.opacity = (1 - k) * 0.8;
    });
  }

  tickPad(dt) {
    const showPad = this.mode !== 'down' && !this.releasing;
    this.pad = THREE.MathUtils.clamp(this.pad + (showPad ? dt * 1.5 : -dt * 2), 0, 1);
    const p = this.padGroup.userData;
    this.padGroup.visible = this.pad > 0;
    const starting = this.item?.status === 'starting';
    p.mat.opacity = this.pad * 0.9;
    p.solid.opacity = this.pad * (starting ? 0.3 : 0.95);
    p.decalMat.opacity = this.pad;
  }

  tick(dt, time, selected, hovered) {
    if (this.wantCar && !this.car && this.mode === 'down') this.spawnCar(this.station.driveDelay());
    this.tickCar(dt, time);
    this.tickGarage(dt, time);
    this.tickPad(dt);

    // a released garage has flown off: clear the slot and land a fresh empty one
    if (this.releasing && this.mode === 'gone' && !this.car) {
      this.item = null;
      this.color.set(theme.vacant);
      this.paint(this.color);
      this.wantGarage = true;
    }
    if (this.releasing && this.mode === 'down' && this.wantGarage) this.releasing = false;

    this.selectMat.opacity += ((selected ? 0.5 : hovered ? 0.22 : 0) - this.selectMat.opacity) * Math.min(1, dt * 10);
  }
}

// ---------- the station ----------

export class Station {
  constructor(canvas, labelRoot, { onSelect, onHover, theme: themeName = 'dark' } = {}) {
    this.onSelect = onSelect || (() => {});
    this.onHover = onHover || (() => {});
    this.slots = [];
    this.slotByKey = new Map();
    this.selectedKey = null;
    this.hoverSlot = null;
    this.focus = null;
    this.clock = new THREE.Clock();
    this.activity = 0;
    this.cols = 0;
    this.settled = false;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // neutral keeps ivory ivory; filmic would grey it
    renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color();
    this.scene = scene;

    // no perspective: rows stay straight and garages keep their size, like an isometric drawing
    this.camera = new THREE.OrthographicCamera(-VIEW, VIEW, VIEW, -VIEW, 1, 1000);
    this.homeOffset = new THREE.Vector3(Math.sin(YAW) * Math.cos(TILT), Math.sin(TILT), Math.cos(YAW) * Math.cos(TILT)).multiplyScalar(220);
    this.camOffset = this.homeOffset.clone();
    this.camera.position.copy(this.camOffset);

    this.labels = new CSS2DRenderer({ element: labelRoot });

    // drag pans; right-drag (two fingers on touch) turns the street around, always from the same height
    const controls = new OrbitControls(this.camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minZoom = 0.25;
    controls.maxZoom = 4;
    controls.minPolarAngle = controls.maxPolarAngle = Math.PI / 2 - TILT;
    controls.rotateSpeed = 0.6;
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    controls.addEventListener('start', () => { this.focus = null; });
    controls.addEventListener('change', () => {
      if (!this.focus) this.camOffset.copy(this.camera.position).sub(controls.target);
    });
    this.controls = controls;

    this.hemi = new THREE.HemisphereLight();
    this.key = new THREE.DirectionalLight();
    this.key.position.set(40, 60, 25);
    this.rim = new THREE.DirectionalLight();
    this.rim.position.set(-40, 20, -30);
    scene.add(this.hemi, this.key, this.rim);

    this.lot = new THREE.Group();
    this.streets = new THREE.Group();
    scene.add(this.lot, this.streets);

    this.buildGround();

    this.coreLabelEl = document.createElement('div');
    this.coreLabelEl.className = 'tag core-tag';
    this.coreLabel = new CSS2DObject(this.coreLabelEl);
    scene.add(this.coreLabel);
    this.setHost('localhost');

    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.5, 0.25);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.setTheme(themeName);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.bindPointer(canvas);

    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    this.resize();
    // the station is already standing before any data arrives
    this.ensureSpare(false);
    this.resetView(true);
    renderer.setAnimationLoop(() => this.frame());
  }

  buildGround() {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uActivity: { value: 0 }, uCenter: { value: new THREE.Vector2() },
        uBase: { value: new THREE.Color() }, uGrid: { value: new THREE.Color() }, uWave: { value: new THREE.Color() },
      },
      vertexShader: `varying vec2 vXZ; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vXZ = w.xz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform float uTime; uniform float uActivity; uniform vec2 uCenter; uniform vec3 uBase; uniform vec3 uGrid; uniform vec3 uWave; varying vec2 vXZ;
        float grid(vec2 p, float s){ vec2 q = p / s; vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q); return 1.0 - min(min(g.x, g.y), 1.0); }
        void main(){
          float r = length(vXZ - uCenter);
          float fade = exp(-r * 0.012);
          float g = grid(vXZ, 2.0) * 0.12 + grid(vXZ, 10.0) * 0.3;
          float wave = smoothstep(1.2, 0.0, abs(mod(r - uTime * (7.0 + uActivity * 10.0), 80.0) - 40.0));
          vec3 col = mix(uBase, uGrid, g * fade);
          col = mix(col, uWave, wave * 0.18 * fade);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900).rotateX(-Math.PI / 2), mat);
    this.scene.add(this.ground);
  }

  // one street in front of every row of garages
  buildStreets() {
    this.streets.children.slice().forEach((o) => { o.geometry.dispose(); o.material.dispose(); o.removeFromParent(); });
    const rows = Math.max(1, Math.ceil(this.slots.length / this.cols));
    const len = this.streetRight - this.streetLeft;
    const cx = (this.streetLeft + this.streetRight) / 2;
    for (let r = 0; r < rows; r++) {
      const z0 = r * ROW;
      const road = new THREE.Mesh(new THREE.PlaneGeometry(len, 8.6).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: theme.road }));
      road.position.set(cx, 0.01, z0 + 4.6);
      this.streets.add(road);
      for (const z of [0.4, 8.8]) {
        const edge = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.08).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: theme.edge, transparent: true, opacity: 0.5 }));
        edge.position.set(cx, 0.02, z0 + z);
        this.streets.add(edge);
      }
      const dashes = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.12).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
        transparent: true,
        uniforms: { uColor: { value: new THREE.Color(theme.dash) } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `uniform vec3 uColor; varying vec2 vUv; void main(){ float d = step(0.5, fract(vUv.x * ${Math.round(len / 2.4)}.0)); gl_FragColor = vec4(uColor, d * 0.8); }`,
      }));
      dashes.position.set(cx, 0.02, z0 + 3.4);
      this.streets.add(dashes);
    }
  }

  layout() {
    const half = (this.cols * PITCH) / 2;
    this.streetLeft = -half - 34;
    this.streetRight = half + 34;
    this.slots.forEach((s, i) => s.place((i % this.cols - (this.cols - 1) / 2) * PITCH, Math.floor(i / this.cols) * ROW));
    this.buildStreets();
    this.coreLabel.position.set(0, GH + 6.5, -GD - 2);
    const rows = Math.max(1, Math.ceil(this.slots.length / this.cols));
    this.ground.material.uniforms.uCenter.value.set(0, ((rows - 1) * ROW) / 2);
  }

  // keep a few empty garages ready and every row full
  ensureSpare(landing) {
    let free = this.slots.filter((s) => !s.key && !s.releasing).length;
    let grew = false;
    while (free < SPARE || this.slots.length % this.cols) {
      this.slots.push(new Slot(this, this.slots.length, landing));
      free++;
      grew = true;
    }
    if (grew) this.layout();
  }

  // 'light' (ivory and gold) or 'dark' (soft black and purple), switched live
  setTheme(name) {
    usePalette(name);
    this.themeName = name;
    if (shared.ready) paintShared();
    this.scene.background.set(theme.ground);
    const u = this.ground.material.uniforms;
    u.uBase.value.set(theme.ground);
    u.uGrid.value.set(theme.grid);
    u.uWave.value.set(theme.wave);
    this.hemi.color.set(theme.sky);
    this.hemi.groundColor.set(theme.low);
    this.hemi.intensity = theme.hemi;
    this.key.color.set(theme.key);
    this.key.intensity = theme.keyI;
    this.rim.color.set(theme.rim);
    this.rim.intensity = theme.rimI;
    this.renderer.toneMappingExposure = theme.exposure;
    this.bloom.enabled = theme.bloom > 0;
    this.bloom.strength = theme.bloom;
    this.scene.traverse((o) => {
      const m = o.material;
      if (m?.userData.glow && m.blending !== theme.blend) { m.blending = theme.blend; m.needsUpdate = true; }
    });
    for (const slot of this.slots) slot.retheme();
    if (this.cols) this.buildStreets();
  }

  setHost(name) {
    this.coreLabelEl.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = name;
    const s = document.createElement('span');
    s.textContent = 'this computer';
    this.coreLabelEl.append(b, s);
  }

  bindPointer(canvas) {
    let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener('pointermove', (e) => {
      this.setPointer(e);
      const slot = this.pick();
      if (slot !== this.hoverSlot) {
        this.hoverSlot = slot;
        canvas.style.cursor = slot ? 'pointer' : '';
        this.onHover(slot?.item || null);
      }
    });
    canvas.addEventListener('pointerleave', () => { this.hoverSlot = null; canvas.style.cursor = ''; });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
      this.setPointer(e);
      const slot = this.pick();
      this.onSelect(slot ? slot.key : null);
    });
  }

  setPointer(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  pick() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.slots.filter((s) => s.key).map((s) => s.hit);
    const [hit] = this.raycaster.intersectObjects(hits, false);
    return hit?.object.userData.slot || null;
  }

  update(items) {
    const seen = new Set();
    for (const item of items) {
      seen.add(item.key);
      let slot = this.slotByKey.get(item.key);
      if (!slot) {
        slot = this.slots.find((s) => s.claimable);
        if (!slot) {
          slot = new Slot(this, this.slots.length, this.settled);
          this.slots.push(slot);
          this.layout();
        }
        slot.assign(item.key);
        this.slotByKey.set(item.key, slot);
      }
      slot.setItem(item);
    }
    for (const [key, slot] of this.slotByKey) {
      if (!seen.has(key)) { slot.release(); this.slotByKey.delete(key); }
    }
    this.ensureSpare(this.settled);
    if (!this.settled) { this.settled = true; this.resetView(); }
    this.activity = items.reduce((n, i) => n + (i.kind === 'parked' ? 0 : i.connectionCount || 0), 0);
  }

  select(key) {
    this.selectedKey = key;
    const slot = key && this.slotByKey.get(key);
    if (!slot) return;
    const p = slot.group.position;
    this.focus = { target: new THREE.Vector3(p.x, 1.5, p.z + 1), zoom: Math.max(this.camera.zoom, 2.2), offset: this.camOffset.clone() };
  }

  // back to the 45° corner view, with every garage and street on screen
  resetView(instant) {
    const rows = Math.max(1, Math.ceil(this.slots.length / this.cols));
    const hw = (this.cols * PITCH + 6) / 2;
    const z0 = -GD - 1;
    const z1 = (rows - 1) * ROW + 9;
    // measure the lot's box the way the camera sees it
    const look = new THREE.Matrix4().lookAt(this.homeOffset, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)).invert();
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const x of [-hw, hw]) for (const y of [0, GH + 8]) for (const z of [z0, z1]) box.expandByPoint(v.set(x, y, z).applyMatrix4(look));
    const size = box.getSize(v);
    const aspect = this.width / this.height;
    // leave room for the header and the dock
    const zoom = THREE.MathUtils.clamp(Math.min((1.9 * VIEW * aspect) / size.x, (1.55 * VIEW) / size.y), 0.25, 3);
    const target = new THREE.Vector3(0, (GH + 8) / 2, (z0 + z1) / 2);
    this.focus = { target, zoom, offset: this.homeOffset.clone() };
    if (instant) {
      this.controls.target.copy(target);
      this.camOffset.copy(this.homeOffset);
      this.camera.position.copy(target).add(this.camOffset);
      this.camera.zoom = zoom;
      this.camera.updateProjectionMatrix();
      this.focus = null;
    }
  }

  // cars that arrive together come down the street one after another
  driveDelay() {
    const now = this.clock.elapsedTime;
    this.nextDrive = Math.max(this.nextDrive || 0, now);
    const delay = this.nextDrive - now;
    this.nextDrive += 0.25;
    return delay;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.labels.setSize(w, h);
    const aspect = w / h;
    Object.assign(this.camera, { left: -VIEW * aspect, right: VIEW * aspect, top: VIEW, bottom: -VIEW });
    this.camera.updateProjectionMatrix();
    // seen from a corner, a long thin lot turns into a long diagonal, so even phones keep 5 per row
    const cols = w < 1100 ? 5 : 7;
    if (cols !== this.cols) {
      this.cols = cols;
      if (this.slots.length) { this.ensureSpare(false); this.layout(); this.resetView(); }
    }
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const time = this.clock.elapsedTime;

    if (this.focus) {
      const k = 1 - Math.pow(0.004, dt);
      this.controls.target.lerp(this.focus.target, k);
      // swing around the street at the same distance, not through it
      this.camOffset.lerp(this.focus.offset, k).setLength(this.focus.offset.length());
      this.camera.position.copy(this.controls.target).add(this.camOffset);
      this.camera.zoom += (this.focus.zoom - this.camera.zoom) * k;
      this.camera.updateProjectionMatrix();
      if (this.controls.target.distanceTo(this.focus.target) < 0.05 && Math.abs(this.camera.zoom - this.focus.zoom) < 0.005 && this.camOffset.distanceTo(this.focus.offset) < 0.05) this.focus = null;
    }
    this.controls.update();

    const act = Math.min(1, this.activity / 30);
    this.ground.material.uniforms.uTime.value = time;
    this.ground.material.uniforms.uActivity.value = act;

    // tags shrink to just the port number when garages are small on screen
    const garagePx = (GW * this.camera.zoom * this.height) / (2 * VIEW);
    for (const slot of this.slots) {
      const sel = !!slot.key && slot.key === this.selectedKey;
      const hov = slot === this.hoverSlot;
      slot.tick(dt, time, sel, hov);
      slot.labelEl.classList.toggle('far', garagePx < 95 && !sel && !hov);
      slot.labelEl.classList.toggle('on', sel);
    }

    this.composer.render();
    this.labels.render(this.scene, this.camera);
  }
}
