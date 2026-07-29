import * as THREE from 'three';

/**
 * Deterministic PRNG. Every procedural surface must be reproducible across
 * renders or the review gates compare two different objects.
 */
function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function valueNoise2D(seed: number, gridW: number, gridH: number) {
  const rnd = mulberry32(seed);
  const g = new Float32Array((gridW + 1) * (gridH + 1));
  for (let i = 0; i < g.length; i += 1) g[i] = rnd();
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (u: number, v: number) => {
    const x = u * gridW;
    const y = v * gridH;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const at = (a: number, b: number) =>
      g[Math.min(gridH, Math.max(0, b)) * (gridW + 1) + Math.min(gridW, Math.max(0, a))];
    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bot = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    return top * (1 - fy) + bot * fy;
  };
}

/** Fractal sum — the marbled patina needs several octaves or it reads as one blobby stain. */
function fbm(seed: number, baseGrid: number, octaves: number) {
  const layers = Array.from({ length: octaves }, (_, i) =>
    valueNoise2D(seed + i * 977, baseGrid << i, baseGrid << i),
  );
  return (u: number, v: number) => {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    for (const layer of layers) {
      sum += layer(u, v) * amp;
      norm += amp;
      amp *= 0.52;
    }
    return sum / norm;
  };
}

function canvas(size: number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function toTexture(c: HTMLCanvasElement, srgb: boolean, repeat = 1) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/**
 * The reference's dominant surface trait: irregular cloudy dark blotches marbling
 * across every green surface, roughly 8-15% of slide length, soft-edged.
 * Modulates albedo AND roughness from the same field but as INDEPENDENT channels
 * (never the albedo texture reused as the roughness map).
 */
export function createEmeraldChrome(size = 1024) {
  const noise = fbm(20260728, 4, 5);
  const alb = canvas(size);
  const rgh = canvas(size);
  const ac = alb.getContext('2d')!;
  const rc = rgh.getContext('2d')!;
  const aimg = ac.createImageData(size, size);
  const rimg = rc.createImageData(size, size);

  // For a METAL, base colour IS the specular reflectance (F0) — there is no
  // diffuse term to darken. A green chromed metal therefore needs a saturated
  // mid-green F0. (An earlier pass authored this near-black on the reasoning that
  // "the green is environment response"; that holds for a dielectric under a
  // clearcoat, not for a metal, and it rendered the whole model black.)
  // Values are the extractor's own dominant palette entries.
  const BASE = { r: 0x0b, g: 0xa8, b: 0x5c };
  const DEEP = { r: 0x02, g: 0x4e, b: 0x2a };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const n = noise(x / size, y / size);
      // keep the patina as a soft cloudy modulation, not a moss-like mask
      // Patina kept as a faint tonal drift only. The reference does have marbling,
      // but reproducing it at full strength on a procedurally flat flank reads as
      // dirt/camouflage rather than as a polished finish. Smooth wins.
      const blotch = Math.pow(Math.max(0, n - 0.40) / 0.60, 1.7);
      const i = (y * size + x) * 4;
      aimg.data[i] = BASE.r + (DEEP.r - BASE.r) * blotch;
      aimg.data[i + 1] = BASE.g + (DEEP.g - BASE.g) * blotch;
      aimg.data[i + 2] = BASE.b + (DEEP.b - BASE.b) * blotch;
      aimg.data[i + 3] = 255;
      // polished base (0.10) rising inside the patina patches (~0.34)
      // tighter base gloss: broad medium-roughness highlights average out to the
      // uniform mid-green the measurements caught; a polished surface concentrates
      // the same energy into small very bright bands instead
      const r = (0.035 + blotch * 0.17) * 255;
      rimg.data[i] = rimg.data[i + 1] = rimg.data[i + 2] = r;
      rimg.data[i + 3] = 255;
    }
  }
  ac.putImageData(aimg, 0, 0);
  rc.putImageData(rimg, 0, 0);

  // Smooth crown normal, not noise.
  //
  // A flat extruded flank samples ONE point of the environment, so it returns a
  // single flat colour. The flank needs to sweep a range. An fbm noise field was
  // tried first and it did raise the tonal-spread number — by turning the pistol
  // into camouflage blotches. That is optimising the metric and losing the goal:
  // a polished flank varies SMOOTHLY and DIRECTIONALLY, like a shallow barrel, not
  // randomly. So the dominant term here is a gentle analytic undulation (the crown
  // the geometry cannot supply without tessellated caps) with only a whisper of
  // noise on top for surface life.
  const micro = fbm(20260729, 6, 3);
  const nrm = canvas(size);
  const nc = nrm.getContext('2d')!;
  const nimg = nc.createImageData(size, size);
  const CROWN = 0.95;   // single-axis barrel sweep: tonal range with no cross-hatching
  const MICRO = 0.0;    // no micro noise: any high-frequency term reads as surface grime here
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    // one gentle cycle over the texture: each part spans a fraction of it, so the
    // flank gets a smooth top-to-bottom tilt rather than a repeating ripple
    const dyCrown = Math.cos(v * Math.PI * 2) * CROWN;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      // Vertical term ONLY. Adding a horizontal cosine as well made the two
      // directions cross into a grid of round dimples — the slide looked hammered.
      // A real flank is crowned across its height, not dented in both axes.
      const dx = (micro(u, v) - 0.5) * MICRO;
      const dy = dyCrown + (micro(v, u) - 0.5) * MICRO;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      nimg.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      nimg.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255; // OpenGL (+Y up)
      nimg.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      nimg.data[i + 3] = 255;
    }
  }
  nc.putImageData(nimg, 0, 0);

  return new THREE.MeshPhysicalMaterial({
    map: toTexture(alb, true),
    roughnessMap: toTexture(rgh, false),
    normalMap: toTexture(nrm, false),
    normalScale: new THREE.Vector2(1.0, 1.0),
    color: 0xffffff,
    metalness: 1.0,
    roughness: 1.0, // scaled by roughnessMap
    clearcoat: 0.7,
    clearcoatRoughness: 0.03,
    envMapIntensity: 3.1,
    name: 'mat-emerald-chrome',
  });
}

