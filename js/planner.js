import * as THREE from 'three';
import { evaluateLink } from './motion.js';
import { snapToSurface, pointOnSurface } from './math.js';

// 端口图：每个 link 的两端各是一个端口，端口按 (面, 棱中点) 聚类
function keyOf(surfId, p) {
  return `${surfId}@${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`;
}

function midOf(edge) {
  return edge.a.clone().add(edge.b).multiplyScalar(0.5);
}

const MANEUVER_PENALTY = { 平滑翻身: 1.0, 原地调姿: 1.35, 跨缝平移: 0.9 };

const asVec = (p) => (p && p.isVector3 ? p.clone() : new THREE.Vector3(p.x, p.y, p.z));

export function planPath(level, body, maxSeam, startSurfId, startPoint, goalSurfId, goalPoint) {
  const start = snapToSurface(level.surfs.find((s) => s.id === startSurfId), asVec(startPoint));
  const goal = snapToSurface(level.surfs.find((s) => s.id === goalSurfId), asVec(goalPoint));

  // 评估所有边，记录拒绝原因；通过的边建图
  const rejections = [];
  const ports = new Map();
  let portSeq = 0;
  const getPort = (surfId, point) => {
    const key = keyOf(surfId, point);
    if (!ports.has(key)) {
      ports.set(key, { key: `p${portSeq++}`, matchKey: key, surfId, point: point.clone(), links: [] });
    }
    return ports.get(key);
  };

  for (const link of level.links) {
    const fwd = evaluateLink(level, link, body, maxSeam, 'ab');
    const rev = evaluateLink(level, link, body, maxSeam, 'ba');
    const midA = midOf(link.edgeA);
    const midB = midOf(link.edgeB);
    if (fwd.ok || rev.ok) {
      const pA = getPort(link.a, midA);
      const pB = getPort(link.b, midB);
      if (fwd.ok) {
        pA.links.push({ to: pB, link, dir: 'ab', ev: fwd });
        pB.links.push({ to: pA, link, dir: 'ba', ev: fwd });
      }
      if (rev.ok && !fwd.ok) {
        pB.links.push({ to: pA, link, dir: 'ba', ev: rev });
      }
      if (!fwd.ok) rejections.push({ link, ev: fwd, oneSided: rev.ok });
    } else {
      rejections.push({ link, ev: fwd, oneSided: false });
    }
  }

  // 虚拟起终点端口
  const startPort = { key: `p${portSeq++}`, surfId: startSurfId, point: start, links: [] };
  const goalPort = { key: `p${portSeq++}`, surfId: goalSurfId, point: goal, links: [] };

  // 同面上的端口之间可步行（含起终点虚拟端口，全连接）
  const bySurf = new Map();
  const allPorts = [...ports.values(), startPort, goalPort];
  for (const p of allPorts) {
    if (!bySurf.has(p.surfId)) bySurf.set(p.surfId, []);
    bySurf.get(p.surfId).push(p);
  }
  for (const list of bySurf.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = list[i].point.distanceTo(list[j].point);
        list[i].links.push({ to: list[j], walk: true, cost: d });
        list[j].links.push({ to: list[i], walk: true, cost: d });
      }
    }
  }

  // A*
  const open = new Map();
  const g = new Map();
  const came = new Map();
  g.set(startPort.key, 0);
  open.set(startPort.key, startPort);

  while (open.size) {
    let cur = null;
    let curF = Infinity;
    for (const p of open.values()) {
      const f = g.get(p.key) + p.point.distanceTo(goal);
      if (f < curF) { curF = f; cur = p; }
    }
    open.delete(cur.key);
    if (cur === goalPort) break;
    for (const nb of cur.links) {
      let cost;
      if (nb.walk) cost = nb.cost;
      else cost = cur.point.distanceTo(nb.to.point) * (MANEUVER_PENALTY[nb.ev.maneuver] ?? 1) + 0.15;
      const ng = g.get(cur.key) + cost;
      if (ng < (g.get(nb.to.key) ?? Infinity)) {
        g.set(nb.to.key, ng);
        came.set(nb.to.key, { from: cur, edge: nb });
        open.set(nb.to.key, nb.to);
      }
    }
  }

  if (!came.has(goalPort.key) && startPort !== goalPort) {
    return { ok: false, rejections, steps: [], start, goal };
  }

  // 重建端口序列
  const seq = [];
  let curKey = goalPort.key;
  if (startPort === goalPort) {
    seq.push(startPort);
  } else {
    let guard = 0;
    while (curKey !== startPort.key) {
      const node = came.get(curKey);
      if (!node) {
        console.error('链断裂 at', curKey, '已收集', seq.length);
        return { ok: false, rejections, steps: [], start, goal };
      }
      const nextNode = node.edge.to;
      if (!nextNode) {
        console.error('node.edge.to 为空', node);
        return { ok: false, rejections, steps: [], start, goal };
      }
      seq.unshift(nextNode);
      curKey = node.from.key;
      if (++guard > 10000) return { ok: false, rejections, steps: [], start, goal };
    }
    seq.unshift(startPort);
  }

  // 转成动作步骤
  const steps = [];
  for (let i = 0; i < seq.length - 1; i++) {
    const a = seq[i];
    const b = seq[i + 1];
    const edge = a.links.find((l) => l.to.key === b.key);
    if (!edge) return { ok: false, rejections, steps: [], start, goal };
    if (edge.walk) {
      steps.push({ kind: 'walk', surfId: a.surfId, from: a.point.clone(), to: b.point.clone() });
    } else {
      steps.push({
        kind: 'edge',
        link: edge.link,
        dir: edge.dir,
        ev: edge.ev,
        fromSurf: a.surfId,
        toSurf: b.surfId,
      });
    }
  }
  return { ok: true, steps, rejections, start, goal };
}

