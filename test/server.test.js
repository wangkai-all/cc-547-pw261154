'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

async function startServer(options) {
  const { server } = createApp(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function post(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, data: await res.json() };
}

test('服务：页面包含 data-evidence-result 业务结果区', async (t) => {
  const { base, close } = await startServer();
  t.after(close);
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  const markers = html.match(/data-evidence-result="[^"]+"/g) || [];
  assert.ok(markers.length >= 3, '页面应有至少三个业务结果区');
  assert.ok(html.includes('data-evidence-result="batch1"'));
  assert.ok(html.includes('data-evidence-result="reset"'));
  assert.ok(html.includes('data-evidence-result="qc"'));
});

test('服务：默认代价（错配高）走固定等待窗，完整演示流程', async (t) => {
  const { base, close } = await startServer();
  t.after(close);

  let res = await post(base, '/api/demo/batch1');
  assert.equal(res.status, 200);
  assert.equal(res.data.summary.paired, 10);
  assert.equal(res.data.summary.qcAccepted, 10);
  assert.equal(res.data.summary.missed, 2);
  assert.equal(res.data.summary.duplicates, 1);
  assert.equal(res.data.state.strategy.strategy, 'fixed-window');
  assert.equal(res.data.state.pending.unpaired.length, 1, 'B-0013 悬置在接收端');

  res = await post(base, '/api/demo/batch2');
  assert.equal(res.status, 200);
  assert.equal(res.data.summary.resets, 1);
  assert.equal(res.data.summary.paired, 0, '固定窗下复位后计数不再相等，无法成对');
  assert.equal(res.data.summary.missed, 9, '复位清出1件 + 后续8帧全部漏配');

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.qcAccepted.length, 10);
  assert.equal(state.qcQuarantine.length, 0);
  assert.equal(state.rejects.length, 2 + 1 + 8 + 1, '漏配11 + 重复1');
});

test('服务：漏配代价调高后切换动态校正，复位后配对恢复但被质检隔离', async (t) => {
  const { base, close } = await startServer();
  t.after(close);

  let res = await post(base, '/api/config', { costMismatch: 1, costMiss: 50, waitWindow: 3 });
  assert.equal(res.status, 200);
  assert.equal(res.data.state.strategy.strategy, 'dynamic-correction');

  res = await post(base, '/api/demo/batch1');
  assert.equal(res.data.summary.paired, 10, '动态策略下正常流程结果一致');

  res = await post(base, '/api/demo/batch2');
  assert.equal(res.status, 200);
  assert.equal(res.data.summary.paired, 4, '动态校正学到偏移后继续配对');
  assert.equal(res.data.summary.qcQuarantine, 4, '跨产品配对被质检隔离');
  assert.equal(res.data.summary.qcAccepted, 0);
  assert.equal(res.data.summary.missed, 1, '仅复位清出的旧图判漏配');

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.qcAccepted.length, 10);
  assert.equal(state.qcQuarantine.length, 4);
  assert.ok(state.events.some((e) => e.type === 'camera-reset'));
  assert.ok(state.events.some((e) => e.type === 'offset-corrected'));
});

test('服务：重置后统计清零；非法配置返回 400', async (t) => {
  const { base, close } = await startServer();
  t.after(close);

  await post(base, '/api/demo/batch1');
  let res = await post(base, '/api/reset');
  assert.equal(res.status, 200);
  assert.equal(res.data.state.stats.frames, 0);
  assert.equal(res.data.state.qcAccepted.length, 0);

  res = await post(base, '/api/config', { costMismatch: -5, costMiss: 1 });
  assert.equal(res.status, 400);
});
