import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;

// Earth-fixed frame: +y is the north pole, +x is lat 0 / lon 0, -z is lon 90E.
// This matches how three.js wraps an equirectangular texture onto SphereGeometry.
function latLonToVec(lat, lon, r = 1) {
  const la = lat * DEG, lo = lon * DEG;
  return new THREE.Vector3(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
}

// Where the sun is directly overhead, from the low-precision solar ephemeris
// (Astronomical Almanac). Good to about 0.01 degrees, plenty for a globe.
function subsolarPoint(date) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / DEG;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda)) / DEG;
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  let lon = ra - gmst;
  lon = ((lon + 540) % 360) - 180;
  return { lat: dec, lon };
}

// ---------- scene ----------
const canvas = $('globe');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x03050b, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);

const loader = new THREE.TextureLoader();
const maxAniso = renderer.capabilities.getMaxAnisotropy();
function tex(url, srgb = true) {
  return new Promise((resolve) => {
    loader.load(url, (t) => {
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = Math.min(8, maxAniso);
      resolve(t);
    }, undefined, () => resolve(null));
  });
}

const uniforms = {
  dayMap: { value: null },
  nightMap: { value: null },
  surfMap: { value: null },
  sunDir: { value: new THREE.Vector3(1, 0, 0) },
  bumpScale: { value: 1.2 },
};

