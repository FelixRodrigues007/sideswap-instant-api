const express = require('express');
const WebSocket = require('ws');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const app = express();

// Configurações do ambiente
const HTTP_PORT = process.env.HTTP_PORT || 3000;
const HTTP_HOST = process.env.HTTP_HOST || '0.0.0.0';
const HETZNER_IP = process.env.HETZNER_IP || '127.0.0.1';
const WS_PORT = process.env.WS_PORT || 7777;
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 35000;
const QUOTE_REQUEST_TIMEOUT = parseInt(process.env.QUOTE_REQUEST_TIMEOUT) || 35000;
const QUOTE_RETRIES = parseInt(process.env.QUOTE_RETRIES) || 3;
const QUOTE_RETRY_DELAY_MS = parseInt(process.env.QUOTE_RETRY_DELAY_MS) || 2000;
const QUOTE_RETRY_BACKOFF_FACTOR = parseFloat(process.env.QUOTE_RETRY_BACKOFF_FACTOR) || 1.5;
const RECONNECT_INTERVAL = parseInt(process.env.RECONNECT_INTERVAL) || 5000;
const MAX_RECONNECT_ATTEMPTS = parseInt(process.env.MAX_RECONNECT_ATTEMPTS) || 10;
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL) || 30000;
const CLEANUP_INTERVAL = parseInt(process.env.CLEANUP_INTERVAL) || 60000;
const REQUEST_CLEANUP_THRESHOLD = parseInt(process.env.REQUEST_CLEANUP_THRESHOLD) || 300000;
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL) || 15000;
const PONG_TIMEOUT = parseInt(process.env.PONG_TIMEOUT) || 7000;
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000;
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const NODE_ENV = process.env.NODE_ENV || 'development';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['*'];

// Estado da aplicação
let ws = null;
let isConnected = false;
let reconnectAttempts = 0;
let pendingRequests = new Map();
let connectionStats = {
    totalConnections: 0,
    totalReconnections: 0,
    totalRequests: 0,
    totalErrors: 0,
    uptime: Date.now()
};

// Configuração de segurança
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
        },
    },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    }
}));

// Configuração CORS
app.use(cors({
    origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX_REQUESTS,
    message: {
        error: 'Too many requests',
        message: 'Rate limit exceeded. Please try again later.',
        retryAfter: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)
    },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(limiter);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging
function log(level, message, data = null) {
    const levels = { error: 0, warn: 1, info: 2, debug: 3 };
    const currentLevel = levels[LOG_LEVEL] || 2;
    
    if (levels[level] <= currentLevel) {
        const timestamp = new Date().toISOString();
        const logData = data ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}${logData}`);
    }
}

// Função para conectar ao WebSocket
function connectWebSocket() {
    const wsUrl = `ws://${HETZNER_IP}:${WS_PORT}`;
    
    log('info', `Tentando conectar ao SideSwap Manager: ${wsUrl}`);
    
    try {
        ws = new WebSocket(wsUrl);
        
        ws.on('open', () => {
            log('info', 'Conectado ao SideSwap Manager com sucesso');
            isConnected = true;
            reconnectAttempts = 0;
            connectionStats.totalConnections++;
            
            // Iniciar heartbeat
            startHeartbeat();
        });
        
        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                log('debug', 'Mensagem recebida do SideSwap Manager', message);
                
                // Processar resposta
                if (message.id && pendingRequests.has(message.id)) {
                    const { resolve } = pendingRequests.get(message.id);
                    pendingRequests.delete(message.id);
                    resolve(message);
                }
            } catch (error) {
                log('error', 'Erro ao processar mensagem do WebSocket', { error: error.message, data: data.toString() });
            }
        });
        
        ws.on('close', (code, reason) => {
            log('warn', `Conexão WebSocket fechada`, { code, reason: reason.toString() });
            isConnected = false;
            
            // Rejeitar todas as requisições pendentes
            for (const [id, { reject }] of pendingRequests) {
                reject(new Error('Conexão WebSocket perdida'));
            }
            pendingRequests.clear();
            
            // Tentar reconectar
            scheduleReconnect();
        });
        
        ws.on('error', (error) => {
            log('error', 'Erro na conexão WebSocket', { error: error.message });
            connectionStats.totalErrors++;
            isConnected = false;
        });
        
        ws.on('pong', () => {
            log('debug', 'Pong recebido do SideSwap Manager');
        });
        
    } catch (error) {
        log('error', 'Erro ao criar conexão WebSocket', { error: error.message });
        scheduleReconnect();
    }
}

