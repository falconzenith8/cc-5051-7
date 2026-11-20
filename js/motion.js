import * as THREE from 'three';
import {
  bodyFrame, bodyBox, boxesOverlap, pointOnSurface, edgeQuaternion,
} from './math.js';

// 检查某个贴附姿态是否与其它板碰撞（排除支撑面与铰链邻板自身）
function poseCollides(level, bf, body, excludeIds) {
  const box = bodyBox(bf, body);
  for (const s of level.surfs) {
    if (excludeIds.includes(s.id)) continue;
    const thin = s.attachable ? 0.08 : 0.06;
    const hu = Math.max(...s.poly.map((p) => Math.abs(p.clone().sub(s.center).dot(s.frame.u))));
    const hv = Math.max(...s.poly.map((p) => Math.abs(p.clone().sub(s.center).dot(s.frame.v))));
    const obb = {
      center: s.center.clone(),
      half: new THREE.Vector3(hu, hv, thin * 0.5),
      axes: [s.frame.u, s.frame.v, s.frame.n],
    };
    // 贴合容差=身体半厚+小余量：接触点位于板面时，盒面与薄板沿法线的重叠最大为半厚
    if (boxesOverlap(box, obb, body.t * 0.5 + 0.06, bf.contact)) return s;
  }
  return null;
}

// 收集与某条棱拓扑交汇的所有表面：
//  1) 棱中点重合的其它连接（同一铰链的第三块板）
//  2) 与棱端点重合的其它连接（相邻铰链板，翻身扫掠可能贴经）
function hingeSurfaces(level, link) {
  const mid = link.edgeA.a.clone().add(link.edgeA.b).multiplyScalar(0.5);
  const endPts = [link.edgeA.a, link.edgeA.b];
  const ids = new Set([link.a, link.b]);
  for (const other of level.links) {
    if (other === link) continue;
    const m = other.edgeA.a.clone().add(other.edgeA.b).multiplyScalar(0.5);
    if (m.distanceTo(mid) < 0.05) {
      ids.add(other.a);
      ids.add(other.b);
      continue;
    }
    const otherEnds = [other.edgeA.a, other.edgeA.b];
    for (const p of endPts) {
      if (otherEnds.some((q) => q.distanceTo(p) < 0.05)) {
        ids.add(other.a);
        ids.add(other.b);
        break;
      }
    }
  }
  return [...ids];
}

function surfOf(level, id) {
  return level.surfs.find((s) => s.id === id);
}

// 凸外角平滑翻身：接触点钉在棱上，法线绕棱旋转，全程离面高度 = 半厚
function rollFrames(level, link, body, dir) {
  const A = surfOf(level, dir === 'ab' ? link.a : link.b);
  const B = surfOf(level, dir === 'ab' ? link.b : link.a);
  const edge = dir === 'ab' ? link.edgeA : link.edgeB;
  const edgeDir = edge.b.clone().sub(edge.a).normalize();
  const contact = edge.a.clone().add(edge.b).multiplyScalar(0.5);
  const n0 = dir === 'ab' ? A.frame.n : B.frame.n;
  const n1 = dir === 'ab' ? B.frame.n : A.frame.n;
  const qd = edgeQuaternion(n0, n1, edgeDir);
  const N = 26;
  const frames = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const qi = new THREE.Quaternion().setFromAxisAngle(qd.axis, qd.angle * t);
    const n = n0.clone().applyQuaternion(qi);
    const refT = A.frame.u.clone().applyQuaternion(qi);
    frames.push(bodyFrame(contact, n, refT, { t: body.t * 0.5, w: body.w * 0.5, l: body.l * 0.5 }));
  }
  return { frames, contact, exclude: [A.id, B.id] };
}

// 凹内角原地调姿：先沿当前法线抬离，再绕棱转法线，最后落到目标面
function pivotFrames(level, link, body, dir) {
  const A = surfOf(level, dir === 'ab' ? link.a : link.b);
  const B = surfOf(level, dir === 'ab' ? link.b : link.a);
  const edge = dir === 'ab' ? link.edgeA : link.edgeB;
  const edgeDir = edge.b.clone().sub(edge.a).normalize();
  const contact = edge.a.clone().add(edge.b).multiplyScalar(0.5);
  const n0 = dir === 'ab' ? A.frame.n : B.frame.n;
  const n1 = dir === 'ab' ? B.frame.n : A.frame.n;
  const qd = edgeQuaternion(n0, n1, edgeDir);
  const half = { t: body.t * 0.5, w: body.w * 0.5, l: body.l * 0.5 };
  const frames = [];
  // 首帧：标准贴附姿态（离面高度=半厚）
  frames.push(bodyFrame(contact, n0, A.frame.u, half));

  // 抬离距离：保证旋转后盒子在两条面之间不被夹住（按身体最大半尺寸）
  const lift = half.t + Math.max(half.w, half.l) * Math.SQRT1_2 + 0.05;
  const Nlift = 10;
  for (let i = 1; i <= Nlift; i++) {
    const t = i / Nlift;
    // 接触点钉在棱上，中心沿当前法线抬离（离面高度从半厚增加到 lift+半厚）
    const center = contact.clone().addScaledVector(n0, half.t + lift * t);
    frames.push({ center, n: n0.clone(), t1: A.frame.u.clone(), t2: A.frame.v.clone(), contact: contact.clone() });
  }
  const Nrot = 22;
  for (let i = 1; i <= Nrot; i++) {
    const t = i / Nrot;
    const qi = new THREE.Quaternion().setFromAxisAngle(qd.axis, qd.angle * t);
    const n = n0.clone().applyQuaternion(qi);
    const refT = A.frame.u.clone().applyQuaternion(qi);
    const center = contact.clone().addScaledVector(n, half.t + lift);
    frames.push({ center, n, t1: refT, t2: n.clone().cross(refT).normalize(), contact: contact.clone() });
  }
  const Nset = 10;
  for (let i = 1; i <= Nset; i++) {
    const t = i / Nset;
    const center = contact.clone().addScaledVector(n1, half.t + lift * (1 - t));
    frames.push({ center, n: n1.clone(), t1: B.frame.u.clone(), t2: B.frame.v.clone(), contact: contact.clone() });
  }
  // 末帧：标准贴附姿态
  frames.push(bodyFrame(contact, n1, B.frame.u, half));
  return { frames, contact, exclude: [A.id, B.id] };
}

