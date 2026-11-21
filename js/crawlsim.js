import {
  DEFAULTS, makeWheelSpec, makeDoorSpec, makeKin, stepKin, bandState,
  candidateWindows, worldFromLocal, localFromWorld, surfaceVelocity,
  wheelPose, doorPose,
} from './dynamic.js';

// 落点：滑门局部坐标的缝缘锚点（v 由几何决定，u 为可选位）
export const SLOTS = [
  { id: 'S0', u: 0.0 },
  { id: 'S1', u: 0.5 },
  { id: 'S2', u: -0.5 },
];

let rid = 0;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export class CrawlSim {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...(opts.tune || {}) };
    this.wheel = makeWheelSpec(opts.wheel);
    this.door = makeDoorSpec(opts.door);
    this.kin = makeKin(this.wheel, this.door);
    this.chars = [];
    this.reservations = [];
    this.windows = [];      // 已观测开放窗 {contactId, t0, t1}
    this.trace = [];        // 逐拍记录：附着物 + 世界接触点
    this.events = [];       // 结构化事件流
    this.audits = [];       // 全部交接复核（含中止/暂缓）
    this.handoffs = [];     // 成功交接复核
    this.snaps = {};
    this.phaseLabel = '分离';
    this.parking = { wheel: { u: 0, v: -0.2 }, door: { u: 0, v: 0.5 } };
  }

  log(type, msg, extra = {}) {
    const e = { tick: this.kin.tick, type, msg, ...extra };
    this.events.push(e);
    return e;
  }

  addChar(id, surf, local) {
    const c = {
      id, surf, local: { ...local }, state: 'parked',
      reservationId: null, goal: null, goalAnchor: null, lastHandoff: null,
    };
    this.chars.push(c);
    return c;
  }

  slotLocal(slotId) {
    const s = SLOTS.find((x) => x.id === slotId);
    return { u: s.u, v: -this.door.hv + this.opts.landMargin };
  }

  poseOf(char) {
    return char.surf === 'wheel'
      ? wheelPose(this.wheel, this.kin.theta)
      : doorPose(this.door, this.kin.slide);
  }

  contactOf(char) {
    return worldFromLocal(this.poseOf(char), char.local);
  }

  findClash(slotId, window, ignoreCharId) {
    return this.reservations.find((r) =>
      r.state === 'granted' && r.slotId === slotId && r.charId !== ignoreCharId &&
      !(window.t1 < r.window.t0 || window.t0 > r.window.t1));
  }

  grant(char, slotId, dir, w) {
    const res = {
      id: `r${++rid}`, charId: char.id, slotId, dir,
      window: { ...w }, state: 'granted', createdTick: this.kin.tick,
    };
    this.reservations.push(res);
    char.reservationId = res.id;
    char.state = 'booked';
    char.goal = { slotId, dir };
    return res;
  }

  // 预约：申请落点的最早候选时窗；与已授预约冲突即失约
  book(charId, slotId, dir) {
    const char = this.chars.find((c) => c.id === charId);
    const wins = candidateWindows(this.wheel, this.door, this.kin, this.slotLocal(slotId), this.opts);
    if (!wins.length) {
      this.log('book-fail', `${charId} 预约落点${slotId}：候选时窗为空，失约`, { charId });
      this.decideAfterWithdrawal(char, slotId, dir, 'no-window');
      return { ok: false, reason: 'no-window' };
    }
    const w0 = wins[0];
    const clash = this.findClash(slotId, w0, charId);
    if (clash) {
      this.log('book-conflict',
        `${charId} 与 ${clash.charId} 反向竞争落点${slotId} 窗[${w0.t0},${w0.t1}] 失败，失约`,
        { charId });
      this.decideAfterWithdrawal(char, slotId, dir, 'conflict');
      return { ok: false, reason: 'conflict' };
    }
    const res = this.grant(char, slotId, dir, w0);
    this.log('book', `${charId} 预约落点${slotId} 窗[${w0.t0},${w0.t1}] 接触#${w0.contactId}`, { charId, slotId });
    return { ok: true, res };
  }

  // 撤回后的决策：候选时窗内还有空档 → 保留原定落点改约；否则重新找路（撤回泊位重找支撑）
  decideAfterWithdrawal(char, slotId, dir, cause) {
    const wins = candidateWindows(this.wheel, this.door, this.kin, this.slotLocal(slotId), this.opts)
      .filter((w) => !this.findClash(slotId, w, char.id));
    if (wins.length) {
      const res = this.grant(char, slotId, dir, wins[0]);
      this.log('keep-landing',
        `${char.id} 保留原定落点${slotId}，改约窗[${wins[0].t0},${wins[0].t1}] 接触#${wins[0].contactId}（${cause}）`,
        { charId: char.id });
      return res;
    }
    char.state = 'retreating';
    char.reservationId = null;
    char.goal = null;
    this.log('replan', `${char.id} 候选时窗为空，重新找路：撤回泊位重找支撑（${cause}）`, { charId: char.id });
    return null;
  }

  // 玩家反转：尚未越过接缝的预约一律撤回，再按候选时窗决定保留落点或重新找路
  rescheduleAfterReversal(cause) {
    for (const char of this.chars) {
      if (char.state !== 'booked') continue; // 已换面/已交接的角色不受影响
      const res = this.reservations.find((r) => r.id === char.reservationId);
      if (!res || res.state !== 'granted') continue;
      res.state = 'withdrawn';
      char.reservationId = null;
      this.log('withdraw', `${char.id} 预约撤回（${cause}）`, { charId: char.id });
      this.decideAfterWithdrawal(char, res.slotId, res.dir, cause);
    }
  }

  reverseWheel() {
    this.kin.omega = -this.kin.omega;
    this.log('reverse-wheel', `转轮反转 ω=${this.kin.omega.toFixed(3)}`);
    this.rescheduleAfterReversal('转轮反转');
  }

  reverseDoor() {
    this.kin.slideDir = -this.kin.slideDir;
    this.log('reverse-door', '滑门换向');
    this.rescheduleAfterReversal('滑门换向');
  }

  reverseBoth() {
    this.kin.omega = -this.kin.omega;
    this.kin.slideDir = -this.kin.slideDir;
    this.log('reverse-both', '双表面同时反转');
    this.rescheduleAfterReversal('双表面反转');
  }

  approachPoint(char) {
    const slotU = SLOTS.find((s) => s.id === char.goal.slotId).u;
    if (char.surf === 'wheel') {
      const doorX = this.door.base.x + this.kin.slide;
      const lim = this.wheel.hu - this.opts.edgeMargin;
      return {
        u: clamp(doorX + slotU - this.wheel.C.x, -lim, lim),
        v: this.wheel.hv - this.opts.edgeMargin,
      };
    }
    const lim = this.door.hu - this.opts.edgeMargin;
    return { u: clamp(slotU, -lim, lim), v: -(this.door.hv - this.opts.edgeMargin) };
  }

  crawlToward(char, target) {
    const du = target.u - char.local.u;
    const dv = target.v - char.local.v;
    const d = Math.hypot(du, dv);
    if (d <= this.opts.crawlSpeed) {
      char.local.u = target.u;
      char.local.v = target.v;
      return true;
    }
    char.local.u += (du / d) * this.opts.crawlSpeed;
    char.local.v += (dv / d) * this.opts.crawlSpeed;
    return false;
  }

  // 附着权转移：世界接触点连续，锚点换算到新表面局部坐标；
  // 复核相对速度与"旧锚/新锚同属本次接触"，不满足则中止或暂缓
  tryTransfer(char, res, bs) {
    const fromWheel = char.surf === 'wheel';
    const fromPose = fromWheel ? bs.wp : bs.dp;
    const toPose = fromWheel ? bs.dp : bs.wp;
    const toSpec = fromWheel ? this.door : this.wheel;
    const pW = worldFromLocal(fromPose, char.local);
    const vOld = surfaceVelocity(this.wheel, this.door, this.kin, char.surf, pW);
    const vNew = surfaceVelocity(this.wheel, this.door, this.kin, toSpec.id, pW);
    const relVel = vNew.sub(vOld).length();
    const sameContact = bs.open &&
      res.window.contactId === this.kin.contactId &&
      (!char.lastHandoff || char.lastHandoff.contactId !== this.kin.contactId);
    const audit = {
      tick: this.kin.tick, charId: char.id, contactId: this.kin.contactId,
      from: char.surf, to: toSpec.id, relVel: +relVel.toFixed(4), sameContact,
      pWorld: pW.toArray().map((n) => +n.toFixed(4)), ok: false,
    };
    if (!sameContact) {
      this.audits.push(audit);
      this.log('handoff-abort',
        `${char.id} 交接中止：预约接触#${res.window.contactId} ≠ 当前接触#${this.kin.contactId}，旧锚与新锚非同一次接触`,
        { charId: char.id });
      return false;
    }
    if (relVel > this.opts.relVelTol) {
      this.audits.push(audit);
      this.log('handoff-defer',
        `${char.id} 交接暂缓：相对速度 ${relVel.toFixed(3)} 超过上限 ${this.opts.relVelTol}`,
        { charId: char.id });
      return false;
    }
    const dl = localFromWorld(toPose, pW);
    const lim = toSpec.hu - this.opts.edgeMargin;
    const newLocal = {
      u: clamp(dl.u, -lim, lim),
      v: (toSpec.id === 'door' ? -1 : 1) * (toSpec.hv - this.opts.landMargin),
    };
    char.surf = toSpec.id;
    char.local = newLocal;
    char.state = 'riding';
    char.lastHandoff = { contactId: this.kin.contactId, tick: this.kin.tick };
    char.reservationId = null;
    res.state = 'consumed';
    const slotU = SLOTS.find((s) => s.id === res.slotId).u;
    char.goalAnchor = toSpec.id === 'door' ? { u: slotU, v: 0.5 } : { u: newLocal.u, v: -0.2 };
    char.goal = null;
    const pAfter = worldFromLocal(toPose, newLocal);
    audit.ok = true;
    audit.jump = +pAfter.distanceTo(pW).toFixed(4);
    this.audits.push(audit);
    this.handoffs.push(audit);
    this.log('handoff',
      `${char.id} 附着权转移 ${audit.from}→${audit.to} @接触#${this.kin.contactId} ` +
      `相对速度${relVel.toFixed(3)} 同次接触✓ 跨缝步距${audit.jump}`,
      { charId: char.id });
    return true;
  }

  stepChar(char, bs) {
    if (char.state === 'booked') {
      const res = this.reservations.find((r) => r.id === char.reservationId);
      if (!res || res.state !== 'granted') {
        char.state = 'retreating';
        char.reservationId = null;
        return;
      }
      const w = res.window;
      const inLead = this.kin.tick >= w.t0 - this.opts.lead && this.kin.tick <= w.t1;
      const target = inLead ? this.approachPoint(char) : this.parking[char.surf];
      const arrived = this.crawlToward(char, target);
      if (inLead && arrived && bs.open) this.tryTransfer(char, res, bs);
    } else if (char.state === 'riding') {
      if (char.goalAnchor && this.crawlToward(char, char.goalAnchor)) char.state = 'done';
    } else if (char.state === 'retreating') {
      if (this.crawlToward(char, this.parking[char.surf])) char.state = 'parked';
    }
  }

  tick() {
    stepKin(this.door, this.kin);
    const bs = bandState(this.wheel, this.door, this.kin, this.opts);
    const justOpened = bs.open && !this.kin.prevOpen;
    if (justOpened) {
      this.kin.contactId += 1;
      this.windows.push({ contactId: this.kin.contactId, t0: this.kin.tick, t1: null });
      if (!this.snaps.preContact && this.reservations.some((r) => r.state === 'granted')) {
        this.snapshot('preContact');
      }
    }
    if (!bs.open && this.kin.prevOpen) {
      const w = this.windows[this.windows.length - 1];
      if (w && w.t1 === null) w.t1 = this.kin.tick - 1;
    }
    this.kin.prevOpen = bs.open;

    // 失约清扫：窗口已过仍未交接的预约作废并重新决策
    for (const r of this.reservations) {
      if (r.state !== 'granted' || this.kin.tick <= r.window.t1) continue;
      r.state = 'expired';
      this.log('expire', `${r.charId} 错过窗[${r.window.t0},${r.window.t1}]，失约`, { charId: r.charId });
      const char = this.chars.find((c) => c.id === r.charId);
      if (char && char.state === 'booked') {
        char.reservationId = null;
        this.decideAfterWithdrawal(char, r.slotId, r.dir, 'expired');
      }
    }

    for (const char of this.chars) this.stepChar(char, bs);

    if (!this.snaps.postContact) {
      const h = this.handoffs[this.handoffs.length - 1];
      if (h && h.tick === this.kin.tick) this.snapshot('postContact');
    }

    this.phaseLabel = bs.open
      ? (this.kin.contactId === 1 ? '相切' : justOpened ? '重新相接' : '相切')
      : '分离';
    this.trace.push({
      tick: this.kin.tick,
      phase: this.phaseLabel,
      contactId: this.kin.contactId,
      band: { open: bs.open, gap: +bs.gap.toFixed(4), overlap: +bs.overlap.toFixed(3) },
      kin: { theta: +this.kin.theta.toFixed(4), slide: +this.kin.slide.toFixed(4) },
      chars: this.chars.map((c) => ({
        id: c.id, surf: c.surf, state: c.state,
        local: { u: +c.local.u.toFixed(4), v: +c.local.v.toFixed(4) },
        contact: this.contactOf(c).toArray().map((n) => +n.toFixed(4)),
      })),
    });
  }

  run(n) {
    for (let i = 0; i < n; i++) this.tick();
  }

  snapshot(tag) {
    this.snaps[tag] = {
      tick: this.kin.tick,
      theta: this.kin.theta,
      slide: this.kin.slide,
      contactId: this.kin.contactId,
      prevOpen: this.kin.prevOpen,
      chars: JSON.parse(JSON.stringify(this.chars)),
      reservations: JSON.parse(JSON.stringify(this.reservations)),
      windows: JSON.parse(JSON.stringify(this.windows)),
      handoffsLen: this.handoffs.length,
      auditsLen: this.audits.length,
      traceLen: this.trace.length,
      eventsLen: this.events.length,
    };
    this.log('snapshot', `存点[${tag}] @拍${this.kin.tick}`);
  }

  // 恢复存点：位置/附着/预约回放，但保留当前运动方向（便于先反转再恢复）
  restore(tag) {
    const s = this.snaps[tag];
    if (!s) return false;
    this.kin.tick = s.tick;
    this.kin.theta = s.theta;
    this.kin.slide = s.slide;
    this.kin.contactId = s.contactId;
    this.kin.prevOpen = s.prevOpen;
    this.chars = JSON.parse(JSON.stringify(s.chars));
    this.reservations = JSON.parse(JSON.stringify(s.reservations));
    this.windows = JSON.parse(JSON.stringify(s.windows));
    this.handoffs.length = s.handoffsLen;
    this.audits.length = s.auditsLen;
    this.trace.length = s.traceLen;
    this.events.length = s.eventsLen;
    this.log('restore', `恢复存点[${tag}]（保留当前运动方向）`);
    return true;
  }
}
