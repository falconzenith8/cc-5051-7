import { v, frameFromNormalEdge } from './math.js';

// 构造一个矩形表面：center 中心，n 法线，u 长边方向，半宽 hu/hv
function makeRect(id, name, center, n, u, hu, hv, attachable, color) {
  const frame = frameFromNormalEdge(n, u);
  const poly = [
    center.clone().addScaledVector(frame.u, -hu).addScaledVector(frame.v, -hv),
    center.clone().addScaledVector(frame.u, hu).addScaledVector(frame.v, -hv),
    center.clone().addScaledVector(frame.u, hu).addScaledVector(frame.v, hv),
    center.clone().addScaledVector(frame.u, -hu).addScaledVector(frame.v, hv),
  ];
  return { id, name, center: center.clone(), frame, poly, attachable, color };
}

// 找到表面上棱中点最接近 mid 的棱
function edgeAtMidpoint(surf, mid, tol = 0.05) {
  let best = null;
  for (let i = 0; i < surf.poly.length; i++) {
    const a = surf.poly[i];
    const b = surf.poly[(i + 1) % surf.poly.length];
    const m = a.clone().add(b).multiplyScalar(0.5);
    const d = m.distanceTo(mid);
    if (!best || d < best.d) best = { a, b, d };
  }
  if (best.d > tol + 1e-6) {
    throw new Error(`棱中点不匹配：${surf.name} 上找不到 ${mid.toArray().map((n) => n.toFixed(2))}（最近 ${best.d.toFixed(2)}）`);
  }
  return { a: best.a, b: best.b };
}

// 在表面平面内，以 mid 为中点、dir 为方向、len 为长度构造线段（用于大面上的投影棱）
function projectedEdge(surf, mid, dir, len) {
  const d = dir.clone().sub(surf.frame.n.clone().multiplyScalar(dir.dot(surf.frame.n))).normalize();
  return { a: mid.clone().addScaledVector(d, -len / 2), b: mid.clone().addScaledVector(d, len / 2) };
}

// 建立拓扑连接：若未显式给棱端点，则按中点匹配表面自身棱；大面侧可用投影棱
function linkSurfs(surfs, idA, idB, specA, specB, type, corner, seam, note) {
  const A = surfs.find((s) => s.id === idA);
  const B = surfs.find((s) => s.id === idB);
  const resolve = (surf, spec) => {
    if (spec.edge) return spec.edge;
    if (spec.projected) return projectedEdge(surf, spec.mid, spec.dir, spec.len);
    return edgeAtMidpoint(surf, spec.mid);
  };
  return {
    a: idA,
    b: idB,
    type, // 'shared' | 'seam'
    corner, // convex | concave | coplanar
    seam, // 两棱间的真实间隙
    edgeA: resolve(A, specA),
    edgeB: resolve(B, specB),
    note,
  };
}

