'use strict';

/* 页面逻辑：所有业务数字均来自后端引擎的实际处理结果，前端只做渲染。 */

const $ = (sel) => document.querySelector(sel);

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function renderStrategy(container, strategy) {
  container.textContent = '';
  const label = strategy.strategy === 'fixed-window' ? '固定等待窗' : '动态校正';
  container.append(
    el('strong', `当前策略：${label}`),
    el('span', ` — ${strategy.rationale}`, 'banner-reason'),
  );
}

function renderSummary(container, summary) {
  const names = {
    frames: '接收帧', passes: '过站信号', duplicates: '重复帧', resets: '复位',
    paired: '成对', qcAccepted: '质检接收', qcQuarantine: '隔离(跨产品)',
    missed: '漏配', noProduct: '无过站信号',
  };
  const grid = el('div', null, 'stat-grid');
  for (const [key, label] of Object.entries(names)) {
    const card = el('div', null, 'stat');
    card.append(el('div', summary[key] ?? 0, 'stat-value'), el('div', label, 'stat-label'));
    grid.append(card);
  }
  container.append(grid);
}

function renderTable(container, columns, rows, emptyText) {
  if (!rows || rows.length === 0) {
    container.append(el('p', emptyText || '（无）', 'muted'));
    return;
  }
  const table = el('table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const col of columns) headRow.append(el('th', col.label));
  thead.append(headRow);
  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    for (const col of columns) tr.append(el('td', col.value(row)));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  container.append(table);
}

function renderEvents(container, events) {
  if (!events.length) return;
  const list = el('ul', null, 'events');
  for (const e of events) {
    list.append(el('li', `[${e.type}] ${e.note || JSON.stringify(e)}`));
  }
  container.append(el('h3', '事件'), list);
}

function sampleRow(s) {
  return {
    id: s.id,
    pair: `${s.photoA} (#${s.countA}) ＋ ${s.photoB} (#${s.countB})`,
    product: s.productId || `${s.productA || '?'} ≠ ${s.productB || '?'}`,
    note: s.corrected ? `动态校正(偏移${s.offsetUsed})` : (s.reason || ''),
  };
}

const SAMPLE_COLUMNS = [
  { label: '样本', value: (r) => r.id },
  { label: '帧配对', value: (r) => r.pair },
  { label: '产品', value: (r) => r.product },
  { label: '备注', value: (r) => r.note },
];

const REJECT_COLUMNS = [
  { label: '类型', value: (r) => ({ miss: '漏配', duplicate: '重复帧', 'no-product': '无过站信号' }[r.kind] || r.kind) },
  { label: '对象', value: (r) => (r.kind === 'no-product' ? r.sampleId : `${r.camera}:${r.photoId} (#${r.triggerCount})`) },
  { label: '原因', value: (r) => r.reason },
];

function renderQc(container, state) {
  container.textContent = '';
  container.append(el('h3', `质检接收（成对且同一产品，共 ${state.qcAccepted.length} 件）`));
  renderTable(container, SAMPLE_COLUMNS, state.qcAccepted.map(sampleRow), '暂无质检接收样本');
  container.append(el('h3', `隔离（成对但跨产品，质检不处理，共 ${state.qcQuarantine.length} 件）`));
  renderTable(container, SAMPLE_COLUMNS, state.qcQuarantine.map(sampleRow), '暂无隔离样本');
  container.append(el('h3', `拒收 / 漏配（共 ${state.rejects.length} 件）`));
  renderTable(container, REJECT_COLUMNS, state.rejects, '暂无拒收记录');
  if (state.pending.unpaired.length) {
    container.append(el('h3', `接收端保留的未配对件（${state.pending.unpaired.length}）`));
    renderTable(container, [
      { label: '相机', value: (r) => r.camera },
      { label: '照片编号', value: (r) => r.photoId },
      { label: '触发计数', value: (r) => r.triggerCount },
      { label: '代数', value: (r) => r.epoch },
    ], state.pending.unpaired);
  }
}

async function refreshStrategy() {
  const state = await api('/api/state');
  renderStrategy($('#strategy-banner'), state.strategy);
  return state;
}

$('#btn-batch1').addEventListener('click', async () => {
  const box = $('#result-batch1');
  try {
    const result = await api('/api/demo/batch1', { method: 'POST', body: '{}' });
    box.textContent = '';
    box.append(el('h2', '① 接收双相机帧 — 处理结果'));
    box.append(el('p', `本批次实际处理 ${result.ingestedEvents} 个事件（含正常、丢帧、重复、乱序），统计增量：`));
    renderSummary(box, result.summary);
    renderEvents(box, result.state.events);
    box.append(el('h3', '接收端保留的未配对件'));
    renderTable(box, [
      { label: '相机', value: (r) => r.camera },
      { label: '照片编号', value: (r) => r.photoId },
      { label: '触发计数', value: (r) => r.triggerCount },
    ], result.state.pending.unpaired, '（无悬置帧）');
    renderStrategy($('#strategy-banner'), result.state.strategy);
  } catch (err) {
    box.textContent = `处理失败：${err.message}`;
  }
});

$('#btn-batch2').addEventListener('click', async () => {
  const box = $('#result-reset');
  try {
    const result = await api('/api/demo/batch2', { method: 'POST', body: '{}' });
    box.textContent = '';
    box.append(el('h2', '② 模拟复位后续收 — 处理结果'));
    box.append(el('p', `相机A重新计数后继续接收，本批次实际处理 ${result.ingestedEvents} 个事件，统计增量：`));
    renderSummary(box, result.summary);
    renderEvents(box, result.state.events.filter((e) => e.type === 'camera-reset' || e.type === 'offset-corrected'));
    box.append(el('h3', '本批次相关拒收 / 漏配'));
    renderTable(box, REJECT_COLUMNS, result.state.rejects, '（无）');
    renderStrategy($('#strategy-banner'), result.state.strategy);
  } catch (err) {
    box.textContent = `处理失败：${err.message}`;
  }
});

$('#btn-qc').addEventListener('click', async () => {
  const box = $('#result-qc');
  try {
    const state = await api('/api/state');
    box.textContent = '';
    box.append(el('h2', '③ 质检配对 — 当前判定'));
    box.append(el('p', `策略：${state.strategy.strategy}；累计接收 ${state.stats.qcAccepted} 件，隔离 ${state.stats.qcQuarantine} 件，漏配/拒收 ${state.rejects.length} 件。`));
    renderQc(box, state);
  } catch (err) {
    box.textContent = `查询失败：${err.message}`;
  }
});

$('#config-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = {
    costMismatch: Number($('#cost-mismatch').value),
    costMiss: Number($('#cost-miss').value),
    waitWindow: Number($('#wait-window').value),
  };
  try {
    const result = await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
    renderStrategy($('#strategy-banner'), result.state.strategy);
    for (const sel of ['#result-batch1', '#result-reset', '#result-qc']) {
      const box = $(sel);
      const title = box.querySelector('h2');
      box.textContent = '';
      box.append(title);
      box.append(el('div', '策略已更新，数据已清空，请重新执行操作。', 'placeholder'));
    }
  } catch (err) {
    $('#strategy-banner').textContent = `配置失败：${err.message}`;
  }
});

$('#btn-reset').addEventListener('click', async () => {
  await api('/api/reset', { method: 'POST', body: '{}' });
  await refreshStrategy();
});

refreshStrategy().catch((err) => {
  $('#strategy-banner').textContent = `无法连接服务：${err.message}`;
});
