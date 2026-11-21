import { CrawlSim } from '../js/crawlsim.js';
import { bandState, doorPose, worldFromLocal } from '../js/dynamic.js';

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
}
const maxStep = (trace, charId) => {
  let m = 0;
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1].chars.find((c) => c.id === charId);
    const b = trace[i].chars.find((c) => c.id === charId);
    if (!a || !b) continue;
    m = Math.max(m, Math.hypot(...b.contact.map((v, k) => v - a.contact[k])));
  }
  return m;
};

// ---------- T1 三相过程与逐拍记录 ----------
console.log('\n=== T1 相切→分离→重新相接 + 逐拍记录 ===');
{
  const sim = new CrawlSim();
  sim.run(260);
  const phases = sim.trace.map((t) => t.phase);
  const i1 = phases.indexOf('相切');
  const i2 = phases.indexOf('分离', i1 + 1);
  const i3 = phases.indexOf('重新相接', i2 + 1);
  check('依次经过 相切→分离→重新相接', i1 > 0 && i2 > i1 && i3 > i2,
    `i1=${i1} i2=${i2} i3=${i3}`);
  check('记录到两次以上开放窗', sim.windows.length >= 2, `windows=${sim.windows.length}`);
  check('开放拍缝距均 ≤ 容差', sim.trace.every((t) => !t.band.open || t.band.gap <= 0.2 + 1e-9));
  check('每拍都有接触带与附着记录', sim.trace.length === 260 &&
    sim.trace.every((t) => t.band && Array.isArray(t.chars) && typeof t.contactId === 'number'));
}

// ---------- T2 预约→候选时窗→交接→随新面骑乘 ----------
console.log('\n=== T2 预约落点→交接→随滑门局部坐标移动 ===');
{
  const sim = new CrawlSim();
  sim.addChar('A', 'wheel', { ...sim.parking.wheel });
  const bk = sim.book('A', 'S0', 'w2d');
  check('预约成功且落在首个候选时窗', bk.ok && bk.res.window.t0 >= 14 && bk.res.window.t0 <= 30,
    JSON.stringify(bk.res && bk.res.window));
  sim.run(120);
  const h = sim.handoffs[0];
  check('恰好一次交接', sim.handoffs.length === 1);
  check('交接复核：同次接触且相对速度合格', !!h && h.sameContact && h.relVel <= 0.09,
    JSON.stringify(h));
  check('交接发生在首个接触窗内', !!h && h.contactId === 1 && h.tick >= 14 && h.tick <= 30);
  check('交接后附着滑门、预约已消费', sim.chars[0].surf === 'door' &&
    sim.reservations[0].state === 'consumed');
  check('全程接触点无异常跳变', maxStep(sim.trace, 'A') <= 0.4, `max=${maxStep(sim.trace, 'A')}`);
  const done = sim.trace.filter((t) => t.chars[0].state === 'done');
  const d0 = done[0], d1 = done[done.length - 1];
  check('骑乘证明：局部锚点不变而世界接触点随门移动', !!d0 && !!d1 && d1.tick - d0.tick > 10 &&
    d0.chars[0].local.u === d1.chars[0].local.u && d0.chars[0].local.v === d1.chars[0].local.v &&
    Math.hypot(...d1.chars[0].contact.map((v, k) => v - d0.chars[0].contact[k])) > 0.05);
  check('事件流含附着权转移记录', sim.events.some((e) => e.type === 'handoff'));
}

// ---------- T3 未过缝反转 → 撤回 → 保留原定落点 ----------
console.log('\n=== T3 靠近未过缝时反转转轮：撤回并保留落点 ===');
{
  const sim = new CrawlSim();
  sim.addChar('A', 'wheel', { ...sim.parking.wheel });
  sim.book('A', 'S0', 'w2d');
  sim.run(14); // 已靠近尚未越过接缝
  sim.reverseWheel();
  check('预约被撤回', sim.events.some((e) => e.type === 'withdraw' && e.charId === 'A'));
  check('保留原定落点并改约', sim.events.some((e) => e.type === 'keep-landing' && e.charId === 'A'));
  check('撤回后仍处于预约状态', sim.chars[0].state === 'booked');
  sim.run(240);
  const h = sim.handoffs[0];
  check('在新时窗完成唯一一次交接', sim.handoffs.length === 1 && !!h && h.tick > 100,
    JSON.stringify(h));
  check('交接拍接触带确实开放', !!h && sim.trace.find((t) => t.tick === h.tick).band.open);
  check('新交接属于重新相接的那次接触', !!h && sim.windows.length >= 1 &&
    h.contactId === sim.windows[0].contactId && sim.windows[0].t0 > 100);
}

