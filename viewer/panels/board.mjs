// Board views: the design's schematic, PCB and 3D board, as KiCad exported
// them, with every part marked where it sits and coloured by what the run
// found about it. Click a part in any view to select it everywhere.
//
// Nothing here is drawn by us except the markers. The SVGs and the GLB are
// kicad-cli's own output (engine/design-views.mjs), fetched by content hash.
// A view that is missing says so. The panels re-render on every event, so the
// loaded images and the 3D scene are cached by hash and only the markers are
// redrawn.

import { el, svgEl, section } from '../dom.mjs';

const cache = new Map();
let activeTab = null;

const STATUS_RANK = { survived: 0, error: 1, not_checked: 2, killed: 3, equivalent: 4 };
const STATUS_COLOR = { survived: '#d64545', error: '#b7791f', not_checked: '#8a8f98', killed: '#2f9e5b', equivalent: '#6b7280', none: '#4c7bd9' };

/** The worst status of any mutant on each part: a survivor outranks a kill. */
export function partStatus(state) {
  const out = new Map();
  for (const id of state.mutantOrder ?? []) {
    const m = state.mutants[id];
    const cur = out.get(m.target);
    if (!cur || STATUS_RANK[m.status] < STATUS_RANK[cur]) out.set(m.target, m.status);
  }
  return out;
}

function fetchOnce(key, url, as) {
  if (!cache.has(key)) {
    cache.set(key, fetch(url).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return as === 'json' ? r.json() : as === 'text' ? r.text() : r.arrayBuffer();
    }));
  }
  return cache.get(key);
}

function marker2d(p, status, selected, onSelect, unit = 1) {
  const color = STATUS_COLOR[status ?? 'none'];
  const g = svgEl('g', { class: `bv-marker${selected ? ' selected' : ''}`, 'data-ref': p.ref, 'data-testid': 'bv-marker', 'data-status': status ?? 'none',
    'data-selected': selected ? 'true' : 'false' }, [
    svgEl('circle', { cx: p.x, cy: p.y, r: (selected ? 1.5 : 1) * unit, fill: color, 'fill-opacity': selected ? 0.45 : 0.25, stroke: color, 'stroke-width': (selected ? 0.35 : 0.2) * unit }),
    svgEl('text', { x: p.x + 1.2 * unit, y: p.y - 1.2 * unit, 'font-size': unit, fill: color, 'font-family': 'sans-serif', text: p.ref }),
  ]);
  g.addEventListener('click', () => onSelect && onSelect(p.ref));
  return g;
}

function view2d(key, url, parts, status, selection, ctx, label) {
  let entry = cache.get(`${key}:node`);
  if (!entry) {
    const img = el('img', { class: 'bv-img', alt: label });
    const overlay = svgEl('svg', { class: 'bv-overlay', preserveAspectRatio: 'xMidYMid meet' });
    const stage = el('div', { class: 'bv-stage', 'data-testid': `bv-${key}` }, [img, overlay]);
    entry = { stage, overlay, ready: false };
    cache.set(`${key}:node`, entry);
    fetchOnce(key, url, 'text').then(text => {
      const vb = /viewBox="([^"]+)"/.exec(text)?.[1];
      if (vb) {
        entry.overlay.setAttribute('viewBox', vb);
        // Markers scale with the drawing: about 0.9% of its larger side.
        const [, , w, h] = vb.trim().split(/[\s,]+/).map(Number);
        if (w > 0 && h > 0) entry.unit = 0.009 * Math.max(w, h);
      }
      img.src = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
      entry.ready = true;
      entry.redraw?.();
    }).catch(e => stage.replaceChildren(el('p', { class: 'muted', text: `${label} could not be loaded: ${e.message}` })));
  }
  entry.redraw = () => {
    entry.overlay.replaceChildren(...parts.map(p => marker2d(p, status.get(p.ref), selection.has(p.ref), ctx.onSelect, entry.unit ?? 2.6)));
    entry.stage.dataset.ready = entry.ready ? 'true' : 'false';
  };
  entry.redraw();
  return entry.stage;
}

