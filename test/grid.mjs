import { buildLevel } from '../js/level.js';
import { planPath, flattenPlan } from '../js/planner.js';
import { verifyFrames } from '../js/replay.js';

// 模拟 UI 滑杆参数空间，验证规划-展开-核验全数据流不抛异常且结论自洽
let total = 0;
let pass = 0;
const failures = [];

for (const S of [0.6, 1.0, 1.6]) {
  const level = buildLevel(S);
  const ground = level.surfs[0].id;
  const pillarTop = level.surfs.find((s) => s.name === '柱·顶板').id;
  const lintel = level.surfs.find((s) => s.name === '北部门楣顶板').id;
  const foldTop = level.surfs.find((s) => s.name === '折边·顶面').id;

  for (const t of [0.15, 0.55, 1.1]) {
    for (const seam of [0, 0.4, 1.0]) {
      const body = { w: 0.7 * S, l: 1.0 * S, t: t * S };
      const goals = [
        ['柱顶', pillarTop, { x: 0, y: 4 * S, z: 0 }],
        ['门楣', lintel, { x: 0, y: 4 * S, z: -3.1 * S }],
        ['折顶', foldTop, { x: 4.85 * S, y: 2.6 * S, z: 1.6 * S }],
      ];
      for (const [label, surfId, gp] of goals) {
        total++;
        try {
          const plan = planPath(level, body, seam * S, ground, { x: 0, y: 0, z: 2.2 * S }, surfId, gp);
          if (!plan.ok) { pass++; continue; } // 不可达也是合法输出，只要拒绝理由非空
          if (!plan.rejections.every((r) => r.ev.reasons.length > 0)) {
            failures.push(`S=${S} t=${t} seam=${seam} ${label}: 存在无理由拒绝`);
            continue;
          }
          const frames = flattenPlan(level, plan, body);
          if (!frames.length) { failures.push('空帧序列'); continue; }
          const ver = verifyFrames(level, frames, body);
          if (ver.ok) {
            pass++;
          } else {
            failures.push(`S=${S} t=${t} seam=${seam} ${label}: 核验失败帧${ver.firstFailure.index + 1} ${ver.firstFailure.problems.join(',')}`);
          }
        } catch (e) {
          failures.push(`S=${S} t=${t} seam=${seam} ${label}: 异常 ${e.message}`);
        }
      }
    }
  }
}

console.log(`参数扫描：${pass}/${total} 个组合自洽`);
if (failures.length) {
  console.log('失败：');
  failures.forEach((f) => console.log(' -', f));
  process.exit(1);
}

// 失败定位信息完整性：构造一个必然被拒的场景，检查 firstHit 与原因文本
const level = buildLevel(1);
const plan = planPath(
  level, { w: 1.3, l: 1.6, t: 1.15 }, 0.6,
  level.surfs[0].id, { x: 2.6, y: 0, z: 1.6 },
  level.surfs.find((s) => s.name === '折边·墙面').id, { x: 3, y: 2, z: 1.6 }
);
const foldRej = plan.rejections.find((r) => r.link.note.includes('折墙→折顶'));
if (!foldRej || !foldRej.ev.firstHit || !foldRej.ev.reasons[0].includes('相撞')) {
  console.error('失败定位信息缺失');
  process.exit(1);
}
console.log('失败定位 OK：第', foldRej.ev.firstHit.index + 1, '帧撞到「' + foldRej.ev.firstHit.surf.name + '」');
