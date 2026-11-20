import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildLevel } from './level.js';
import { planPath, flattenPlan } from './planner.js';
import { verifyFrames } from './replay.js';

// ---------- 可调参数 ----------
const params = {
  edgeScale: 1.0,      // 边长 S
  bodyW: 0.7,          // 宽
  bodyL: 1.0,          // 长
  bodyT: 0.55,         // 厚
  maxSeam: 0.6,        // 允许跨缝距离
  speed: 0.45,         // 回放速度（帧/秒）
};

let renderer, scene, camera, controls, raycaster, pointer;
let levelGroup, linkGroup, pathGroup, bodyMesh, startMarker, goalMarker;
let level, currentPlan, flatFrames, verification;
let playState = { playing: false, index: 0 };
let startSurfId = null;
let goalSurfId = null;
const pickables = [];
const ui = {};

function bodyDims() {
  const S = params.edgeScale;
  return { w: params.bodyW * S, l: params.bodyL * S, t: params.bodyT * S };
}

// ---------- 场景搭建 ----------
function initScene() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  document.getElementById('view').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1020);
  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 200);
  camera.position.set(9, 7.5, 11);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 2, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dir = new THREE.DirectionalLight(0xffffff, 1.1);
  dir.position.set(7, 12, 6);
  dir.castShadow = true;
  scene.add(dir);
  const grid = new THREE.GridHelper(24, 48, 0x335577, 0x1d2a44);
  grid.position.y = -0.01;
  scene.add(grid);

  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();

  // 身体：外层组（位置/朝向，不缩放）内含缩放盒体、法线箭头、接触点小球
  bodyMesh = new THREE.Group();
  const boxGroup = new THREE.Group();
  boxGroup.name = 'boxGroup';
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const boxMat = new THREE.MeshStandardMaterial({ color: 0xffd166, transparent: true, opacity: 0.92 });
  boxGroup.add(new THREE.Mesh(boxGeo, boxMat));
  boxGroup.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(boxGeo), new THREE.LineBasicMaterial({ color: 0x222222 })
  ));
  bodyMesh.add(boxGroup);
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 0.55, 0xff4444, 0.15, 0.09);
  arrow.name = 'normalArrow';
  bodyMesh.add(arrow);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
  dot.name = 'contactDot';
  bodyMesh.add(dot);
  scene.add(bodyMesh);

  startMarker = makeMarker(0x44ff88);
  goalMarker = makeMarker(0xff5577);
  scene.add(startMarker, goalMarker);

  renderer.domElement.addEventListener('pointermove', onHover);
  renderer.domElement.addEventListener('click', onClick);
  window.addEventListener('resize', onResize);
}

