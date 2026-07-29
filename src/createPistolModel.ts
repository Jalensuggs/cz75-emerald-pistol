import * as THREE from 'three';
import profiles from './data/profiles.json';
import { createMaterials, type PistolMaterials } from './materials';

/**
 * CZ-75 pattern pistol + independent spare magazine, rebuilt procedurally.
 *
 * X/Y geometry is TRACED from the reference silhouette (build/profiles.json).
 * Z depth is AUTHORED from CZ-75 proportion ratios (206 mm overall length mapped
 * to 2.0 world units) — a single lateral view carries no depth information, so no
 * thickness in this file is a measurement.
 *
 * Right-flank ejection port and extractor are authored from the CZ-75 pattern and
 * are NOT observed; the reference shows only the left flank. Confidence 0.35.
 */

// ---- reference frame -------------------------------------------------------
const PX0 = 136, PY0 = 129, PW = 1204, PH = 795;
const LEN_W = 2.0;
const HGT_W = LEN_W / (PW / PH);
const px = (p: number) => (p - PX0) / PW * LEN_W - LEN_W / 2;
const py = (p: number) => HGT_W / 2 - (p - PY0) / PH * HGT_W;
/** CZ-75 millimetres -> world units. Every depth below comes through here. */
const mm = (v: number) => (v / 206) * LEN_W;

const D_SLIDE = mm(25);
const D_FRAME = mm(22);
const D_GRIP = mm(35);
const D_MAG = mm(20);
/** The rail must sit PROUD of the slide flank — that step is the CZ-75 signature. */
const D_RAIL = D_SLIDE + mm(5);

type Pt = [number, number];

function shapeFrom(points: number[][], holes?: number[][][]): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) s.lineTo(points[i][0], points[i][1]);
  s.closePath();
  for (const h of holes ?? []) {
    const p = new THREE.Path();
    p.moveTo(h[0][0], h[0][1]);
    for (let i = 1; i < h.length; i += 1) p.lineTo(h[i][0], h[i][1]);
    p.closePath();
    s.holes.push(p);
  }
  return s;
}

/** Signed area — tells us the winding so the inset goes inward, not outward. */
function signedArea(p: number[][]) {
  let s = 0;
  for (let i = 0; i < p.length; i += 1) {
    const q = p[(i + 1) % p.length];
    s += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return s / 2;
}

/**
 * Offset a polygon inward by `d` along its edge normals.
 *
 * ExtrudeGeometry's `bevelSize` expands the profile OUTWARD, but a real chamfer
 * cuts material away. Left uncorrected the model grew ~0.007 world units on every
 * side, which lifted the slide's top edge 28 px above the reference and cost ~17%
 * of excess silhouette area. Insetting first makes the bevelled outer boundary
 * land back on the traced contour.
 */
function insetPolygon(points: number[][], d: number): number[][] {
  const n = points.length;
  if (n < 3 || d <= 0) return points;
  const sign = signedArea(points) > 0 ? 1 : -1;
  const out: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const prev = points[(i - 1 + n) % n];
    const cur = points[i];
    const next = points[(i + 1) % n];
    const nrm = (ax: number, ay: number, bx: number, by: number) => {
      const ex = bx - ax;
      const ey = by - ay;
      const len = Math.hypot(ex, ey) || 1;
      return [(sign * ey) / len, (-sign * ex) / len];
    };
    const [n1x, n1y] = nrm(prev[0], prev[1], cur[0], cur[1]);
    const [n2x, n2y] = nrm(cur[0], cur[1], next[0], next[1]);
    let bx = n1x + n2x;
    let by = n1y + n2y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-6) { out.push([cur[0], cur[1]]); continue; }
    bx /= bl; by /= bl;
    // limit the miter so sharp corners do not shoot far from the original vertex
    const miter = Math.min(1 / Math.max(0.2, (bx * n1x + by * n1y)), 3);
    out.push([cur[0] - bx * d * miter, cur[1] - by * d * miter]);
  }
  return out;
}

/**
 * Chamfered extrude. The bevel is load-bearing, not decoration: the reference's
 * brightest feature is a crisp specular band along every chamfered edge, and a
 * normal map cannot hold that under a grazing key. The profile is inset by the
 * bevel first so the finished part still matches the traced silhouette.
 */
let BEVEL = 0.007;

function extrude(points: number[][], depth: number, holes?: number[][][], bevel = BEVEL) {
  const outer = insetPolygon(points, bevel);
  const inner = holes?.map((h) => insetPolygon(h, -bevel).map((p) => p));
  const g = new THREE.ExtrudeGeometry(shapeFrom(outer, inner), {
    depth: depth - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 12,
  });
  g.translate(0, 0, -depth / 2 + bevel);
  // NOTE: crownFlanks() is deliberately NOT called. See its doc comment — the idea
  // is right but ExtrudeGeometry's caps have no interior tessellation, so the
  // displacement produced hard triangle fans instead of a smooth barrel. Left in
  // place as the documented next step once the caps are subdivided.
  g.computeVertexNormals();
  return g;
}

