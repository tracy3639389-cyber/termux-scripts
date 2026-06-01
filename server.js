const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { EventEmitter } = require('events');

// ═══════════════════════════════════════════════════════════
// ANSI 颜色常量
// ═══════════════════════════════════════════════════════════
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  blink: '\x1b[5m',
  inverse: '\x1b[7m',
  hidden: '\x1b[8m',
  strikethrough: '\x1b[9m',
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
};

// ═══════════════════════════════════════════════════════════
// 日志记录器模块
// ═══════════════════════════════════════════════════════════
class LoggingService {
  constructor(serviceName = 'ProxyServer') {
    this.serviceName = serviceName;
  }

  _formatMessage(level, message) {
    const timestamp = new Date().toISOString();
    const levelConfig = {
      INFO:  { color: C.green,  icon: '✔' },
      ERROR: { color: C.red,    icon: '✖' },
      WARN:  { color: C.yellow, icon: '⚠' },
      DEBUG: { color: C.cyan,   icon: '●' },
    };
    const cfg = levelConfig[level] || { color: C.white, icon: '·' };
    return `${C.dim}${timestamp}${C.reset} ${cfg.color}${C.bold}${cfg.icon} [${level}]${C.reset} ${C.dim}[${this.serviceName}]${C.reset} ${cfg.color}${message}${C.reset}`;
  }

  info(message)  { console.log(this._formatMessage('INFO', message)); }
  error(message) { console.error(this._formatMessage('ERROR', message)); }
  warn(message)  { console.warn(this._formatMessage('WARN', message)); }
  debug(message) { console.debug(this._formatMessage('DEBUG', message)); }
}

// ═══════════════════════════════════════════════════════════
// 消息队列实现
// ═══════════════════════════════════════════════════════════
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
      clearTimeout(resolver.timeoutId); // 修复：清除超时定时器防止内存泄漏
      resolver.resolve(message);
    } else {
      this.messages.push(message);
    }
  }

  async dequeue(timeoutMs = this.defaultTimeout) {
    if (this.closed) {
      throw new Error('Queue is closed');
    }

    return new Promise((resolve, reject) => {
      if (this.messages.length > 0) {
        resolve(this.messages.shift());
        return;
      }

      const resolver = { resolve, reject };
      this.waitingResolvers.push(resolver);

      const timeoutId = setTimeout(() => {
        const index = this.waitingResolvers.indexOf(resolver);
        if (index !== -1) {
          this.waitingResolvers.splice(index, 1);
          reject(new Error('Queue timeout'));
        }
      }, timeoutMs);

      resolver.timeoutId = timeoutId;
    });
  }

  close() {
    this.closed = true;
    this.waitingResolvers.forEach(resolver => {
      clearTimeout(resolver.timeoutId);
      resolver.reject(new Error('Queue closed'));
    });
    this.waitingResolvers = [];
    this.messages = [];
  }
}