// 跨缝：法线不变，接触点沿两棱中点连线平移
function seamFrames(level, link, body, dir) {
  const A = surfOf(level, dir === 'ab' ? link.a : link.b);
  const B = surfOf(level, dir === 'ab' ? link.b : link.a);
  const eA = dir === 'ab' ? link.edgeA : link.edgeB;
  const eB = dir === 'ab' ? link.edgeB : link.edgeA;
  const c0 = eA.a.clone().add(eA.b).multiplyScalar(0.5);
  const c1 = eB.a.clone().add(eB.b).multiplyScalar(0.5);
  const n = A.frame.n.clone();
  const half = { t: body.t * 0.5, w: body.w * 0.5, l: body.l * 0.5 };
  const frames = [];
  const N = 14;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const c = c0.clone().lerp(c1, t);
    frames.push(bodyFrame(c, n, A.frame.u, half));
  }
  return { frames: frames, contact: c0, exclude: [A.id, B.id] };
}

// 完整可行性检查：支撑、跨缝限制、逐姿态扫掠净空
export function evaluateLink(level, link, body, maxSeam, dir = 'ab') {
  const A = surfOf(level, dir === 'ab' ? link.a : link.b);
  const B = surfOf(level, dir === 'ab' ? link.b : link.a);
  const reasons = [];
  if (!A.attachable || !B.attachable) {
    reasons.push(`面不可附着（${A.attachable ? '' : A.name + ' '}${B.attachable ? '' : B.name}禁附）`);
  }
  if (link.type === 'seam' && link.seam > maxSeam + 1e-9) {
    reasons.push(`缝宽 ${link.seam.toFixed(2)} 超过允许跨缝 ${maxSeam.toFixed(2)}`);
  }
  if (reasons.length) return { ok: false, reasons, frames: [] };

  let gen;
  const exclude = hingeSurfaces(level, link);
  if (link.type === 'seam' || link.corner === 'coplanar') {
    gen = seamFrames(level, link, body, dir);
  } else if (link.corner === 'concave') {
    gen = pivotFrames(level, link, body, dir);
  } else {
    gen = rollFrames(level, link, body, dir);
  }
  gen.exclude = exclude;

  // 支撑检查：首帧必须由 A 支撑（接触点在 A 内、离面高度=半厚），末帧由 B 支撑
  const supportCheck = (bf, s, tag) => {
    if (!pointOnSurface(s, bf.contact, 0)) {
      reasons.push(`${tag}：接触点超出 ${s.name} 边界，失去支撑`);
      return false;
    }
    const off = bf.center.clone().sub(bf.contact).dot(bf.n);
    if (Math.abs(off - body.t * 0.5) > 0.02) {
      reasons.push(`${tag}：离面高度 ${off.toFixed(2)} ≠ 半厚 ${(body.t * 0.5).toFixed(2)}`);
      return false;
    }
    return true;
  };
  supportCheck(gen.frames[0], A, '起始支撑');
  supportCheck(gen.frames[gen.frames.length - 1], B, '末端支撑');

  // 扫掠净空：逐姿态 OBB 碰撞
  let firstHit = null;
  for (let i = 0; i < gen.frames.length; i++) {
    const hit = poseCollides(level, gen.frames[i], body, gen.exclude);
    if (hit) {
      firstHit = { index: i, total: gen.frames.length, surf: hit };
      reasons.push(
        `扫掠第 ${i + 1}/${gen.frames.length} 帧背部与「${hit.name}」相撞（净空不足）`
      );
      break;
    }
  }
  return {
    ok: reasons.length === 0,
    reasons,
    frames: gen.frames,
    firstHit,
    maneuver: link.type === 'seam' || link.corner === 'coplanar'
      ? '跨缝平移'
      : link.corner === 'concave' ? '原地调姿' : '平滑翻身',
  };
}
