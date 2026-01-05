/**
 * 🌸 TRACY SERVER - Sakura Edition 🌸
 * Build 1.8 | Experimental Injector
 * Features: 强制注入 BLOCK_NONE (越狱模式) + 剔除 Tools
 */

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { EventEmitter } = require('events');

// ==========================================
// 🎨 1. 界面与颜色配置
// ==========================================
const C = {
  RESET: "\x1b[0m", PINK: "\x1b[38;5;213m", PURPLE: "\x1b[38;5;141m", 
  CYAN: "\x1b[38;5;117m", YELLOW: "\x1b[38;5;228m", WHITE: "\x1b[37m", GRAY: "\x1b[90m"
};

function drawBanner(httpPort, wsPort) {
  console.clear();
  const width = 52;
  const line = "─".repeat(width);
  const center = (text) => {
    const pad = Math.max(0, Math.floor((width - text.length) / 2));
    return " ".repeat(pad) + text + " ".repeat(Math.max(0, width - text.length - pad));
  };

  console.log(`${C.PINK}╭${line}╮`);
  console.log(`│${" ".repeat(width)}│`);
  console.log(`│${C.BRIGHT}${C.PURPLE}${center("✨ TRACY SERVER ✨")}${C.PINK}│`);
  console.log(`│${C.CYAN}${center("Build 1.8 (Injector Mode)")}${C.PINK}│`);
  console.log(`│${" ".repeat(width)}│`);
  console.log(`├${line}┤`);
  console.log(`│ ${C.YELLOW}🎀 HTTP Port${C.PINK} : ${C.WHITE}${httpPort.toString().padEnd(30)}${C.PINK} │`);
  console.log(`│ ${C.CYAN}🌸 WS   Port${C.PINK} : ${C.WHITE}${wsPort.toString().padEnd(30)}${C.PINK} │`);
  console.log(`╰${line}╯${C.RESET}\n`);
}

// ==========================================
// 📝 2. 日志服务
// ==========================================
class LoggingService {
  constructor(serviceName = 'System') { this.serviceName = serviceName; }
  _log(emoji, label, color, message) { 
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`${C.GRAY}[${time}]${C.RESET} ${emoji} ${color}${label}${C.RESET} ${message}`);
  }
  info(message) { this._log('✨', 'INFO', C.CYAN, message); }
  error(message) { this._log('💔', 'ERR ', C.PINK, message); }
  warn(message) { this._log('💡', 'WARN', C.YELLOW, message); }
  req(method, path, ip) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`${C.GRAY}[${time}]${C.RESET} 💌 ${C.PURPLE}${method}${C.RESET} ${path} ${C.GRAY}from ${ip}${C.RESET}`);
  }
}

// ==========================================
// 📨 3. 消息队列 & 连接管理
// ==========================================
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
    this.connections.add(websocket);
    this.logger.info(`网页端已接入 | IP: ${clientInfo.address} | 在线: ${this.connections.size}`);
    websocket.on('message', (data) => { this._handleIncomingMessage(data.toString()); });
    websocket.on('close', () => { this._removeConnection(websocket); });
    websocket.on('error', (error) => { this.logger.error(`WS连接错误: ${error.message}`); });
    this.emit('connectionAdded', websocket);
  }

  _removeConnection(websocket) {
    this.connections.delete(websocket);
    this.logger.warn(`网页端已断开 | 在线: ${this.connections.size}`);
    this.messageQueues.forEach(queue => queue.close()); this.messageQueues.clear();
    this.emit('connectionRemoved', websocket);
  }

  _handleIncomingMessage(messageData) {
    try {
      const parsedMessage = JSON.parse(messageData); const requestId = parsedMessage.request_id;
      if (!requestId) { return; }
      const queue = this.messageQueues.get(requestId);
      if (queue) { this._routeMessage(parsedMessage, queue); }
    } catch (error) { this.logger.error('WS消息解析失败'); }
  }

  _routeMessage(message, queue) {
    const { event_type } = message;
    switch (event_type) {
      case 'response_headers': case 'chunk': case 'error': queue.enqueue(message); break;
      case 'stream_close': queue.enqueue({ type: 'STREAM_END' }); break;
      default: break; 
    }
  }

  hasActiveConnections() { return this.connections.size > 0; }
  getFirstConnection() { return this.connections.values().next().value; }
  createMessageQueue(requestId) { const queue = new MessageQueue(); this.messageQueues.set(requestId, queue); return queue; }
  removeMessageQueue(requestId) { const queue = this.messageQueues.get(requestId); if (queue) { queue.close(); this.messageQueues.delete(requestId); } }
}

// ==========================================
// 🚀 4. 请求处理器 (核心修改区)
// ==========================================
class RequestHandler {
  constructor(connectionRegistry, logger) {
    this.connectionRegistry = connectionRegistry;
    this.logger = logger;
  }

