const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const SIDESWAP_WS_URL = process.env.SIDESWAP_WS_URL || 'ws://localhost:7777';

// Middleware
app.use(cors());
app.use(express.json());

// Estado da conexão WebSocket
let wsConnection = null;
let isConnected = false;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
const reconnectDelay = 5000;

// Armazenar requisições pendentes
const pendingRequests = new Map();
let requestId = 1;

// Função para conectar ao SideSwap Manager
function connectToSideSwap() {
  console.log(`Tentando conectar ao SideSwap Manager: ${SIDESWAP_WS_URL}`);
  
  wsConnection = new WebSocket(SIDESWAP_WS_URL);
  
  wsConnection.on('open', () => {
    console.log('✅ Conectado ao SideSwap Manager');
    isConnected = true;
    reconnectAttempts = 0;
  });
  
  wsConnection.on('message', (data) => {
    try {
      const response = JSON.parse(data.toString());
      console.log('📨 Resposta recebida:', response);
      
      // Processar resposta para requisição pendente
      if (response.id && pendingRequests.has(response.id)) {
        const { resolve, reject } = pendingRequests.get(response.id);
        pendingRequests.delete(response.id);
        
        if (response.error) {
          reject(new Error(response.error.message || 'Erro do SideSwap'));
        } else {
          resolve(response.result);
        }
      }
    } catch (error) {
      console.error('❌ Erro ao processar mensagem:', error);
    }
  });
  
  wsConnection.on('close', () => {
    console.log('🔌 Conexão fechada');
    isConnected = false;
    
    // Tentar reconectar
    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts++;
      console.log(`🔄 Tentativa de reconexão ${reconnectAttempts}/${maxReconnectAttempts}`);
      setTimeout(connectToSideSwap, reconnectDelay);
    }
  });
  
  wsConnection.on('error', (error) => {
    console.error('❌ Erro na conexão WebSocket:', error);
    isConnected = false;
  });
}

// Função para enviar requisição via WebSocket
function sendWebSocketRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!isConnected || !wsConnection) {
      reject(new Error('Não conectado ao SideSwap Manager'));
      return;
    }
    
    const id = requestId++;
    const request = {
      id,
      method,
      params
    };
    
    // Armazenar callback para resposta
    pendingRequests.set(id, { resolve, reject });
    
    // Timeout para requisição
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Timeout na requisição'));
      }
    }, 30000); // 30 segundos
    
    // Enviar requisição
    wsConnection.send(JSON.stringify(request));
    console.log('📤 Requisição enviada:', request);
  });
}

// Rotas da API

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connected: isConnected,
    timestamp: new Date().toISOString()
  });
});

// Status detalhado
app.get('/api/status', (req, res) => {
  res.json({
    service: 'SideSwap Bridge API',
    version: '1.0.0',
    websocket: {
      connected: isConnected,
      url: SIDESWAP_WS_URL,
      reconnectAttempts
    },
    pendingRequests: pendingRequests.size,
    uptime: process.uptime()
  });
});

// Endpoint para obter cotação
app.post('/api/quote', async (req, res) => {
  try {
    const { send_asset, recv_asset, send_amount, recv_amount } = req.body;
    
    // Validar parâmetros
    if (!send_asset || !recv_asset) {
      return res.status(400).json({
        error: 'send_asset e recv_asset são obrigatórios'
      });
    }
    
    if (!send_amount && !recv_amount) {
      return res.status(400).json({
        error: 'send_amount ou recv_amount deve ser especificado'
      });
    }
    
    // Enviar requisição para SideSwap
    const result = await sendWebSocketRequest('GetQuote', {
      send_asset,
      recv_asset,
      send_amount,
      recv_amount
    });
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    console.error('❌ Erro na cotação:', error);
    res.status(500).json({
      error: error.message
    });
  }
});

// Endpoint para criar swap instantâneo
app.post('/api/instant-swap', async (req, res) => {
  try {
    const { send_asset, recv_asset, send_amount, recv_amount, recv_addr } = req.body;
    
    // Validar parâmetros
    if (!send_asset || !recv_asset || !recv_addr) {
      return res.status(400).json({
        error: 'send_asset, recv_asset e recv_addr são obrigatórios'
      });
    }
    
    // Enviar requisição para SideSwap
    const result = await sendWebSocketRequest('CreateInstantSwap', {
      send_asset,
      recv_asset,
      send_amount,
      recv_amount,
      recv_addr
    });
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    console.error('❌ Erro no swap instantâneo:', error);
    res.status(500).json({
      error: error.message
    });
  }
});

// Inicializar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📡 Conectando ao SideSwap Manager...`);
  connectToSideSwap();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Encerrando servidor...');
  if (wsConnection) {
    wsConnection.close();
  }
  process.exit(0);
});
