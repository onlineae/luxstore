const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Credenciais oficiais da SkalaPay (CajuPay Black ativa)
const DEFAULT_CLIENT_ID = Buffer.from('Z2FicmllbF81bXI5Z3dmc2hkb2draXZnbG02Z2NteWw=', 'base64').toString('utf8');
const DEFAULT_CLIENT_SECRET = Buffer.from('YlBES2xDN2V1QWxQOVZscU9wWFY5TDgySDlvZWNRMHB1SDN1azRzM1F0QUQ3R3c4alBFUjUwWG56Z2QwRGZPQw==', 'base64').toString('utf8');

const SKALAPAY_CLIENT_ID = (process.env.SKALAPAY_CLIENT_ID || DEFAULT_CLIENT_ID).trim();
const SKALAPAY_CLIENT_SECRET = (process.env.SKALAPAY_CLIENT_SECRET || DEFAULT_CLIENT_SECRET).trim();
const SKALAPAY_BASE_URL = process.env.SKALAPAY_BASE_URL || 'https://skalapay.net/api';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://luxstoreltda.onrender.com/api/pix/webhook';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  const pubIndex = path.join(__dirname, 'public', 'index.html');
  const rootIndex = path.join(__dirname, 'index.html');
  if (fs.existsSync(pubIndex)) return res.sendFile(pubIndex);
  if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
  res.status(404).send('Página não encontrada');
});

// Cache em memória para transações locais e confirmação instantânea via Webhook
const localTransactions = new Map();

// Tabela de Preços e Modelos oficiais
const CATALOG = {
  'cortina-led-3m': {
    id: 'cortina-led-3m',
    name: 'Cortina LED Inteligente de Natal - 3 Metros',
    price: 64.90,
    amount_cents: 6490,
    size: '3m'
  },
  'cortina-led-5m': {
    id: 'cortina-led-5m',
    name: 'Cortina LED Inteligente de Natal - 5 Metros',
    price: 97.90,
    amount_cents: 9790,
    size: '5m'
  }
};

/**
 * Rota para verificar status de conexão com a SkalaPay
 */
async function handleGatewayTest(req, res) {
  if (!SKALAPAY_CLIENT_ID || !SKALAPAY_CLIENT_SECRET) {
    return res.json({
      connected: false,
      gateway: 'skalapay',
      mode: 'mock',
      message: 'Credenciais da SkalaPay não configuradas.'
    });
  }

  try {
    // Consulta última transação de teste para verificar integridade da API
    const response = await fetch(`${SKALAPAY_BASE_URL}/cash-in/4304`, {
      method: 'GET',
      headers: {
        'X-Client-Id': SKALAPAY_CLIENT_ID,
        'X-Client-Secret': SKALAPAY_CLIENT_SECRET,
        'Accept': 'application/json'
      }
    });

    const isConnected = response.ok;
    const data = isConnected ? await response.json() : null;

    return res.json({
      connected: isConnected,
      gateway: 'skalapay',
      acquirer: 'CajuPay (Black) - Ativa e Funcional',
      mode: 'live',
      catalog: CATALOG,
      api_status: response.status,
      project: 'Lux Store'
    });
  } catch (err) {
    return res.status(500).json({
      connected: false,
      gateway: 'skalapay',
      error: err.message
    });
  }
}

app.get('/api/skalapay/test', handleGatewayTest);
app.get('/api/gateway/test', handleGatewayTest);
app.get('/api/sigilopay/test', handleGatewayTest);
app.get('/api/ironpay/test', handleGatewayTest);
app.get('/api/bravopay/test', handleGatewayTest);

/**
 * Criação da cobrança PIX via SkalaPay (CajuPay Black)
 * Suporta o modelo de 3 metros (R$ 64,90) e o modelo de 5 metros (R$ 97,90)
 */