  async processRequest(req, res) {
    const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    this.logger.req(req.method, req.path, clientIP);

    if (!this.connectionRegistry.hasActiveConnections()) {
      return this._sendErrorResponse(res, 503, 'Tracy Error: 网页端未连接');
    }

    const requestId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
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

  // 🛡️ [构建请求]：保留 BLOCK_NONE 注入
  _buildProxyRequest(req, requestId) {
    let requestBody = '';
    if (req.body && Object.keys(req.body).length > 0) {
      let bodyObject;
      try {
        bodyObject = typeof req.body === 'object' && !Buffer.isBuffer(req.body)
          ? { ...req.body }
          : JSON.parse(req.body.toString());

        // ❌ 1. 剔除 Tools (防止 Chatbox Grounding 报错)
        if (bodyObject.tools) {
            console.log(`${C.YELLOW}⚠️  已剔除 Tools 参数 (防止 400)${C.RESET}`);
            delete bodyObject.tools;
        }

        // ✅ 2. 强制注入 BLOCK_NONE (实验性越狱)
        // 即使 Chatbox 没传，或者传了别的，这里强制覆盖为“无视安全规则”
        bodyObject.safetySettings = [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
        ];
        
        // ❌ 3. 剔除 Stream 标记
        if (bodyObject.hasOwnProperty('stream')) { delete bodyObject.stream; }

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
    const headerMessage = await messageQueue.dequeue();

    if (headerMessage.event_type === 'error') {
      return this._sendErrorResponse(res, headerMessage.status || 500, headerMessage.message);
    }

    let isStreaming = false;
    try {
      if (req.body) {
        const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body.toString());
        isStreaming = body.stream === true;
      }
      if (!isStreaming) isStreaming = req.path.toLowerCase().includes('stream');
    } catch (e) { isStreaming = req.path.toLowerCase().includes('stream'); }

    if (isStreaming) {
      this.logger.info(`模式: 🌊 Stream | 路径: ${req.path}`);
      this._setResponseHeaders(res, headerMessage);
      await this._streamResponseData(messageQueue, res);
    } else {
      this.logger.info(`模式: 📦 Buffer | 路径: ${req.path}`);
      await this._aggregateAndSendResponse(messageQueue, res, req);
    }
  }

  _setResponseHeaders(res, headerMessage) {
    res.status(headerMessage.status || 200);
    const headers = headerMessage.headers || {};
    Object.entries(headers).forEach(([name, value]) => {
      if (!['transfer-encoding', 'content-length'].includes(name.toLowerCase())) {
        res.set(name, value);
      }
    });
  }

  async _streamResponseData(messageQueue, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    while (true) {
      try {
        const dataMessage = await messageQueue.dequeue();
        if (dataMessage.type === 'STREAM_END') break;
        if (dataMessage.data) res.write(dataMessage.data);
      } catch (error) {
        if (error.message === 'Queue timeout') {
            res.write(': keepalive\n\n');
        } else { throw error; }
      }
    }
    res.end();
  }

  _mapFinishReason(geminiReason) {
    if (!geminiReason) return null;
    switch (geminiReason) {
      case "STOP": return "stop";
      case "MAX_TOKENS": return "length";
      case "SAFETY": case "RECITATION": return "content_filter";
      default: return null;
    }
  }

  _transformGeminiToOpenAI(geminiResponse) {
    const candidates = geminiResponse.candidates || [];
    const choices = candidates.map((candidate, index) => {
      let role = candidate.content?.role === "model" ? "assistant" : (candidate.content?.role || "assistant");
      const content = (candidate.content?.parts || []).map(part => part.text || "").join("");

      return {
        index: candidate.index ?? index,
        message: { role: role, content: content },
        finish_reason: this._mapFinishReason(candidate.finishReason),
        logprobs: null 
      };
    });

    const responseData = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "gemini-pro-injector",
      choices: choices
    };
    return responseData;
  }

  async _aggregateAndSendResponse(messageQueue, res, req) {
    const bodyParts = [];
    while (true) {
      try {
        const dataMessage = await messageQueue.dequeue();
        if (dataMessage.type === 'STREAM_END') break;
        if (dataMessage.data) bodyParts.push(dataMessage.data);
      } catch (error) { throw error; }
    }
    
    const fullBody = bodyParts.join('');
    try {
      if (req.path.includes('/chat/completions')) {
        const geminiJson = JSON.parse(fullBody);
        const openaiJson = this._transformGeminiToOpenAI(geminiJson);
        res.json(openaiJson);
      } else {
        res.set('Content-Type', 'application/json');
        res.send(fullBody);
      }
    } catch (e) {
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
    } else { res.end(); }
  }

  _sendErrorResponse(res, status, message) {
    if (!res.headersSent) { res.status(status).send({ error: { message, type: 'tracy_server_error' } }); }
  }
}

// ==========================================
// 5. 主系统启动
// ==========================================
class ProxyServerSystem extends EventEmitter {
  constructor(config = {}) {
    super(); 
    this.config = { httpPort: 8889, wsPort: 9998, host: '0.0.0.0', ...config };
    this.logger = new LoggingService(); 
    this.connectionRegistry = new ConnectionRegistry(this.logger);
    this.requestHandler = new RequestHandler(this.connectionRegistry, this.logger);
  }
  
  async start() {
    drawBanner(this.config.httpPort, this.config.wsPort);
    try {
      await this._startHttpServer(); 
      await this._startWebSocketServer();
      this.logger.info(`${C.GREEN}Tracy Server 启动成功，等待连接...${C.RESET}`);
    } catch (error) { 
      this.logger.error(`启动失败: ${error.message}`); 
      process.exit(1); 
    }
  }

  async _startHttpServer() {
    const app = express();
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', '*');
      res.header('Access-Control-Allow-Headers', '*');
      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });

    app.use(express.json({ limit: '100mb' })); 
    app.use(express.urlencoded({ extended: true, limit: '100mb' }));
    app.use(express.raw({ limit: '100mb', type: '*/*' }));
    
    app.all(/(.*)/, (req, res) => this.requestHandler.processRequest(req, res));
    
    this.httpServer = http.createServer(app);
    return new Promise((resolve) => this.httpServer.listen(this.config.httpPort, this.config.host, resolve));
  }

  async _startWebSocketServer() {
    this.wsServer = new WebSocket.Server({ port: this.config.wsPort, host: this.config.host });
    this.wsServer.on('connection', (ws, req) => { 
      this.connectionRegistry.addConnection(ws, { address: req.socket.remoteAddress }); 
    });
  }
}

if (require.main === module) { 
  new ProxyServerSystem().start(); 
}
module.exports = { ProxyServerSystem };