// ---------- T4 未过缝反转 → 无时窗 → 重新找路 ----------
console.log('\n=== T4 反转后候选时窗为空：重新找路、重找支撑 ===');
{
  const sim = new CrawlSim({ tune: { horizon: 150 } });
  sim.addChar('A', 'wheel', { ...sim.parking.wheel });
  sim.book('A', 'S0', 'w2d');
  sim.run(14);
  sim.reverseWheel();
  check('决策为重新找路', sim.events.some((e) => e.type === 'replan' && e.charId === 'A'));
  sim.run(200);
  const a = sim.chars[0];
  check('失约者撤回泊位重找支撑', a.state === 'parked' &&
    Math.abs(a.local.u - sim.parking.wheel.u) < 1e-9 &&
    Math.abs(a.local.v - sim.parking.wheel.v) < 1e-9, JSON.stringify(a));
  check('全程未发生交接', sim.handoffs.length === 0);
}

// ---------- T5 已换面后反转：不被拉回 ----------
console.log('\n=== T5 已换面后反转转轮：继续随新面移动 ===');
{
  const sim = new CrawlSim();
  sim.addChar('A', 'wheel', { ...sim.parking.wheel });
  sim.book('A', 'S0', 'w2d');
  sim.run(35); // 已交接（t≈17）
  sim.reverseWheel();
  check('已交接角色无撤回事件', !sim.events.some((e) => e.type === 'withdraw' && e.charId === 'A'));
  check('已消费预约保持终态', sim.reservations[0].state === 'consumed');
  const before = sim.handoffs.length;
  sim.run(60);
  check('始终附着滑门未被拉回', sim.trace.slice(-60).every((t) => t.chars[0].surf === 'door'));
  check('无新增交接', sim.handoffs.length === before);
}

// ---------- T6 双角色反向竞争同一落点 ----------
console.log('\n=== T6 双角色反向预约同一落点 ===');
{
  const sim = new CrawlSim();
  sim.addChar('A', 'wheel', { ...sim.parking.wheel });
  sim.addChar('B', 'door', { ...sim.parking.door });
  const bkA = sim.book('A', 'S0', 'w2d');
  const bkB = sim.book('B', 'S0', 'd2w');
  check('先到者获约、后来者失约', bkA.ok && !bkB.ok && bkB.reason === 'conflict');
  check('失约者改约更晚时窗（保留落点）',
    sim.events.some((e) => e.type === 'keep-landing' && e.charId === 'B'));
  sim.run(30);
  const bAt30 = sim.trace[29].chars.find((c) => c.id === 'B');
  check('失约者退回泊位重找支撑', bAt30.state === 'booked' &&
    Math.abs(bAt30.local.v - sim.parking.door.v) < 1e-3, JSON.stringify(bAt30));
  sim.run(230);
  const hA = sim.handoffs.find((h) => h.charId === 'A');
  const hB = sim.handoffs.find((h) => h.charId === 'B');
  check('竞争窗内只有先到者交接', !!hA && hA.contactId === 1 &&
    !sim.handoffs.some((h) => h.charId === 'B' && h.contactId === 1));
  check('失约者在后续接触窗完成交接', !!hB && hB.contactId >= 2 && hB.tick > 150,
    JSON.stringify(hB));
  check('双方向均换面成功', sim.chars.find((c) => c.id === 'A').surf === 'door' &&
    sim.chars.find((c) => c.id === 'B').surf === 'wheel');
  const nBefore = sim.handoffs.length;
  sim.reverseWheel(); // 过时预约不得影响已交接者
  sim.run(30);
  check('反转后无撤回、成功者不被拉回', sim.handoffs.length === nBefore &&
    !sim.events.some((e) => e.type === 'withdraw') &&
    sim.chars.find((c) => c.id === 'A').surf === 'door' &&
    sim.chars.find((c) => c.id === 'B').surf === 'wheel');
}