function makeMarker(color) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 14), new THREE.MeshBasicMaterial({ color }));
  g.add(m);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.22, 0.02, 8, 28), new THREE.MeshBasicMaterial({ color })
  );
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  g.visible = false;
  return g;
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ---------- 关卡重建 ----------
function rebuildLevel() {
  if (levelGroup) {
    scene.remove(levelGroup, linkGroup, pathGroup);
    disposeGroup(levelGroup);
    disposeGroup(linkGroup);
    disposeGroup(pathGroup);
  }
  levelGroup = new THREE.Group();
  pickables.length = 0;
  level = buildLevel(params.edgeScale);

  for (const s of level.surfs) {
    const hu = Math.max(...s.poly.map((p) => Math.abs(p.clone().sub(s.center).dot(s.frame.u))));
    const hv = Math.max(...s.poly.map((p) => Math.abs(p.clone().sub(s.center).dot(s.frame.v))));
    const thin = 0.06 * params.edgeScale;
    const geo = new THREE.BoxGeometry(hu * 2, hv * 2, thin);
    const mat = new THREE.MeshStandardMaterial({
      color: s.color,
      transparent: !s.attachable,
      opacity: s.attachable ? 0.92 : 0.45,
      roughness: 0.7,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    const basis = new THREE.Matrix4().makeBasis(s.frame.u, s.frame.v, s.frame.n);
    mesh.quaternion.setFromRotationMatrix(basis);
    mesh.position.copy(s.center);
    mesh.userData.surfId = s.id;
    mesh.castShadow = mesh.receiveShadow = true;
    const line = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: s.attachable ? 0x0d1b2a : 0x664488 })
    );
    mesh.add(line);
    levelGroup.add(mesh);
    pickables.push(mesh);

    // 法线箭头（可附着面）
    if (s.attachable) {
      const ah = new THREE.ArrowHelper(
        s.frame.n, s.center.clone().addScaledVector(s.frame.n, thin * 0.5 + 0.02),
        0.35 * params.edgeScale, 0x1144aa, 0.1, 0.06
      );
      levelGroup.add(ah);
    }
  }
  scene.add(levelGroup);

  linkGroup = new THREE.Group();
  pathGroup = new THREE.Group();
  scene.add(linkGroup, pathGroup);

  // 重置规划与回放状态
  currentPlan = null;
  flatFrames = [];
  verification = null;
  playState = { playing: false, index: 0 };
  bodyMesh.visible = false;
  ui.slider && (ui.slider.max = 0);

  // 默认起点：主地面靠近柱南墙
  startSurfId = level.surfs[0].id;
  const startP = new THREE.Vector3(0, 0, 2.2 * params.edgeScale);
  startMarker.position.copy(startP);
  startMarker.visible = true;
  goalSurfId = null;
  goalMarker.visible = false;
}

function disposeGroup(group) {
  [...group.children].forEach((child) => {
    group.remove(child);
    child.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => {
          if (m.map) m.map.dispose();
          m.dispose();
        });
      }
    });
  });
}

// ---------- 拾取 ----------
function pickSurf(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(pickables, false);
  return hits[0] ?? null;
}

function onHover(event) {
  const hit = pickSurf(event);
  renderer.domElement.style.cursor = hit ? 'pointer' : 'default';
}

function onClick(event) {
  const hit = pickSurf(event);
  if (!hit) return;
  const surf = level.surfs.find((s) => s.id === hit.object.userData.surfId);
  if (!surf.attachable) {
    flashLog(`「${surf.name}」是禁附表皮，不能指定为终点`);
    return;
  }
  goalSurfId = surf.id;
  goalMarker.position.copy(hit.point);
  goalMarker.visible = true;
  runPlan(hit.point);
}

// ---------- 规划 ----------
function runPlan(goalPoint) {
  const body = bodyDims();
  currentPlan = planPath(
    level, body, params.maxSeam, startSurfId, startMarker.position.clone(), goalSurfId, goalPoint
  );
  drawLinkMarkers();
  if (!currentPlan.ok) {
    flatFrames = [];
    verification = null;
    disposeGroup(pathGroup);
    bodyMesh.visible = false;
    ui.slider.max = 0;
    ui.slider.value = 0;
    ui.frameInfo.textContent = '无可达路径';
    const rj = currentPlan.rejections.map(
      (r) => `· ${r.link.note}：${r.ev.reasons.join('；')}`
    ).join('\n');
    flashLog(`找不到可达路径，被拒绝的边：\n${rj}`);
    return;
  }
  flatFrames = flattenPlan(level, currentPlan, body);
  verification = verifyFrames(level, flatFrames, body);
  drawPath();
  playState = { playing: false, index: 0 };
  showFrame(0);
  const rejNote = currentPlan.rejections.length
    ? `\n触发绕路，被拒边 ${currentPlan.rejections.length} 条（见场景红色标记）`
    : '';
  const vNote = verification.ok
    ? '\n逐步核验通过：身体全程贴在计划面上'
    : `\n核验失败于第 ${verification.firstFailure.index + 1} 帧（${verification.firstFailure.surfName}）：${verification.firstFailure.problems.join('；')}`;
  flashLog(`路径就绪：${currentPlan.steps.length} 个动作段，${flatFrames.length} 帧。${rejNote}${vNote}`);
  ui.slider.max = flatFrames.length - 1;
  ui.slider.value = 0;
  ui.frameInfo.textContent = `帧 1 / ${flatFrames.length}`;
}