// ═══════════════════════════════════════════════════════════
// WebSocket 连接管理器
// ═══════════════════════════════════════════════════════════
class ConnectionRegistry extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.connections = new Set();
    this.messageQueues = new Map();
  }

  addConnection(websocket, clientInfo) {
    this.connections.add(websocket);
    this.logger.info(`新客户端连接: ${C.cyan}${clientInfo.address}${C.reset}`);

    websocket.on('message', (data) => {
      this._handleIncomingMessage(data.toString());
    });

    websocket.on('close', () => {
      this._removeConnection(websocket);
    });

    websocket.on('error', (error) => {
      this.logger.error(`WebSocket连接错误: ${error.message}`);
    });

    this.emit('connectionAdded', websocket);
  }

  _removeConnection(websocket) {
    this.connections.delete(websocket);
    this.logger.info('客户端连接断开');

    this.messageQueues.forEach(queue => queue.close());
    this.messageQueues.clear();

    this.emit('connectionRemoved', websocket);
  }

  _handleIncomingMessage(messageData) {
    try {
      const parsedMessage = JSON.parse(messageData);
      const requestId = parsedMessage.request_id;

      if (!requestId) {
        this.logger.warn('收到无效消息：缺少request_id');
        return;
      }

      const queue = this.messageQueues.get(requestId);
      if (queue) {
        this._routeMessage(parsedMessage, queue);
      } else {
        this.logger.warn(`收到未知请求ID的消息: ${requestId}`);
      }
    } catch (error) {
      this.logger.error('解析WebSocket消息失败');
    }
  }

  _routeMessage(message, queue) {
    const { event_type } = message;

    switch (event_type) {
      case 'response_headers':
      case 'chunk':
      case 'error':
        queue.enqueue(message);
        break;
      case 'stream_close':
        queue.enqueue({ type: 'STREAM_END' });
        break;
      default:
        this.logger.warn(`未知的事件类型: ${event_type}`);
    }
  }

  hasActiveConnections() {
    return this.connections.size > 0;
  }

  getFirstConnection() {
    return this.connections.values().next().value;
  }

  createMessageQueue(requestId) {
    const queue = new MessageQueue();
    this.messageQueues.set(requestId, queue);
    return queue;
  }

  removeMessageQueue(requestId) {
    const queue = this.messageQueues.get(requestId);
    if (queue) {
      queue.close();
      this.messageQueues.delete(requestId);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 请求处理器 — 支持流式/非流式自动路由
// ═══════════════════════════════════════════════════════════
class RequestHandler {
  constructor(connectionRegistry, logger) {
    this.connectionRegistry = connectionRegistry;
    this.logger = logger;
  }

  async processRequest(req, res) {
    const isStreaming = this._isStreamingRequest(req);
    const startTime = Date.now();

    this.logger.info(
      `处理请求: ${C.bold}${req.method}${C.reset} ${req.path} ` +
      `[${isStreaming ? `${C.cyan}流式${C.reset}` : `${C.yellow}非流式${C.reset}`}]`
    );

    if (!this.connectionRegistry.hasActiveConnections()) {
      return this._sendErrorResponse(res, 503, '没有可用的浏览器连接');
    }

    const requestId = this._generateRequestId();
    const proxyRequest = this._buildProxyRequest(req, requestId);
    const messageQueue = this.connectionRegistry.createMessageQueue(requestId);

    try {
      await this._forwardRequest(proxyRequest);

      if (isStreaming) {
        await this._handleStreamingResponse(messageQueue, res);
      } else {
        await this._handleNonStreamingResponse(messageQueue, res);
      }

      const duration = Date.now() - startTime;
      this.logger.info(
        `请求完成: ${requestId} [${duration}ms]`
      );
    } catch (error) {
      this._handleRequestError(error, res);
    } finally {
      this.connectionRegistry.removeMessageQueue(requestId);
    }
  }

  // ── 流式请求检测 ──────────────────────────────────────
  _isStreamingRequest(req) {
    // 1. 查询参数 alt=sse (Gemini REST API 流式标志)
    if (req.query && req.query.alt === 'sse') {
      return true;
    }

    // 2. 请求体 stream: true (OpenAI 兼容格式)
    if (req.body && req.body.stream === true) {
      return true;
    }

    // 3. 路径包含流式端点标识
    const path = req.path || '';
    if (path.includes('streamGenerateContent') || path.includes('streamPredict')) {
      return true;
    }

    return false;
  }

  _generateRequestId() {
    return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  _buildProxyRequest(req, requestId) {
    let requestBody = '';
    if (req.body) {
      if (typeof req.body === 'string') {
        requestBody = req.body;
      } else if (Buffer.isBuffer(req.body)) {
        requestBody = req.body.toString('utf-8');
      } else {
        requestBody = JSON.stringify(req.body);
      }
    }

    return {
      path: req.path,
      method: req.method,
      headers: req.headers,
      query_params: req.query,
      body: requestBody,
      request_id: requestId
    };
  }

  async _forwardRequest(proxyRequest) {
    const connection = this.connectionRegistry.getFirstConnection();
    connection.send(JSON.stringify(proxyRequest));
  }

  // ── 流式响应处理 ──────────────────────────────────────
  async _handleStreamingResponse(messageQueue, res) {
    const headerMessage = await messageQueue.dequeue();

    if (headerMessage.event_type === 'error') {
      return this._sendErrorResponse(res, headerMessage.status || 500, headerMessage.message);
    }

    // 设置响应头
    this._setResponseHeaders(res, headerMessage);

    // SSE 专属头信息
    const contentType = headerMessage.headers?.['content-type'] ||
                        headerMessage.headers?.['Content-Type'] || '';
    const isSSE = contentType.includes('text/event-stream');

    if (isSSE) {
      res.set('Cache-Control', 'no-cache');
      res.set('Connection', 'keep-alive');
      res.set('X-Accel-Buffering', 'no');
    }

    // 立即刷新头信息，客户端可尽早知道响应已开始
    res.flushHeaders();

    // 流式传输循环
    let consecutiveTimeouts = 0;
    const MAX_KEEPALIVE = 120; // 最多连续 120 次超时 (约 1 小时)

    while (true) {
      try {
        // 流式用较短超时，便于及时发送 keepalive
        const dataMessage = await messageQueue.dequeue(30000);

        if (dataMessage.type === 'STREAM_END') {
          break;
        }

        consecutiveTimeouts = 0;

        if (dataMessage.data) {
          const payload = typeof dataMessage.data === 'string'
            ? dataMessage.data
            : String(dataMessage.data);
          res.write(payload);
        }
      } catch (error) {
        if (error.message === 'Queue timeout') {
          consecutiveTimeouts++;

          if (isSSE && consecutiveTimeouts <= MAX_KEEPALIVE) {
            // SSE keepalive 注释
            res.write(': keepalive\n\n');
          } else {
            // 非 SSE 或超过最大 keepalive 次数，终止
            this.logger.warn('流式响应超时，终止连接');
            break;
          }
        } else {
          throw error;
        }
      }
    }

    res.end();
  }

  // ── 非流式响应处理 ────────────────────────────────────
  async _handleNonStreamingResponse(messageQueue, res) {
    const headerMessage = await messageQueue.dequeue();

    if (headerMessage.event_type === 'error') {
      return this._sendErrorResponse(res, headerMessage.status || 500, headerMessage.message);
    }

    // 收集所有数据块
    const chunks = [];

    while (true) {
      try {
        const dataMessage = await messageQueue.dequeue();

        if (dataMessage.type === 'STREAM_END') {
          break;
        }

        if (dataMessage.data) {
          chunks.push(
            typeof dataMessage.data === 'string'
              ? dataMessage.data
              : String(dataMessage.data)
          );
        }
      } catch (error) {
        if (error.message === 'Queue timeout') {
          this.logger.warn('非流式响应等待超时，提前结束');
          break;
        } else {
          throw error;
        }
      }
    }

    // 组装完整响应体
    const responseBody = chunks.join('');

    // 设置响应头
    this._setResponseHeaders(res, headerMessage);

    // 移除可能导致冲突的头
    res.removeHeader('Transfer-Encoding');

    // 发送完整响应（express 自动设置 Content-Length）
    res.send(responseBody);
  }

  _setResponseHeaders(res, headerMessage) {
    res.status(headerMessage.status || 200);

    const headers = headerMessage.headers || {};
    Object.entries(headers).forEach(([name, value]) => {
      try {
        res.set(name, value);
      } catch (e) {
        // 跳过不合法的头信息
      }
    });
  }

  _handleRequestError(error, res) {
    if (error.message === 'Queue timeout') {
      this._sendErrorResponse(res, 504, '请求超时');
    } else {
      this.logger.error(`请求处理错误: ${error.message}`);
      this._sendErrorResponse(res, 500, `代理错误: ${error.message}`);
    }
  }

  _sendErrorResponse(res, status, message) {
    if (!res.headersSent) {
      res.status(status).json({
        error: { code: status, message }
      });
    } else {
      res.end();
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 主服务器类
// ═══════════════════════════════════════════════════════════
class ProxyServerSystem extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      httpPort: 8889,
      wsPort: 9998,
      host: '0.0.0.0',
      ...config
    };

    this.logger = new LoggingService('ProxyServer');
    this.connectionRegistry = new ConnectionRegistry(this.logger);
    this.requestHandler = new RequestHandler(this.connectionRegistry, this.logger);

    this.httpServer = null;
    this.wsServer = null;
  }

  async start() {
    try {
      await this._startHttpServer();
      await this._startWebSocketServer();

      this._printStartupBanner();
      this.emit('started');
    } catch (error) {
      this.logger.error(`启动失败: ${error.message}`);
      this.emit('error', error);
      throw error;
    }
  }

  // ── 花里胡哨的启动横幅 ────────────────────────────────
  _printStartupBanner() {
    const { httpPort, wsPort, host } = this.config;
    const W = 62;

    const pad = (str, len) => {
      // 去除 ANSI 控制码后计算可见宽度
      const visible = str.replace(/\x1b\[[0-9;]*m/g, '');
      const padLen = Math.max(0, len - visible.length);
      return str + ' '.repeat(padLen);
    };

    const row = (content) => {
      return `${C.cyan}║${C.reset} ${pad(content, W - 2)} ${C.cyan}║${C.reset}`;
    };

    const top    = `${C.cyan}╔${'═'.repeat(W)}╗${C.reset}`;
    const bottom = `${C.cyan}╚${'═'.repeat(W)}╝${C.reset}`;
    const empty  = row('');

    console.log('');
    console.log(top);
    console.log(empty);

    // ── 标题 ──
    const titleArt = [
      '  ██████╗ ██████╗ ███╗   ██╗███████╗██╗███╗   ██╗███████╗',
      '  ██╔════╝██╔═══██╗████╗  ██║██╔════╝██║████╗  ██║██╔════╝',
      '  ██║     ██║   ██║██╔██╗ ██║█████╗  ██║██╔██╗ ██║█████╗  ',
      '  ██║     ██║   ██║██║╚██╗██║██╔══╝  ██║██║╚██╗██║██╔══╝  ',
      '  ╚██████╗╚██████╔╝██║ ╚████║██║     ██║██║ ╚████║███████╗',
      '   ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝     ╚═╝╚═╝  ╚═══╝╚══════╝',
    ];

    titleArt.forEach(line => {
      console.log(row(`${C.magenta}${C.bold}${line}${C.reset}`));
    });

    console.log(empty);

    // ── 副标题 ──
    const subtitle = `${C.yellow}${C.bold}⚡ Tracy Proxy Server${C.reset}  ${C.dim}v2.0${C.reset}`;
    console.log(row(subtitle));

    const features = `${C.green}Stream-Ready${C.reset} ${C.dim}•${C.reset} ${C.green}Auto-Routing${C.reset} ${C.dim}•${C.reset} ${C.green}Zero-Config${C.reset}`;
    console.log(row(features));

    console.log(empty);

    // ── 分隔线 ──
    console.log(row(`${C.dim}${'─'.repeat(W - 2)}${C.reset}`));
    console.log(empty);

    // ── 端点信息 ──
    console.log(row(`${C.white}${C.bold}📡  Endpoints${C.reset}`));
    console.log(row(`    HTTP        ${C.green}http://${host}:${httpPort}${C.reset}`));
    console.log(row(`    WebSocket   ${C.green}ws://${host}:${wsPort}${C.reset}`));

    console.log(empty);

    // ── 模型列表 ──
    console.log(row(`${C.white}${C.bold}🤖  Available Models${C.reset}`));
    console.log(row(`    ${C.magenta}├─${C.reset} ${C.yellow}gemini-3.1-pro-preview${C.reset}  ${C.dim}(Default)${C.reset}`));
    console.log(row(`    ${C.magenta}└─${C.reset} ${C.yellow}gemini-3.5-pro-preview${C.reset}`));

    console.log(empty);

    // ── 状态 ──
    const status = `${C.bgGreen}${C.black}${C.bold} RUNNING ${C.reset}  ${C.dim}Ready to accept connections${C.reset}`;
    console.log(row(status));

    console.log(empty);
    console.log(bottom);
    console.log('');
  }

  async _startHttpServer() {
    const app = this._createExpressApp();
    this.httpServer = http.createServer(app);

    return new Promise((resolve) => {
      this.httpServer.listen(this.config.httpPort, this.config.host, () => {
        resolve();
      });
    });
  }

  _createExpressApp() {
    const app = express();

    // 中间件配置
    app.use(express.json({ limit: '100mb' }));
    app.use(express.urlencoded({ extended: true, limit: '100mb' }));
    app.use(express.raw({ limit: '100mb' }));

    // ── 模型列表路由 ──
    const modelsHandler = (req, res) => {
      res.json({
        "models": [
          {
            "name": "gemini-3.1-pro-preview",
            "displayName": "gemini-3.1-pro-preview"
          },
          {
            "name": "gemini-3.5-pro-preview",
            "displayName": "gemini-3.5-pro-preview"
          }
        ]
      });
    };

    app.get('/v1beta/models', modelsHandler);
    app.get('/v1/models', modelsHandler);
    app.get('/models', modelsHandler);

    // ── 健康检查 ──
    app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        connections: this.connectionRegistry.connections.size,
        uptime: process.uptime(),
      });
    });

    // ── 所有其他路由由请求处理器处理 ──
    app.all(/(.*)/, (req, res) => this.requestHandler.processRequest(req, res));

    return app;
  }

  async _startWebSocketServer() {
    this.wsServer = new WebSocket.Server({
      port: this.config.wsPort,
      host: this.config.host
    });

    this.wsServer.on('connection', (ws, req) => {
      this.connectionRegistry.addConnection(ws, {
        address: req.socket.remoteAddress
      });
    });
  }
}

// ═══════════════════════════════════════════════════════════
// 启动函数
// ═══════════════════════════════════════════════════════════
async function initializeServer() {
  const serverSystem = new ProxyServerSystem();

  try {
    await serverSystem.start();
  } catch (error) {
    console.error(`${C.red}${C.bold}✖ 服务器启动失败:${C.reset}`, error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  initializeServer();
}

module.exports = { ProxyServerSystem, initializeServer };