export function buildLevel(S) {
  const surfs = [];
  let k = 0;
  const add = (...args) => {
    const s = makeRect(...args);
    surfs.push(s);
    return s;
  };

  const colAttach = 0x6fa8dc;
  const topAttach = 0x4fa3a5;
  const groundCol = 0x8fbc6f;
  const blockedCol = 0x9e9e9e;

  // ---- 地面 A（主地面，留一条缝）----
  add(`s${k++}`, '主地面', v(0, 0, 0.5 * S), v(0, 1, 0), v(1, 0, 0), 5.2 * S, 4.5 * S, true, groundCol);
  // ---- 地面 B（缝北侧，不共边但距离可跨）；A 北缘 z=-4S，B 南缘 z=-4.4S，间隙 0.4S ----
  add(`s${k++}`, '缝北地面', v(0, 0, -5.3 * S), v(0, 1, 0), v(1, 0, 0), 5.2 * S, 0.9 * S, true, groundCol);

  // ---- 中央方柱：四面墙 + 顶板 ----
  const pw = S;            // 柱半宽
  const ph = 4 * S;        // 柱高
  add(`s${k++}`, '柱·南墙', v(0, ph / 2, pw), v(0, 0, 1), v(1, 0, 0), pw, ph / 2, true, colAttach);
  add(`s${k++}`, '柱·北墙', v(0, ph / 2, -pw), v(0, 0, -1), v(1, 0, 0), pw, ph / 2, true, colAttach);
  add(`s${k++}`, '柱·西墙', v(-pw, ph / 2, 0), v(-1, 0, 0), v(0, 0, 1), pw, ph / 2, true, colAttach);
  add(`s${k++}`, '柱·东墙', v(pw, ph / 2, 0), v(1, 0, 0), v(0, 0, -1), pw, ph / 2, true, colAttach);
  add(`s${k++}`, '柱·顶板', v(0, ph, 0), v(0, 1, 0), v(1, 0, 0), pw, pw, true, topAttach);

  // ---- 柱北顶板外挑的门楣板（顶板向北伸出）：与柱北墙形成凹内角 ----
  const lintHalf = 1.1 * S;
  add(
    `s${k++}`, '北部门楣顶板', v(0, ph, -pw - lintHalf), v(0, 1, 0), v(1, 0, 0),
    pw, lintHalf, true, topAttach
  );

  // ---- 折边结构：墙 + 顶 两面共享拓扑边；上方第三块板形成背部净空威胁 ----
  const foldX = 3.0 * S;
  const foldZ = 1.6 * S;
  const fw = 1.2 * S;
  const fh = 2.6 * S;
  const topHalf = 1.0 * S;
  add(`s${k++}`, '折边·墙面', v(foldX, fh / 2, foldZ), v(1, 0, 0), v(0, 0, -1), fw, fh / 2, true, colAttach);
  add(
    `s${k++}`, '折边·顶面', v(foldX + topHalf, fh, foldZ), v(0, 1, 0),
    v(1, 0, 0), topHalf, fw, true, topAttach
  );
  // 东侧挡板：折边顶面被拒绝时的绕路出口
  const baffleX = foldX + 2 * topHalf;
  add(
    `s${k++}`, '折边·东挡板', v(baffleX, fh / 2, foldZ), v(1, 0, 0),
    v(0, 0, 1), fw, fh / 2, true, colAttach
  );
  // 绕路平台：从东挡板顶向东延伸，超出悬顶板覆盖范围，厚身体可借此绕回
  const detourHalf = 0.9 * S;
  add(
    `s${k++}`, '绕路平台', v(baffleX + detourHalf, fh, foldZ), v(0, 1, 0),
    v(1, 0, 0), detourHalf, fw, true, topAttach
  );
  // 第三块板：悬在墙顶棱上方，不参与附着；薄身体可过、厚身体翻身被挡，不覆盖折顶东端与绕路平台
  add(
    `s${k++}`, '悬顶障碍板(禁附)', v(foldX - 0.1 * topHalf, fh + 0.55 * S, foldZ),
    v(0, -1, 0), v(1, 0, 0), 0.7 * topHalf, fw * 1.05, false, blockedCol
  );
  // 很近却完全不连接的表皮：与折边墙面平行，只覆盖墙上半段，禁附；厚身体翻身扫掠时可能擦碰
  const skinH = fh * 0.4;
  add(
    `s${k++}`, '近距断开表皮(禁附)', v(foldX - 0.55 * S, fh - skinH / 2 + 0.1 * S, foldZ),
    v(-1, 0, 0), v(0, 0, 1), fw * 1.1, skinH / 2, false, 0x7a5c9e
  );

  // ---- 拓扑边连接表（显式棱规格）----
  // corner: convex=凸外角(平滑翻身) concave=凹内角(原地调姿) coplanar=共面拼缝
  const ids = surfs.map((s) => s.id);
  const links = [];
  const at = (mid) => ({ mid });
  const proj = (mid, dir, len) => ({ projected: true, mid, dir, len });
  const L = (a, b, specA, specB, type, corner, seam, note) =>
    links.push(linkSurfs(surfs, ids[a], ids[b], specA, specB, type, corner, seam, note));

  // 地面跨缝：两条都是地面自身棱
  L(0, 1, at(v(0, 0, -4 * S)), at(v(0, 0, -4.4 * S)), 'seam', 'coplanar', 0.4 * S, '地面跨缝');
  // 柱四墙落地：地面侧为投影棱（沿 x 或 z，长度 2S）
  L(0, 2, proj(v(0, 0, S), v(1, 0, 0), 2 * S), at(v(0, 0, S)), 'shared', 'convex', 0, '柱南墙落地');
  L(0, 3, proj(v(0, 0, -S), v(1, 0, 0), 2 * S), at(v(0, 0, -S)), 'shared', 'convex', 0, '柱北墙落地');
  L(0, 4, proj(v(-S, 0, 0), v(0, 0, 1), 2 * S), at(v(-S, 0, 0)), 'shared', 'convex', 0, '柱西墙落地');
  L(0, 5, proj(v(S, 0, 0), v(0, 0, 1), 2 * S), at(v(S, 0, 0)), 'shared', 'convex', 0, '柱东墙落地');
  // 柱墙之间的竖向棱（柱四角，中点 y=2S）
  L(2, 5, at(v(S, 2 * S, S)), at(v(S, 2 * S, S)), 'shared', 'convex', 0, '柱东南角棱');
  L(2, 4, at(v(-S, 2 * S, S)), at(v(-S, 2 * S, S)), 'shared', 'convex', 0, '柱西南角棱');
  L(3, 5, at(v(S, 2 * S, -S)), at(v(S, 2 * S, -S)), 'shared', 'convex', 0, '柱东北角棱');
  L(3, 4, at(v(-S, 2 * S, -S)), at(v(-S, 2 * S, -S)), 'shared', 'convex', 0, '柱西北角棱');
  // 柱顶板四缘（y=4S）与墙顶：外角翻滚
  L(2, 6, at(v(0, 4 * S, S)), at(v(0, 4 * S, S)), 'shared', 'convex', 0, '南墙→柱顶(外角)');
  L(3, 6, at(v(0, 4 * S, -S)), at(v(0, 4 * S, -S)), 'shared', 'convex', 0, '北墙→柱顶(外角)');
  L(4, 6, at(v(-S, 4 * S, 0)), at(v(-S, 4 * S, 0)), 'shared', 'convex', 0, '西墙→柱顶(外角)');
  L(5, 6, at(v(S, 4 * S, 0)), at(v(S, 4 * S, 0)), 'shared', 'convex', 0, '东墙→柱顶(外角)');
  // 门楣：与柱北墙凹内角；与柱顶共面拼缝（同一条棱两侧）
  L(3, 7, at(v(0, 4 * S, -S)), at(v(0, 4 * S, -S)), 'shared', 'concave', 0, '北墙→门楣(凹内角)');
  L(6, 7, at(v(0, 4 * S, -S)), at(v(0, 4 * S, -S)), 'shared', 'coplanar', 0, '柱顶→门楣(共面拼缝)');
  // 折边墙顶共享边（凸外角，上方悬顶）
  L(8, 9, at(v(foldX, fh, foldZ)), at(v(foldX, fh, foldZ)), 'shared', 'convex', 0, '折墙→折顶(凸外角,悬顶净空)');
  L(9, 10, at(v(foldX + 2 * topHalf, fh, foldZ)), at(v(foldX + 2 * topHalf, fh, foldZ)), 'shared', 'convex', 0, '折顶→东挡板(外角)');
  // 绕路平台：东挡板顶→平台（外角），平台→折顶（共面拼缝，位于悬顶板覆盖之外）
  L(10, 11, at(v(baffleX, fh, foldZ)), at(v(baffleX, fh, foldZ)), 'shared', 'convex', 0, '东挡板→绕路平台(外角)');
  L(11, 9, at(v(baffleX, fh, foldZ)), at(v(baffleX, fh, foldZ)), 'shared', 'coplanar', 0, '绕路平台→折顶(共面拼缝)');
  // 折边两墙落地（墙半宽 fw，棱全长 2fw）
  L(8, 0, at(v(foldX, 0, foldZ)), proj(v(foldX, 0, foldZ), v(0, 0, 1), 2 * fw), 'shared', 'convex', 0, '折墙落地');
  L(10, 0, at(v(baffleX, 0, foldZ)), proj(v(baffleX, 0, foldZ), v(0, 0, 1), 2 * fw), 'shared', 'convex', 0, '东挡板落地');

  return { surfs, links };
}
