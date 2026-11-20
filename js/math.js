import * as THREE from 'three';

export const UP = new THREE.Vector3(0, 1, 0);

export function v(x, y, z) {
  return new THREE.Vector3(x, y, z);
}

// 由法线与一条棱方向构造正交局部框架 (u, v, n)，v = n × u
export function frameFromNormalEdge(n, edgeDir) {
  const nrm = n.clone().normalize();
  let u = edgeDir.clone().normalize();
  u.sub(nrm.clone().multiplyScalar(u.dot(nrm)));
  if (u.lengthSq() < 1e-10) {
    u = Math.abs(nrm.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    u.sub(nrm.clone().multiplyScalar(u.dot(nrm)));
  }
  u.normalize();
  const vv = new THREE.Vector3().crossVectors(nrm, u).normalize();
  return { u, v: vv, n: nrm };
}

// 绕棱把源法线旋转到目标法线，返回四元数与旋转轴、转角
export function edgeQuaternion(nSrc, nDst, edgeDir) {
  const a = nSrc.clone().normalize();
  const b = nDst.clone().normalize();
  let axis = new THREE.Vector3().crossVectors(a, b);
  if (axis.lengthSq() < 1e-12) {
    axis = edgeDir.clone().normalize();
  } else {
    axis.normalize();
    // 保证旋转轴与棱方向平行（符号与棱一致即可，转角带符号）
    if (axis.dot(edgeDir) < 0) axis.negate();
  }
  let cos = THREE.MathUtils.clamp(a.dot(b), -1, 1);
  let angle = Math.acos(cos);
  // 判定方向：绕 axis 正转是否把 a 带到 b
  const probe = a.clone().applyAxisAngle(axis, angle);
  if (probe.distanceTo(b) > 1e-4) angle = -angle;
  const q = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  return { q, axis, angle };
}

export function rotateFrame(frame, q) {
  return {
    u: frame.u.clone().applyQuaternion(q).normalize(),
    v: frame.v.clone().applyQuaternion(q).normalize(),
    n: frame.n.clone().applyQuaternion(q).normalize(),
  };
}

// 身体贴附姿态：接触面接触点 + 法线 + 半厚
export function bodyFrame(contact, n, refTangent, half) {
  const nrm = n.clone().normalize();
  let t1 = refTangent.clone();
  t1.sub(nrm.clone().multiplyScalar(t1.dot(nrm)));
  if (t1.lengthSq() < 1e-10) {
    t1 = Math.abs(nrm.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    t1.sub(nrm.clone().multiplyScalar(t1.dot(nrm)));
  }
  t1.normalize();
  const t2 = nrm.clone().cross(t1).normalize();
  const center = contact.clone().add(nrm.clone().multiplyScalar(half.t));
  return { center, n: nrm, t1, t2, contact: contact.clone() };
}

export function bodyBox(bf, body) {
  return {
    center: bf.center,
    half: new THREE.Vector3(body.w * 0.5, body.l * 0.5, body.t * 0.5),
    axes: [bf.t1, bf.t2, bf.n],
  };
}

// 身体盒 A 与薄板 OBB B 的碰撞（完整 SAT）：
//  接触点在 B 板面覆盖范围（含边缘带）内、且身体沿 B 法线仍在板片之外（有向间距≥板半厚）时，
//  允许 contactTol 的贴合容差；接触点远离板面、或身体真正穿入板内（如顶入悬顶板）则不享容差，按碰撞处理。
export function boxesOverlap(A, B, contactTol = 0, contactPoint = null) {
  const eps = 1e-9;
  let inBand = false;
  if (contactPoint && contactTol > 0) {
    const rel = contactPoint.clone().sub(B.center);
    const xu = rel.dot(B.axes[0]);
    const yv = rel.dot(B.axes[1]);
    const band = Math.max(B.half.x, B.half.y) * 0.15;
    inBand = Math.abs(xu) <= B.half.x + band && Math.abs(yv) <= B.half.y + band;
  }
  const axes = [
    A.axes[0], A.axes[1], A.axes[2],
    B.axes[0], B.axes[1], B.axes[2],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const cross = new THREE.Vector3().crossVectors(A.axes[i], B.axes[j]);
      if (cross.lengthSq() > eps) axes.push(cross.normalize());
    }
  }
  const d = B.center.clone().sub(A.center);
  for (const ax of axes) {
    const rA =
      Math.abs(A.axes[0].dot(ax)) * A.half.x +
      Math.abs(A.axes[1].dot(ax)) * A.half.y +
      Math.abs(A.axes[2].dot(ax)) * A.half.z;
    const rB =
      Math.abs(B.axes[0].dot(ax)) * B.half.x +
      Math.abs(B.axes[1].dot(ax)) * B.half.y +
      Math.abs(B.axes[2].dot(ax)) * B.half.z;
    const isNormalAxis = Math.abs(ax.dot(B.axes[2])) > 0.999;
    // 容差只吸收"贴近但未侵入薄板"的接触：身体沿板法线仍在板片之外（有向间距≥板半厚）。
    // 有向间距小于板半厚意味着身体真正穿入板内（如从悬顶板下方顶入），按真实碰撞处理。
    const signedGap = d.dot(ax);
    const rBnormal = Math.abs(B.axes[2].dot(ax)) * B.half.z;
    const tol = inBand && isNormalAxis && signedGap >= rBnormal - eps ? contactTol : 0;
    if (Math.abs(signedGap) > rA + rB + eps - tol) return false;
  }
  return true;
}

// 点是否在表面多边形内（凸多边形半平面法，含边界；margin 为向内收缩余量）
export function pointOnSurface(surf, p, margin = 0) {
  const d = p.clone().sub(surf.center).dot(surf.frame.n);
  if (Math.abs(d) > 0.05 + margin) return false;
  const rp = p.clone().sub(surf.center);
  const x = rp.dot(surf.frame.u);
  const y = rp.dot(surf.frame.v);
  const coords = surf.poly.map((q) => {
    const r = q.clone().sub(surf.center);
    return [r.dot(surf.frame.u), r.dot(surf.frame.v)];
  });
  const tol = 1e-4;
  // 自适应多边形绕序（矩形板在 (u,v) 投影下可能为 CW 或 CCW）
  let signedArea = 0;
  for (let i = 0; i < coords.length; i++) {
    const a = coords[i];
    const b = coords[(i + 1) % coords.length];
    signedArea += a[0] * b[1] - b[0] * a[1];
  }
  const winding = signedArea >= 0 ? 1 : -1;
  for (let i = 0; i < coords.length; i++) {
    const a = coords[i];
    const b = coords[(i + 1) % coords.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const cross = ex * (y - a[1]) - ey * (x - a[0]);
    if (cross * winding < -tol) return false;
  }
  if (margin <= 0) return true;
  for (let i = 0; i < coords.length; i++) {
    const a = coords[i];
    const b = coords[(i + 1) % coords.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len2 = ex * ex + ey * ey;
    let t = ((x - a[0]) * ex + (y - a[1]) * ey) / len2;
    t = THREE.MathUtils.clamp(t, 0, 1);
    const px = a[0] + ex * t;
    const py = a[1] + ey * t;
    if (Math.hypot(x - px, y - py) < margin) return false;
  }
  return true;
}

// 把点吸附到表面平面；若在多边形外则沿质心方向夹回
export function snapToSurface(surf, p) {
  const d = p.clone().sub(surf.center).dot(surf.frame.n);
  let q = p.clone().sub(surf.frame.n.clone().multiplyScalar(d));
  if (pointOnSurface(surf, q, 0.02)) return q;
  const toC = surf.center.clone().sub(q);
  for (let t = 0.05; t <= 1.0; t += 0.05) {
    const cand = q.clone().add(toC.clone().multiplyScalar(t));
    if (pointOnSurface(surf, cand, 0.05)) return cand;
  }
  return surf.center.clone();
}
