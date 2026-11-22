// The studio's 3D stage: KiCad's own 3D board (GLB), the CalculiX temperature
// field laid on its faces, and callouts that name what the solvers found.
//
// Everything shown comes from a run file: the geometry is kicad-cli's export,
// the field is the solver's nodal temperatures (heat-field.json, drawn only
// when converged), part colours are mutation results, and every callout's text
// is a number from those files. The scene is built once per run and reused
// across re-renders; only colours and callouts change.

import { el, svgEl } from './dom.mjs';
import { fieldCanvas } from './heatfield.mjs';

const STUDIO_STATUS_COLOR = { survived: '#f43f5e', error: '#e0a030', not_checked: '#8a8f98', killed: '#2fd27a', equivalent: '#6b7280' };
let stageEntry = null;

/**
 * @param {object} o
 * @param {string} o.glbUrl
 * @param {{board3d: Array<{ref,x,z}>}} o.parts
 * @param {object|null} o.field     heat-field.json, or null
 * @param {{min,max}|null} o.range
 * @param {'heat'|'faults'} o.mode
 * @param {Map<string,string>} o.status  worst mutant status per part
 * @param {Array<{ref, text, tone}>} o.callouts
 * @param {Set<string>} o.selection
 * @param {(ref) => void} o.onSelect
 */
export function studioStage(o) {
  if (!stageEntry || stageEntry.url !== o.glbUrl) stageEntry = build(o);
  stageEntry.update(o);
  return stageEntry.root;
}