// ---------- T7 双表面反转 + 接触前/后存点恢复 ----------
console.log('\n=== T7 双反转后分别从接触前/接触后恢复 ===');
{
  const sim = new CrawlSim();
  sim.addChar('A', 'wheel', { ...sim.parking.wheel });
  sim.book('A', 'S0', 'w2d');
  sim.run(28); // 交接已完成，且滑门仍在行程中段（未触端点自动换向）
  check('接触前/接触后存点均已自动记录', !!sim.snaps.preContact && !!sim.snaps.postContact);
  const postTick = sim.snaps.postContact.tick;
  sim.reverseBoth();

  check('恢复·接触前', sim.restore('preContact'));
  check('回到转轮且预约有效', sim.chars[0].surf === 'wheel' && sim.chars[0].state === 'booked');
  check('运动方向保持反转', sim.kin.omega < 0 && sim.kin.slideDir < 0);
  sim.run(120);
  check('过期窗被清扫并重新决策（保留落点）',
    sim.events.some((e) => e.type === 'expire') &&
    sim.events.some((e) => e.type === 'keep-landing' && e.tick >= postTick - 20));
  check('恢复后未发生幻影交接', sim.handoffs.length === 0);

  check('恢复·接触后', sim.restore('postContact'));
  check('回到滑门骑乘态', sim.chars[0].surf === 'door' && sim.handoffs.length === 1);
  const mark = sim.trace.length;
  sim.run(60);
  const slice = sim.trace.slice(mark);
  check('恢复后无重复交接', sim.handoffs.length === 1);
  check('滑门反向滑行', slice[slice.length - 1].kin.slide < slice[0].kin.slide,
    `${slice[0].kin.slide} -> ${slice[slice.length - 1].kin.slide}`);
  check('恢复后接触点连续', maxStep(slice, 'A') <= 0.4, `max=${maxStep(slice, 'A')}`);
  // 防重复位移：每拍世界接触点必须严格等于"当前附着面局部锚点"的派生位置
  const exact = slice.every((t) => {
    const c = t.chars[0];
    const p = worldFromLocal(doorPose(sim.door, t.kin.slide), c.local);
    return Math.hypot(p.x - c.contact[0], p.y - c.contact[1], p.z - c.contact[2]) < 2e-3;
  });
  check('位移只由当前附着面贡献（无重复施加）', exact);
}

// ---------- T8 同次接触审查与相对速度复核 ----------
console.log('\n=== T8 交接复核：旧锚/新锚须属同一次接触 ===');
{
  const sim = new CrawlSim();
  sim.addChar('X', 'wheel', { u: 0, v: 0.65 });
  sim.kin.theta = Math.PI / 2;
  sim.kin.slide = 0;
  sim.kin.contactId = 5;
  sim.kin.prevOpen = true;
  const bs = bandState(sim.wheel, sim.door, sim.kin, sim.opts);
  check('强制相切时接触带开放', bs.open);
  const stale = { id: 'rx1', charId: 'X', slotId: 'S0', dir: 'w2d',
    window: { t0: 0, t1: 999, contactId: 3 }, state: 'granted' };
  check('几何重合但非本次接触 → 中止', !sim.tryTransfer(sim.chars[0], stale, bs) &&
    sim.events.some((e) => e.type === 'handoff-abort'));
  check('中止复核已记录 sameContact=false',
    sim.audits.some((a) => !a.ok && a.sameContact === false));
  check('中止后仍在原面', sim.chars[0].surf === 'wheel');
  const good = { id: 'rx2', charId: 'X', slotId: 'S0', dir: 'w2d',
    window: { t0: 0, t1: 999, contactId: 5 }, state: 'granted' };
  check('同次接触 → 允许交接', sim.tryTransfer(sim.chars[0], good, bs) &&
    sim.chars[0].surf === 'door');

  const sim2 = new CrawlSim({ tune: { relVelTol: 1e-6 } });
  sim2.addChar('Y', 'wheel', { u: 0, v: 0.65 });
  sim2.kin.theta = Math.PI / 2;
  sim2.kin.contactId = 1;
  sim2.kin.prevOpen = true;
  const bs2 = bandState(sim2.wheel, sim2.door, sim2.kin, sim2.opts);
  const res2 = { id: 'ry', charId: 'Y', slotId: 'S0', dir: 'w2d',
    window: { t0: 0, t1: 999, contactId: 1 }, state: 'granted' };
  check('相对速度超限 → 暂缓交接', !sim2.tryTransfer(sim2.chars[0], res2, bs2) &&
    sim2.events.some((e) => e.type === 'handoff-defer'));
}

console.log(`\n动态接触带测试：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