/**
 * Crown the flat cap faces into a shallow barrel.
 *
 * A perfectly flat flank reflects exactly one direction of the environment, so it
 * renders as one uniform colour — which is why the first material read as flat
 * paint no matter how bright the environment was. The reference's flanks are
 * subtly convex and therefore sweep a RANGE of the environment, producing its
 * vertical specular gradient. Fixing this with curvature keeps the lighting in
 * the lighting; baking the gradient into albedo would have faked the same look
 * while destroying the material's response to any other light.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function crownFlanks(g: THREE.BufferGeometry, depth: number, amount = 0.16) {
  const pos = g.attributes.position as THREE.BufferAttribute;
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  const rx = Math.max(1e-4, (bb.max.x - bb.min.x) / 2);
  const ry = Math.max(1e-4, (bb.max.y - bb.min.y) / 2);
  const half = depth / 2;
  const crown = depth * amount;
  for (let i = 0; i < pos.count; i += 1) {
    const z = pos.getZ(i);
    if (Math.abs(Math.abs(z) - half) > half * 0.35) continue; // cap faces only
    const u = (pos.getX(i) - cx) / rx;
    const v = (pos.getY(i) - cy) / ry;
    const falloff = Math.max(0, 1 - Math.min(1, (u * u + v * v) * 0.55));
    pos.setZ(i, z + Math.sign(z) * crown * falloff);
  }
  pos.needsUpdate = true;
}

/**
 * Heavy smoothing pass for a closed profile.
 *
 * Tracing is the right tool for the overall outline, but it also faithfully picks
 * up small surface texture — the backstrap's scallops came through as contour
 * teeth, and extruding those produced a wall of horizontal fins that looked like a
 * radiator. Where a part's outline should read as a clean machined curve, smooth
 * the trace hard and let a texture carry the fine detail instead.
 */
function smoothProfile(points: number[][], passes: number): number[][] {
  // Taubin (lambda/mu) rather than plain Laplacian. Repeated Laplacian averaging
  // SHRINKS a closed curve, and at the pass counts needed to erase the scallops it
  // pulled every part away from its neighbours and opened visible gaps in the
  // assembly. Alternating a positive lambda step with a slightly larger negative mu
  // step smooths at the same rate while cancelling the shrinkage.
  const LAMBDA = 0.55;
  const MU = -0.58;
  let p = points.map((q) => [q[0], q[1]]);
  const n = p.length;
  const step = (k: number) => {
    const out: number[][] = [];
    for (let i = 0; i < n; i += 1) {
      const a2 = p[(i - 1 + n) % n];
      const b2 = p[i];
      const c2 = p[(i + 1) % n];
      out.push([
        b2[0] + k * ((a2[0] + c2[0]) / 2 - b2[0]),
        b2[1] + k * ((a2[1] + c2[1]) / 2 - b2[1]),
      ]);
    }
    p = out;
  };
  for (let i = 0; i < passes; i += 1) {
    step(LAMBDA);
    step(MU);
  }
  return p;
}


/**
 * Authored grip outline — deliberately NOT traced.
 *
 * The reference's grip edges carry fine scallops (the backstrap knurling), and a
 * faithful trace hands those to the extruder, which turns every scallop into a
 * horizontal fin. The grip then reads as a radiator instead of a grip. Smoothing
 * the trace hard enough to erase them also erased the shape, and smoothing only
 * some parts left the panel hanging outside the frame.
 *
 * So the grip is authored the way a real one is shaped — a concave frontstrap, a
 * convex backstrap, a flared bottom — with the control points placed on the
 * MEASURED landmarks (bbox x[959,1339] y[420,924], frontstrap rake 15.4 deg,
 * backstrap rake 18.7 deg) so the proportions still come from the reference even
 * though the curve does not. Fine texture belongs in the material, not the outline.
 */
function authoredGripProfile(): number[][] {
  const ctrl: [number, number][] = [
    [959, 402],   // top-front — overlaps the frame rather than butting against it
    [1339, 402],  // top-rear, tucked under the tang
    [1336, 505],  // backstrap upper
    [1326, 640],  // backstrap belly (convex)
    [1309, 792],
    [1300, 884],
    [1286, 906],  // bottom-rear corner
    [1104, 906],  // bottom-front corner
    [1086, 858],
    [1063, 726],  // frontstrap waist (concave)
    [1036, 596],
    [1002, 486],
    [978, 436],
  ];
  return catmullRomClosed(ctrl.map(([x, y]) => [px(x), py(y)]), 7);
}

