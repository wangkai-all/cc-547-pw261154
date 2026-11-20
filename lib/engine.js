'use strict';

/**
 * 双相机帧配对引擎（纯 Node.js 内置模块，无第三方依赖）。
 *
 * 产线模型：
 *  - 两台本地相机 A / B，各自上报 { photoId, triggerCount }（照片编号 + 触发计数）。
 *  - 工位控制源独立上报产品通过信号 { productId, cycle }（cycle 为工位周期号，单调递增）。
 *  - 接收端：保留未配对帧（缓冲），识别重复帧 / 乱序帧 / 相机重新计数（复位）。
 *  - 组装端：按触发周期关联两相机帧，形成样本。
 *      · fixed-window      固定等待窗：只接受计数完全一致的配对，宁可漏配不可错配。
 *      · dynamic-correction 动态校正：从同窗口未配对帧估计两相机的计数偏移，按偏移继续配对。
 *    策略选择由错配 / 漏配代价决定（chooseStrategy）。
 *  - 质检端：只处理「成对且属于同一产品」的样本。
 *      · 成对但两帧分属不同产品 → 隔离（quarantine），质检不处理；
 *      · 工位过站信号缺失 → 拒收（no-product）；
 *      · 未配对帧等待窗耗尽 → 漏配（miss）。
 *  - 相机重新计数（复位）：计数明显回退即判定复位，立即清空两侧未配对缓存，
 *    复位前的旧图绝不会接到复位后的新件上。
 */

const STRATEGY_FIXED = 'fixed-window';
const STRATEGY_DYNAMIC = 'dynamic-correction';

/**
 * 由错配 / 漏配代价选择策略：
 *  - 错配代价 ≥ 漏配代价 → 固定等待窗（保守，绝不强行配对）；
 *  - 漏配代价更高       → 动态校正（估计计数偏移挽回配对，错配风险交给质检拦截）。
 */
function chooseStrategy(costMismatch, costMiss) {
  return costMismatch >= costMiss ? STRATEGY_FIXED : STRATEGY_DYNAMIC;
}