function view3d(url, parts, status, selection, ctx) {
  let entry = cache.get('board3d:node');
  if (!entry) {
    const stage = el('div', { class: 'bv-stage bv-3d', 'data-testid': 'bv-board3d', 'data-ready': 'false' },
      [el('p', { class: 'muted', text: 'Loading the 3D board…' })]);
    entry = { stage, markers: new Map(), redraw: () => {} };
    cache.set('board3d:node', entry);
    Promise.all([
      import('three'),
      import('../vendor/three/addons/loaders/GLTFLoader.js'),
      import('../vendor/three/addons/controls/OrbitControls.js'),
      fetchOnce('board3d', url, 'buffer'),
    ]).then(([THREE, { GLTFLoader }, { OrbitControls }, buf]) => new Promise((res, rej) =>
      new GLTFLoader().parse(buf, '', gltf => res({ THREE, OrbitControls, gltf }), rej)))
      .then(({ THREE, OrbitControls, gltf }) => {
        const width = Math.max(320, stage.clientWidth || 640);
        const height = Math.round(width * 0.6);
        const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        renderer.setPixelRatio(globalThis.devicePixelRatio || 1);
        renderer.setSize(width, height);
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x101418);
        scene.add(new THREE.AmbientLight(0xffffff, 1.2));
        const sun = new THREE.DirectionalLight(0xffffff, 2.0);
        sun.position.set(0.3, 1, 0.5);
        scene.add(sun);
        scene.add(gltf.scene);
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const centre = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3()).length();
        const camera = new THREE.PerspectiveCamera(40, width / height, size / 100, size * 20);
        camera.position.copy(centre).add(new THREE.Vector3(size * 0.35, size * 0.9, size * 0.75));
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.target.copy(centre);
        controls.update(); // aims the camera at the target; without it the board sits off-centre
        const top = box.max.y;
        const geo = new THREE.SphereGeometry(size * 0.012, 16, 12);
        for (const p of parts) {
          const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: STATUS_COLOR.none, emissive: 0x000000 }));
          m.position.set(p.x, top + size * 0.012, p.z);
          m.userData.ref = p.ref;
          scene.add(m);
          entry.markers.set(p.ref, m);
        }
        const draw = () => renderer.render(scene, camera);
        controls.addEventListener('change', draw);
        const ray = new THREE.Raycaster();
        renderer.domElement.addEventListener('click', ev => {
          const r = renderer.domElement.getBoundingClientRect();
          const v = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
          ray.setFromCamera(v, camera);
          const hit = ray.intersectObjects([...entry.markers.values()])[0];
          if (hit && ctx.onSelect) ctx.onSelect(hit.object.userData.ref);
        });
        renderer.domElement.dataset.testid = 'bv-canvas';
        stage.replaceChildren(renderer.domElement);
        stage.dataset.ready = 'true';
        entry.redraw = (st, sel) => {
          for (const [ref, m] of entry.markers) {
            const on = sel.has(ref);
            m.material.color.set(STATUS_COLOR[st.get(ref) ?? 'none']);
            m.material.emissive.set(on ? 0x666666 : 0x000000);
            m.scale.setScalar(on ? 1.8 : 1);
          }
          draw();
        };
        entry.redraw(entry.lastStatus ?? new Map(), entry.lastSelection ?? new Set());
      })
      .catch(e => stage.replaceChildren(el('p', { class: 'muted', text: `The 3D board could not be shown: ${e.message}` })));
  }
  entry.lastStatus = status;
  entry.lastSelection = selection;
  entry.redraw(status, selection);
  return entry.stage;
}

/** The "Board views" section, or null when the run carries no design views. */
export function renderBoardViews(state, ctx) {
  const views = Object.fromEntries((state.artifacts ?? []).filter(a => a.test_id === 'design').map(a => [a.artifact_id, a]));
  if (!views.parts) return null;
  if (!ctx.artifactUrl) {
    return section('Board views', el('p', { class: 'muted', text: 'This run has a schematic, PCB and 3D board from KiCad, but they are not included in an offline export. Open the run from its folder or its live server to see them.' }), { 'data-testid': 'board-views' });
  }
  const url = a => ctx.artifactUrl(a);
  const holder = el('div', { class: 'bv-holder' });
  const status = partStatus(state);
  const selection = ctx.selection ?? new Set();
  const tabs = [
    views.schematic && ['schematic', 'Schematic'],
    views.pcb && ['pcb', 'PCB'],
    views.board3d && ['board3d', '3D board'],
  ].filter(Boolean);
  if (!tabs.some(([k]) => k === activeTab)) activeTab = tabs[0]?.[0] ?? null;
  const show = () => {
    holder.replaceChildren(el('p', { class: 'muted', text: 'Loading part positions…' }));
    fetchOnce('parts', url(views.parts), 'json').then(parts => {
      if (activeTab === 'schematic') holder.replaceChildren(view2d('schematic', url(views.schematic), parts.schematic, status, selection, ctx, 'Schematic'));
      else if (activeTab === 'pcb') holder.replaceChildren(view2d('pcb', url(views.pcb), parts.pcb, status, selection, ctx, 'PCB'));
      else if (activeTab === 'board3d') holder.replaceChildren(view3d(url(views.board3d), parts.board3d, status, selection, ctx));
    }).catch(e => holder.replaceChildren(el('p', { class: 'muted', text: `Part positions could not be loaded: ${e.message}` })));
  };
  const bar = el('div', { class: 'bv-tabs', role: 'tablist' }, tabs.map(([k, label]) => el('button', {
    type: 'button', role: 'tab', class: `bv-tab${k === activeTab ? ' active' : ''}`, 'data-tab': k, 'data-testid': `bv-tab-${k}`,
    'aria-selected': k === activeTab ? 'true' : 'false',
    onclick: () => { activeTab = k; for (const b of bar.children) { b.classList.toggle('active', b.dataset.tab === k); b.setAttribute('aria-selected', b.dataset.tab === k ? 'true' : 'false'); } show(); },
  }, [label])));
  show();
  const legend = el('p', { class: 'muted bv-legend' }, [
    'Drawn by KiCad (kicad-cli); markers by Kinux, coloured by the worst mutant on each part: ',
    ...['survived', 'killed', 'not_checked', 'none'].flatMap(s => [el('span', { class: 'bv-swatch', style: `background:${STATUS_COLOR[s]}` }), ` ${s === 'none' ? 'no mutant' : s.replace('_', ' ')}  `]),
    views.board3d ? 'Part bodies in 3D appear only where KiCad found a 3D model.' : '',
  ]);
  return section('Board views', [bar, holder, legend], { 'data-testid': 'board-views' });
}