// Função para agendar reconexão
function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        log('error', `Máximo de tentativas de reconexão atingido (${MAX_RECONNECT_ATTEMPTS})`);
        return;
    }
    
    reconnectAttempts++;
    connectionStats.totalReconnections++;
    
    const delay = RECONNECT_INTERVAL * Math.pow(2, reconnectAttempts - 1);
    log('info', `Agendando reconexão em ${delay}ms (tentativa ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    
    setTimeout(() => {
        connectWebSocket();
    }, delay);
}

// Heartbeat
let heartbeatInterval;
let pongTimeout;

function startHeartbeat() {
    heartbeatInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            log('debug', 'Enviando ping para SideSwap Manager');
            ws.ping();
            
            // Configurar timeout para pong
            pongTimeout = setTimeout(() => {
                log('warn', 'Timeout do pong - conexão pode estar instável');
                ws.terminate();
            }, PONG_TIMEOUT);
        }
    }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    if (pongTimeout) {
        clearTimeout(pongTimeout);
        pongTimeout = null;
    }
}

// Função para enviar mensagem com retry
async function sendMessageWithRetry(message, retries = QUOTE_RETRIES) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const result = await sendMessage(message);
            return result;
        } catch (error) {
            log('warn', `Tentativa ${attempt}/${retries} falhou`, { error: error.message, message });
            
            if (attempt === retries) {
                throw error;
            }
            
            // Aguardar antes da próxima tentativa
            const delay = QUOTE_RETRY_DELAY_MS * Math.pow(QUOTE_RETRY_BACKOFF_FACTOR, attempt - 1);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Função para enviar mensagem
function sendMessage(message) {
    return new Promise((resolve, reject) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            reject(new Error('WebSocket não está conectado'));
            return;
        }
        
        const id = message.id || uuidv4();
        message.id = id;
        
        // Armazenar a promessa
        pendingRequests.set(id, { resolve, reject });
        
        // Configurar timeout
        const timeout = setTimeout(() => {
            if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                reject(new Error('Timeout da requisição'));
            }
        }, QUOTE_REQUEST_TIMEOUT);
        
        // Modificar resolve para limpar timeout
        const originalResolve = resolve;
        pendingRequests.set(id, {
            resolve: (data) => {
                clearTimeout(timeout);
                originalResolve(data);
            },
            reject: (error) => {
                clearTimeout(timeout);
                reject(error);
            }
        });
        
        try {
            ws.send(JSON.stringify(message));
            log('debug', 'Mensagem enviada para SideSwap Manager', message);
        } catch (error) {
            pendingRequests.delete(id);
            clearTimeout(timeout);
            reject(error);
        }
    });
}

// Limpeza de requisições antigas
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [id, request] of pendingRequests) {
        if (now - request.timestamp > REQUEST_CLEANUP_THRESHOLD) {
            pendingRequests.delete(id);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        log('info', `Limpeza automática: ${cleaned} requisições antigas removidas`);
    }
}, CLEANUP_INTERVAL);

// Rotas da API
app.get('/health', (req, res) => {
    const uptime = Date.now() - connectionStats.uptime;
    
    res.json({
        status: 'ok',
        websocket: {
            connected: isConnected,
            reconnectAttempts,
            maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS
        },
        stats: {
            ...connectionStats,
            uptime,
            pendingRequests: pendingRequests.size
        },
        config: {
            httpPort: HTTP_PORT,
            wsHost: HETZNER_IP,
            wsPort: WS_PORT,
            nodeEnv: NODE_ENV
        },
        timestamp: new Date().toISOString()
    });
});

app.post('/api/quote', async (req, res) => {
    try {
        connectionStats.totalRequests++;
        
        const { send_asset, recv_asset, send_amount, recv_amount } = req.body;
        
        // Validação básica
        if (!send_asset || !recv_asset) {
            return res.status(400).json({
                error: 'Parâmetros obrigatórios: send_asset, recv_asset'
            });
        }
        
        if (!send_amount && !recv_amount) {
            return res.status(400).json({
                error: 'Deve especificar send_amount ou recv_amount'
            });
        }
        
        const message = {
            method: 'quote',
            params: {
                send_asset,
                recv_asset,
                ...(send_amount && { send_amount }),
                ...(recv_amount && { recv_amount })
            }
        };
        
        log('info', 'Processando requisição de cotação', message.params);
        
        const response = await sendMessageWithRetry(message);
        
        if (response.error) {
            log('warn', 'Erro na cotação do SideSwap Manager', response.error);
            return res.status(400).json({
                error: response.error.message || 'Erro na cotação',
                code: response.error.code
            });
        }
        
        log('info', 'Cotação processada com sucesso');
        res.json(response.result || response);
        
    } catch (error) {
        log('error', 'Erro ao processar cotação', { error: error.message });
        connectionStats.totalErrors++;
        
        res.status(500).json({
            error: 'Erro interno do servidor',
            message: error.message
        });
    }
});

app.get('/api/stats', (req, res) => {
    const uptime = Date.now() - connectionStats.uptime;
    
    res.json({
        ...connectionStats,
        uptime,
        pendingRequests: pendingRequests.size,
        websocket: {
            connected: isConnected,
            reconnectAttempts,
            maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS
        }
    });
});

// Rota raiz
app.get('/', (req, res) => {
    res.json({
        name: 'SideSwap Bridge API',
        version: '2.0.0',
        description: 'HTTP bridge to SideSwap Manager WebSocket API',
        endpoints: {
            health: 'GET /health',
            quote: 'POST /api/quote',
            stats: 'GET /api/stats'
        },
        websocket: {
            connected: isConnected,
            host: HETZNER_IP,
            port: WS_PORT
        }
    });
});

// Middleware de erro
app.use((error, req, res, next) => {
    log('error', 'Erro não tratado', { error: error.message, stack: error.stack });
    res.status(500).json({
        error: 'Erro interno do servidor'
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    log('info', 'Recebido SIGTERM, iniciando shutdown graceful...');
    
    stopHeartbeat();
    
    if (ws) {
        ws.close();
    }
    
    process.exit(0);
});

process.on('SIGINT', () => {
    log('info', 'Recebido SIGINT, iniciando shutdown graceful...');
    
    stopHeartbeat();
    
    if (ws) {
        ws.close();
    }
    
    process.exit(0);
});

// Iniciar servidor
app.listen(HTTP_PORT, HTTP_HOST, () => {
    log('info', `Servidor HTTP iniciado em ${HTTP_HOST}:${HTTP_PORT}`);
    log('info', `Ambiente: ${NODE_ENV}`);
    log('info', `Conectando ao SideSwap Manager em ${HETZNER_IP}:${WS_PORT}`);
    
    // Conectar ao WebSocket
    connectWebSocket();
});
