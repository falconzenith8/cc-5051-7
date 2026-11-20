import * as THREE from 'three';
import { pointOnSurface, bodyBox, boxesOverlap } from './math.js';

// 逐帧核验：身体是否始终贴在计划支撑面上，并报告第一个失败点
export function verifyFrames(level, frames, body) {
  const report = [];
  for (let i = 0; i < frames.length; i++) {
    const { f, surfId, step, local, total } = frames[i];
    const surf = level.surfs.find((s) => s.id === surfId);
    const problems = [];
    const isEndpoint = local === 0 || local === total - 1;
    const isSeam = step.kind === 'edge' && (step.link.type === 'seam' || step.link.corner === 'coplanar');
    const isPivot = step.kind === 'edge' && step.link.corner === 'concave';

    // 1) 接触点必须在计划面上；跨缝中段允许位于缝隙上方，凹内角调姿接触点钉在棱上（两面边界）
    const onPoly = pointOnSurface(surf, f.contact, 0);
    if (!onPoly && !(isSeam && !isEndpoint) && !(isPivot && !isEndpoint)) {
      problems.push(`接触点离开计划面「${surf.name}」`);
    }

    // 2) 法线：步行时必须与计划面一致；过棱中间帧为过渡姿态，要求夹在两面法线之间
    const nAlign = f.n.dot(surf.frame.n);
    if (step.kind === 'walk' && nAlign < 0.99 - 1e-6) {
      problems.push(`身体法线与「${surf.name}」法线偏差 ${((1 - nAlign) * 90).toFixed(1)}°`);
    }
    if (step.kind === 'edge') {
      const idA = step.dir === 'ab' ? step.link.a : step.link.b;
      const idB = step.dir === 'ab' ? step.link.b : step.link.a;
      const sA = level.surfs.find((s) => s.id === idA);
      const sB = level.surfs.find((s) => s.id === idB);
      const span = sA.frame.n.dot(sB.frame.n);
      const inCone = f.n.dot(sA.frame.n) >= span - 1e-4 && f.n.dot(sB.frame.n) >= span - 1e-4;
      if (!inCone) problems.push('过渡姿态法线超出两支撑面法线构成的旋转锥');
    }

    // 3) 离面高度：步行与过棱首末帧必须=半厚；过棱中间帧允许抬离（调姿/翻身扫掠）
    const off = f.center.clone().sub(f.contact).dot(f.n);
    const strictHeight = step.kind === 'walk' || isEndpoint;
    if (strictHeight && Math.abs(off - body.t * 0.5) > 0.02) {
      problems.push(`离面高度 ${off.toFixed(2)} ≠ 半厚 ${(body.t * 0.5).toFixed(2)}`);
    }
    if (!strictHeight && off < body.t * 0.5 - 0.02) {
      problems.push(`中间帧离面高度 ${off.toFixed(2)} 小于半厚，身体侵入板面`);
    }

    // 4) 净空：步行时排除与当前面共享棱的邻板（墙脚/板缘的贴合合法）；过棱时排除铰链关联板
    let exclude = [surfId];
    if (step.kind === 'walk') {
      for (const other of level.links) {
        if (other.a === surfId) exclude.push(other.b);
        if (other.b === surfId) exclude.push(other.a);
      }
    } else {
      const mid = step.link.edgeA.a.clone().add(step.link.edgeA.b).multiplyScalar(0.5);
      const endPts = [step.link.edgeA.a, step.link.edgeA.b];
      exclude = [step.link.a, step.link.b];
      for (const other of level.links) {
        if (other === step.link) continue;
        const m = other.edgeA.a.clone().add(other.edgeA.b).multiplyScalar(0.5);
        if (m.distanceTo(mid) < 0.05) {
          exclude.push(other.a, other.b);
          continue;
        }
        const otherEnds = [other.edgeA.a, other.edgeA.b];
        if (endPts.some((p) => otherEnds.some((q) => q.distanceTo(p) < 0.05))) {
          exclude.push(other.a, other.b);
        }
      }
    }
    const box = bodyBox(f, body);
    for (const s of level.surfs) {
      if (exclude.includes(s.id)) continue;
      const thin = s.attachable ? 0.08 : 0.06;
      const hu = Math.max(...s.poly.map((p) => Math.abs(p.clone().sub(s.center).dot(s.frame.u))));
      const hv = Math.max(...s.poly.map((p) => Math.abs(p.clone().sub(s.center).dot(s.frame.v))));
      const obb = {
        center: s.center.clone(),
        half: new THREE.Vector3(hu, hv, thin * 0.5),
        axes: [s.frame.u, s.frame.v, s.frame.n],
      };
      // 贴合容差=身体半厚+小余量，仅在接触点所在板面边缘带生效
      if (boxesOverlap(box, obb, body.t * 0.5 + 0.06, f.contact)) {
        problems.push(`身体与「${s.name}」发生碰撞，净空被破坏`);
        break;
      }
    }

    report.push({
      index: i,
      ok: problems.length === 0,
      problems,
      surfName: surf.name,
      stepKind: step.kind === 'walk' ? '贴面前进' : (step.ev?.maneuver ?? '过棱'),
      linkNote: step.kind === 'edge' ? step.link.note : '',
    });
    if (problems.length) {
      return { ok: false, firstFailure: report[i], report };
    }
  }
  return { ok: true, firstFailure: null, report };
}
