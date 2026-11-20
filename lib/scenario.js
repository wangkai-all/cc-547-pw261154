'use strict';

/**
 * 合成数据：按到达顺序编排的事件流，可复现题述各类情况——
 * 正常配对、丢帧漏配、重复帧、乱序帧、相机重新计数（复位）后续收。
 * 事件类型：frame = 相机帧（照片编号 + 触发计数）；pass = 工位产品通过信号。
 */

function frame(camera, triggerCount, photoId) {
  return { type: 'frame', camera, triggerCount, photoId };
}

function pass(cycle) {
  return { type: 'pass', productId: `P${String(cycle).padStart(3, '0')}`, cycle };
}

function photo(camera, n) {
  return `${camera}-${String(n).padStart(4, '0')}`;
}

/**
 * 批次1「接收双相机帧」：
 *  - 周期 1..6  正常：双相机同计数到达，工位随后报过站 → 成对且同产品，质检接收
 *  - 周期 7     只有 A（B 丢帧）→ 等待窗耗尽后判漏配
 *  - 周期 8     只有 B（A 丢帧）→ 等待窗耗尽后判漏配
 *  - 周期 9     正常 + 一张重复帧（A-0009 重发）→ 重复拒收
 *  - 周期 10/11 A 侧乱序（先 11 后 10，在容忍窗内）→ 仍应正确配对
 *  - 周期 12    正常（其到达把 7、8 的滞留帧挤出等待窗）
 *  - 周期 13    只有 B（A 丢帧），批次结束时仍悬置在接收端缓存（未配对件被保留）
 */
function batch1() {
  const events = [];
  for (let c = 1; c <= 6; c += 1) {
    events.push(frame('A', c, photo('A', c)));
    events.push(frame('B', c, photo('B', c)));
    events.push(pass(c));
  }
  events.push(frame('A', 7, photo('A', 7)));
  events.push(pass(7));
  events.push(frame('B', 8, photo('B', 8)));
  events.push(pass(8));
  events.push(frame('A', 9, photo('A', 9)));
  events.push(frame('B', 9, photo('B', 9)));
  events.push(frame('A', 9, photo('A', 9))); // 重复帧
  events.push(pass(9));
  events.push(frame('A', 11, photo('A', 11))); // 乱序：11 先于 10 到达
  events.push(frame('A', 10, photo('A', 10)));
  events.push(frame('B', 10, photo('B', 10)));
  events.push(frame('B', 11, photo('B', 11)));
  events.push(pass(10));
  events.push(pass(11));
  events.push(frame('A', 12, photo('A', 12)));
  events.push(frame('B', 12, photo('B', 12)));
  events.push(pass(12));
  events.push(frame('B', 13, photo('B', 13))); // A@13 丢失，B@13 悬置等待
  events.push(pass(13));
  return events;
}

/**
 * 批次2「模拟复位后续收」：
 *  - 相机A重新计数：触发计数从 12 直接回退到 1（新照片编号 A-1001 起）
 *  - 接收端判定复位，清空复位前未配对旧帧（B-0013 按漏配处理，旧图不接新件）
 *  - 相机B计数原样延续（14 起），工位周期也单调延续（14 起）
 *  - 固定等待窗策略：两侧计数不再相等 → 全部漏配
 *  - 动态校正策略：学到偏移 13 后继续配对，但质检发现两帧分属不同产品 → 隔离
 */
function batch2() {
  const events = [];
  events.push(frame('A', 1, photo('A', 1001))); // A 复位后的第一帧
  for (let i = 1; i <= 4; i += 1) {
    if (i > 1) events.push(frame('A', i, photo('A', 1000 + i)));
    events.push(frame('B', 13 + i, photo('B', 13 + i)));
    events.push(pass(13 + i));
  }
  return events;
}

module.exports = { batch1, batch2 };