const earthMat = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    varying vec3 vN;
    varying vec3 vPos;
    void main() {
      vUv = uv;
      vN = normalize(mat3(modelMatrix) * normal);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D dayMap;
    uniform sampler2D nightMap;
    uniform sampler2D surfMap;
    uniform vec3 sunDir;
    uniform float bumpScale;
    varying vec2 vUv;
    varying vec3 vN;
    varying vec3 vPos;

    void main() {
      vec3 Ng = normalize(vN);
      vec3 V = normalize(cameraPosition - vPos);
      vec4 surf = texture2D(surfMap, vUv);

      // Relief from the elevation map: slope from neighbouring texels, applied
      // along east (T) and north (B) so it stays smooth at any zoom.
      vec2 px = vec2(1.0 / 2048.0, 1.0 / 1024.0);
      float hE = texture2D(surfMap, vUv + vec2(px.x, 0.0)).r - texture2D(surfMap, vUv - vec2(px.x, 0.0)).r;
      float hN = texture2D(surfMap, vUv + vec2(0.0, px.y)).r - texture2D(surfMap, vUv - vec2(0.0, px.y)).r;
      vec3 T = normalize(cross(vec3(0.0, 1.0, 0.0), Ng) + vec3(1e-5, 0.0, 0.0));
      vec3 B = cross(Ng, T);
      vec3 N = normalize(Ng - bumpScale * (hE * T + hN * B));

      float cg = dot(Ng, sunDir);              // geometric sun angle: drives the terminator
      float ndl = max(dot(N, sunDir), 0.0);    // shaded: shows relief
      float dayAmt = smoothstep(-0.10, 0.16, cg);

      vec3 day = texture2D(dayMap, vUv).rgb;
      vec3 lit = day * (pow(ndl, 0.7) * 1.15 + 0.012);

      // Warm band along the terminator, like low sun through the atmosphere.
      float twi = smoothstep(-0.14, 0.0, cg) * (1.0 - smoothstep(0.0, 0.12, cg));
      lit = mix(lit, lit * vec3(1.2, 0.85, 0.65), twi * 0.5) + vec3(1.0, 0.45, 0.15) * twi * 0.012;

      // City lights, only on the night side.
      vec3 night = texture2D(nightMap, vUv).rgb;
      night = pow(night, vec3(1.7)) * vec3(1.0, 0.8, 0.52) * 3.2;

      // Sun glint on open water.
      float water = surf.g;
      vec3 H = normalize(sunDir + V);
      float nh = max(dot(Ng, H), 0.0);
      float spec = (pow(nh, 600.0) * 0.5 + pow(nh, 70.0) * 0.035) * water * smoothstep(0.0, 0.2, cg);

      vec3 col = mix(night, lit, dayAmt) + vec3(1.0, 0.93, 0.8) * spec;

      // Blue haze toward the limb on the day side.
      float fres = pow(1.0 - max(dot(Ng, V), 0.0), 2.6);
      col += vec3(0.32, 0.6, 1.0) * fres * smoothstep(-0.25, 0.45, cg) * 0.75;

      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }`,
});

const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 96), earthMat);
scene.add(earth);

// Atmosphere: a glow that is brightest at the Earth's limb and fades out
// by 10% of the radius, tinted by how much sunlight that edge gets.
const ATMO_R = 1.1;
const atmoMat = new THREE.ShaderMaterial({
  uniforms: { sunDir: uniforms.sunDir },
  vertexShader: /* glsl */ `
    varying vec3 vPos;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 sunDir;
    varying vec3 vPos;
    void main() {
      vec3 dir = normalize(vPos - cameraPosition);
      vec3 cp = cameraPosition + dir * -dot(cameraPosition, dir); // ray's closest point to the centre
      float d = length(cp);
      float glow = pow(clamp((${ATMO_R.toFixed(2)} - d) / ${(ATMO_R - 1).toFixed(2)}, 0.0, 1.0), 2.4);
      float s = dot(normalize(cp), sunDir);
      float lit = smoothstep(-0.35, 0.35, s);
      vec3 c = mix(vec3(1.0, 0.5, 0.25), vec3(0.35, 0.62, 1.0), smoothstep(-0.1, 0.4, s));
      gl_FragColor = vec4(c * glow * (0.04 + 1.05 * lit), 1.0);
    }`,
  side: THREE.BackSide,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false,
});
const atmo = new THREE.Mesh(new THREE.SphereGeometry(ATMO_R, 96, 64), atmoMat);
scene.add(atmo);

// Stars: a fixed sky of faint points, a few brighter ones.
{
  const count = 2600;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    pos.set([60 * s * Math.cos(t), 60 * u, 60 * s * Math.sin(t)], i * 3);
    const b = Math.pow(Math.random(), 3) * 0.85 + 0.15;
    const warm = Math.random();
    col.set([b * (0.85 + 0.15 * warm), b * 0.9, b * (1.05 - 0.2 * warm)], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 1.3, sizeAttenuation: false, vertexColors: true, depthWrite: false })));
}

// "You are here" marker: a dot and a pulsing ring sitting on the surface.
const marker = new THREE.Group();
{
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.009, 24), new THREE.MeshBasicMaterial({ color: 0xffd27a }));
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.014, 0.018, 48),
    new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, depthWrite: false }),
  );
  dot.position.z = ring.position.z = 0.0015;
  marker.add(dot, ring);
  marker.userData.ring = ring;
  marker.visible = false;
  scene.add(marker);
}
function placeMarker(lat, lon) {
  const p = latLonToVec(lat, lon, 1.001);
  marker.position.copy(p);
  marker.lookAt(p.clone().multiplyScalar(2));
  marker.visible = true;
}

// ---------- camera and controls ----------
const controls = new OrbitControls(camera, canvas);
controls.enablePan = false;
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.rotateSpeed = 0.45;
controls.zoomSpeed = 0.6;
controls.minDistance = 1.35;
controls.maxDistance = 9;

let baseDistance = 4;
function layout() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Keep the whole globe in frame on narrow screens.
  const vFov = camera.fov * DEG;
  const fitH = 1.28 / Math.tan(vFov / 2);
  const fitW = 1.28 / (Math.tan(vFov / 2) * Math.min(camera.aspect, 1));
  baseDistance = Math.max(fitH, fitW);
  // On wide screens, shift the globe right so the greeting has room on the left.
  if (w / h > 1.25) camera.setViewOffset(w, h, -w * 0.14, 0, w, h);
  else if (w / h < 0.8) camera.setViewOffset(w, h, 0, h * 0.06, w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', layout);
layout();

// ---------- where to look ----------
const state = {
  lat: 20,
  lon: -(new Date().getTimezoneOffset() / 60) * 15, // rough longitude from the time zone
  source: 'tz',
  timeOffset: 0, // ms added to the clock while fast-forwarding
  ff: false,
};

let fly = null; // { from, to, d0, d1, t0, dur }
function flyTo(lat, lon, distance = baseDistance, dur = 2600) {
  const to = latLonToVec(lat, lon).normalize();
  const from = camera.position.clone().normalize();
  const d0 = camera.position.length();
  if (reduceMotion || dur === 0) {
    camera.position.copy(to.multiplyScalar(distance));
    camera.lookAt(0, 0, 0);
    fly = null;
    return;
  }
  fly = { from, to, d0, d1: distance, t0: performance.now(), dur };
}
controls.addEventListener('start', () => {
  fly = null;
  document.body.classList.add('touched');
});

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), up = new THREE.Vector3(0, 0, 1);
function stepFly(now) {
  if (!fly) return;
  const t = Math.min(1, (now - fly.t0) / fly.dur);
  const k = ease(t);
  qa.setFromUnitVectors(up, fly.from);
  qb.setFromUnitVectors(up, fly.to);
  const dir = up.clone().applyQuaternion(qa.clone().slerp(qb, k));
  camera.position.copy(dir.multiplyScalar(fly.d0 + (fly.d1 - fly.d0) * k));
  camera.lookAt(0, 0, 0);
  if (t >= 1) fly = null;
}

// Start far out over the time-zone guess, then glide in.
camera.position.copy(latLonToVec(state.lat - 25, state.lon + 70).normalize().multiplyScalar(baseDistance * 2.4));
camera.lookAt(0, 0, 0);

// ---------- readouts ----------
const fmtCoord = (v, pos, neg) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? pos : neg}`;
const fmtLatLon = (lat, lon) => `${fmtCoord(lat, 'N', 'S')}  ${fmtCoord(lon, 'E', 'W')}`;
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

function greeting(hour) {
  if (hour < 5) return 'Up late? Good night.';
  if (hour < 12) return 'Good morning.';
  if (hour < 17) return 'Good afternoon.';
  if (hour < 22) return 'Good evening.';
  return 'Good night.';
}

function updateReadouts(now, sun) {
  $('greet').textContent = greeting(now.getHours());
  $('r-time').textContent = timeFmt.format(now);
  $('r-date').textContent = dayFmt.format(now);
  $('r-sun').textContent = fmtLatLon(sun.lat, sun.lon);
  $('r-here').textContent = fmtLatLon(state.lat, state.lon);
  $('r-here-note').textContent =
    state.source === 'gps' ? 'From your browser' : 'Estimated from your time zone';
  const alt = Math.asin(THREE.MathUtils.clamp(latLonToVec(state.lat, state.lon).dot(latLonToVec(sun.lat, sun.lon)), -1, 1)) / DEG;
  const a = Math.round(Math.abs(alt));
  $('r-alt').textContent = alt >= 0 ? `${a}° above the horizon` : `${a}° below the horizon`;
  $('r-alt-note').textContent = alt > 6 ? 'Daylight where you are' : alt > -6 ? 'Twilight where you are' : 'Night where you are';
}

// ---------- geolocation ----------
const locBtn = $('btn-locate');
function locate(userAsked) {
  if (!('geolocation' in navigator)) {
    $('loc-msg').textContent = 'This browser can’t share a location, so the globe is centered on your time zone.';
    return;
  }
  locBtn.disabled = true;
  locBtn.textContent = 'Finding you…';
  navigator.geolocation.getCurrentPosition(
    (p) => {
      state.lat = p.coords.latitude;
      state.lon = p.coords.longitude;
      state.source = 'gps';
      placeMarker(state.lat, state.lon);
      flyTo(state.lat, state.lon, baseDistance, userAsked ? 1800 : 2600);
      $('loc-msg').textContent = '';
      locBtn.disabled = false;
      locBtn.textContent = 'Center on me';
    },
    () => {
      $('loc-msg').textContent = userAsked
        ? 'Location is blocked for this page. Allow it in your browser’s site settings to center on you.'
        : 'Centered on your time zone. Share your location to center on you.';
      locBtn.disabled = false;
      locBtn.textContent = state.source === 'gps' ? 'Center on me' : 'Use my location';
      if (userAsked) flyTo(state.lat, state.lon, baseDistance, 1400);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
  );
}
locBtn.addEventListener('click', () => {
  if (state.source === 'gps') flyTo(state.lat, state.lon, baseDistance, 1400);
  else locate(true);
});

// ---------- fast-forward ----------
const ffBtn = $('btn-ff');
ffBtn.addEventListener('click', () => {
  state.ff = !state.ff;
  if (!state.ff) state.timeOffset = 0;
  ffBtn.textContent = state.ff ? 'Back to live' : 'Fast-forward the day';
  ffBtn.setAttribute('aria-pressed', String(state.ff));
  document.body.classList.toggle('ff', state.ff);
});

// ---------- go ----------
const sunVec = new THREE.Vector3();
let lastText = 0, lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(now - lastFrame, 100);
  lastFrame = now;
  if (state.ff) state.timeOffset += dt * 3600; // one hour per second
  const date = new Date(Date.now() + state.timeOffset);
  const sun = subsolarPoint(date);
  sunVec.copy(latLonToVec(sun.lat, sun.lon)).normalize();
  uniforms.sunDir.value.copy(sunVec);

  stepFly(now);
  if (!fly) controls.update();

  if (marker.visible && !reduceMotion) {
    const k = (now % 2400) / 2400;
    const ring = marker.userData.ring;
    ring.scale.setScalar(1 + k * 2.2);
    ring.material.opacity = 0.9 * (1 - k);
  }

  if (now - lastText > (state.ff ? 100 : 1000)) {
    updateReadouts(date, sun);
    lastText = now;
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

Promise.all([tex('textures/earth-day.jpg'), tex('textures/earth-night.jpg'), tex('textures/earth-surface.jpg', false)]).then(
  ([day, night, surf]) => {
    uniforms.dayMap.value = day;
    uniforms.nightMap.value = night;
    uniforms.surfMap.value = surf;
    document.body.classList.add('ready');
    flyTo(state.lat, state.lon, baseDistance, 3200);
    locate(false);
  },
);
requestAnimationFrame(frame);
