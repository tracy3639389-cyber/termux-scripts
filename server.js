const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { EventEmitter } = require('events');

// ==========================================
// 基础服务类
// ==========================================

class LoggingService {
  constructor(serviceName = 'ProxyServer') { this.serviceName = serviceName; }
  
  _formatMessage(level, message) { 
    // [修改] 使用北京时间 (CST/UTC+8)
    const timestamp = new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    return `[${level}] ${timestamp} [${this.serviceName}] - ${message}`; 
  }

  info(message) { console.log(this._formatMessage('INFO', message)); }
  error(message) { console.error(this._formatMessage('ERROR', message)); }
  warn(message) { console.warn(this._formatMessage('WARN', message)); }
  debug(message) { console.debug(this._formatMessage('DEBUG', message)); }
}

class MessageQueue extends EventEmitter {
  constructor(timeoutMs = 600000) { super(); this.messages = []; this.waitingResolvers = []; this.defaultTimeout = timeoutMs; this.closed = false; }
  enqueue(message) { if (this.closed) return; if (this.waitingResolvers.length > 0) { this.waitingResolvers.shift().resolve(message); } else { this.messages.push(message); } }
  async dequeue(timeoutMs = this.defaultTimeout) {
    if (this.closed) { throw new Error('Queue is closed'); }
    return new Promise((resolve, reject) => {
      if (this.messages.length > 0) { resolve(this.messages.shift()); return; }
      const resolver = { resolve, reject }; this.waitingResolvers.push(resolver);
      const timeoutId = setTimeout(() => {
        const index = this.waitingResolvers.indexOf(resolver);
        if (index !== -1) { this.waitingResolvers.splice(index, 1); reject(new Error('Queue timeout')); }
      }, timeoutMs);
      resolver.timeoutId = timeoutId;
    });
  }
  close() { this.closed = true; this.waitingResolvers.forEach(resolver => { clearTimeout(resolver.timeoutId); resolver.reject(new Error('Queue closed')); }); this.waitingResolvers = []; this.messages = []; }
}

class ConnectionRegistry extends EventEmitter {
  constructor(logger) { super(); this.logger = logger; this.connections = new Set(); this.messageQueues = new Map(); }
  addConnection(websocket, clientInfo) {
    this.connections.add(websocket); this.logger.info(`新客户端连接: ${clientInfo.address}`);
    websocket.on('message', (data) => { this._handleIncomingMessage(data.toString()); });
    websocket.on('close', () => { this._removeConnection(websocket); });
    websocket.on('error', (error) => { this.logger.error(`WebSocket连接错误: ${error.message}`); });
    this.emit('connectionAdded', websocket);
  }
  _removeConnection(websocket) {
    this.connections.delete(websocket); this.logger.info('客户端连接断开');
    this.messageQueues.forEach(queue => queue.close()); this.messageQueues.clear();
    this.emit('connectionRemoved', websocket);
  }
  _handleIncomingMessage(messageData) {
    try {
      const parsedMessage = JSON.parse(messageData); const requestId = parsedMessage.request_id;
      if (!requestId) { this.logger.warn('收到无效消息：缺少request_id'); return; }
      const queue = this.messageQueues.get(requestId);
      if (queue) { this._routeMessage(parsedMessage, queue); } else { this.logger.warn(`收到未知请求ID的消息: ${requestId}`); }
    } catch (error) { this.logger.error('解析WebSocket消息失败'); }
  }
  _routeMessage(message, queue) {
    const { event_type } = message;
    switch (event_type) {
      case 'response_headers': case 'chunk': case 'error': queue.enqueue(message); break;
      case 'stream_close': queue.enqueue({ type: 'STREAM_END' }); break;
      default: this.logger.warn(`未知的事件类型: ${event_type}`);
    }
  }
  hasActiveConnections() { return this.connections.size > 0; }
  getFirstConnection() { return this.connections.values().next().value; }
  createMessageQueue(requestId) { const queue = new MessageQueue(); this.messageQueues.set(requestId, queue); return queue; }
  removeMessageQueue(requestId) { const queue = this.messageQueues.get(requestId); if (queue) { queue.close(); this.messageQueues.delete(requestId); } }
}

// ==========================================
// 请求处理器
// ==========================================

class RequestHandler {
  constructor(connectionRegistry, logger) {
    this.connectionRegistry = connectionRegistry;
    this.logger = logger;
  }

  async processRequest(req, res) {
    this.logger.info(`处理请求: ${req.method} ${req.path}`);
    if (!this.connectionRegistry.hasActiveConnections()) {
      return this._sendErrorResponse(res, 503, '没有可用的浏览器连接');
    }
    const requestId = this._generateRequestId();
    const proxyRequest = this._buildProxyRequest(req, requestId);
    const messageQueue = this.connectionRegistry.createMessageQueue(requestId);
    
    try {
      await this._forwardRequest(proxyRequest);
      await this._handleResponse(messageQueue, res, req);
    } catch (error) {
      this._handleRequestError(error, res);
    } finally {
      this.connectionRegistry.removeMessageQueue(requestId);
    }
  }

