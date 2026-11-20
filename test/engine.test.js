'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PairingEngine,
  chooseStrategy,
  STRATEGY_FIXED,
  STRATEGY_DYNAMIC,
} = require('../lib/engine');
const { batch1, batch2 } = require('../lib/scenario');

function feed(engine, events, { drain = false } = {}) {
  for (const event of events) {
    if (event.type === 'pass') engine.ingestPass(event);
    else engine.ingestFrame(event);
  }
  if (drain) engine.drain();
}

function frame(camera, triggerCount, photoId) {
  return { type: 'frame', camera, triggerCount, photoId };
}
function pass(cycle, productId) {
  return { type: 'pass', productId: productId || `P${String(cycle).padStart(3, '0')}`, cycle };
}

// ---------- 正常路径 ----------

test('正常：双相机同计数帧成对，过站后质检接收', () => {
  const engine = new PairingEngine({ strategy: STRATEGY_FIXED });
  for (let c = 1; c <= 3; c += 1) {
    feed(engine, [frame('A', c, `A-${c}`), frame('B', c, `B-${c}`), pass(c)]);
  }
  assert.equal(engine.stats.paired, 3);
  assert.equal(engine.qcAccepted.length, 3);
  assert.deepEqual(engine.qcAccepted.map((s) => s.productId), ['P001', 'P002', 'P003']);
  assert.equal(engine.rejects.length, 0);
});

test('正常：乱序帧在容忍窗内仍能正确配对', () => {
  const engine = new PairingEngine({ strategy: STRATEGY_FIXED });
  feed(engine, [
    frame('A', 3, 'A-3'),
    frame('A', 2, 'A-2'), // 乱序：2 比 3 晚到，但在容忍窗内
    frame('B', 2, 'B-2'),
    frame('B', 3, 'B-3'),
    pass(2),
    pass(3),
  ]);
  assert.equal(engine.stats.paired, 2);
  assert.equal(engine.qcAccepted.length, 2);
  assert.ok(engine.events.some((e) => e.type === 'late-frame'));
});

test('正常：过站信号晚到，样本先等待、信号到达后补判接收', () => {
  const engine = new PairingEngine({ strategy: STRATEGY_FIXED });
  feed(engine, [frame('A', 5, 'A-5'), frame('B', 5, 'B-5')]);
  assert.equal(engine.qcAccepted.length, 0);
  assert.equal(engine.samples[0].status, 'pending');
  feed(engine, [pass(5)]);
  assert.equal(engine.qcAccepted.length, 1);
  assert.equal(engine.qcAccepted[0].productId, 'P005');
});

// ---------- 异常路径 ----------

test('异常：伴侣帧不到，等待窗耗尽判漏配，未配对件先被保留', () => {
  const engine = new PairingEngine({ strategy: STRATEGY_FIXED, waitWindow: 2 });
  feed(engine, [frame('A', 1, 'A-1')]);
  assert.equal(engine.buffers.A.size, 1, '接收端应保留未配对件');
  feed(engine, [frame('B', 2, 'B-2'), frame('B', 3, 'B-3')]);
  assert.equal(engine.rejects.filter((r) => r.kind === 'miss').length, 0, '等待窗内不得判漏配');
  feed(engine, [frame('B', 4, 'B-4')]); // 对侧第 3 帧到达，超出等待窗
  const misses = engine.rejects.filter((r) => r.kind === 'miss');
  assert.equal(misses.length, 1);
  assert.equal(misses[0].photoId, 'A-1');
});

test('异常：重复帧被拒收且不进入配对', () => {
  const engine = new PairingEngine({ strategy: STRATEGY_FIXED });
  feed(engine, [frame('A', 1, 'A-1'), frame('A', 1, 'A-1-重发')]);
  assert.equal(engine.stats.duplicates, 1);
  assert.equal(engine.rejects[0].kind, 'duplicate');
  assert.equal(engine.buffers.A.size, 1, '首帧仍在等待伴侣');
});

