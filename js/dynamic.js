import * as THREE from 'three';

// 动态接触带子系统：转轮桨叶 × 滑门
// 桨叶绕 x 轴整周旋转，滑门沿 x 轴三角波滑动；
// 桨叶缝缘（局部 v=+hv）与滑门缝缘（局部 v=-hv）短暂相切时接触带开放。

export const DEFAULTS = {
  gapTol: 0.2,       // 缝缘线距 ≤ 此值视为相切
  minOverlap: 0.3,   // x 向重叠 ≥ 此值接触带才开放
  edgeMargin: 0.05,  // 缝缘停留余量
  landMargin: 0.06,  // 落点离缝缘距离
  crawlSpeed: 0.06,  // 爬行速度（单位/拍）
  relVelTol: 0.09,   // 交接时两面相对速度上限
  jumpTol: 0.4,      // 相邻拍世界接触点最大允许跳变
  horizon: 400,      // 候选时窗扫描范围（拍）
  lead: 30,          // 预约提前量：窗口开始前多少拍开始爬向缝缘
  bodyHalfW: 0.15,   // 身体半宽（落点须整段落在重叠带内）
};

export function makeWheelSpec(over = {}) {
  return {
    id: 'wheel', name: '转轮桨叶',
    C: new THREE.Vector3(8.8, 2.0, -3.0),
    R: 1.2, hu: 0.9, hv: 0.7,
    theta0: 0.9, omega0: 0.03,
    ...over,
  };
}

export function makeDoorSpec(over = {}) {
  return {
    id: 'door', name: '滑门',
    base: new THREE.Vector3(8.8, 3.88, -1.8),
    hu: 0.8, hv: 1.1,
    slide0: 0.0, amp: 0.6, speed: 0.02, dir0: 1,
    ...over,
  };
}

// 桨叶姿态：u 恒为轴向 (1,0,0)，n 为径向，v = n × u 的右手系补全（相切时 v 指向上）
export function wheelPose(spec, theta) {
  const n = new THREE.Vector3(0, Math.cos(theta), Math.sin(theta));
  const u = new THREE.Vector3(1, 0, 0);
  const v = new THREE.Vector3(0, Math.sin(theta), -Math.cos(theta));
  const center = spec.C.clone().addScaledVector(n, spec.R);
  return { center, u, v, n };
}

export function doorPose(spec, slide) {
  const center = spec.base.clone();
  center.x += slide;
  return {
    center,
    u: new THREE.Vector3(1, 0, 0),
    v: new THREE.Vector3(0, 1, 0),
    n: new THREE.Vector3(0, 0, 1),
  };
}

export function worldFromLocal(pose, local) {
  return pose.center.clone()
    .addScaledVector(pose.u, local.u)
    .addScaledVector(pose.v, local.v);
}

export function localFromWorld(pose, p) {
  const rel = p.clone().sub(pose.center);
  return { u: rel.dot(pose.u), v: rel.dot(pose.v), off: rel.dot(pose.n) };
}

// 运动学状态（全部可 JSON 序列化，便于存点）
export function makeKin(wheelSpec, doorSpec) {
  return {
    tick: 0,
    theta: wheelSpec.theta0,
    omega: wheelSpec.omega0,
    slide: doorSpec.slide0,
    slideDir: doorSpec.dir0,
    contactId: 0,
    prevOpen: false,
  };
}

export function stepKin(doorSpec, kin) {
  kin.tick += 1;
  kin.theta += kin.omega;
  kin.slide += kin.slideDir * doorSpec.speed;
  if (kin.slide > doorSpec.amp) {
    kin.slide = 2 * doorSpec.amp - kin.slide;
    kin.slideDir = -1;
  } else if (kin.slide < -doorSpec.amp) {
    kin.slide = -2 * doorSpec.amp - kin.slide;
    kin.slideDir = 1;
  }
}

// 接触带状态：两条缝缘均平行 x 轴，线距取 yz 分量；重叠取 x 区间交
export function bandState(wheelSpec, doorSpec, kin, opts) {
  const wp = wheelPose(wheelSpec, kin.theta);
  const dp = doorPose(doorSpec, kin.slide);
  const wEdge = worldFromLocal(wp, { u: 0, v: wheelSpec.hv });
  const dEdge = worldFromLocal(dp, { u: 0, v: -doorSpec.hv });
  const gap = Math.hypot(dEdge.y - wEdge.y, dEdge.z - wEdge.z);
  const ov0 = Math.max(wp.center.x - wheelSpec.hu, dp.center.x - doorSpec.hu);
  const ov1 = Math.min(wp.center.x + wheelSpec.hu, dp.center.x + doorSpec.hu);
  const overlap = Math.max(0, ov1 - ov0);
  const open = gap <= opts.gapTol && overlap >= opts.minOverlap;
  return { open, gap, overlap, ov0, ov1, wp, dp, wEdge, dEdge };
}

// 表面材质点速度（每拍位移）
export function surfaceVelocity(wheelSpec, doorSpec, kin, surfId, p) {
  if (surfId === 'wheel') {
    return new THREE.Vector3(
      0,
      -kin.omega * (p.z - wheelSpec.C.z),
      kin.omega * (p.y - wheelSpec.C.y)
    );
  }
  return new THREE.Vector3(kin.slideDir * doorSpec.speed, 0, 0);
}

// 候选时窗：从当前运动状态虚拟前推，收集"接触带开放且落点世界 x 落在重叠带内"的连续区间
export function candidateWindows(wheelSpec, doorSpec, kin0, slotLocal, opts) {
  const kin = { ...kin0 };
  let contactId = kin0.contactId;
  let prevOpen = kin0.prevOpen;
  const wins = [];
  let cur = null;
  for (let i = 0; i < opts.horizon; i++) {
    stepKin(doorSpec, kin);
    const bs = bandState(wheelSpec, doorSpec, kin, opts);
    if (bs.open && !prevOpen) contactId += 1;
    prevOpen = bs.open;
    const slotX = bs.dp.center.x + slotLocal.u;
    const inBand = bs.open &&
      slotX >= bs.ov0 + opts.bodyHalfW && slotX <= bs.ov1 - opts.bodyHalfW;
    if (inBand) {
      if (!cur) cur = { t0: kin.tick, t1: kin.tick, contactId };
      else cur.t1 = kin.tick;
    } else if (cur) {
      wins.push(cur);
      cur = null;
    }
  }
  if (cur) wins.push(cur);
  return wins;
}
