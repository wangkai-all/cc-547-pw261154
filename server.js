'use strict';

/**
 * 产线双相机配对演示服务（仅 Node.js 内置模块）。
 * 启动：node server.js（读取 PORT 环境变量，默认 3000，绑定 127.0.0.1）。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { PairingEngine } = require('./lib/engine');
const { batch1, batch2 } = require('./lib/scenario');

const PUBLIC_DIR = path.join(__dirname, 'public');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function createApp(options = {}) {
  let config = {
    costMismatch: options.costMismatch ?? 10,
    costMiss: options.costMiss ?? 1,
    waitWindow: options.waitWindow ?? 3,
  };
  let engine = new PairingEngine({ ...config, strategy: 'auto' });

  function diffStats(before, after) {
    const delta = {};
    for (const key of Object.keys(after)) delta[key] = after[key] - (before[key] ?? 0);
    return delta;
  }

  /** 实际跑一遍事件流，返回本批次统计增量（结果全部由引擎实际处理得出） */
  function runEvents(events, { drain = false } = {}) {
    const before = { ...engine.stats };
    for (const event of events) {
      if (event.type === 'pass') engine.ingestPass(event);
      else engine.ingestFrame(event);
    }
    if (drain) engine.drain();
    return { ingestedEvents: events.length, summary: diffStats(before, engine.stats) };
  }

  function serveStatic(pathname, res) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
        return;
      }
      const type = CONTENT_TYPES[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const route = `${req.method} ${url.pathname}`;

      if (route === 'GET /api/state') {
        return sendJson(res, 200, engine.getState());
      }
      if (route === 'POST /api/demo/batch1') {
        // 「接收双相机帧」：正常 + 漏配 + 重复 + 乱序，末尾留一件未配对帧
        const result = runEvents(batch1());
        return sendJson(res, 200, { ...result, state: engine.getState() });
      }
      if (route === 'POST /api/demo/batch2') {
        // 「模拟复位后续收」：相机A重新计数后继续上报，批次关闭
        const result = runEvents(batch2(), { drain: true });
        return sendJson(res, 200, { ...result, state: engine.getState() });
      }
      if (route === 'POST /api/config') {
        const body = await readBody(req);
        const next = {
          costMismatch: Number(body.costMismatch),
          costMiss: Number(body.costMiss),
          waitWindow: Number(body.waitWindow ?? config.waitWindow),
        };
        if (!Number.isFinite(next.costMismatch) || next.costMismatch < 0
          || !Number.isFinite(next.costMiss) || next.costMiss < 0
          || !Number.isInteger(next.waitWindow) || next.waitWindow < 0) {
          return sendJson(res, 400, { error: '代价需为非负数值，等待窗需为非负整数' });
        }
        config = next;
        engine = new PairingEngine({ ...config, strategy: 'auto' });
        return sendJson(res, 200, { ok: true, state: engine.getState() });
      }
      if (route === 'POST /api/reset') {
        engine = new PairingEngine({ ...config, strategy: 'auto' });
        return sendJson(res, 200, { ok: true, state: engine.getState() });
      }

      if (req.method === 'GET') return serveStatic(url.pathname, res);
      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      const status = err instanceof TypeError ? 400 : 500;
      return sendJson(res, status, { error: String((err && err.message) || err) });
    }
  });

  return { server, getEngine: () => engine };
}

if (require.main === module) {
  const PORT = Number(process.env.PORT || 3000);
  const HOST = '127.0.0.1';
  const { server } = createApp();
  server.listen(PORT, HOST, () => {
    console.log(`产线双相机配对演示已启动: http://${HOST}:${server.address().port}/`);
  });
}

module.exports = { createApp };