// ---------- 边标记 ----------
function drawLinkMarkers() {
  disposeGroup(linkGroup);
  if (!currentPlan) return;
  const usedLinks = new Set(currentPlan.steps.filter((s) => s.kind === 'edge').map((s) => s.link));
  for (const r of currentPlan.rejections) {
    const mid = r.link.edgeA.a.clone().add(r.link.edgeA.b).multiplyScalar(0.5);
    mid.addScaledVector(new THREE.Vector3(0, 1, 0), 0.12);
    const tag = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), mid, 0.5, 0xff3333, 0.14, 0.09);
    linkGroup.add(tag);
    const label = makeTextSprite(`拒:${r.ev.reasons[0]?.slice(0, 10) ?? '净空'}`, '#ff5555');
    label.position.copy(mid).add(new THREE.Vector3(0, 0.65, 0));
    linkGroup.add(label);
  }
  for (const link of level.links) {
    if (usedLinks.has(link)) {
      const mid = link.edgeA.a.clone().add(link.edgeA.b).multiplyScalar(0.5);
      const tag = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), mid, 0.35, 0x33ff88, 0.1, 0.06);
      linkGroup.add(tag);
    }
  }
}

function makeTextSprite(text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(8,12,24,0.75)';
  if (ctx.roundRect) {
    ctx.roundRect(4, 8, 248, 48, 8);
    ctx.fill();
  } else {
    ctx.fillRect(4, 8, 248, 48);
  }
  ctx.font = '22px sans-serif';
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.fillText(text, 128, 40);
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  spr.scale.set(1.7, 0.42, 1);
  return spr;
}

// ---------- 路径线 ----------
function drawPath() {
  disposeGroup(pathGroup);
  const pts = flatFrames.map((fr) => fr.f.contact);
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe066, linewidth: 2 }));
  pathGroup.add(line);
  // 过棱段用不同颜色的接触点标出真实经过的边
  for (const step of currentPlan.steps) {
    if (step.kind !== 'edge') continue;
    const mid = step.link.edgeA.a.clone().add(step.link.edgeA.b).multiplyScalar(0.5);
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff })
    );
    dot.position.copy(mid);
    pathGroup.add(dot);
    const label = makeTextSprite(step.ev.maneuver, '#7df9ff');
    label.position.copy(mid).add(new THREE.Vector3(0, 0.5, 0));
    pathGroup.add(label);
  }
}

// ---------- 回放 ----------
function showFrame(i) {
  if (!flatFrames || !flatFrames.length) {
    bodyMesh.visible = false;
    return;
  }
  bodyMesh.visible = true;
  const { f } = flatFrames[i];
  const body = bodyDims();
  bodyMesh.getObjectByName('boxGroup').scale.set(body.w, body.l, body.t);
  bodyMesh.position.copy(f.center);
  const basis = new THREE.Matrix4().makeBasis(f.t1, f.t2, f.n);
  bodyMesh.quaternion.setFromRotationMatrix(basis);
  const arrow = bodyMesh.getObjectByName('normalArrow');
  arrow.position.set(0, 0, body.t * 0.5);
  arrow.setDirection(new THREE.Vector3(0, 0, 1));
  const contactDot = bodyMesh.getObjectByName('contactDot');
  contactDot.position.copy(f.contact.clone().sub(f.center));
  const v = verification?.report[i];
  if (v) {
    ui.frameInfo.textContent =
      `帧 ${i + 1}/${flatFrames.length} · 计划面:${v.surfName} · ${v.stepKind}${v.linkNote ? '·' + v.linkNote : ''}` +
      (v.ok ? ' · 支撑OK' : ` · 丢支撑:${v.problems.join('；')}`);
    ui.frameInfo.style.color = v.ok ? '#9be7a1' : '#ff8080';
  }
  ui.slider.value = i;
}

