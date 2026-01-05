/**
 * 🌸 TRACY SERVER - Sakura Edition 🌸
 * Build 1.6 | 纯净 Pro 版
 * Fixed: 剔除 Chatbox 工具箱参数 (tools), 保持真实模型名, 修复 400 报错
 */

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { EventEmitter } = require('events');

// ==========================================
// 🎨 调色板
// ==========================================
const C = {
  RESET: "\x1b[0m", PINK: "\x1b[38;5;213m", PURPLE: "\x1b[38;5;141m", 
  CYAN: "\x1b[38;5;117m", YELLOW: "\x1b[38;5;228m", GRAY: "\x1b[90m"
};

function drawBanner(httpPort, wsPort) {
  console.clear();
  console.log(`${C.PINK}╭──────────────────────────────────────────────────╮${C.RESET}`);
  console.log(`${C.PINK}│   ${C.PURPLE}✨ TRACY SERVER v1.6 (Pure Proxy)${C.PINK}            │${C.RESET}`);
  console.log(`${C.PINK}│   ${C.CYAN}💎 真实模型透传 | 🚫 自动剔除 Tools/联网参数${C.PINK}   │${C.RESET}`);
  console.log(`${C.PINK}╰──────────────────────────────────────────────────╯${C.RESET}`);
  console.log(`${C.GRAY}HTTP: ${httpPort} | WS: ${wsPort}${C.RESET}\n`);
}

// ==========================================
// 🚀 核心请求处理 (修改重点)
// ==========================================
class RequestHandler {
  constructor(registry, logger) { this.registry = registry; this.logger = logger; }

  async processRequest(req, res) {
    if (!this.registry.hasActiveConnections()) {
      return res.status(503).json({ error: { message: "Tracy 网页端未连接" } });
    }

    // 💎 1. 真实模型透传：完全保留 Chatbox 传来的模型路径
    // 即使你填 gemini-2.5-pro (虽然官方没这号，可能是1.5或2.0)，这里也原样转发，绝不修改。
    const targetPath = req.path;
    
    // 生成请求ID
    const requestId = `${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    
    // 构建清洗后的请求
    const proxyReq = this._buildProxyRequest(req, requestId, targetPath);
    const queue = this.registry.createMessageQueue(requestId);
    
    try {
      this.registry.getFirstConnection().send(JSON.stringify(proxyReq));
      await this._handleResponse(queue, res, req);
    } catch (e) {
      if(!res.headersSent) res.status(500).json({ error: { message: e.message } });
    } finally {
      this.registry.removeMessageQueue(requestId);
    }
  }

  _buildProxyRequest(req, requestId, targetPath) {
    let bodyObj = {};
    if (req.body) {
        try {
            bodyObj = typeof req.body === 'object' ? req.body : JSON.parse(req.body.toString());
        } catch (e) {}
    }

    // ======================================================
    // 🧹 深度清洗区 (Fix 400 Root Cause)
    // ======================================================

    // 1. 🚫 剔除 Tools (Chatbox 工具箱/联网搜索)
    // 这是导致 Gemini 3 Pro 报错 400 的核心原因
    if (bodyObj.tools) {
        console.log(`${C.YELLOW}⚠️ 检测到 Tools/联网参数，已剔除以防止 400 报错${C.RESET}`);
        delete bodyObj.tools;
    }

    // 2. 🔪 剔除 SafetySettings
    // 防止因权限不足导致的 400
    if (bodyObj.safetySettings) {
        delete bodyObj.safetySettings;
    }
    
    // 3. 🧹 清理 generationConfig 中的杂项
    // 有时候 Chatbox 会传一些旧参数
    if (bodyObj.generationConfig) {
        // 如果这里面有不支持的参数也可以在这里删
        // delete bodyObj.generationConfig; // 暂时保留，通常只清理 tools 就够了
    }

    return { 
        path: targetPath, 
        method: req.method, 
        headers: req.headers, 
        query_params: req.query, 
        body: JSON.stringify(bodyObj), 
        request_id: requestId 
    };
  }

  // ... (下方的 WebSocket 处理逻辑保持最稳的 Build 1.5 版本) ...
  
  async _handleResponse(queue, res, req) {
    const head = await queue.dequeue();
    if (head.event_type === 'error') return res.status(head.status||500).json({error:{message:head.message}});

    res.status(head.status || 200);
    Object.entries(head.headers || {}).forEach(([k, v]) => {
      if (!['content-length', 'transfer-encoding'].includes(k.toLowerCase())) res.set(k, v);
    });

    if (head.headers && head.headers['content-type'] && head.headers['content-type'].includes('event-stream')) {
        while(true) {
            const msg = await queue.dequeue();
            if (msg.type === 'STREAM_END') break;
            if (msg.data) res.write(msg.data);
        }
        res.end();
    } else {
        const parts = [];
        while(true) {
            const msg = await queue.dequeue();
            if (msg.type === 'STREAM_END') break;
            if (msg.data) parts.push(msg.data);
        }
        const full = parts.join('');
        if (req.path.includes('/chat/completions')) {
            try { res.json(this._toOpenAI(JSON.parse(full))); } catch(e) { res.send(full); }
        } else {
            res.send(full);
        }
    }
  }

  _toOpenAI(g) {
    return {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now()/1000),
        model: "gemini-pro-real",
        choices: (g.candidates||[]).map((c,i)=>({
            index: c.index??i,
            message: { role: "assistant", content: (c.content?.parts||[]).map(p=>p.text).join("") },
            finish_reason: "stop"
        }))
    };
  }
}

// ==========================================
// 🔗 连接与系统
// ==========================================
class ConnectionRegistry {
    constructor() { this.conns = new Set(); this.qs = new Map(); }
    add(ws) { this.conns.add(ws); ws.on('message', d=>this.msg(d)); ws.on('close', ()=>this.conns.delete(ws)); }
    msg(d) { try{const m=JSON.parse(d); if(m.request_id && this.qs.has(m.request_id)) this.qs.get(m.request_id).enqueue(m);}catch(e){} }
    createMessageQueue(id) { const q = new MessageQueue(); this.qs.set(id, q); return q; }
    removeMessageQueue(id) { if(this.qs.has(id)) { this.qs.get(id).close(); this.qs.delete(id); } }
    hasActiveConnections() { return this.conns.size > 0; }
    getFirstConnection() { return this.conns.values().next().value; }
}

class MessageQueue {
    constructor() { this.q=[]; this.w=[]; this.closed=false; }
    enqueue(m) { if(this.w.length) this.w.shift()(m); else this.q.push(m); }
    dequeue() { return new Promise((r,j)=> { if(this.q.length) r(this.q.shift()); else this.w.push(r); }); }
    close() { this.closed=true; }
}

const app = express();
app.use(express.json({limit:'50mb'})); 
app.use(express.raw({type:'*/*', limit:'50mb'}));
app.use((req,r,n)=>{r.set({'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'}); if(req.method==='OPTIONS')r.sendStatus(200);else n();});

const logger = { log: console.log };
const registry = new ConnectionRegistry();
const handler = new RequestHandler(registry, logger);

app.all('*', (req, res) => handler.processRequest(req, res));

const server = http.createServer(app);
const wss = new WebSocket.Server({ port: 9998 }); 
wss.on('connection', ws => registry.add(ws));

server.listen(8889, () => drawBanner(8889, 9998));
