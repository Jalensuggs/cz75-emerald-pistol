import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  createPistolModel,
  createEnvironment,
  configureRenderer,
  frameCamera,
  makeReferenceCamera,
  type PistolRuntime,
  type PistolModelOptions,
} from './createPistolModel';

/**
 * Review viewpoints mirror qualityTargets.reviewCameraDefinitions in the spec.
 * `reference-match` reproduces the source framing (left lateral, muzzle toward -X).
 * The orbit views exist to prove the model is volumetric rather than a flat card —
 * the degenerate-view failure a single-lateral-view reconstruction is most at risk of.
 */
const VIEWS = {
  'reference-match': { azimuthDeg: 0, elevationDeg: 0, margin: 1.06 },
  'orbit-front-quarter': { azimuthDeg: -52, elevationDeg: 16, margin: 1.18 },
  'orbit-rear-quarter': { azimuthDeg: 56, elevationDeg: 20, margin: 1.18 },
  'grazing-top': { azimuthDeg: 12, elevationDeg: 62, margin: 1.18 },
} as const;
type ViewId = keyof typeof VIEWS;

const params = new URLSearchParams(location.search);
const viewId = (params.get('view') ?? 'reference-match') as ViewId;
const view = VIEWS[viewId] ?? VIEWS['reference-match'];
const tier = (params.get('tier') ?? 'final') as NonNullable<PistolModelOptions['tier']>;
/**
 * eval mode = the evaluation render: plain renderer, no HUD, no controls.
 * Post FX would blow highlights and soften edges, corrupting the deterministic
 * IoU / edge / blowout signals the review gates depend on.
 */
const evalMode = params.get('mode') === 'eval';
const explode = Number(params.get('explode') ?? '0');

const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
// eval renders go to the gates via toDataURL, which exports the BACKING STORE.
// At devicePixelRatio 2 that is 2896x2172 against a 1448x1086 reference, and the
// gates then compare two differently-sized images. Pin to 1 for evaluation.
renderer.setPixelRatio(evalMode ? 1 : Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
configureRenderer(renderer);
// ACES compresses highlights hard; a little headroom is what lets the specular
// bands actually clip bright the way the reference's do.
renderer.toneMappingExposure = 0.72;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000); // reference is a pure black studio sweep
scene.environment = createEnvironment(renderer);

const bevelParam = params.get('bevel');
const model = createPistolModel({ tier, bevel: bevelParam === null ? undefined : Number(bevelParam) });
scene.add(model);

// lighting authored in the spec's lookDevTargets.lightingPass
const key = new THREE.DirectionalLight(0xf2fff8, 2.1);
key.position.set(-2.2, 2.6, 3.4);
scene.add(key);

const rim = new THREE.DirectionalLight(0xcfffe6, 1.9);
rim.position.set(0.4, 3.6, -0.8);
scene.add(rim);

const fill = new THREE.DirectionalLight(0x7fbfa0, 0.22);
fill.position.set(2.4, -0.6, 2.2);
scene.add(fill);

// Ambient lifts EVERY pixel, which is exactly what flattened the midtones
// (measured p50 82 against the reference's 38). Keep it to a floor that stops
// black parts crushing, and let the environment do the actual lighting.
scene.add(new THREE.AmbientLight(0x0d1a13, 0.18));

/**
 * The reference view uses an orthographic camera locked to the measured reference
 * framing; the orbit views use perspective. Matching framing matters because IoU
 * compares raw pixels, so a correct shape framed differently still scores badly.
 */
const isRef = viewId === 'reference-match';
const perspective = new THREE.PerspectiveCamera(24, innerWidth / innerHeight, 0.01, 100);
const camera: THREE.Camera = isRef ? makeReferenceCamera() : perspective;
const applyView = () => {
  if (isRef) return;
  perspective.aspect = innerWidth / innerHeight;
  frameCamera(perspective, model, view);
};
applyView();

/**
 * Assembly gate: separation must SCALE the layout about the model centre.
 * Pushing every part the same distance translates the arrangement without
 * opening any gap between neighbours.
 */
function applyExplode(amount: number) {
  const runtime = model.userData.sculptRuntime as PistolRuntime;
  const centre = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
  for (const node of Object.values(runtime.nodes)) {
    if (node === model) continue;
    const base: THREE.Vector3 = (node.userData.explodeBase ??= node.position.clone());
    node.position.copy(base);
    node.updateWorldMatrix(true, false);
    const world = node.getWorldPosition(new THREE.Vector3());
    const target = world.clone().sub(centre).multiplyScalar(1 + amount).add(centre);
    const parent = node.parent!;
    parent.updateWorldMatrix(true, false);
    node.position.copy(parent.worldToLocal(target));
  }
}
if (explode > 0) applyExplode(explode);

let controls: OrbitControls | null = null;
if (!evalMode) {
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.copy(new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3()));

  const runtime = model.userData.sculptRuntime as PistolRuntime;
  let tris = 0;
  model.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!g) return;
    const n = g.index ? g.index.count / 3 : (g.attributes?.position?.count ?? 0) / 3;
    tris += n * ((o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1);
  });
  document.getElementById('hud')!.textContent =
    `view ${viewId}  tier ${tier}\n` +
    `parts ${Object.keys(runtime.meshes).length}   tris ${Math.round(tris).toLocaleString()}\n` +
    `?view=reference-match|orbit-front-quarter|orbit-rear-quarter|grazing-top\n` +
    `?tier=blockout|final   ?mode=eval   ?explode=0.6`;
} else {
  document.body.classList.add('eval');
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  applyView();
});

renderer.setAnimationLoop(() => {
  controls?.update();
  renderer.render(scene, camera);
});

/** Dev-only: hand the current frame to the vite save endpoint for the review gates. */
async function saveRender(name: string) {
  renderer.render(scene, camera);
  const dataUrl = renderer.domElement.toDataURL('image/png');
  const res = await fetch('/__save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, dataUrl }),
  });
  return res.json();
}

Object.assign(window, { __saveRender: saveRender, __model: model, __scene: scene, __camera: camera });

requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    (window as unknown as { __renderReady?: boolean }).__renderReady = true;
  }),
);
