/**
 * TRACY SERVER - Build 1.1 (Fixed)
 * Optimized for Termux & Cloudflare Tunnel
 * Fixes: Safety Settings, Stream Detection, Timeout Issues
 */

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { EventEmitter } = require('events');

// ==========================================
// 界面与颜色配置 (UI & Colors)
// ==========================================
const C = {
  RESET: "\x1b[0m",
  BRIGHT: "\x1b[1m",
  DIM: "\x1b[2m",
  RED: "\x1b[31m",
  GREEN: "\x1b[32m",
  YELLOW: "\x1b[33m",
  BLUE: "\x1b[34m",
  MAGENTA: "\x1b[35m",
  CYAN: "\x1b[36m",
  WHITE: "\x1b[37m",
};

function drawBanner(httpPort, wsPort) {
  console.clear();
  const width = 50;
  const line = "═".repeat(width);
  const space = " ".repeat(width);
  const center = (text) => {
    const pad = Math.floor((width - text.length) / 2);
    return " ".repeat(pad) + text + " ".repeat(width - text.length - pad);
  };
  console.log(`${C.CYAN}╔${line}╗`);
  console.log(`║${space}║`);
  console.log(`║${C.BRIGHT}${C.MAGENTA}${center("TRACY SERVER")}${C.CYAN}║`);
  console.log(`║${C.RESET}${C.DIM}${center("Build 1.1 (Fixed)")}${C.CYAN}║`);
  console.log(`║${space}║`);
  console.log(`╠${line}╣`);
  console.log(`║${space}║`);
  console.log(`║${C.GREEN}   HTTP Port : ${C.WHITE}${httpPort.toString().padEnd(31)}${C.CYAN}║`);
  console.log(`║${C.YELLOW}   WS Port   : ${C.WHITE}${wsPort.toString().padEnd(31)}${C.CYAN}║`);
  console.log(`║${space}║`);
  console.log(`╚${line}╝${C.RESET}\n`);
}

// ==========================================
// 基础服务类
// ==========================================
class LoggingService {
  constructor(serviceName = 'System') { this.serviceName = serviceName; }
  _log(level, color, message) { 
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`${C.DIM}[${timestamp}]${C.RESET} ${color}[${level}]${C.RESET} ${message}`);
  }
  info(message) { this._log('INFO', C.GREEN, message); }
  error(message) { this._log('ERR ', C.RED, message); }
  warn(message) { this._log('WARN', C.YELLOW, message); }
  debug(message) { this._log('DBUG', C.BLUE, message); }
  req(method, path, ip) {
    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`${C.DIM}[${timestamp}]${C.RESET} ${C.MAGENTA}[REQ ]${C.RESET} ${C.BRIGHT}${method}${C.RESET} ${path} ${C.DIM}from ${ip}${C.RESET}`);
  }
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
    this.connections.add(websocket);
    this.logger.info(`Web端已接入 | IP: ${clientInfo.address} | 在线: ${this.connections.size}`);
    websocket.on('message', (data) => { this._handleIncomingMessage(data.toString()); });
    websocket.on('close', () => { this._removeConnection(websocket); });
    websocket.on('error', (error) => { this.logger.error(`WS连接错误: ${error.message}`); });
    this.emit('connectionAdded', websocket);
  }

  _removeConnection(websocket) {
    this.connections.delete(websocket);
    this.logger.warn(`Web端已断开 | 在线: ${this.connections.size}`);
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
// 请求处理器 (核心逻辑 - 已修复)
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
      return this._sendErrorResponse(res, 503, 'Tracy Error: 没有可用的Web端连接，请检查浏览器是否已连接WS。');
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

  // 🛡️ 修复1：强行注入安全设置 (BLOCK_NONE)
  _buildProxyRequest(req, requestId) {
    let requestBody = '';
    if (req.body && Object.keys(req.body).length > 0) {
      let bodyObject;
      try {
        bodyObject = typeof req.body === 'object' && !Buffer.isBuffer(req.body)
          ? { ...req.body }
          : JSON.parse(req.body.toString());

        // 注入安全设置，防止 400 错误
        bodyObject.safetySettings = [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
        ];

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

  // 🛡️ 修复2：改进流式检测逻辑，防止 100秒超时
  async _handleResponse(messageQueue, res, req) {
    const headerMessage = await messageQueue.dequeue();

    if (headerMessage.event_type === 'error') {
      return this._sendErrorResponse(res, headerMessage.status || 500, headerMessage.message);
    }

    let isStreaming = false;
    try {
      // 检测1: 检查 Body 里的 stream 参数
      if (req.body) {
        const body = typeof req.body === 'object' ? req.body : JSON.parse(req.body.toString());
        isStreaming = body.stream === true;
      }
      // 检测2: 检查 URL 路径里是否包含 stream (针对 Gemini 协议)
      if (!isStreaming) {
        isStreaming = req.path.toLowerCase().includes('stream');
      }
    } catch (e) { 
        // 兜底: 如果解析失败，看路径就行
        isStreaming = req.path.toLowerCase().includes('stream');
    }

    if (isStreaming) {
      this.logger.info(`模式: ${C.CYAN}流式(Stream)${C.RESET} | 路径: ${req.path}`);
      this._setResponseHeaders(res, headerMessage);
      await this._streamResponseData(messageQueue, res);
    } else {
      this.logger.info(`模式: ${C.YELLOW}缓冲(Buffer)${C.RESET} | 路径: ${req.path}`);
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
    // 强制设置流式头，防止客户端不认
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
    if (usage) responseData.usage = usage;
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
// 主系统类
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
    
    // 模型列表接口 (Mock)
    const modelsHandler = (req, res) => { 
      res.json({ "models": [{ "name": "gemini-3-pro-preview", "displayName": "gemini-3-pro-preview", "version": "Tracy" }] }); 
    };
    app.get('/v1beta/models', modelsHandler); 
    app.get('/models', modelsHandler);
    
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
