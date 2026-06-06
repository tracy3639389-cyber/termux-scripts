const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { EventEmitter } = require('events');

// ═══════════════════════════════════════════════════════════════
// 🎨 ANSI 颜色常量 - 亮紫色主题
// ═══════════════════════════════════════════════════════════════
const C = {
  reset:      '\x1b[0m',
  bold:       '\x1b[1m',
  dim:        '\x1b[2m',
  italic:     '\x1b[3m',
  underline:  '\x1b[4m',
  blink:      '\x1b[5m',
  inverse:    '\x1b[7m',
  hidden:     '\x1b[8m',
  strikethrough: '\x1b[9m',

  black:   '\x1b[30m',  red:     '\x1b[31m',
  green:   '\x1b[32m',  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',  white:   '\x1b[37m',

  bgBlack:   '\x1b[40m', bgRed:     '\x1b[41m',
  bgGreen:   '\x1b[42m', bgYellow:  '\x1b[43m',
  bgBlue:    '\x1b[44m', bgMagenta: '\x1b[45m',
  bgCyan:    '\x1b[46m', bgWhite:   '\x1b[47m',

  // 💜 亮紫色主题色板
  purple:      '\x1b[38;5;207m',
  lightPurple: '\x1b[38;5;183m',
  dimPurple:   '\x1b[38;5;92m',
  deepPurple:  '\x1b[38;5;55m',
  neonPurple:  '\x1b[38;5;171m',
  bgDimPurple: '\x1b[48;5;55m',
};

// ═══════════════════════════════════════════════════════════════
// 🚨 自定义代理错误类
// ═══════════════════════════════════════════════════════════════
class ProxyError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'ProxyError';
    this.status = status;
  }
}

// ═══════════════════════════════════════════════════════════════
// 📝 日志服务
// ═══════════════════════════════════════════════════════════════
class LoggingService {
  constructor(name = 'Tracy') {
    this.name = name;
  }

  _fmt(level, msg) {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const cfg = {
      INFO:  { c: C.green,       i: '✔' },
      ERROR: { c: C.red,         i: '✖' },
      WARN:  { c: C.yellow,      i: '⚠' },
      DEBUG: { c: C.lightPurple, i: '◈' },
    }[level] || { c: C.white, i: '·' };

    return `${C.dim}[${t}]${C.reset} ${cfg.c}${C.bold}${cfg.i} [${level}]${C.reset} ${cfg.c}${msg}${C.reset}`;
  }

  info(msg)  { console.log(this._fmt('INFO', msg)); }
  error(msg) { console.error(this._fmt('ERROR', msg)); }
  warn(msg)  { console.warn(this._fmt('WARN', msg)); }
  debug(msg) { console.debug(this._fmt('DEBUG', msg)); }
}

// ═══════════════════════════════════════════════════════════════
// 📦 消息队列
// ═══════════════════════════════════════════════════════════════
class MessageQueue extends EventEmitter {
  constructor(timeoutMs = 600000) {
    super();
    this.messages = [];
    this.waitingResolvers = [];
    this.defaultTimeout = timeoutMs;
    this.closed = false;
  }

  enqueue(message) {
    if (this.closed) return;

    if (this.waitingResolvers.length > 0) {
      const resolver = this.waitingResolvers.shift();
      clearTimeout(resolver.timeoutId);
      resolver.resolve(message);
    } else {
      this.messages.push(message);
    }
  }

  async dequeue(timeoutMs = this.defaultTimeout) {
    if (this.closed) throw new Error('Queue closed');

    return new Promise((resolve, reject) => {
      if (this.messages.length > 0) {
        return resolve(this.messages.shift());
      }

      const resolver = { resolve, reject };
      this.waitingResolvers.push(resolver);

      resolver.timeoutId = setTimeout(() => {
        const idx = this.waitingResolvers.indexOf(resolver);
        if (idx !== -1) {
          this.waitingResolvers.splice(idx, 1);
          reject(new Error('Queue timeout'));
        }
      }, timeoutMs);
    });
  }

  close() {
    this.closed = true;
    this.waitingResolvers.forEach(r => {
      clearTimeout(r.timeoutId);
      r.reject(new Error('Queue closed'));
    });
    this.waitingResolvers = [];
    this.messages = [];
  }
}