  _generateRequestId() {
    return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  _buildProxyRequest(req, requestId) {
    let requestBody = '';
    if (req.body && Object.keys(req.body).length > 0) {
      let bodyObject;
      try {
        bodyObject = typeof req.body === 'object' && !Buffer.isBuffer(req.body)
          ? { ...req.body }
          : JSON.parse(req.body.toString());
        // 移除 stream 参数
        if (bodyObject.hasOwnProperty('stream')) {
          delete bodyObject.stream;
        }
        requestBody = JSON.stringify(bodyObject);
      } catch (e) {
        requestBody = Buffer.isBuffer(req.body) ? req.body.toString() : String(req.body);
      }
    }
    return {
      path: req.path, method: req.method, headers: req.headers,
      query_params: req.query, body: requestBody, request_id: requestId
    };
  }

  async _forwardRequest(proxyRequest) {
    const connection = this.connectionRegistry.getFirstConnection();
    connection.send(JSON.stringify(proxyRequest));
  }

  async _handleResponse(messageQueue, res, req) {
    // 1. 获取第一个消息（通常是响应头）
    const headerMessage = await messageQueue.dequeue();

    // 如果第一条消息就是错误，直接返回错误
    if (headerMessage.event_type === 'error') {
      return this._sendErrorResponse(res, headerMessage.status || 500, headerMessage.message);
    }

    // 2. 判断客户端是否请求流式
    let isStreaming = false;
    try {
      if (req.body) {
        const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body.toString());
        isStreaming = body.stream === true;
      }
    } catch (e) { /* ignore */ }

    if (isStreaming) {
      // === 流式处理路径 ===
      this.logger.info(`请求 ${req.path} 使用流式输出`);
      // 立刻发送响应头，建立流式连接
      this._setResponseHeaders(res, headerMessage);
      // 开始逐块转发
      await this._streamResponseData(messageQueue, res);
    } else {
      // === 非流式处理路径 ===
      this.logger.info(`请求 ${req.path} 使用非流式输出 (默认)`);
      // 【重要】传入 req，以便在聚合时判断是否需要转换格式
      await this._aggregateAndSendResponse(messageQueue, res, req);
    }
  }

  _setResponseHeaders(res, headerMessage) {
    res.status(headerMessage.status || 200);
    const headers = headerMessage.headers || {};
    Object.entries(headers).forEach(([name, value]) => {
      // 过滤掉可能导致冲突的头
      if (name.toLowerCase() !== 'transfer-encoding' && name.toLowerCase() !== 'content-length') {
        res.set(name, value);
      }
    });
  }

  async _streamResponseData(messageQueue, res) {
    while (true) {
      try {
        const dataMessage = await messageQueue.dequeue();
        if (dataMessage.type === 'STREAM_END') break;
        if (dataMessage.data) res.write(dataMessage.data);
      } catch (error) {
        if (error.message === 'Queue timeout') {
          if ((res.get('Content-Type') || '').includes('text/event-stream')) {
            res.write(': keepalive\n\n');
          } else {
            break;
          }
        } else { throw error; }
      }
    }
    res.end();
  }

  // 辅助方法：OpenAI 兼容性映射 (参考 openai_transfer.py)
  _mapFinishReason(geminiReason) {
    if (!geminiReason) return null;
    switch (geminiReason) {
      case "STOP": return "stop";
      case "MAX_TOKENS": return "length";
      case "SAFETY":
      case "RECITATION": return "content_filter";
      default: return null;
    }
  }

  // 辅助方法：转换为 OpenAI 格式 (参考 openai_transfer.py)
  _transformGeminiToOpenAI(geminiResponse) {
    const choices = [];
    const candidates = geminiResponse.candidates || [];

    candidates.forEach((candidate, index) => {
      let role = candidate.content?.role || "assistant";
      if (role === "model") role = "assistant";

      const parts = candidate.content?.parts || [];
      let content = "";
      parts.forEach(part => {
        if (part.text) {
          content += part.text;
        }
      });

      const message = {
        role: role,
        content: content
      };

      const finishReason = this._mapFinishReason(candidate.finishReason);

      choices.push({
        index: candidate.index ?? index,
        message: message,
        finish_reason: finishReason,
        logprobs: null 
      });
    });

    let usage = null;
    if (geminiResponse.usageMetadata) {
      usage = {
        prompt_tokens: geminiResponse.usageMetadata.promptTokenCount || 0,
        completion_tokens: geminiResponse.usageMetadata.candidatesTokenCount || 0,
        total_tokens: geminiResponse.usageMetadata.totalTokenCount || 0
      };
    }

    const responseData = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "gemini-3-pro-preview",
      choices: choices
    };