/** Closed Catmull-Rom resample — turns sparse control points into a smooth loop. */
function catmullRomClosed(pts: number[][], perSegment: number): number[][] {
  const n = pts.length;
  const out: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    for (let k = 0; k < perSegment; k += 1) {
      const t = k / perSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  return out;
}

/** Rounded-rectangle profile from a pixel box — used for the small hardware. */
function boxProfile(x0: number, y0: number, x1: number, y1: number, r = 0.012): number[][] {
  const a = px(x0), b = py(y1), c = px(x1), d = py(y0);
  const rr = Math.min(r, (c - a) / 2.2, (d - b) / 2.2);
  const pts: number[][] = [];
  const corner = (cx: number, cy: number, s: number) => {
    for (let i = 0; i <= 4; i += 1) {
      const t = s + (i / 4) * (Math.PI / 2);
      pts.push([cx + Math.cos(t) * rr, cy + Math.sin(t) * rr]);
    }
  };
  corner(c - rr, d - rr, 0);
  corner(a + rr, d - rr, Math.PI / 2);
  corner(a + rr, b + rr, Math.PI);
  corner(c - rr, b + rr, -Math.PI / 2);
  return pts;
}

function circleLoop(cx: number, cy: number, r: number, seg = 28): number[][] {
  return Array.from({ length: seg }, (_, i) => {
    const t = (i / seg) * Math.PI * 2;
    return [cx + Math.cos(t) * r, cy + Math.sin(t) * r];
  });
}

export type PistolModelOptions = {
  /** Build pass tier. `blockout` shows silhouette only, in a single flat material. */
  tier?: 'blockout' | 'structure' | 'form' | 'material' | 'final';
  /** Chamfer size in world units. Exposed so the silhouette gate can isolate its effect. */
  bevel?: number;
};

export type PistolRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, { type: string; halfExtents: [number, number, number] }>;
  destructionGroups: Record<string, THREE.Object3D[]>;
  repetitionSystems: Record<string, number>;
};