// ═══════════════════════════════════════════════════════════════
// 🔌 WebSocket 连接管理器 (带 Ping/Pong 心跳保活)
// ═══════════════════════════════════════════════════════════════
class ConnectionRegistry extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.connections = new Set();
    this.messageQueues = new Map();

    // 💓 每 30 秒向网页端发送原生 Ping 帧探测存活
    this.pingTimer = setInterval(() => {
      this.connections.forEach(ws => {
        if (ws.isAlive === false) {
          this.logger.warn('💀 网页端心跳无响应，强制断开僵尸连接');
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);
  }

  addConnection(ws, info) {
    ws.isAlive = true;
    this.connections.add(ws);

    this.logger.info(
      `🔌 网页端接入: ${C.cyan}${info.address}${C.reset} │ ` +
      `活跃连接: ${C.purple}${C.bold}${this.connections.size}${C.reset}`
    );

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => this._onMessage(data.toString()));
    ws.on('close', () => this._removeConnection(ws));
    ws.on('error', (err) => this.logger.error(`🚨 WebSocket 异常: ${err.message}`));
  }

  _removeConnection(ws) {
    this.connections.delete(ws);
    const count = this.connections.size;

    this.logger.warn(
      `🔌 网页端断开 │ 剩余连接: ${C.purple}${C.bold}${count}${C.reset}`
    );

    // 单连接架构：断开时关闭所有未完成队列，防止客户端死等
    if (count === 0) {
      this.messageQueues.forEach(q => q.close());
      this.messageQueues.clear();
    }
  }

  _onMessage(raw) {
    try {
      const msg = JSON.parse(raw);

      // 忽略应用层心跳包，不触发任何队列操作
      if (msg.event_type === 'heartbeat' || msg.event_type === 'ping') {
        return;
      }

      const queue = this.messageQueues.get(msg.request_id);
      if (!queue) {
        // 可能是已超时被清理的队列，忽略
        return;
      }

      if (msg.event_type === 'stream_close') {
        queue.enqueue({ type: 'STREAM_END' });
      } else {
        queue.enqueue(msg);
      }
    } catch (e) {
      this.logger.error('🚨 WS 消息解析失败');
    }
  }

  hasActiveConnections() { return this.connections.size > 0; }
  getFirstConnection()   { return this.connections.values().next().value; }

  createQueue(reqId) {
    const q = new MessageQueue();
    this.messageQueues.set(reqId, q);
    return q;
  }

  removeQueue(reqId) {
    const q = this.messageQueues.get(reqId);
    if (q) { q.close(); this.messageQueues.delete(reqId); }
  }

  destroy() {
    clearInterval(this.pingTimer);
    this.connections.forEach(ws => {
      try { ws.terminate(); } catch (e) {}
    });
    this.messageQueues.forEach(q => q.close());
    this.messageQueues.clear();
  }
}

// ═══════════════════════════════════════════════════════════════
// 🚀 请求处理器 - 流式/非流式自动路由
// ═══════════════════════════════════════════════════════════════
class RequestHandler {
  constructor(registry, logger) {
    this.registry = registry;
    this.logger = logger;
  }

  // ── 从数据中提取 Token 计数 ─────────────────────────
  _extractTokens(data) {
    if (typeof data !== 'string') return { prompt: 0, candidates: 0, total: 0 };
    const tMatch = data.match(/"totalTokenCount"\s*:\s*(\d+)/);
    const pMatch = data.match(/"promptTokenCount"\s*:\s*(\d+)/);
    const cMatch = data.match(/"candidatesTokenCount"\s*:\s*(\d+)/);
    return {
      prompt:      pMatch ? parseInt(pMatch[1]) : 0,
      candidates:  cMatch ? parseInt(cMatch[1]) : 0,
      total:       tMatch ? parseInt(tMatch[1]) : 0,
    };
  }

  // ── 合并两组 Token 数据（取最大值） ────────────────
  _mergeTokens(a, b) {
    return {
      prompt:     Math.max(a.prompt, b.prompt),
      candidates: Math.max(a.candidates, b.candidates),
      total:      Math.max(a.total, b.total),
    };
  }

  // ── 格式化 Token 显示 ──────────────────────────────
  _fmtTokens(tk) {
    if (!tk || tk.total === 0) return '';
    const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    return (
      `${C.dim}[${C.reset}` +
      `${C.blue}↑${fmt(tk.prompt)}${C.reset} ${C.dim}|${C.reset} ` +
      `${C.green}↓${fmt(tk.candidates)}${C.reset} ${C.dim}|${C.reset} ` +
      `${C.yellow}Σ${fmt(tk.total)}${C.reset}` +
      `${C.dim}]${C.reset}`
    );
  }

  async processRequest(req, res) {
    // 🚫 忽略浏览器自动请求
    if (req.path === '/favicon.ico') {
      return res.status(204).end();
    }

    const isStream = this._isStream(req);
    const reqId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const startTime = Date.now();

    this.logger.info(
      `📨 ${C.bold}${req.method}${C.reset} ${req.path} ` +
      `[${isStream ? `${C.purple}流式${C.reset}` : `${C.lightPurple}非流式${C.reset}`}]`
    );

    if (!this.registry.hasActiveConnections()) {
      this.logger.warn('⚠️ 没有可用的 Tracy 网页端连接');
      return res.status(503).json({
        error: { message: '没有连接到 Tracy 网页端，请先打开并连接', status: 'UNAVAILABLE' }
      });
    }

    const queue = this.registry.createQueue(reqId);
    const ctx = { tokens: { prompt: 0, candidates: 0, total: 0 } };

    try {
      const proxyReq = this._buildProxyRequest(req, reqId);
      this.registry.getFirstConnection().send(JSON.stringify(proxyReq));

      if (isStream) {
        await this._handleStream(queue, res, ctx);
      } else {
        await this._handleNonStream(queue, res, ctx);
      }

      const dur = Date.now() - startTime;
      const tkStr = this._fmtTokens(ctx.tokens);

      this.logger.info(
        `✅ 完成 ${C.neonPurple}${dur}ms${C.reset} ${tkStr} ${req.path}`
      );
    } catch (err) {
      const dur = Date.now() - startTime;
      const tkStr = ctx.tokens.total > 0 ? ` ${this._fmtTokens(ctx.tokens)}` : '';

      this._handleError(err, res);
      this.logger.error(
        `❌ 失败 ${C.red}${dur}ms${C.reset}${tkStr} ${req.path}: ${err.message}`
      );
    } finally {
      this.registry.removeQueue(reqId);
    }
  }

  // ── 流式请求检测 ──────────────────────────────────────
  _isStream(req) {
    // 1. Gemini REST API 标志: alt=sse
    if (req.query && req.query.alt === 'sse') return true;
    // 2. OpenAI 兼容标志: body.stream
    if (req.body && req.body.stream === true) return true;
    // 3. 路径关键字
    const p = req.path || '';
    return p.includes('streamGenerateContent') || p.includes('streamPredict');
  }

  _buildProxyRequest(req, reqId) {
    let body = '';
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === 'string') {
        body = req.body;
      } else if (Buffer.isBuffer(req.body)) {
        body = req.body.toString('utf-8');
      } else {
        body = JSON.stringify(req.body);
      }
    }

    return {
      path: req.path,
      method: req.method,
      headers: req.headers,
      query_params: req.query,
      body,
      request_id: reqId
    };
  }

  // ── 流式响应处理（同步心跳，不截断数据） ─────────────
  async _handleStream(queue, res, ctx) {
    // 1. 等待响应头
    const headerMsg = await queue.dequeue();
    if (headerMsg.event_type === 'error') {
      throw new ProxyError(
        headerMsg.message || 'Upstream error',
        headerMsg.status || 500
      );
    }

    // 2. 设置响应头
    res.status(headerMsg.status || 200);
    const headers = headerMsg.headers || {};
    Object.entries(headers).forEach(([k, v]) => {
      try { res.set(k, v); } catch (e) { /* 跳过非法头 */ }
    });

    // 强制 SSE 头
    res.set({
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    // 3. 流式数据循环 —— 使用 dequeue 超时机制实现同步心跳
    let consecutiveTimeouts = 0;
    const MAX_TIMEOUTS = 20; // 连续 20 次超时 (约 5 分钟无数据) 则断开

    try {
      while (true) {
        try {
          // 单次等待最多 15 秒；有数据则立刻返回，无数据则触发超时发心跳
          const msg = await queue.dequeue(15000);

          if (msg.type === 'STREAM_END') break;

          // 成功收到数据，重置超时计数
          consecutiveTimeouts = 0;

          // 流式中途收到上游错误
          if (msg.event_type === 'error') {
            const errPayload = JSON.stringify({
              error: { message: msg.message, status: msg.status }
            });
            res.write(`data: ${errPayload}\n\n`);
            break;
          }

          if (msg.data) {
            const payload = typeof msg.data === 'string' ? msg.data : String(msg.data);

            // 尝试从 chunk 中提取 tokens（流式最后几块通常包含 usageMetadata）
            const extracted = this._extractTokens(payload);
            if (extracted.total > 0) {
              ctx.tokens = this._mergeTokens(ctx.tokens, extracted);
            }

            res.write(payload);
          }

        } catch (err) {
          // dequeue 15 秒超时 → 发送同步心跳（绝对不会打断正在传输的数据）
          if (err.message === 'Queue timeout') {
            consecutiveTimeouts++;

            if (consecutiveTimeouts > MAX_TIMEOUTS) {
              this.logger.warn('⚠️ 流式响应长期无数据，安全终止连接');
              break;
            }

            // 当前处于空闲状态，安全发送 SSE 注释保活
            if (!res.writableEnded) {
              res.write(': heartbeat 💜\n\n');
            }
          } else {
            // Queue closed 等严重错误，向上抛出
            throw err;
          }
        }
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  // ── 非流式响应处理 ────────────────────────────────────
  async _handleNonStream(queue, res, ctx) {
    // 1. 等待响应头
    const headerMsg = await queue.dequeue();
    if (headerMsg.event_type === 'error') {
      throw new ProxyError(
        headerMsg.message || 'Upstream error',
        headerMsg.status || 500
      );
    }

    // 2. 收集所有数据块
    const chunks = [];

    try {
      while (true) {
        const msg = await queue.dequeue(300000);

        if (msg.type === 'STREAM_END') break;

        // 非流式中途收到上游错误
        if (msg.event_type === 'error') {
          throw new ProxyError(
            msg.message || 'Upstream error',
            msg.status || 500
          );
        }

        if (msg.data) {
          chunks.push(typeof msg.data === 'string' ? msg.data : String(msg.data));
        }
      }
    } catch (err) {
      if (err instanceof ProxyError) throw err;

      // Queue timeout: 如果已收集部分数据，仍尝试返回
      if (err.message === 'Queue timeout' && chunks.length > 0) {
        this.logger.warn('⚠️ 非流式响应超时，返回已收集的部分数据');
      } else {
        throw err;
      }
    }

    // 3. 组装完整响应
    const body = chunks.join('');

    // 从完整响应体中提取 tokens
    const extracted = this._extractTokens(body);
    if (extracted.total > 0) {
      ctx.tokens = this._mergeTokens(ctx.tokens, extracted);
    }

    res.status(headerMsg.status || 200);
    const headers = headerMsg.headers || {};
    Object.entries(headers).forEach(([k, v]) => {
      try { res.set(k, v); } catch (e) {}
    });
    res.removeHeader('Transfer-Encoding');

    res.send(body);
  }

  // ── 统一错误处理 ──────────────────────────────────────
  _handleError(err, res) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }

    if (err instanceof ProxyError) {
      res.status(err.status).json({
        error: { message: err.message, status: `HTTP_${err.status}` }
      });
    } else if (err.message === 'Queue timeout') {
      res.status(504).json({
        error: { message: '请求超时，浏览器端未及时响应', status: 'TIMEOUT' }
      });
    } else if (err.message === 'Queue closed') {
      res.status(503).json({
        error: { message: '浏览器连接已断开，请重试', status: 'UNAVAILABLE' }
      });
    } else {
      res.status(500).json({
        error: { message: `代理内部错误: ${err.message}`, status: 'INTERNAL' }
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 🏠 主服务器类
// ═══════════════════════════════════════════════════════════════
class ProxyServerSystem {
  constructor(config = {}) {
    this.config = {
      httpPort: 8889,
      wsPort: 9998,
      host: '0.0.0.0',
      ...config
    };

    this.logger   = new LoggingService('Tracy');
    this.registry = new ConnectionRegistry(this.logger);
    this.handler  = new RequestHandler(this.registry, this.logger);

    this.httpServer = null;
    this.wsServer   = null;
  }

  async start() {
    const app = this._createApp();
    this.httpServer = http.createServer(app);

    // 启动 HTTP
    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.config.httpPort, this.config.host, () => {
        this.httpServer.removeListener('error', reject);
        resolve();
      });
    });

    // 启动 WebSocket
    this.wsServer = new WebSocket.Server({
      port: this.config.wsPort,
      host: this.config.host
    });

    this.wsServer.on('connection', (ws, req) => {
      this.registry.addConnection(ws, { address: req.socket.remoteAddress });
    });

    // 打印横幅（在服务实际就绪后）
    this._printBanner();

    // 注册优雅退出
    this._setupGracefulShutdown();
  }

  _createApp() {
    const app = express();

    // ── CORS 全放行 ──
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.header('Access-Control-Allow-Headers', '*');
      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });

    // ── 解除 Node.js 默认超时 ──
    app.use((req, res, next) => {
      req.setTimeout(0);
      res.setTimeout(0);
      next();
    });

    // ── Body 解析（精确类型，互不冲突） ──
    app.use(express.json({ limit: '50mb' }));
    app.use(express.urlencoded({ extended: true, limit: '50mb' }));
    app.use(express.raw({ type: 'application/octet-stream', limit: '50mb' }));
    app.use(express.text({ type: 'text/plain', limit: '50mb' }));

    // ── 健康检查 ──
    app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        connections: this.registry.connections.size,
        uptime: Math.floor(process.uptime()),
        version: '2.1'
      });
    });

    // ── 模型列表 ──
    const modelsData = {
      models: [
        {
          name: "gemini-3.1-pro-preview",
          displayName: "gemini-3.1-pro-preview",
          version: "001",
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
          temperature: 1.0,
          topP: 0.95,
          topK: 40
        },
        {
          name: "gemini-3.5-pro-preview",
          displayName: "gemini-3.5-pro-preview",
          version: "001",
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
          temperature: 1.0,
          topP: 0.95,
          topK: 40
        }
      ]
    };

    // 列表路由
    app.get(['/v1beta/models', '/v1/models', '/models'], (req, res) => {
      res.json(modelsData);
    });

    // 单模型详情路由
    app.get(['/v1beta/models/:model', '/v1/models/:model'], (req, res) => {
      const modelId = req.params.model;
      const found = modelsData.models.find(m => m.name === modelId);
      if (found) {
        res.json(found);
      } else {
        res.status(404).json({
          error: { message: `Model ${modelId} not found`, status: 'NOT_FOUND' }
        });
      }
    });

    // ── 全局路由 ──
    app.all(/(.*)/, (req, res) => this.handler.processRequest(req, res));

    return app;
  }

  // ═══════════════════════════════════════════════════════════
  // 🎨 启动横幅 - 亮紫色主题
  // ═══════════════════════════════════════════════════════════
  _printBanner() {
    const p  = C.purple;
    const pl = C.lightPurple;
    const pd = C.dimPurple;
    const dp = C.deepPurple;
    const np = C.neonPurple;

    const W = 44;

    const visLen = (str) => {
      const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
      let len = 0;
      for (const ch of stripped) {
        len += ch.charCodeAt(0) > 127 ? 2 : 1;
      }
      return len;
    };

    const pad = (str, len) => str + ' '.repeat(Math.max(0, len - visLen(str)));

    const row = (content) =>
      `${p}║${C.reset} ${pad(content, W - 2)} ${p}║${C.reset}`;

    const empty = () =>
      `${p}║${' '.repeat(W)}${p}║${C.reset}`;

    const top    = `${p}╔${'═'.repeat(W)}╗${C.reset}`;
    const bot    = `${p}╚${'═'.repeat(W)}╝${C.reset}`;
    const sep    = `${p}╟${'─'.repeat(W)}╢${C.reset}`;
    const line   = `${pd}✦${'━'.repeat(W + 2)}✦${C.reset}`;
    const sparkl = `${pd}  ${C.purple}·${C.reset}  ${C.lightPurple}✧${C.reset}  ${C.purple}·${C.reset}  ${C.lightPurple}✧${C.reset}  ${C.purple}·${C.reset}  ${C.lightPurple}✧${C.reset}  ${C.purple}·${C.reset}  ${C.lightPurple}✧${C.reset}  ${C.purple}·${C.reset}  ${C.lightPurple}✧${C.reset}  ${C.purple}·${C.reset}  ${C.lightPurple}✧${C.reset}  ${C.purple}·${C.reset}  ${C.lightPurple}✧${C.reset}  ${C.purple}·${C.reset}  ${C.lightPurple}✧${C.reset}  ${C.purple}·${C.reset}`;

    console.log('');
    console.log(sparkl);
    console.log(line);
    console.log(top);
    console.log(empty());
    console.log(row(`${C.bold}${C.white}✨ Tracy Build 2.1 反代服务器 ✨${C.reset}`));
    console.log(row(`${pl}双向心跳保活 · 极速中转网关${C.reset}`));
    console.log(empty());
    console.log(sep);
    console.log(empty());
    console.log(row(`${np}📡${C.reset}  HTTP API  ──  ${C.cyan}${this.config.host}:${this.config.httpPort}${C.reset}`));
    console.log(row(`${np}🔌${C.reset}  WS 桥接   ──  ${C.cyan}${this.config.host}:${this.config.wsPort}${C.reset}`));
    console.log(empty());
    console.log(sep);
    console.log(empty());
    console.log(row(`${C.yellow}🤖${C.reset}  默认模型   ──  ${C.yellow}gemini-3.1-pro-preview${C.reset}`));
    console.log(row(`${C.yellow}🔮${C.reset}  可选模型   ──  ${C.yellow}gemini-3.5-pro-preview${C.reset}`));
    console.log(empty());
    console.log(sep);
    console.log(empty());
    console.log(row(`${C.bgMagenta}${C.white}${C.bold} 💜 RUNNING ${C.reset}  ${C.dim}等待 Tracy 网页端连接...${C.reset}`));
    console.log(empty());
    console.log(bot);
    console.log(line);
    console.log(sparkl);
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════
  // 🛑 优雅退出
  // ═══════════════════════════════════════════════════════════
  _setupGracefulShutdown() {
    let isShuttingDown = false;

    const shutdown = (signal) => {
      if (isShuttingDown) return;
      isShuttingDown = true;

      this.logger.warn(`🛑 收到 ${signal}，正在安全关闭...`);

      // 1. 销毁连接注册器（停止心跳、关闭队列、断开 WS）
      this.registry.destroy();
      this.logger.info('🔌 已断开所有 WebSocket 连接');

      // 2. 关闭 WS 服务器
      if (this.wsServer) {
        this.wsServer.close(() => {
          this.logger.info('📡 WS 服务器已关闭');
        });
      }

      // 3. 关闭 HTTP 服务器
      if (this.httpServer) {
        this.httpServer.close(() => {
          this.logger.info('💜 Tracy 已安全关闭，再见！');
          process.exit(0);
        });
      }

      // 4. 超时强制退出
      setTimeout(() => {
        this.logger.warn('⚠️ 关闭超时，强制退出');
        process.exit(1);
      }, 3000);
    };

    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // 未捕获异常保护
    process.on('uncaughtException', (err) => {
      this.logger.error(`💥 未捕获异常: ${err.message}`);
    });

    process.on('unhandledRejection', (reason) => {
      this.logger.error(`💥 未处理的 Promise 拒绝: ${reason}`);
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// 🚀 启动入口
// ═══════════════════════════════════════════════════════════════
async function initializeServer() {
  const server = new ProxyServerSystem();

  try {
    await server.start();
  } catch (err) {
    const msg = err.code === 'EADDRINUSE'
      ? `端口已被占用，请检查 ${server.config.httpPort}/${server.config.wsPort}`
      : err.code === 'EACCES'
        ? '端口无权限访问，请使用 1024 以上端口'
        : err.message;

    console.error(`\n${C.red}${C.bold}✖ 致命错误:${C.reset} ${msg}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  initializeServer();
}

module.exports = { ProxyServerSystem, ProxyError, initializeServer };