let lastTime = 0;
function animate(ts) {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, (ts - lastTime) / 1000 || 0);
  lastTime = ts;
  controls.update();
  if (playState.playing && flatFrames?.length) {
    playState.acc = (playState.acc ?? 0) + dt * params.speed;
    const step = Math.floor(playState.acc);
    if (step > 0) {
      playState.acc -= step;
      playState.index = Math.min(flatFrames.length - 1, playState.index + step);
      showFrame(playState.index);
      if (playState.index >= flatFrames.length - 1) playState.playing = false;
    }
  }
  renderer.render(scene, camera);
}

function flashLog(msg) {
  ui.log.value = msg;
}

// ---------- UI 绑定 ----------
function bindUI() {
  ui.log = document.getElementById('log');
  ui.slider = document.getElementById('frameSlider');
  ui.frameInfo = document.getElementById('frameInfo');
  const bind = (id, key, suffix, rebuild) => {
    const el = document.getElementById(id);
    const out = document.getElementById(id + 'Val');
    el.addEventListener('input', () => {
      params[key] = parseFloat(el.value);
      out.textContent = `${params[key].toFixed(2)}${suffix}`;
      if (rebuild) {
        rebuildLevel();
      } else if (goalSurfId) {
        runPlan(goalMarker.position.clone());
      }
    });
  };
  bind('edgeScale', 'edgeScale', ' S', true);
  bind('bodyW', 'bodyW', ' S', false);
  bind('bodyL', 'bodyL', ' S', false);
  bind('bodyT', 'bodyT', ' S', false);
  bind('maxSeam', 'maxSeam', ' S', false);
  bind('speed', 'speed', ' x', false);

  document.getElementById('btnPlay').addEventListener('click', () => {
    if (!flatFrames?.length) return;
    if (playState.index >= flatFrames.length - 1) playState.index = 0;
    playState.playing = true;
    playState.acc = 0;
  });
  document.getElementById('btnPause').addEventListener('click', () => (playState.playing = false));
  document.getElementById('btnStep').addEventListener('click', () => {
    if (!flatFrames?.length) return;
    playState.playing = false;
    showFrame(Math.min(flatFrames.length - 1, playState.index + 1));
    playState.index = Math.min(flatFrames.length - 1, playState.index + 1);
  });
  document.getElementById('btnBack').addEventListener('click', () => {
    if (!flatFrames?.length) return;
    playState.playing = false;
    playState.index = Math.max(0, playState.index - 1);
    showFrame(playState.index);
  });
  document.getElementById('btnVerify').addEventListener('click', () => {
    if (!flatFrames?.length) return;
    verification = verifyFrames(level, flatFrames, bodyDims());
    if (verification.ok) {
      flashLog(`逐步核验通过：共 ${flatFrames.length} 帧，接触点、法线、离面高度、净空全部满足。`);
    } else {
      const f0 = verification.firstFailure;
      flashLog(
        `核验失败于第 ${f0.index + 1}/${flatFrames.length} 帧（计划面「${f0.surfName}」，${f0.stepKind}）\n` +
        `问题：${f0.problems.join('；')}\n` +
        `上一支撑面：${f0.index > 0 ? verification.report[f0.index - 1].surfName : '无（起点）'}`
      );
    }
    showFrame(playState.index);
  });
  document.getElementById('btnReplan').addEventListener('click', () => {
    if (goalSurfId) runPlan(goalMarker.position.clone());
  });
  document.getElementById('btnResetView').addEventListener('click', () => {
    camera.position.set(9, 7.5, 11);
    controls.target.set(0, 2, 0);
  });
  ui.slider.addEventListener('input', () => {
    playState.playing = false;
    playState.index = parseInt(ui.slider.value, 10);
    showFrame(playState.index);
  });
}

initScene();
bindUI();
rebuildLevel();
flashLog('点击任意可附着墙面/顶板指定终点（禁附的半透明板不可选）。');
requestAnimationFrame(animate);