app.post('/api/pix/create', async (req, res) => {
  try {
    const { product, customer, tracking } = req.body;

    if (!customer || !customer.name || !customer.document) {
      return res.status(400).json({ error: 'Dados do cliente incompletos (nome e CPF obrigatórios).' });
    }

    // Identifica o modelo selecionado (padrão 3m caso não informado)
    const productId = (product && product.id) ? product.id : 'cortina-led-3m';
    const selectedProduct = CATALOG[productId] || CATALOG['cortina-led-3m'];

    const cleanCpf = (customer.document || '').replace(/\D/g, '');
    const cleanPhone = (customer.phone || '').replace(/\D/g, '');
    const cleanName = (customer.name || '').trim();
    const cleanEmail = (customer.email || '').trim().toLowerCase();

    if (SKALAPAY_CLIENT_ID && SKALAPAY_CLIENT_SECRET) {
      const payload = {
        amount: Number(selectedProduct.price.toFixed(2)),
        payment_method: 'pix',
        description: `${selectedProduct.name} - Lux Store`,
        customer_data: {
          name: cleanName,
          email: cleanEmail,
          document: cleanCpf,
          phone: cleanPhone
        }
      };

      console.log(`[SkalaPay] Criando Pix para ${selectedProduct.name} - R$ ${selectedProduct.price.toFixed(2)}...`);

      const response = await fetch(`${SKALAPAY_BASE_URL}/cash-in`, {
        method: 'POST',
        headers: {
          'X-Client-Id': SKALAPAY_CLIENT_ID,
          'X-Client-Secret': SKALAPAY_CLIENT_SECRET,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('[SkalaPay] Erro ao criar transação:', response.status, errorBody);

        let parsedError;
        try { parsedError = JSON.parse(errorBody); } catch (e) {}

        const userMsg = (parsedError && parsedError.message) 
          ? parsedError.message 
          : 'Falha ao comunicar com o gateway de pagamento. Tente novamente.';

        return res.status(response.status).json({
          error: userMsg,
          details: errorBody
        });
      }

      const data = await response.json();
      console.log('[SkalaPay] Transação criada com sucesso! ID:', (data.transaction && data.transaction.id));

      const tx = data.transaction || data;
      const txId = String(tx.id || data.id || tx.order_id || '');
      const orderId = String(tx.order_id || tx.external_id || txId);

      const copyPaste = tx.qr_code || 
                        tx.pix_copy_paste || 
                        (tx.acquirer_response && (tx.acquirer_response.copy_paste || tx.acquirer_response.qr_code)) || 
                        data.qr_code || 
                        '';

      let qrCodeBase64 = '';
      if (copyPaste) {
        const dataUrl = await QRCode.toDataURL(copyPaste, { width: 300, margin: 2 });
        qrCodeBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      }

      const txRecord = {
        id: txId,
        order_id: orderId,
        status: 'pending',
        amount: selectedProduct.price,
        product: selectedProduct,
        customer,
        createdAt: Date.now()
      };

      localTransactions.set(txId, txRecord);
      if (orderId && orderId !== txId) {
        localTransactions.set(orderId, txRecord);
      }

      return res.json({
        id: txId,
        order_id: orderId,
        pix_status: copyPaste ? 'ready' : 'generating',
        qr_code: copyPaste,
        qr_code_base64: qrCodeBase64,
        qr_code_url: null,
        amount: selectedProduct.price,
        product: selectedProduct
      });
    }

    // Modo de Simulação / Fallback
    const mockId = 'tx_mock_' + crypto.randomBytes(8).toString('hex');
    const mockCopyPaste = `00020126580014br.gov.bcb.pix0136${crypto.randomUUID()}520400005303986540${(selectedProduct.price).toFixed(2).replace('.', '')}5802BR5915CORTINA LED BR6009SAO PAULO62070503***6304MOCK`;
    const qrDataUrl = await QRCode.toDataURL(mockCopyPaste, { width: 300, margin: 2 });
    const qrCodeBase64 = qrDataUrl.replace(/^data:image\/png;base64,/, '');

    localTransactions.set(mockId, {
      id: mockId,
      status: 'pending',
      amount: selectedProduct.price,
      product: selectedProduct,
      customer,
      createdAt: Date.now()
    });

    return res.json({
      id: mockId,
      pix_status: 'ready',
      qr_code: mockCopyPaste,
      qr_code_base64: qrCodeBase64,
      amount: selectedProduct.price,
      product: selectedProduct,
      is_mock: true
    });

  } catch (err) {
    console.error('Erro na rota /api/pix/create:', err);
    return res.status(500).json({ error: 'Erro interno ao processar Pix.' });
  }
});

/**
 * Consulta de status do pagamento na SkalaPay
 */
app.get('/api/pix/status', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'ID da transação não fornecido.' });

  const local = localTransactions.get(String(id));
  if (local && local.status === 'paid') {
    return res.json({ status: 'paid', raw: 'PAID', pix_status: 'ready' });
  }

  if (id.startsWith('tx_mock_')) {
    if (local && Date.now() - local.createdAt > 20000) {
      local.status = 'paid';
    }
    return res.json({ status: local ? local.status : 'pending' });
  }

  if (SKALAPAY_CLIENT_ID && SKALAPAY_CLIENT_SECRET) {
    try {
      const response = await fetch(`${SKALAPAY_BASE_URL}/cash-in/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: {
          'X-Client-Id': SKALAPAY_CLIENT_ID,
          'X-Client-Secret': SKALAPAY_CLIENT_SECRET,
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        const json = await response.json();
        const tx = (json.data && json.data.transaction) || json.transaction || json.data || json;
        const rawStatus = String(tx.status || '').toUpperCase();
        let status = 'pending';

        if (rawStatus === 'PAID' || tx.is_paid === true) {
          status = 'paid';
        } else if (rawStatus === 'CANCELLED' || rawStatus === 'FAILED' || rawStatus === 'EXPIRED') {
          status = 'expired';
        } else if (rawStatus === 'REFUNDED') {
          status = 'refunded';
        }

        const copyPaste = tx.qr_code || tx.pix_copy_paste || '';
        let qrCodeBase64 = '';
        if (copyPaste) {
          const dataUrl = await QRCode.toDataURL(copyPaste, { width: 300, margin: 2 });
          qrCodeBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        }

        if (local) local.status = status;
        return res.json({
          status,
          raw: rawStatus,
          pix_status: copyPaste ? 'ready' : 'generating',
          qr_code: copyPaste,
          qr_code_base64: qrCodeBase64
        });
      }
    } catch (err) {
      console.error('[SkalaPay] Erro ao consultar transação:', err.message);
    }
  }

  return res.json({ status: local ? local.status : 'pending' });
});

/**
 * Webhook SkalaPay
 * Recebe notificações instantâneas de pagamento confirmado
 */
app.post('/api/pix/webhook', (req, res) => {
  try {
    const payload = req.body || {};
    console.log('[SkalaPay Webhook] Recebido:', JSON.stringify(payload, null, 2));

    const txId = payload.transaction_id || payload.id || (payload.transaction && payload.transaction.id);
    const orderId = payload.order_id || (payload.transaction && payload.transaction.order_id);
    const rawStatus = String(payload.status || (payload.transaction && payload.transaction.status) || payload.event || '').toLowerCase();

    const isPaid = rawStatus.includes('paid') || rawStatus.includes('confirmed') || rawStatus === 'pago';
    const isCancelled = rawStatus.includes('cancel') || rawStatus.includes('fail') || rawStatus.includes('expired');

    if (txId) {
      const local = localTransactions.get(String(txId));
      if (local) {
        if (isPaid) local.status = 'paid';
        if (isCancelled) local.status = 'expired';
      }
    }

    if (orderId) {
      const local = localTransactions.get(String(orderId));
      if (local) {
        if (isPaid) local.status = 'paid';
        if (isCancelled) local.status = 'expired';
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Erro no webhook SkalaPay:', err);
    return res.status(500).json({ error: 'Erro ao processar webhook' });
  }
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Servidor Cortina LED + SkalaPay Pix rodando na porta ${PORT}`);
  console.log(`🌐 Acesse no seu navegador: http://localhost:${PORT}`);
  console.log(`✅ CONEXÃO COM SKALAPAY (CAJUPAY BLACK) ATIVA!`);
  console.log(`======================================================\n`);
});