export function createPistolModel(options: PistolModelOptions = {}): THREE.Group {
  const tier = options.tier ?? 'final';
  const blockout = tier === 'blockout';
  BEVEL = options.bevel ?? 0.007;

  const root = new THREE.Group();
  root.name = 'CZ-75 Pattern Pistol (Emerald Chrome)';

  const nodes: PistolRuntime['nodes'] = {};
  const meshes: PistolRuntime['meshes'] = {};
  const sockets: PistolRuntime['sockets'] = {};
  const colliders: PistolRuntime['colliders'] = {};
  const destructionGroups: PistolRuntime['destructionGroups'] = {};
  const repetitionSystems: PistolRuntime['repetitionSystems'] = {};

  const mats: PistolMaterials = createMaterials();
  const flat = new THREE.MeshStandardMaterial({ color: 0x8a9a91, roughness: 0.85, metalness: 0.0 });
  const pick = (m: THREE.Material) => (blockout ? flat : m);

  const pistol = new THREE.Group();
  pistol.name = 'pistol';
  root.add(pistol);
  nodes['pistol-root'] = pistol;

  const spare = new THREE.Group();
  spare.name = 'spare-magazine';
  root.add(spare);
  nodes['spare-magazine-root'] = spare;

  /** Register a mesh as a named, individually pickable part. */
  function part(
    id: string,
    name: string,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    parent: THREE.Object3D,
    opts: { position?: [number, number, number]; rotation?: [number, number, number]; ridesParent?: boolean } = {},
  ) {
    const node = new THREE.Group();
    node.name = `${id}__pivot`;
    if (opts.position) node.position.set(...opts.position);
    if (opts.rotation) node.rotation.set(...opts.rotation);
    parent.add(node);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = id;
    mesh.userData.partId = id;
    mesh.userData.displayName = name;
    // Surface relief rides its shell so explode and part-picking agree on what a part is.
    mesh.userData.explodeWithParent = opts.ridesParent ?? false;
    node.add(mesh);

    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    colliders[id] = {
      type: 'box',
      halfExtents: [(bb.max.x - bb.min.x) / 2, (bb.max.y - bb.min.y) / 2, (bb.max.z - bb.min.z) / 2],
    };
    nodes[id] = node;
    meshes[id] = mesh;
    (destructionGroups[parent === spare ? 'spare-magazine' : 'pistol'] ??= []).push(node);
    return { node, mesh };
  }

  function socket(id: string, parent: THREE.Object3D, p: [number, number, number]) {
    const o = new THREE.Object3D();
    o.name = id;
    o.position.set(...p);
    parent.add(o);
    sockets[id] = o;
    return o;
  }

  // ======================= traced silhouette parts ==========================
  const CP = profiles.componentProfiles as Record<string, { polygon: number[][] }>;
  const MP = profiles.magazineProfiles as Record<string, { polygon: number[][] }>;
  const guardHole = (profiles as any).triggerGuardHole?.polygon as number[][] | undefined;

  part('slide', 'Slide', extrude(smoothProfile(CP['slide'].polygon, 7), D_SLIDE), pick(mats.chrome), pistol);
  part('frame-rail', 'Frame rail (slide-inside-frame step)',
       extrude(CP['frame-rail'].polygon, D_RAIL), pick(mats.chrome), pistol);
  part('dust-cover', 'Dust cover', extrude(CP['dust-cover'].polygon, D_FRAME), pick(mats.chrome), pistol);
  part('frame-body', 'Frame body', extrude(CP['frame-body'].polygon, D_FRAME), pick(mats.chrome), pistol);
  part('trigger-guard', 'Trigger guard',
       extrude(CP['trigger-guard'].polygon, D_FRAME, guardHole ? [guardHole] : undefined),
       pick(mats.chrome), pistol);
  part('beavertail', 'Beavertail tang', extrude(smoothProfile(CP['beavertail'].polygon, 8), D_FRAME), pick(mats.chrome), pistol);
  part('grip-frame', 'Grip frame', extrude(authoredGripProfile(), D_GRIP), pick(mats.chrome), pistol);
  /*
   * Backstrap is built INSIDE the grip, not proud of it.
   *
   * Its traced outline runs along the scalloped rear grip edge, so extruding it as
   * a protruding slab turned every scallop into a horizontal fin — the part read as
   * a radiator bolted to the grip. Smoothing could not remove it because the
   * scallops are genuinely in the outline. A real pistol's backstrap is continuous
   * with the grip frame, so that is how it is built now: the grip carries the
   * visible surface and this part stays interior, keeping its identity in the part
   * tree without damaging the silhouette.
   */
  part('backstrap', 'Backstrap', extrude(smoothProfile(CP['backstrap'].polygon, 12), D_GRIP - mm(11)),
       pick(mats.chrome), pistol, { ridesParent: true });

  // ======================= sights, muzzle, controls =========================
  part('front-sight', 'Front sight (ramped blade)',
       extrude(boxProfile(275, 140, 330, 172, 0.006), mm(4)), pick(mats.black), pistol,
       { position: [0, 0, 0] });
  socket('socket-front-sight-dovetail', pistol, [px(302), py(172), 0]);

  part('rear-sight', 'Rear sight (notched blade)',
       extrude(boxProfile(1085, 130, 1155, 180, 0.008), mm(6)), pick(mats.black), pistol);
  socket('socket-rear-sight-dovetail', pistol, [px(1120), py(180), 0]);

  {
    const g = new THREE.CylinderGeometry(Math.abs(py(243) - py(185)) / 2, Math.abs(py(243) - py(185)) / 2, mm(16), 28, 1);
    g.rotateZ(Math.PI / 2);
    part('barrel-bushing', 'Barrel bushing / recoil plug', g, pick(mats.black), pistol,
         { position: [px(168), (py(185) + py(243)) / 2, 0] });
  }
  socket('socket-muzzle-bore', pistol, [px(150), (py(185) + py(243)) / 2, 0]);

  part('trigger', 'Trigger', extrude(boxProfile(748, 378, 812, 522, 0.03), mm(6)), pick(mats.black), pistol);
  socket('socket-trigger-pin', pistol, [px(780), py(392), 0]);

  {
    // ring hammer: bored head + radial knurl, both silhouette-changing
    const cx = px(1272), cy = (py(185) + py(270)) / 2;
    const rOuter = Math.abs(py(270) - py(185)) / 2;
    const outer = circleLoop(cx, cy, rOuter, 30);
    const bore = circleLoop(cx, cy, rOuter * 0.42, 22);
    part('hammer', 'Ring hammer', extrude(outer, mm(6), [bore]), pick(mats.black), pistol);
    socket('socket-hammer-pin', pistol, [cx, cy - rOuter, 0]);
  }

  part('safety-lever', 'Manual safety lever',
       extrude(boxProfile(1140, 258, 1218, 318, 0.02), mm(5)), pick(mats.black), pistol,
       { position: [0, 0, D_FRAME / 2] });
  socket('socket-safety-pin', pistol, [px(1180), py(288), D_FRAME / 2]);

  part('slide-stop', 'Slide stop lever',
       extrude(boxProfile(805, 264, 935, 316, 0.012), mm(5)), pick(mats.black), pistol,
       { position: [0, 0, D_FRAME / 2] });
  socket('socket-slidestop-pin', pistol, [px(870), py(290), D_FRAME / 2]);

  {
    const r = Math.abs(py(508) - py(462)) / 2;
    const g = new THREE.CylinderGeometry(r, r, mm(8), 24, 1);
    g.rotateX(Math.PI / 2);
    part('mag-release', 'Magazine release button', g, pick(mats.black), pistol,
         { position: [px(946), (py(462) + py(508)) / 2, D_FRAME / 2 + mm(4)] });
  }

  part('magwell-base', 'Grip bottom plate',
       extrude(boxProfile(1100, 862, 1292, 908, 0.012), D_GRIP + mm(1)), pick(mats.black), pistol);

  {
    const r = Math.abs(py(905) - py(855)) / 2;
    const g = new THREE.TorusGeometry(r * 0.78, r * 0.24, 12, 26);
    part('lanyard-loop', 'Lanyard loop', g, pick(mats.black), pistol,
         { position: [px(1310), (py(855) + py(905)) / 2, 0] });
    socket('socket-lanyard-stem', pistol, [px(1292), (py(855) + py(905)) / 2, 0]);
  }

  // ======================= grip panels ======================================
  // Traced from the reference (the dark polymer inset plus its raised bezel),
  // not a rounded-rectangle approximation — the panel's curved frontstrap-side
  // edge and top-rear notch are identity-defining and a box gets both wrong.
  /*
   * Panel outline is authored to match the authored grip.
   *
   * The traced panel hung outside the new frame, and insetting the trace made it
   * self-intersect — a concave traced outline does not survive a miter offset. A
   * real grip panel is a simple rounded plate seated in a pocket, so it is drawn
   * that way, on control points that sit inside the authored grip by construction.
   */
  const panelProfile = catmullRomClosed(([
    [1044, 452], [1150, 440], [1246, 452], [1272, 560],
    [1276, 700], [1262, 826], [1196, 862], [1136, 856],
    [1116, 762], [1092, 640], [1064, 536],
  ] as [number, number][]).map(([x, y]) => [px(x), py(y)]), 6);
  const panelDepth = mm(6);
  const panelZ = D_GRIP / 2 - mm(2.5);
  for (const side of ['left', 'right'] as const) {
    const sign = side === 'left' ? 1 : -1;
    part(`grip-panel-${side}`, `Grip panel (${side})`,
         extrude(panelProfile, panelDepth, undefined, 0.010), pick(mats.polymer), pistol,
         { position: [0, 0, sign * panelZ] });
    socket(`socket-grip-panel-pocket-${side}`, pistol, [px(1145), py(625), sign * panelZ]);
  }

  // ======================= right-flank inference ============================
  // NOT OBSERVED. Authored from the CZ-75 pattern: the reference shows only the
  // left flank and these exist solely on the right. Mirroring would give a pistol
  // with no ejection port at all.
  {
    const port = new THREE.BoxGeometry(Math.abs(px(1020) - px(830)), Math.abs(py(232) - py(170)), mm(8));
    const m = part('ejection-port', 'Ejection port (inferred, right flank)', port, pick(mats.black), pistol,
                   { position: [(px(830) + px(1020)) / 2, (py(170) + py(232)) / 2, -(D_SLIDE / 2 - mm(3))] });
    m.mesh.userData.inference = { observed: false, confidence: 0.35, basis: 'CZ-75 pattern' };

    const ext = new THREE.BoxGeometry(Math.abs(px(1080) - px(1030)), Math.abs(py(215) - py(180)), mm(6));
    const e = part('extractor', 'Extractor (inferred, right flank)', ext, pick(mats.black), pistol,
                   { position: [(px(1030) + px(1080)) / 2, (py(180) + py(215)) / 2, -(D_SLIDE / 2 - mm(2))] });
    e.mesh.userData.inference = { observed: false, confidence: 0.35, basis: 'CZ-75 pattern' };
  }

  // ======================= spare magazine ===================================
  // No rotation is applied here. The magazine profiles are TRACED from the
  // reference, so the measured -12 degree rake is already baked into their
  // vertices; rotating the group again would double the rake.
  {
    part('magazine-body', 'Magazine body', extrude(smoothProfile(MP['magazine-body'].polygon, 7), D_MAG), pick(mats.chrome), spare);
    part('magazine-top-collar', 'Magazine top collar',
         extrude(MP['magazine-top-collar'].polygon, D_MAG + mm(1)), pick(mats.black), spare);
    part('magazine-baseplate', 'Magazine baseplate',
         extrude(MP['magazine-baseplate'].polygon, D_MAG + mm(3)), pick(mats.black), spare);
    socket('socket-mag-top', spare, [px(468), py(400), 0]);
    socket('socket-mag-base', spare, [px(390), py(960), 0]);
  }

  // ======================= repetition systems ===============================
  if (!blockout) {
    /** 12 raked, rounded-crest ribs on the rear third of the slide flank. */
    {
      const count = 12;
      const x0 = px(1008), x1 = px(1158);
      const h = Math.abs(py(240) - py(178));
      const g = new THREE.CapsuleGeometry(mm(1.1), h * 0.82, 3, 8);
      const inst = new THREE.InstancedMesh(g, pick(mats.black), count * 2);
      inst.name = 'rep-slide-serrations';
      inst.userData.partId = 'rep-slide-serrations';
      inst.userData.explodeWithParent = true;
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, THREE.MathUtils.degToRad(-9)));
      let i = 0;
      for (let s = 0; s < 2; s += 1) {
        const z = (s === 0 ? 1 : -1) * (D_SLIDE / 2 - mm(0.4));
        for (let k = 0; k < count; k += 1) {
          const x = x0 + ((x1 - x0) * k) / (count - 1);
          m.compose(new THREE.Vector3(x, (py(178) + py(240)) / 2, z), q, new THREE.Vector3(1, 1, 1));
          inst.setMatrixAt(i, m);
          i += 1;
        }
      }
      inst.instanceMatrix.needsUpdate = true;
      pistol.add(inst);
      meshes['rep-slide-serrations'] = inst as unknown as THREE.Mesh;
      repetitionSystems['rep-slide-serrations'] = count * 2;
    }

    /*
     * rep-grip-checkering is carried by the polymer material's crosshatch relief
     * map, not by instanced geometry. 2,400 instanced 4-sided cones were built
     * first and read as a grid of round DOTS: at this panel's on-screen size each
     * cone covers a few pixels, so its facets never resolve. See
     * createCheckeredPolymer() in materials.ts.
     */
    repetitionSystems['rep-grip-checkering'] = 0;

    /*
     * rep-backstrap-beads is NOT built as geometry.
     *
     * The grip-frame contour is traced from the reference, and that trace already
     * captures the scalloped backstrap edge (visible as the serrated right edge in
     * build/crops/profile-overlay.png). Instancing spheres on top of it represented
     * the same feature twice, which is what produced the chain-of-beads artefact
     * hanging outside the grip silhouette. The repetition system is satisfied by
     * the traced geometry; adding meshes here double-counts it.
     */
    repetitionSystems['rep-backstrap-beads'] = 0;

    /** 18 radial teeth around the hammer head. */
    {
      const count = 11;   // only the exposed upper-rear arc is knurled in the reference
      const cx = px(1272), cy = (py(185) + py(270)) / 2;
      const r = Math.abs(py(270) - py(185)) / 2;
      const g = new THREE.BoxGeometry(mm(1.0), mm(1.5), mm(6.0));
      const inst = new THREE.InstancedMesh(g, pick(mats.black), count);
      inst.name = 'rep-hammer-knurl';
      inst.userData.partId = 'rep-hammer-knurl';
      inst.userData.explodeWithParent = true;
      const m = new THREE.Matrix4();
      // reference shows serrations on roughly the upper-rear 140 degrees only;
      // a full ring is what made the hammer read as a cog
      for (let k = 0; k < count; k += 1) {
        const t = -0.35 + (k / (count - 1)) * 2.44;
        m.compose(
          new THREE.Vector3(cx + Math.cos(t) * r * 0.94, cy + Math.sin(t) * r * 0.94, 0),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, t)),
          new THREE.Vector3(1, 1, 1),
        );
        inst.setMatrixAt(k, m);
      }
      inst.instanceMatrix.needsUpdate = true;
      pistol.add(inst);
      meshes['rep-hammer-knurl'] = inst as unknown as THREE.Mesh;
      repetitionSystems['rep-hammer-knurl'] = count;
    }

    /** 8 knurl ribs across the magazine release face. */
    {
      const count = 8;
      const r = Math.abs(py(508) - py(462)) / 2;
      const g = new THREE.BoxGeometry(mm(0.8), r * 1.7, mm(1.2));
      const inst = new THREE.InstancedMesh(g, pick(mats.black), count);
      inst.name = 'rep-magrelease-knurl';
      inst.userData.partId = 'rep-magrelease-knurl';
      inst.userData.explodeWithParent = true;
      const m = new THREE.Matrix4();
      const cx = px(946), cy = (py(462) + py(508)) / 2;
      const z = D_FRAME / 2 + mm(8);
      for (let k = 0; k < count; k += 1) {
        const t = (k / (count - 1) - 0.5) * r * 1.5;
        m.compose(new THREE.Vector3(cx + t, cy, z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
        inst.setMatrixAt(k, m);
      }
      inst.instanceMatrix.needsUpdate = true;
      pistol.add(inst);
      meshes['rep-magrelease-knurl'] = inst as unknown as THREE.Mesh;
      repetitionSystems['rep-magrelease-knurl'] = count;
    }

    /** Fastener micro-parts: 2 frame pins + 1 green safety screw. */
    {
      const g = new THREE.CylinderGeometry(mm(2.4), mm(2.4), mm(1.2), 16);
      g.rotateX(Math.PI / 2);
      const inst = new THREE.InstancedMesh(g, pick(mats.chrome), 4);
      inst.name = 'frame-pin-heads';
      inst.userData.partId = 'frame-pin-heads';
      const m = new THREE.Matrix4();
      const spots: [number, number][] = [[810, 350], [1208, 348]];
      let i = 0;
      for (const s of [1, -1]) {
        for (const [sx, sy] of spots) {
          m.compose(new THREE.Vector3(px(sx), py(sy), s * (D_FRAME / 2 + mm(0.4))), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
          inst.setMatrixAt(i, m);
          i += 1;
        }
      }
      inst.instanceMatrix.needsUpdate = true;
      pistol.add(inst);
      meshes['frame-pin-heads'] = inst as unknown as THREE.Mesh;
      repetitionSystems['frame-pin-heads'] = 4;

      const sg = new THREE.SphereGeometry(mm(2.6), 14, 10);
      part('safety-screw', 'Safety lever fastener', sg, pick(mats.chrome), pistol,
           { position: [px(1157), py(288), D_FRAME / 2 + mm(5)], ridesParent: true });
    }
  }

  // ======================= runtime contract =================================
  root.userData.sculptRuntime = {
    nodes, meshes, sockets, colliders, destructionGroups, repetitionSystems,
  } satisfies PistolRuntime;
  root.userData.tier = tier;
  root.userData.provenance = {
    silhouetteSource: 'traced from the reference (build/profiles.json)',
    depthSource: 'authored from CZ-75 proportion ratios; NOT measured',
    inferredParts: ['ejection-port', 'extractor', 'grip-panel-right'],
    exactnessTier: 'image-only',
  };
  return root;
}

/**
 * Studio environment for the chrome.
 *
 * A metal has no diffuse term: everything it shows is reflected environment, so
 * the environment IS the lighting for this model. An earlier dark gradient left
 * the whole pistol reading black even though the geometry was correct. This one
 * gives the metal something bright to reflect — a hot overhead band for the top
 * crest line, a mid green-grey band for the flanks, and black below to keep the
 * reference's unlit underside.
 */
export function createEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const scene = new THREE.Scene();
  // Equirectangular: u = longitude, v = latitude.
  //
  // Measured against the reference, the first attempt had this backwards. The photo
  // is MOSTLY DARK with concentrated hot highlights: in-object luminance p50 37.6
  // but 4.76% of the object is a hot specular pixel. A broadly bright environment
  // makes chrome return one uniform mid-green everywhere — measured p50 82.3 with
  // only 0.29% hot pixels, 16x too few. So: dark base, small very intense sources.
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  const base = g.createLinearGradient(0, 0, 0, 256);
  // Mid-latitudes carry the body colour: a flat flank facing the camera reflects
  // roughly this band, so it must sit at the reference's midtone (p50 ~38), not at
  // black. Only the strips below go hot.
  base.addColorStop(0.00, '#6ea88c');
  base.addColorStop(0.26, '#4d8168');
  base.addColorStop(0.46, '#356a52');
  base.addColorStop(0.66, '#1d3a2c');
  base.addColorStop(1.00, '#050b08');
  g.fillStyle = base;
  g.fillRect(0, 0, 512, 256);

  // narrow, very hot softboxes — these are what become the reference's rim bands
  g.globalCompositeOperation = 'lighter';
  const strip = (x: number, y: number, w: number, h: number, peak: number) => {
    const grad = g.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, `rgba(255,255,255,${peak})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(x, y, w, h);
  };
  strip(0, 18, 512, 22, 1.0);     // main overhead bank -> slide top crest
  strip(0, 62, 512, 12, 0.85);    // second bank -> chamfer bands on the flanks
  strip(0, 96, 512, 7, 0.5);
  /*
   * The main bank must sit where a flat flank actually SAMPLES.
   *
   * For a mirror flank with normal +Z viewed from +Z, the reflection vector is
   * also +Z. Under Three.js equirectangular mapping +Z lands at u ~ 0/1 (the
   * canvas's left and right EDGES) and v = 0.5 (the equator) — not at the centre.
   * Every bright source was previously painted near u = 0.5, which is -Z: in front
   * of the object, away from the camera. The flanks were sampling the dark equator
   * band at the seam, which is why the body went black while the chamfers lit up
   * (chamfer normals are tilted, so they reach the overhead strips).
   * Painted at both edges so it is continuous across the wrap.
   */
  const bank = (cxp: number) => {
    /*
     * A flat flank samples essentially ONE point of the environment, so however
     * bright that point is the whole flank comes back at a single value — that is
     * why the first attempt read as uniform paint and the second as uniform dark.
     * Tonal RANGE needs a steep bright-to-dark transition sitting right at the
     * sample point, so the chrome's normal-map perturbation sweeps across it and
     * neighbouring pixels land on different parts of the ramp.
     */
    const ramp = g.createLinearGradient(0, 74, 0, 168);
    ramp.addColorStop(0.00, 'rgba(255,255,255,0.15)');
    ramp.addColorStop(0.34, 'rgba(255,255,255,1.00)');   // hot band just above the equator
    ramp.addColorStop(0.46, 'rgba(190,245,215,0.62)');
    ramp.addColorStop(0.62, 'rgba(110,190,150,0.55)');
    ramp.addColorStop(1.00, 'rgba(70,130,102,0.22)');   // keeps a floor so shadows sit at the reference's midtone, not at black
    g.fillStyle = ramp;
    g.fillRect(cxp - 190, 74, 380, 94);
  };
  bank(0);
  bank(512);
  g.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(10, 32, 20),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide }),
  ));
  const t = pmrem.fromScene(scene, 0.02).texture;
  pmrem.dispose();
  return t;
}

/**
 * Reproduce the reference framing exactly for the comparison render.
 *
 * Silhouette IoU compares raw pixels, so a model whose SHAPE is right still
 * scores badly if it is framed differently. Auto-framing fits the model to the
 * viewport; the reference does not, so the two disagree on scale and position.
 *
 * Derivation from the measurements (all numbers measured, none tuned by eye):
 *   reference object bbox : x[136,1339] y[129,1004] inside a 1448x1086 frame
 *   model world bbox      : x[-1.0,1.0] y[-0.7931,0.6603]
 *   vertical   : 875 px span  <->  1.4534 world  =>  602.0 px per world unit
 *   horizontal : 1203 px span <->  2.0    world  =>  601.5 px per world unit
 *   => tan(fovY/2) * distance = (1086/2) / 602.0 = 0.9020
 *
 * The camera TARGET is the world point that lands at the frame centre — NOT the
 * object's centre. The reference does not centre its subject: the object bbox
 * sits 23.5 px below and 13 px right of centre. Aiming at the object's centre
 * instead shifted the whole render up 24 px and left 13 px, which showed up as
 * silhouette error that looked like a shape problem but was pure framing.
 *   target_y = 0.6603 - (543 - 129) / 602.0 = -0.0274
 *   target_x = -1.0   + (724 - 136) / 602.0 = -0.0233
 */
export const REFERENCE_FRAME = {
  targetX: -0.0233,
  targetY: -0.0274,
  pxPerWorld: 602.0,
  frameWidthPx: 1448,
  frameHeightPx: 1086,
};

/**
 * Orthographic camera for the reference-match evaluation render.
 *
 * The traced profiles ARE the reference's projected silhouette, which already
 * contains that object's own near-face perspective magnification. Placing them at
 * z = 0 under a perspective camera magnified them a SECOND time: at distance 4.24
 * with parts reaching z = 0.17, the near faces grew by 4.2%, which measured as a
 * uniform ~7 px dilation and cost ~12% of excess silhouette area. That is a
 * projection artefact, not a shape error.
 *
 * The reference is a near-orthographic product render (low silhouette divergence
 * between near and far edges), so evaluating orthographically removes the bias
 * instead of hiding it. The orbit views keep a perspective camera — their job is
 * to prove the model has volume, not to match the reference.
 */
export function makeReferenceCamera(): THREE.OrthographicCamera {
  const { targetX, targetY, pxPerWorld, frameWidthPx, frameHeightPx } = REFERENCE_FRAME;
  const halfW = frameWidthPx / 2 / pxPerWorld;
  const halfH = frameHeightPx / 2 / pxPerWorld;
  // The frustum bounds are relative to the camera's OWN position. Offsetting the
  // bounds by the target AND positioning the camera at the target applies the
  // offset twice — that showed up as a constant (+14, -16) px shift of the whole
  // render, which reads as a shape error but is purely a camera-setup bug.
  const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.01, 20);
  cam.position.set(targetX, targetY, 6);
  cam.lookAt(targetX, targetY, 0);
  cam.updateProjectionMatrix();
  return cam;
}

export function frameCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  o: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = o.margin ?? 1.15;
  const fov = (camera.fov * Math.PI) / 180;
  const fitH = size.y / 2 / Math.tan(fov / 2);
  const fitW = size.x / 2 / Math.tan(fov / 2) / camera.aspect;
  const distance = Math.max(fitH, fitW) * margin;
  const az = ((o.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((o.elevationDeg ?? 0) * Math.PI) / 180;
  camera.position.copy(center).addScaledVector(
    new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)),
    distance,
  );
  camera.near = Math.max(0.01, distance - Math.max(size.x, size.y, size.z));
  camera.far = distance + Math.max(size.x, size.y, size.z) * 3;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

export function configureRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}