test('异常：成对但工位过站信号缺失，批次关闭时判 no-product', () => {
  const engine = new PairingEngine({ strategy: STRATEGY_FIXED });
  feed(engine, [frame('A', 5, 'A-5'), frame('B', 5, 'B-5')], { drain: true });
  assert.equal(engine.qcAccepted.length, 0);
  const noProduct = engine.rejects.filter((r) => r.kind === 'no-product');
  assert.equal(noProduct.length, 1);
  assert.equal(noProduct[0].sampleId, engine.samples[0].id);
});

test('异常：相机重新计数时，复位前的未配对旧图不得接到新件', () => {
  const engine = new PairingEngine({ strategy: STRATEGY_FIXED });
  for (let c = 1; c <= 5; c += 1) {
    feed(engine, [frame('A', c, `A-${c}`), frame('B', c, `B-${c}`), pass(c)]);
  }
  feed(engine, [frame('B', 6, 'B-6')]); // A@6 丢失，B-6 悬置（旧图）
  assert.equal(engine.buffers.B.size, 1);
  // 相机A重新计数：5 直接回到 1
  feed(engine, [frame('A', 1, 'A-9001')]);
  assert.equal(engine.stats.resets, 1);
  assert.ok(engine.events.some((e) => e.type === 'camera-reset'));
  // 旧图 B-6 已被清空并按漏配处理
  const flushed = engine.rejects.find((r) => r.photoId === 'B-6');
  assert.ok(flushed, '复位前未配对旧帧应被清出');
  assert.match(flushed.reason, /复位|重新计数/);
  // 复位后 A 的计数重新爬升到 6：绝不能与旧图 B-6 配成对
  feed(engine, [
    frame('A', 2, 'A-9002'), frame('A', 3, 'A-9003'), frame('A', 4, 'A-9004'),
    frame('A', 5, 'A-9005'), frame('A', 6, 'A-9006'),
  ]);
  assert.equal(engine.samples.length, 5, '旧图不得接到新件上');
  assert.ok(engine.samples.every((s) => s.photoB !== 'B-6'));
});

test('异常：质检只处理成对且同一产品的样本，跨产品配对被隔离', () => {
  const engine = new PairingEngine({ strategy: STRATEGY_FIXED });
  // 构造跨产品配对：两侧计数相邻但产品不同（模拟错误关联）
  feed(engine, [
    frame('A', 7, 'A-7'),
    frame('B', 7, 'B-7'),
    pass(7, 'PX'),
  ]);
  assert.equal(engine.qcAccepted.length, 1);
  // 手工制造一对分属不同产品的样本：直接让两帧计数相同但过站记录不同产品
  const engine2 = new PairingEngine({ strategy: STRATEGY_DYNAMIC, costMiss: 100, costMismatch: 1 });
  feed(engine2, [
    frame('A', 1, 'A-1'), frame('B', 1, 'B-1'), pass(1, 'PA'),
    frame('A', 2, 'A-2'), // B@2 丢失
    frame('B', 3, 'B-3'), frame('A', 3, 'A-3'), pass(3, 'PC'),
    pass(2, 'PB'),
  ], { drain: true });
  // 动态校正在丢帧时可能错配（A-2 被关联到 B-3），质检必须将其隔离而非接收
  assert.equal(engine2.qcAccepted.length, 1);
  assert.equal(engine2.qcAccepted[0].productId, 'PA');
  assert.equal(engine2.qcQuarantine.length, 1);
  assert.equal(engine2.qcQuarantine[0].productA, 'PB');
  assert.equal(engine2.qcQuarantine[0].productB, 'PC');
  assert.ok(engine2.qcAccepted.every((s) => {
    const pA = engine2.products.get(s.countA);
    const pB = engine2.products.get(s.countB);
    return pA && pB && pA.productId === pB.productId;
  }), '质检接收的样本必须两帧同属一个产品');
});

// ---------- 策略选择 ----------