function build(o) {
  const canvasHolder = el('div', { class: 'st3d-canvas' }, [el('p', { class: 'st-loading', text: 'Loading the 3D board…' })]);
  const lines = svgEl('svg', { class: 'st3d-lines' });
  const labels = el('div', { class: 'st3d-labels' });
  const root = el('div', { class: 'st3d', 'data-testid': 'studio-3d', 'data-ready': 'false' }, [canvasHolder, lines, labels]);
  const entry = { url: o.glbUrl, root, last: o, update: next => { entry.last = next; entry.apply?.(); } };

  Promise.all([
    import('three'),
    import('./vendor/three/addons/loaders/GLTFLoader.js'),
    import('./vendor/three/addons/controls/OrbitControls.js'),
    fetch(o.glbUrl).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }),
  ]).then(([THREE, { GLTFLoader }, { OrbitControls }, buf]) => new Promise((res, rej) =>
    new GLTFLoader().parse(buf, '', gltf => res({ THREE, OrbitControls, gltf }), rej)))
    .then(({ THREE, OrbitControls, gltf }) => {
      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
      renderer.setPixelRatio(globalThis.devicePixelRatio || 1);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xdde8ff, 0x202430, 1.6));
      const sun = new THREE.DirectionalLight(0xffffff, 2.2);
      sun.position.set(0.4, 1, 0.6);
      scene.add(sun);
      scene.add(gltf.scene);
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const centre = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3()).length();
      const camera = new THREE.PerspectiveCamera(30, 1.6, size / 200, size * 20);
      // Far enough that the whole board fits, from the front-left, about 40 degrees up.
      const dist = (size / 2) / Math.tan((30 * Math.PI) / 360) * 1.0;
      const home = new THREE.Vector3(-0.32, 0.62, 0.72).normalize().multiplyScalar(dist);
      camera.position.copy(centre).add(home);
      // A faint floor grid under the board, for depth only.
      const grid = new THREE.GridHelper(size * 3, 30, 0x1f3a66, 0x14223d);
      grid.position.set(centre.x, box.min.y - size * 0.06, centre.z);
      grid.material.transparent = true; grid.material.opacity = 0.55;
      scene.add(grid);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.target.copy(centre);
      controls.update();

      const known = new Set(o.parts.board3d.map(p => p.ref));
      const bodies = new Map();
      gltf.scene.traverse(obj => {
        if (known.has(obj.name) && !bodies.has(obj.name)) {
          const meshes = [];
          obj.traverse(m => { if (m.isMesh) { m.material = m.material.clone(); m.userData.ref = obj.name; meshes.push(m); } });
          if (meshes.length) bodies.set(obj.name, meshes);
        }
      });

      // The field planes, just above the top face and just below the bottom face.
      // Built when the field arrives (it loads separately from the board).
      const planes = [];
      let planesFor = null;
      const ensurePlanes = (field, range) => {
        if (!field?.drawn || planesFor === field) return;
        for (const p of planes.splice(0)) scene.remove(p);
        planesFor = field;
        const { width: W, height: H, thickness: t, origin: [x0, y0] } = field.board_mm;
        for (const face of ['top', 'bottom']) {
          const tex = new THREE.CanvasTexture(fieldCanvas(field, face, range));
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
          if (face === 'bottom') tex.flipY = false;
          const geo = new THREE.PlaneGeometry(W / 1000, H / 1000);
          geo.rotateX(face === 'top' ? -Math.PI / 2 : Math.PI / 2);
          const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.9, depthWrite: false });
          const mesh = new THREE.Mesh(geo, mat);
          mesh.position.set((x0 + W / 2) / 1000, face === 'top' ? (t + 0.12) / 1000 : -0.12 / 1000, (y0 + H / 2) / 1000);
          mesh.renderOrder = 2;
          scene.add(mesh);
          planes.push(mesh);
        }
        root.dataset.field = 'drawn';
      };

      const pos = new Map(o.parts.board3d.map(p => [p.ref, new THREE.Vector3(p.x, box.min.y + 0.0016, p.z)]));
      const draw = () => {
        renderer.render(scene, camera);
        placeCallouts();
        drawAxes?.();
      };
      const placeCallouts = () => {
        const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
        const items = entry.last.callouts ?? [];
        lines.setAttribute('viewBox', `0 0 ${w} ${h}`);
        lines.replaceChildren();
        labels.replaceChildren();
        const sideCount = { left: 0, right: 0 };
        items.forEach((c) => {
          const p = pos.get(c.ref);
          if (!p) return;
          const v = p.clone().project(camera);
          const sx = (v.x + 1) / 2 * w, sy = (1 - v.y) / 2 * h;
          const side = sx < w / 2 ? 'left' : 'right';
          const k = sideCount[side]++;
          const lx = side === "left" ? 16 : w - 86, ly = 56 + k * 52;
          lines.append(svgEl('line', { x1: sx, y1: sy, x2: side === 'left' ? lx + 172 : lx - 172, y2: ly + 14, class: `st3d-leader tone-${c.tone}` }),
            svgEl('circle', { cx: sx, cy: sy, r: 3.5, class: `st3d-dot tone-${c.tone}` }));
          labels.append(el('div', { class: `st3d-callout tone-${c.tone}`, 'data-testid': 'studio-callout', 'data-ref': c.ref,
            style: `top:${ly}px;${side === "left" ? `left:${lx}px` : "right:86px"}`, onclick: () => entry.last.onSelect?.(c.ref) }, [c.text]));
        });
      };
      controls.enableDamping = false;
      controls.addEventListener('change', draw);
      const reset = el('button', { type: 'button', class: 'st-chip st3d-reset', 'data-testid': 'studio-reset-view', onclick: () => {
        camera.position.copy(centre).add(home); controls.target.copy(centre); controls.update(); draw();
      } }, ['Reset view']);
      root.append(reset);
      // Axis gizmo: the camera's real orientation (x along the board, y up, z toward the viewer).
      const axes = svgEl('svg', { class: 'st3d-axes', viewBox: '-32 -32 64 64' });
      root.append(axes);
      const drawAxes = () => {
        const q = camera.quaternion.clone().invert();
        axes.replaceChildren(...[['X', 0xf43f5e, [1, 0, 0]], ['Y', 0x34d399, [0, 1, 0]], ['Z', 0x38bdf8, [0, 0, 1]]].map(([n, c, v]) => {
          const d = new THREE.Vector3(...v).applyQuaternion(q);
          const col = `#${c.toString(16).padStart(6, '0')}`;
          return svgEl('g', {}, [svgEl('line', { x1: 0, y1: 0, x2: d.x * 20, y2: -d.y * 20, stroke: col, 'stroke-width': 2 }),
            svgEl('text', { x: d.x * 27, y: -d.y * 27 + 4, fill: col, 'font-size': 10, 'text-anchor': 'middle', 'font-family': 'sans-serif', text: n })]);
        }));
      };
      controls.addEventListener('change', drawAxes);
      const ray = new THREE.Raycaster();
      renderer.domElement.addEventListener('click', ev => {
        const r = renderer.domElement.getBoundingClientRect();
        ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
        const hit = ray.intersectObjects([...bodies.values()].flat())[0];
        if (hit) entry.last.onSelect?.(hit.object.userData.ref);
      });
      const resize = () => {
        if (!root.isConnected || !root.clientWidth) return; // detached during a re-render: wait to be placed
        const w = Math.max(320, root.clientWidth), h = Math.max(260, root.clientHeight);
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        draw();
      };
      new ResizeObserver(resize).observe(root);
      renderer.domElement.dataset.testid = 'studio-canvas';
      canvasHolder.replaceChildren(renderer.domElement);
      root.dataset.ready = 'true';
      root.dataset.bodies = String(bodies.size);
      root.dataset.field = 'none';

      entry.apply = () => {
        const { mode, status, selection } = entry.last;
        ensurePlanes(entry.last.field, entry.last.range);
        for (const pl of planes) pl.visible = mode === 'heat';
        for (const [ref, meshes] of bodies) {
          const on = selection?.has(ref);
          const colour = mode === 'faults' ? STUDIO_STATUS_COLOR[status.get(ref)] : null;
          for (const m of meshes) {
            if (!m.material.emissive) continue;
            m.material.emissive.set(on ? 0x4ea3ff : colour ?? 0x000000);
            m.material.emissiveIntensity = on ? 0.8 : colour ? 0.55 : 0;
          }
        }
        resize();
        requestAnimationFrame(resize); // after the re-rendered page has placed the stage
      };
      entry.apply();
    })
    .catch(e => canvasHolder.replaceChildren(el('p', { class: 'st-loading', text: `The 3D board could not be shown: ${e.message}` })));
  return entry;
}