    if (usage) {
      responseData.usage = usage;
    }

    return responseData;
  }

  // 核心：聚合响应并根据请求类型决定是否转换
  async _aggregateAndSendResponse(messageQueue, res, req) {
    const bodyParts = [];
    while (true) {
      try {
        const dataMessage = await messageQueue.dequeue();
        if (dataMessage.type === 'STREAM_END') break;
        if (dataMessage.data) bodyParts.push(dataMessage.data);
      } catch (error) {
        this.logger.error(`聚合响应时发生错误: ${error.message}`);
        throw error;
      }
    }
    
    const fullBody = bodyParts.join('');
    
    try {
      // ============================================================
      // 智能判断：是原生 Gemini 请求还是 OpenAI 转换请求？
      // ============================================================
      // 如果路径包含 /chat/completions，说明是 OpenAI 客户端
      const isOpenAIRequest = req.path.includes('/chat/completions');

      if (isOpenAIRequest) {
        this.logger.info("检测到 OpenAI 兼容请求，执行格式转换");
        const geminiJson = JSON.parse(fullBody);
        const openaiJson = this._transformGeminiToOpenAI(geminiJson);
        // res.json 会自动处理 Content-Type: application/json
        res.json(openaiJson);
      } else {
        // 否则，假设是原生 Gemini 请求 (例如 Chatbox 的 GenerateContent)
        this.logger.info("检测到原生 Gemini 请求，原样透传响应");
        // 确保返回 JSON 类型
        res.set('Content-Type', 'application/json');
        // 直接返回原始字符串，不进行任何转换
        res.send(fullBody);
      }
    } catch (e) {
      this.logger.warn(`响应处理失败，按原样发送: ${e.message}`);
      res.send(fullBody);
    }
  }

  _handleRequestError(error, res) {
    if (!res.headersSent) {
      if (error.message === 'Queue timeout') {
        this._sendErrorResponse(res, 504, '请求超时');
      } else {
        this._sendErrorResponse(res, 500, `代理错误: ${error.message}`);
      }
    } else {
        res.end();
    }
  }

  _sendErrorResponse(res, status, message) {
    if (!res.headersSent) {
        res.status(status).send(message);
    }
  }
}

// ==========================================
// 服务器系统类
// ==========================================

class ProxyServerSystem extends EventEmitter {
  constructor(config = {}) {
    super(); this.config = { httpPort: 8889, wsPort: 9998, host: '0.0.0.0', ...config };
    this.logger = new LoggingService('ProxyServer'); this.connectionRegistry = new ConnectionRegistry(this.logger);
    this.requestHandler = new RequestHandler(this.connectionRegistry, this.logger);
    this.httpServer = null; this.wsServer = null;
  }
  async start() {
    try {
      await this._startHttpServer(); await this._startWebSocketServer();
      this.logger.info('代理服务器系统启动完成'); this.emit('started');
    } catch (error) { this.logger.error(`启动失败: ${error.message}`); this.emit('error', error); throw error; }
  }
  async _startHttpServer() {
    const app = this._createExpressApp(); this.httpServer = http.createServer(app);
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.httpPort, this.config.host, () => {
        this.logger.info(`HTTP服务器启动: http://${this.config.host}:${this.config.httpPort}`);
        resolve();
      });
    });
  }
  _createExpressApp() {
    const app = express();
    
    // [CORS 支持] 修复浏览器/Webview 的报错 0 问题
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });

    app.use(express.json({ limit: '100mb' })); app.use(express.urlencoded({ extended: true, limit: '100mb' }));
    app.use(express.raw({ limit: '100mb', type: '*/*' }));
    const modelsHandler = (req, res) => { res.json({ "models": [{ "name": "gemini-3-pro-preview", "displayName": "gemini-3-pro-preview", "version": "Tavo" }] }); };
    app.get('/v1beta/models', modelsHandler); app.get('/models', modelsHandler);
    app.all(/(.*)/, (req, res) => this.requestHandler.processRequest(req, res));
    return app;
  }
  async _startWebSocketServer() {
    this.wsServer = new WebSocket.Server({ port: this.config.wsPort, host: this.config.host });
    this.wsServer.on('connection', (ws, req) => { this.connectionRegistry.addConnection(ws, { address: req.socket.remoteAddress }); });
    this.logger.info(`WebSocket服务器启动: ws://${this.config.host}:${this.config.wsPort}`);
  }
}

async function initializeServer() {
  const serverSystem = new ProxyServerSystem();
  try { await serverSystem.start(); } catch (error) { console.error('服务器启动失败:', error.message); process.exit(1); }
}

if (require.main === module) { initializeServer(); }
module.exports = { ProxyServerSystem, initializeServer };
