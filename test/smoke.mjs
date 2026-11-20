import { buildLevel } from '../js/level.js';
import { planPath, flattenPlan } from '../js/planner.js';
import { verifyFrames } from '../js/replay.js';

const S = 1.0;
const level = buildLevel(S);
const maxSeam = 0.6;

function run(label, body, startSurf, startP, goalSurf, goalP) {
  const plan = planPath(level, body, maxSeam, startSurf, startP, goalSurf, goalP);
  console.log(`\n=== ${label} ===`);
  console.log('可达:', plan.ok, '| 动作段:', plan.steps.length, '| 被拒边:', plan.rejections.length);
  for (const r of plan.rejections) {
    console.log('  拒绝:', r.link.note, '->', r.ev.reasons[0]);
  }
  if (!plan.ok) return plan;
  const frames = flattenPlan(level, plan, body);
  const ver = verifyFrames(level, frames, body);
  console.log('帧数:', frames.length, '| 核验:', ver.ok ? 'PASS' : 'FAIL');
  if (!ver.ok) console.log('  失败帧:', ver.firstFailure.index + 1, ver.firstFailure.problems);
  const maneuvers = plan.steps.filter((s) => s.kind === 'edge').map((s) => `${s.link.note}[${s.ev.maneuver}]`);
  console.log('过棱序列:', maneuvers.join(' -> ') || '(无)');
  return plan;
}

const ground = level.surfs[0].id;
const foldWall = level.surfs.find((s) => s.name === '折边·墙面').id;
const foldTop = level.surfs.find((s) => s.name === '折边·顶面').id;
const pillarTop = level.surfs.find((s) => s.name === '柱·顶板').id;
const lintel = level.surfs.find((s) => s.name === '北部门楣顶板').id;
const groundB = level.surfs[1].id;

// 1) 薄身体：折墙→折顶的外角翻身应通过
run('薄身体爬折顶', { w: 0.5, l: 0.7, t: 0.2 }, ground, { x: 3.4, y: 0, z: 3.2 }, foldTop, { x: 4.6, y: 2.6, z: 1.6 });

// 2) 厚身体：直接翻折边应被悬顶拒绝，规划改走东挡板绕路上折顶（目标选在折顶东端净空区）
const thickPlan = run('厚身体爬折顶(应拒边绕路)', { w: 0.9, l: 1.2, t: 0.95 }, ground, { x: 3.4, y: 0, z: 3.2 }, foldTop, { x: 4.6, y: 2.6, z: 1.6 });
if (thickPlan.ok) {
  const usedDirectFold = thickPlan.steps.some((s) => s.kind === 'edge' && s.link.note === '折墙→折顶(凸外角,悬顶净空)');
  const usedDetour = thickPlan.steps.some((s) => s.kind === 'edge' && s.link.note.includes('东挡板'));
  console.log('是否避开直接折边并走东挡板绕路:', (!usedDirectFold && usedDetour) ? 'PASS' : 'FAIL');
}

// 2b) 极厚身体：直接翻越仍被悬顶封死，只能绕路（验证拒绝触发且绕路可行）
const blocked = planPath(level, { w: 1.3, l: 1.6, t: 1.15 }, maxSeam, ground, { x: 3.4, y: 0, z: 3.2 }, foldTop, { x: 4.6, y: 2.6, z: 1.6 });
console.log('\n极厚身体折顶可达(绕路):', blocked.ok, '| 直接翻越被拒:', blocked.rejections.some((r) => r.link.note.includes('折墙→折顶')));
if (blocked.ok) {
  const bf = flattenPlan(level, blocked, { w: 1.3, l: 1.6, t: 1.15 });
  const bv = verifyFrames(level, bf, { w: 1.3, l: 1.6, t: 1.15 });
  console.log('极厚绕路核验:', bv.ok ? 'PASS' : 'FAIL');
}

// 3) 凹内角：柱北墙→门楣，原地调姿
run('凹内角上門楣', { w: 0.7, l: 1.0, t: 0.55 }, ground, { x: 0, y: 0, z: 2.2 }, lintel, { x: 0, y: 4, z: -3.1 });

// 4) 柱顶：外角翻滚
run('外角翻上柱顶', { w: 0.7, l: 1.0, t: 0.55 }, ground, { x: 0, y: 0, z: 2.2 }, pillarTop, { x: 0, y: 4, z: 0 });

// 5) 跨缝：缝宽 0.4S < 0.6S 应通过；收紧到 0.3S 应拒绝
const seamPlan = run('地面跨缝(允许)', { w: 0.7, l: 1.0, t: 0.55 }, ground, { x: 0, y: 0, z: 3 }, groundB, { x: 0, y: 0, z: -5.3 });
const tight = planPath(level, { w: 0.7, l: 1.0, t: 0.55 }, 0.3, ground, { x: 0, y: 0, z: 3 }, groundB, { x: 0, y: 0, z: -5.3 });
console.log('\n跨缝收紧到0.3S -> 可达:', tight.ok, '(应 false)');

// 6) 禁附面不能作为目标（手动模拟：评估到悬顶板的连接）
const blocker = level.surfs.find((s) => !s.attachable);
console.log('禁附板数量:', level.surfs.filter((s) => !s.attachable).length, '| 名称:', level.surfs.filter((s) => !s.attachable).map((s) => s.name).join(', '));