test('策略：错配代价高选固定等待窗，漏配代价高选动态校正', () => {
  assert.equal(chooseStrategy(10, 1), STRATEGY_FIXED);
  assert.equal(chooseStrategy(1, 10), STRATEGY_DYNAMIC);
  assert.equal(chooseStrategy(5, 5), STRATEGY_FIXED);
  assert.equal(new PairingEngine({ strategy: 'auto', costMismatch: 10, costMiss: 1 }).strategy, STRATEGY_FIXED);
  assert.equal(new PairingEngine({ strategy: 'auto', costMismatch: 1, costMiss: 10 }).strategy, STRATEGY_DYNAMIC);
});

// ---------- 合成数据全流程 ----------

test('合成批次1：正常配对、漏配、重复、乱序均按预期处理', () => {
  const engine = new PairingEngine({ strategy: 'auto', costMismatch: 10, costMiss: 1 });
  feed(engine, batch1());
  assert.equal(engine.stats.paired, 10, '周期1-6、9、10、11、12 应成对');
  assert.equal(engine.stats.qcAccepted, 10);
  assert.equal(engine.stats.missed, 2, 'A-0007 与 B-0008 等待窗耗尽判漏配');
  assert.equal(engine.stats.duplicates, 1, 'A-0009 重发判重复');
  assert.ok(engine.events.some((e) => e.type === 'late-frame'));
  // 接收端仍保留 B-0013（A@13 丢失，等待窗未耗尽）
  assert.equal(engine.buffers.B.size, 1);
  assert.equal(engine.buffers.B.get(13).photoId, 'B-0013');
});

test('合成批次2（固定等待窗）：复位清空旧图，后续计数不再相等全部漏配', () => {
  const engine = new PairingEngine({ strategy: STRATEGY_FIXED });
  feed(engine, batch1());
  feed(engine, batch2(), { drain: true });
  assert.equal(engine.stats.resets, 1);
  const resetEvent = engine.events.find((e) => e.type === 'camera-reset');
  assert.deepEqual(resetEvent.flushed, ['B:B-0013#13'], '复位应清出悬置旧图');
  assert.equal(engine.stats.paired, 10, '复位后固定窗下无新配对');
  assert.equal(engine.stats.missed, 2 + 1 + 8, '批次1漏配2 + 复位清出1 + 复位后8帧全漏配');
  assert.equal(engine.stats.qcAccepted, 10, '质检接收不增加');
  assert.equal(engine.stats.qcQuarantine, 0, '固定窗不产生跨产品配对');
});

test('合成批次2（动态校正）：学到偏移继续配对，跨产品样本被质检隔离', () => {
  const engine = new PairingEngine({ strategy: STRATEGY_DYNAMIC });
  feed(engine, batch1());
  feed(engine, batch2(), { drain: true });
  assert.equal(engine.stats.resets, 1);
  assert.ok(engine.events.some((e) => e.type === 'offset-corrected' && e.to === 13),
    '动态校正应学到偏移 13');
  assert.equal(engine.stats.paired, 14, '复位后 4 对经校正关联');
  assert.equal(engine.stats.qcAccepted, 10, '复位后的配对不能进入质检接收');
  assert.equal(engine.stats.qcQuarantine, 4, '跨产品配对全部隔离');
  for (const s of engine.qcQuarantine) {
    assert.ok(s.corrected, '隔离样本来自校正配对');
    assert.notEqual(s.productA, s.productB, '两帧分属不同产品');
  }
  // 旧图 B-0013 在复位时已被清出，未接到任何新件
  assert.ok(engine.rejects.some((r) => r.photoId === 'B-0013' && r.kind === 'miss'));
  assert.ok(engine.samples.every((s) => s.photoB !== 'B-0013'));
});

test('输入校验：非法相机 / 计数 / 照片编号直接抛错', () => {
  const engine = new PairingEngine();
  assert.throws(() => engine.ingestFrame({ camera: 'C', photoId: 'x', triggerCount: 1 }), TypeError);
  assert.throws(() => engine.ingestFrame({ camera: 'A', photoId: '', triggerCount: 1 }), TypeError);
  assert.throws(() => engine.ingestFrame({ camera: 'A', photoId: 'x', triggerCount: -1 }), TypeError);
  assert.throws(() => engine.ingestPass({ productId: '', cycle: 1 }), TypeError);
});