export function createBlackOxide() {
  return new THREE.MeshPhysicalMaterial({
    color: 0x14181a,
    metalness: 1.0,
    roughness: 0.38,
    clearcoat: 0.15,
    envMapIntensity: 1.35,
    name: 'mat-black-oxide',
  });
}

/**
 * Grip panel substance is not resolvable at source resolution (polymer vs rubber
 * vs blacked wood) — treated as a dielectric polymer, materialClassConfidence 0.6.
 */
export function createCheckeredPolymer(size = 1024, cellsU = 30, cellsV = 40) {
  // Diamond crosshatch as a relief map rather than instanced pyramids.
  //
  // 2,400 instanced 4-sided cones were tried first and read as a regular grid of
  // round DOTS — at the size this panel occupies on screen each cone covers only a
  // few pixels, so its facets never resolve and only its circular footprint shows.
  // Two crossing groove families in a height field resolve correctly at that scale
  // and cost no triangles. This is relief in the shading, not a pattern painted
  // into albedo — albedo stays a flat dark polymer.
  const h = canvas(size);
  const hc = h.getContext('2d')!;
  const img = hc.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x / size) * cellsU * Math.PI * 2;
      const v = (y / size) * cellsV * Math.PI * 2;
      // crossing families at +/-45 degrees -> a field of raised pyramids
      const a = Math.sin(u + v);
      const b = Math.sin(u - v);
      const height = Math.pow(Math.abs(a) * Math.abs(b), 0.6);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = height * 255;
      img.data[i + 3] = 255;
    }
  }
  hc.putImageData(img, 0, 0);

  const nrm = canvas(size);
  const nc = nrm.getContext('2d')!;
  const nimg = nc.createImageData(size, size);
  const H = (x: number, y: number) =>
    img.data[((((y % size) + size) % size) * size + (((x % size) + size) % size)) * 4] / 255;
  const STRENGTH = 5.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * STRENGTH;
      const dy = (H(x, y + 1) - H(x, y - 1)) * STRENGTH;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      nimg.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      nimg.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255; // OpenGL (+Y up)
      nimg.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      nimg.data[i + 3] = 255;
    }
  }
  nc.putImageData(nimg, 0, 0);

  // AO in the valleys, crests left lighter — an independent channel, not the albedo
  const ao = canvas(size);
  const oc = ao.getContext('2d')!;
  const oimg = oc.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const occl = 0.45 + 0.55 * (img.data[i] / 255);
    oimg.data[i] = oimg.data[i + 1] = oimg.data[i + 2] = occl * 255;
    oimg.data[i + 3] = 255;
  }
  oc.putImageData(oimg, 0, 0);

  return new THREE.MeshPhysicalMaterial({
    color: 0x0a0c0b,
    metalness: 0.0,
    roughness: 0.62,
    normalMap: toTexture(nrm, false),
    normalScale: new THREE.Vector2(1.5, 1.5),
    aoMap: (() => { const a = toTexture(ao, false); a.channel = 0; return a; })(),
    aoMapIntensity: 0.9,
    specularIntensity: 0.55,
    envMapIntensity: 0.75,
    name: 'mat-checkered-polymer',
  });
}

export type PistolMaterials = {
  chrome: THREE.MeshPhysicalMaterial;
  black: THREE.MeshPhysicalMaterial;
  polymer: THREE.MeshPhysicalMaterial;
};

export function createMaterials(): PistolMaterials {
  return {
    chrome: createEmeraldChrome(),
    black: createBlackOxide(),
    polymer: createCheckeredPolymer(),
  };
}
