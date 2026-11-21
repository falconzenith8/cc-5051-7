import * as THREE from 'three';
import { CrawlSim, SLOTS } from './crawlsim.js';
import { wheelPose, doorPose, bandState, worldFromLocal, makeWheelSpec, makeDoorSpec } from './dynamic.js';

const CHAR_STYLE = {
  A: { color: 0xffb347 },
  B: { color: 0x66d9ff },
};
const TICKS_PER_SEC = 8;

// 动态接触带演示：转轮桨叶 × 滑门，预约/撤回/交接/存点恢复的场景视窗
export function initDynDemo({ scene, camera, controls }) {
  const group = new THREE.Group();
  group.name = 'dynDemo';
  scene.add(group);

  const ui = {
    info: document.getElementById('dynInfo'),
    log: document.getElementById('dynLog'),
  };

  let sim = null;
  let mode = 'single';
  let playing = false;
  let acc = 0;
  let loggedTrace = 0;
  let loggedEvents = 0;
  const logLines = [];

  // ---------- 场景物体（尺寸取自 spec，姿态每拍同步） ----------
  const W = makeWheelSpec();
  const D = makeDoorSpec();

  const wheelSpin = new THREE.Group();
  wheelSpin.position.copy(W.C);
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.09, 0.3, 16),
    new THREE.MeshStandardMaterial({ color: 0x8a93a6 })
  );
  hub.rotation.z = Math.PI / 2;
  wheelSpin.add(hub);
  for (let i = 0; i < 4; i++) {
    const spoke = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, W.R * 2, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x5a6378 })
    );
    spoke.rotation.x = (i * Math.PI) / 4;
    wheelSpin.add(spoke);
  }
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(W.R, 0.025, 8, 48),
    new THREE.MeshStandardMaterial({ color: 0x5a6378 })
  );
  rim.rotation.y = Math.PI / 2;
  wheelSpin.add(rim);
  group.add(wheelSpin);

  const paddle = new THREE.Mesh(
    new THREE.BoxGeometry(W.hu * 2, W.hv * 2, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xc98f3d, roughness: 0.7, side: THREE.DoubleSide })
  );
  paddle.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(paddle.geometry),
    new THREE.LineBasicMaterial({ color: 0x2a1f0d })
  ));
  group.add(paddle);

  const door = new THREE.Mesh(
    new THREE.BoxGeometry(D.hu * 2, D.hv * 2, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x4fa3a5, roughness: 0.7, side: THREE.DoubleSide })
  );
  door.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(door.geometry),
    new THREE.LineBasicMaterial({ color: 0x0d2a2b })
  ));
  group.add(door);

  const railY = D.base.y + D.hv + 0.1;
  const rail = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(D.base.x - D.amp - 0.3, railY, D.base.z),
      new THREE.Vector3(D.base.x + D.amp + 0.3, railY, D.base.z),
    ]),
    new THREE.LineBasicMaterial({ color: 0x3a558a })
  );
  group.add(rail);

  const bandMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 0.12, 0.08),
    new THREE.MeshBasicMaterial({ color: 0x33ff88, transparent: true, opacity: 0.45 })
  );
  group.add(bandMesh);

  const wEdgeLine = new THREE.Line(
    new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffb347 })
  );
  const dEdgeLine = new THREE.Line(
    new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x66d9ff })
  );
  group.add(wEdgeLine, dEdgeLine);

  const slotMarkers = SLOTS.map((s) => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0x888888 })
    );
    m.userData.slotId = s.id;
    group.add(m);
    return m;
  });

  const charMeshes = {};
  for (const [id, st] of Object.entries(CHAR_STYLE)) {
    const g = new THREE.Group();
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.44, 0.16),
      new THREE.MeshStandardMaterial({ color: st.color, roughness: 0.6 })
    );
    g.add(box);
    g.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(box.geometry), new THREE.LineBasicMaterial({ color: 0x111111 })
    ));
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xff2222 })
    );
    dot.position.set(0, 0, -0.1);
    g.add(dot);
    g.visible = false;
    charMeshes[id] = g;
    group.add(g);
  }

  // ---------- 日志 ----------
  function appendLog(line) {
    logLines.push(line);
    if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
    ui.log.value = logLines.join('\n');
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function drainEvents() {
    for (; loggedEvents < sim.events.length; loggedEvents++) {
      appendLog(`  ▸ ${sim.events[loggedEvents].msg}`);
    }
  }

  function drainTrace() {
    for (; loggedTrace < sim.trace.length; loggedTrace++) {
      const t = sim.trace[loggedTrace];
      const parts = t.chars.map((c) =>
        `${c.id}@${c.surf === 'wheel' ? '转轮' : '滑门'} 接触点(${c.contact.map((n) => n.toFixed(2)).join(',')})`
      ).join('  ');
      appendLog(
        `#${String(t.tick).padStart(3, '0')} ${t.phase} c${t.contactId} ` +
        `${t.band.open ? `开 gap=${t.band.gap.toFixed(2)}` : '闭'}${parts ? ' ' + parts : ''}`
      );
    }
  }

  // ---------- 姿态同步 ----------
  function setPose(mesh, pose) {
    mesh.position.copy(pose.center);
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(pose.u, pose.v, pose.n));
  }

  function updateLine(line, a, b) {
    line.geometry.setFromPoints([a, b]);
  }

  function syncScene() {
    const wp = wheelPose(sim.wheel, sim.kin.theta);
    const dp = doorPose(sim.door, sim.kin.slide);
    setPose(paddle, wp);
    setPose(door, dp);
    wheelSpin.rotation.x = sim.kin.theta;

    const bs = bandState(sim.wheel, sim.door, sim.kin, sim.opts);
    bandMesh.visible = bs.open;
    if (bs.open) {
      bandMesh.scale.x = Math.max(bs.overlap, 0.06);
      bandMesh.position.set(
        (bs.ov0 + bs.ov1) / 2,
        (bs.wEdge.y + bs.dEdge.y) / 2,
        (bs.wEdge.z + bs.dEdge.z) / 2
      );
    }
    updateLine(wEdgeLine,
      worldFromLocal(wp, { u: -sim.wheel.hu, v: sim.wheel.hv }),
      worldFromLocal(wp, { u: sim.wheel.hu, v: sim.wheel.hv }));
    updateLine(dEdgeLine,
      worldFromLocal(dp, { u: -sim.door.hu, v: -sim.door.hv }),
      worldFromLocal(dp, { u: sim.door.hu, v: -sim.door.hv }));

    for (const m of slotMarkers) {
      const s = SLOTS.find((x) => x.id === m.userData.slotId);
      m.position.copy(worldFromLocal(dp, { u: s.u, v: -sim.door.hv + sim.opts.landMargin }));
      const granted = sim.reservations.some((r) => r.slotId === s.id && r.state === 'granted');
      m.material.color.set(granted ? 0x33ff88 : 0x888888);
    }

    for (const [id, mesh] of Object.entries(charMeshes)) {
      const c = sim.chars.find((x) => x.id === id);
      if (!c) { mesh.visible = false; continue; }
      mesh.visible = true;
      const pose = c.surf === 'wheel' ? wp : dp;
      const contact = worldFromLocal(pose, c.local);
      mesh.position.copy(contact).addScaledVector(pose.n, 0.1);
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(pose.u, pose.v, pose.n));
    }

    ui.info.textContent =
      `拍 ${sim.kin.tick} · ${sim.phaseLabel} · 接触#${sim.kin.contactId} · ` +
      (sim.chars.map((c) =>
        `${c.id}@${c.surf === 'wheel' ? '转轮' : '滑门'}(${c.local.u.toFixed(2)},${c.local.v.toFixed(2)}) ${c.state}`
      ).join(' · ') || '无角色');
  }

  // ---------- 仿真控制 ----------
  function buildSim(m) {
    sim = new CrawlSim();
    if (m === 'duel') {
      sim.addChar('A', 'wheel', { ...sim.parking.wheel });
      sim.addChar('B', 'door', { ...sim.parking.door });
      sim.book('A', 'S0', 'w2d');
      sim.book('B', 'S0', 'd2w');
    } else {
      sim.addChar('A', 'wheel', { ...sim.parking.wheel });
      sim.book('A', 'S0', 'w2d');
    }
    logLines.length = 0;
    loggedTrace = 0;
    loggedEvents = 0;
    appendLog(m === 'duel'
      ? '双角色竞争：A 自转轮、B 自滑门反向预约同一落点 S0'
      : '单角色演示：A 预约转轮→滑门落点 S0，单步经过 相切→分离→重新相接');
    drainEvents();
    syncScene();
  }

  function stepOnce() {
    sim.tick();
    drainEvents();
    drainTrace();
    syncScene();
  }

  document.getElementById('btnDynReset').addEventListener('click', () => { playing = false; buildSim(mode); });
  document.getElementById('btnDynStep').addEventListener('click', () => { playing = false; stepOnce(); });
  document.getElementById('btnDynNextPhase').addEventListener('click', () => {
    playing = false;
    const cur = sim.phaseLabel;
    let guard = 0;
    do { sim.tick(); } while (sim.phaseLabel === cur && ++guard < 3000);
    drainEvents();
    drainTrace();
    syncScene();
  });
  document.getElementById('btnDynPlay').addEventListener('click', () => { playing = !playing; });
  document.getElementById('btnDynFocus').addEventListener('click', () => {
    camera.position.set(12.5, 6.5, 3.5);
    controls.target.set(8.8, 2.6, -2.2);
  });
  document.getElementById('btnDynRevWheel').addEventListener('click', () => {
    sim.reverseWheel();
    drainEvents();
    syncScene();
  });
  document.getElementById('btnDynRevBoth').addEventListener('click', () => {
    sim.reverseBoth();
    drainEvents();
    syncScene();
  });
  document.getElementById('btnDynDuel').addEventListener('click', () => {
    mode = mode === 'duel' ? 'single' : 'duel';
    playing = false;
    buildSim(mode);
  });
  const restore = (tag, label) => {
    playing = false;
    if (!sim.restore(tag)) appendLog(`（尚无${label}存点：先让角色完成一次交接）`);
    loggedEvents = Math.max(0, sim.events.length - 1); // 事件流已随存点截断，游标回退到最后一条（恢复事件）
    drainEvents();
    loggedTrace = sim.trace.length; // 恢复后的新时间线从下一拍开始记录
    syncScene();
  };
  document.getElementById('btnDynRestorePre').addEventListener('click', () => restore('preContact', '接触前'));
  document.getElementById('btnDynRestorePost').addEventListener('click', () => restore('postContact', '接触后'));

  buildSim('single');

  return {
    update(dt) {
      if (playing) {
        acc += dt * TICKS_PER_SEC;
        let guard = 0;
        while (acc >= 1 && ++guard < 40) {
          acc -= 1;
          sim.tick();
        }
        drainEvents();
        drainTrace();
      }
      syncScene();
    },
  };
}
