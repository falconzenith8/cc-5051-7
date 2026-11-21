import * as THREE from 'three';
import { initDynDemo } from '../js/dynDemo.js';

// 最小 DOM 桩：在无浏览器环境下驱动演示 UI 的完整交互流
const handlers = new Map();
const elements = new Map();
function el(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      id, textContent: '', value: '', scrollTop: 0, scrollHeight: 0,
      addEventListener: (ev, fn) => handlers.set(`${id}:${ev}`, fn),
    });
  }
  return elements.get(id);
}
globalThis.document = { getElementById: el };
const click = (id) => {
  const fn = handlers.get(`${id}:click`);
  if (!fn) throw new Error(`按钮未绑定: ${id}`);
  fn();
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1.6, 0.05, 200);
const controls = { target: new THREE.Vector3() };

console.log('\n=== UI 冒烟：动态接触带演示 ===');
const demo = initDynDemo({ scene, camera, controls });
const dynGroup = scene.children.find((c) => c.name === 'dynDemo');
check('演示组已挂入场景', !!dynGroup && dynGroup.children.length > 10,
  `children=${dynGroup?.children.length}`);
check('初始化日志已写入', el('dynLog').value.includes('单角色演示'));
check('信息栏显示拍号与相位', /拍 0 · 分离 · 接触#0/.test(el('dynInfo').textContent),
  el('dynInfo').textContent);

// 单步经过 相切→分离→重新相接 三段
click('btnDynNextPhase'); // → 相切
check('步进到相切', el('dynInfo').textContent.includes('相切'));
const bandMesh = dynGroup.children.find((c) => c.geometry?.type === 'BoxGeometry' && c.material?.transparent && c.material.opacity === 0.45);
check('接触带开放时高亮可见', bandMesh.visible === true);
click('btnDynNextPhase'); // → 分离
check('步进到分离', el('dynInfo').textContent.includes('分离'));
check('接触带关闭时隐藏', bandMesh.visible === false);
click('btnDynNextPhase'); // → 重新相接
check('步进到重新相接', el('dynInfo').textContent.includes('重新相接'));
check('逐拍日志含附着物与接触点', /#\d+ (相切|重新相接) c\d+ 开 gap=[\d.]+ A@(转轮|滑门) 接触点\(/.test(el('dynLog').value) &&
  /#\d+ 分离 c\d+ 闭 A@转轮 接触点\(/.test(el('dynLog').value));
check('交接事件已入日志', el('dynLog').value.includes('附着权转移'));

// 恢复存点
click('btnDynRestorePre');
check('恢复·接触前后回到转轮侧', el('dynInfo').textContent.includes('A@转轮'));
click('btnDynRestorePost');
check('恢复·接触后回到滑门侧', el('dynInfo').textContent.includes('A@滑门'));

// 播放若干帧（驱动 update 循环）
for (let i = 0; i < 30; i++) demo.update(0.5);
check('播放推进无异常', true);

// 反转 + 双角色竞争
click('btnDynDuel');
check('双角色模式初始化', el('dynLog').value.includes('双角色竞争'));
check('竞争失约已记录', el('dynLog').value.includes('失约'));
for (let i = 0; i < 20; i++) click('btnDynStep');
click('btnDynRevWheel');
check('反转后撤回/改约入日志', /预约撤回|保留原定落点/.test(el('dynLog').value));
click('btnDynRevBoth');
for (let i = 0; i < 10; i++) click('btnDynStep');
click('btnDynReset');
check('重置后回到第 0 拍', /拍 0 ·/.test(el('dynInfo').textContent));
click('btnDynFocus');
check('视角对准演示区', controls.target.x > 8);

console.log(`\nUI 冒烟：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