function median(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

class PairingEngine {
  constructor(options = {}) {
    this.costMismatch = options.costMismatch ?? 10;
    this.costMiss = options.costMiss ?? 1;
    this.waitWindow = options.waitWindow ?? 3;       // 等待窗：伴侣帧最多可迟到的对侧帧数
    this.reorderTolerance = options.reorderTolerance ?? 2; // 乱序容忍：计数回退不超过该值视为乱序而非复位
    this.offsetWindowSize = options.offsetWindowSize ?? 6; // 偏移估计滑动窗
    const requested = options.strategy ?? 'auto';
    this.strategy = requested === 'auto'
      ? chooseStrategy(this.costMismatch, this.costMiss)
      : requested;
    if (![STRATEGY_FIXED, STRATEGY_DYNAMIC].includes(this.strategy)) {
      throw new Error(`未知策略: ${this.strategy}`);
    }
    this.reset();
  }

  reset() {
    this.arrivalSeq = 0;
    this.arrivalCount = { A: 0, B: 0 };       // 各相机已接收帧数（用于等待窗老化）
    this.lastCount = { A: null, B: null };    // 各相机最近一次触发计数
    this.lastFrame = { A: null, B: null };    // 各相机最近一帧（用于偏移估计）
    this.epoch = { A: 0, B: 0 };              // 各相机代数（每次复位 +1，仅作追溯标记）
    this.buffers = { A: new Map(), B: new Map() }; // triggerCount -> frame（接收端保留的未配对件）
    this.products = new Map();                // 工位周期 -> { productId, cycle }
    this.samples = [];                        // 所有已成对样本（含状态）
    this.qcAccepted = [];                     // 质检接收（成对且同一产品）
    this.qcQuarantine = [];                   // 成对但跨产品 → 隔离，质检不处理
    this.rejects = [];                        // miss / duplicate / no-product
    this.events = [];                         // 复位、乱序、偏移校正等事件
    this.offsetWindow = [];                   // 动态校正的偏移样本窗
    this.offsetEstimate = 0;
    this.sampleSeq = 0;
    this.stats = {
      frames: 0, passes: 0, duplicates: 0, resets: 0,
      paired: 0, qcAccepted: 0, qcQuarantine: 0, missed: 0, noProduct: 0,
    };
  }

  strategyInfo() {
    return {
      strategy: this.strategy,
      costMismatch: this.costMismatch,
      costMiss: this.costMiss,
      waitWindow: this.waitWindow,
      rationale: this.strategy === STRATEGY_FIXED
        ? `错配代价(${this.costMismatch}) ≥ 漏配代价(${this.costMiss})：固定等待窗，只接受计数完全一致的配对，宁可漏配不可错配`
        : `漏配代价(${this.costMiss}) > 错配代价(${this.costMismatch})：动态校正计数偏移继续配对，错配风险由质检的同产品核对拦截`,
    };
  }

  // ---------- 接收端 ----------

  ingestFrame(input) {
    const { camera, photoId, triggerCount } = input || {};
    if (camera !== 'A' && camera !== 'B') throw new TypeError('camera 必须是 A 或 B');
    if (typeof photoId !== 'string' || photoId.length === 0) throw new TypeError('photoId 必须是非空字符串');
    if (!Number.isInteger(triggerCount) || triggerCount < 0) throw new TypeError('triggerCount 必须是非负整数');

    this.arrivalSeq += 1;
    const frame = {
      camera, photoId, triggerCount,
      epoch: this.epoch[camera],
      arrivalSeq: this.arrivalSeq,
      oppositeArrivals: this.arrivalCount[camera === 'A' ? 'B' : 'A'],
    };

    // 重复帧：与上一帧计数相同，或同计数帧仍在缓冲中等待
    if (this.lastCount[camera] === triggerCount || this.buffers[camera].has(triggerCount)) {
      this.stats.duplicates += 1;
      const record = { kind: 'duplicate', camera, photoId, triggerCount, reason: '重复帧：计数与已接收帧相同' };
      this.rejects.push(record);
      return { accepted: false, reason: 'duplicate', record };
    }

    // 复位检测：计数明显回退（超出乱序容忍窗）→ 相机重新计数
    if (this.lastCount[camera] !== null && triggerCount < this.lastCount[camera] - this.reorderTolerance) {
      this.handleReset(camera, triggerCount);
      frame.epoch = this.epoch[camera];
    } else if (this.lastCount[camera] !== null && triggerCount < this.lastCount[camera]) {
      this.events.push({ type: 'late-frame', camera, photoId, triggerCount, note: '乱序帧（在容忍窗内），仍正常参与配对' });
    }

    this.lastCount[camera] = this.lastCount[camera] === null
      ? triggerCount
      : Math.max(this.lastCount[camera], triggerCount);
    this.lastFrame[camera] = frame;
    this.arrivalCount[camera] += 1;
    this.stats.frames += 1;

    // 动态校正：从「对侧最新帧仍未配对」的相邻帧学习计数偏移
    if (this.strategy === STRATEGY_DYNAMIC) this.learnOffset(frame);

    // 组装端：按触发周期关联
    if (!this.tryPair(frame)) {
      this.buffers[camera].set(triggerCount, frame); // 接收端保留未配对件
    } else if (this.strategy === STRATEGY_DYNAMIC) {
      this.sweepPairs();
    }

    this.expireWaiting();
    return { accepted: true, frame };
  }

  /**
   * 相机重新计数：代数 +1，并立即清空两侧未配对缓存。
   * 这是「旧图不接新件」的核心保护：复位前滞留的帧一律按漏配处理，
   * 复位后计数重新从小编号开始时，绝不会与缓冲中的旧图配成对。
   */
  handleReset(camera, newCount) {
    this.epoch[camera] += 1;
    this.stats.resets += 1;
    const flushed = [];
    for (const side of ['A', 'B']) {
      for (const stale of this.buffers[side].values()) {
        flushed.push(stale);
        this.recordMiss(stale, `相机${camera}重新计数（复位），复位前未配对旧帧不得接到新件`);
      }
      this.buffers[side].clear();
    }
    // 复位后两侧计数关系未知，偏移估计重新学习
    this.offsetWindow = [];
    this.offsetEstimate = 0;
    this.lastCount[camera] = null; // 由调用方随后写入新计数
    this.events.push({
      type: 'camera-reset', camera, epoch: this.epoch[camera], newCount,
      flushed: flushed.map((f) => `${f.camera}:${f.photoId}#${f.triggerCount}`),
      note: `相机${camera}计数回退，判定重新计数；已清空 ${flushed.length} 件复位前未配对帧`,
    });
  }

  learnOffset(frame) {
    const other = frame.camera === 'A' ? 'B' : 'A';
    const otherLast = this.lastFrame[other];
    if (!otherLast) return;
    // 仅当对侧最新帧仍滞留在缓冲（未配对）时，两帧才可能是同一触发周期的相邻帧；
    // 已被配对消费或复位清空的帧不参与估计，避免把旧计数关系学进新偏移。
    if (!this.buffers[other].has(otherLast.triggerCount)) return;
    const aCount = frame.camera === 'A' ? frame.triggerCount : otherLast.triggerCount;
    const bCount = frame.camera === 'B' ? frame.triggerCount : otherLast.triggerCount;
    const delta = bCount - aCount;
    this.offsetWindow.push(delta);
    if (this.offsetWindow.length > this.offsetWindowSize) this.offsetWindow.shift();
    const next = median(this.offsetWindow);
    if (next !== this.offsetEstimate) {
      this.events.push({
        type: 'offset-corrected', from: this.offsetEstimate, to: next,
        note: `动态校正：估计相机B计数 - 相机A计数 = ${next}`,
      });
      this.offsetEstimate = next;
    }
  }

  // ---------- 组装端 ----------

  tryPair(frame) {
    const other = frame.camera === 'A' ? 'B' : 'A';
    const offset = this.strategy === STRATEGY_DYNAMIC ? this.offsetEstimate : 0;
    const want = frame.camera === 'A' ? frame.triggerCount + offset : frame.triggerCount - offset;
    const partner = this.buffers[other].get(want);
    if (!partner) return false;
    this.buffers[other].delete(want);
    const frameA = frame.camera === 'A' ? frame : partner;
    const frameB = frame.camera === 'A' ? partner : frame;
    this.formSample(frameA, frameB, offset);
    return true;
  }

  /** 偏移更新后，扫描缓冲中因新偏移而可配对的滞留帧 */
  sweepPairs() {
    let progress = true;
    while (progress) {
      progress = false;
      for (const a of [...this.buffers.A.values()]) {
        const b = this.buffers.B.get(a.triggerCount + this.offsetEstimate);
        if (b) {
          this.buffers.A.delete(a.triggerCount);
          this.buffers.B.delete(b.triggerCount);
          this.formSample(a, b, this.offsetEstimate);
          progress = true;
        }
      }
    }
  }

  formSample(frameA, frameB, offsetUsed) {
    this.sampleSeq += 1;
    const sample = {
      id: `S${String(this.sampleSeq).padStart(4, '0')}`,
      photoA: frameA.photoId, photoB: frameB.photoId,
      countA: frameA.triggerCount, countB: frameB.triggerCount,
      epochA: frameA.epoch, epochB: frameB.epoch,
      offsetUsed,
      corrected: frameA.triggerCount !== frameB.triggerCount, // 经动态校正关联
      status: 'pending',
    };
    this.samples.push(sample);
    this.stats.paired += 1;
    this.evaluateSample(sample);
    return sample;
  }

  /** 等待窗老化：对侧已到达 waitWindow 帧以上仍无伴侣 → 漏配 */
  expireWaiting() {
    for (const side of ['A', 'B']) {
      const other = side === 'A' ? 'B' : 'A';
      for (const frame of [...this.buffers[side].values()]) {
        const age = this.arrivalCount[other] - frame.oppositeArrivals;
        if (age > this.waitWindow) {
          this.buffers[side].delete(frame.triggerCount);
          this.recordMiss(frame, `等待窗耗尽（对侧已到 ${age} 帧仍无伴侣）`);
        }
      }
    }
  }

  recordMiss(frame, reason) {
    this.stats.missed += 1;
    this.rejects.push({
      kind: 'miss', camera: frame.camera, photoId: frame.photoId,
      triggerCount: frame.triggerCount, epoch: frame.epoch, reason,
    });
  }

  // ---------- 工位控制源 ----------

  ingestPass(input) {
    const { productId, cycle } = input || {};
    if (typeof productId !== 'string' || productId.length === 0) throw new TypeError('productId 必须是非空字符串');
    if (!Number.isInteger(cycle) || cycle < 0) throw new TypeError('cycle 必须是非负整数');
    if (this.products.has(cycle)) {
      this.events.push({ type: 'duplicate-pass', productId, cycle, note: '同工位周期重复过站信号，保留首条' });
      return { accepted: false, reason: 'duplicate-pass' };
    }
    this.products.set(cycle, { productId, cycle });
    this.stats.passes += 1;
    for (const sample of this.samples) this.evaluateSample(sample);
    return { accepted: true };
  }

  // ---------- 质检端 ----------

  /**
   * 质检只处理「成对且属于同一产品」的样本。
   * 对每帧用其自身触发计数独立查工位过站记录，不轻信组装端的关联：
   * 两帧指向同一产品 → 接收；分属不同产品 → 隔离（跨产品错配，质检不处理）。
   * 过站信号未到的保持等待，批次关闭时仍无信号 → no-product 拒收。
   */
  evaluateSample(sample) {
    if (sample.status !== 'pending') return;
    const pA = this.products.get(sample.countA);
    const pB = this.products.get(sample.countB);
    if (!pA || !pB) return; // 等待工位过站信号
    if (pA.productId === pB.productId) {
      sample.status = 'accepted';
      sample.productId = pA.productId;
      this.qcAccepted.push(sample);
      this.stats.qcAccepted += 1;
    } else {
      sample.status = 'quarantine';
      sample.productA = pA.productId;
      sample.productB = pB.productId;
      sample.reason = `两帧分属不同产品（${pA.productId} ≠ ${pB.productId}），疑似错配，隔离待核`;
      this.qcQuarantine.push(sample);
      this.stats.qcQuarantine += 1;
    }
  }

  /** 批次关闭：仍在等待的帧按漏配处理；仍无过站信号的样本按 no-product 拒收 */
  drain() {
    for (const side of ['A', 'B']) {
      for (const frame of [...this.buffers[side].values()]) {
        this.buffers[side].delete(frame.triggerCount);
        this.recordMiss(frame, '批次关闭，等待窗关闭仍无伴侣帧');
      }
    }
    for (const sample of this.samples) {
      if (sample.status === 'pending') {
        sample.status = 'no-product';
        sample.reason = '工位过站信号缺失，无法确认产品归属';
        this.stats.noProduct += 1;
        this.rejects.push({
          kind: 'no-product', sampleId: sample.id,
          countA: sample.countA, countB: sample.countB, reason: sample.reason,
        });
      }
    }
  }

  // ---------- 状态视图 ----------

  getState() {
    return {
      strategy: this.strategyInfo(),
      stats: { ...this.stats },
      pending: {
        unpaired: [...this.buffers.A.values(), ...this.buffers.B.values()]
          .map((f) => ({ camera: f.camera, photoId: f.photoId, triggerCount: f.triggerCount, epoch: f.epoch })),
        awaitingPass: this.samples.filter((s) => s.status === 'pending').map((s) => s.id),
      },
      samples: this.samples,
      qcAccepted: this.qcAccepted,
      qcQuarantine: this.qcQuarantine,
      rejects: this.rejects,
      events: this.events,
    };
  }
}

module.exports = {
  PairingEngine,
  chooseStrategy,
  STRATEGY_FIXED,
  STRATEGY_DYNAMIC,
};