// 步行帧：接触点在表面内等距插值
function walkFrames(level, step, body) {
  const surf = level.surfs.find((s) => s.id === step.surfId);
  const half = { t: body.t * 0.5, w: body.w * 0.5, l: body.l * 0.5 };
  const dist = step.from.distanceTo(step.to);
  const N = Math.max(2, Math.ceil(dist / 0.25));
  const frames = [];
  for (let i = 0; i <= N; i++) {
    const c = step.from.clone().lerp(step.to, i / N);
    const f = {
      center: c.clone().addScaledVector(surf.frame.n, half.t),
      n: surf.frame.n.clone(),
      t1: surf.frame.u.clone(),
      t2: surf.frame.v.clone(),
      contact: c,
    };
    frames.push(f);
  }
  return frames;
}

// 把规划结果展开为连续回放帧序列，并标注每帧计划支撑面
export function flattenPlan(level, plan, body) {
  const out = [];
  for (const step of plan.steps) {
    if (step.kind === 'walk') {
      const frames = walkFrames(level, step, body);
      frames.forEach((f, local) => out.push({
        f, surfId: step.surfId, step, local, total: frames.length,
      }));
    } else {
      const frames = step.ev.frames;
      const idA = step.dir === 'ab' ? step.link.a : step.link.b;
      const idB = step.dir === 'ab' ? step.link.b : step.link.a;
      const A = level.surfs.find((s) => s.id === idA);
      const B = level.surfs.find((s) => s.id === idB);
      const seamLike = step.link.type === 'seam' || step.link.corner === 'coplanar';
      for (let local = 0; local < frames.length; local++) {
        const f = frames[local];
        let surfId;
        if (seamLike) {
          // 共面/跨缝：按接触点落在哪块板上判定计划面，缝隙中归属较近一侧
          surfId = pointOnSurface(B, f.contact, 0) ? B.id : A.id;
        } else {
          surfId = f.n.dot(B.frame.n) > f.n.dot(A.frame.n) ? B.id : A.id;
        }
        out.push({ f, surfId, step, local, total: frames.length });
      }
    }
  }
  return out;
}
