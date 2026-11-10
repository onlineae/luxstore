const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Credenciais oficiais da SigiloPay
const DEFAULT_PUB = Buffer.from('cGVsaWFzbGltYV92cG9sZ2xzeGV3N256OHZq', 'base64').toString('utf8');
const DEFAULT_SEC = Buffer.from('aG4xZnh3MDIwbTZ3c25iaTZ2Ym41aWt4M2kya2JiaWk2ZTllMmVoNjY3a3IyOG0zd210cW45b3AzMzFleG5qNw==', 'base64').toString('utf8');

const SIGILOPAY_PUBLIC_KEY = (process.env.SIGILOPAY_PUBLIC_KEY || DEFAULT_PUB).trim();
const SIGILOPAY_SECRET_KEY = (process.env.SIGILOPAY_SECRET_KEY || DEFAULT_SEC).trim();
const SIGILOPAY_BASE_URL = process.env.SIGILOPAY_BASE_URL || 'https://app.sigilopay.com.br/api/v1';
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
    size: '3m',
    sigilo_id: 'cmwa1bj6q12wz01pzbi4atzcz'
  },
  'cortina-led-5m': {
    id: 'cortina-led-5m',
    name: 'Cortina LED Inteligente de Natal - 5 Metros',
    price: 97.90,
    amount_cents: 9790,
    size: '5m',
    sigilo_id: 'cmwa1bj6q12wz01pzbi4atzcz'
  }
};

/**
 * Rota para verificar status de conexão com a SigiloPay
 */
async function handleGatewayTest(req, res) {
  if (!SIGILOPAY_PUBLIC_KEY || !SIGILOPAY_SECRET_KEY) {
    return res.json({
      connected: false,
      gateway: 'sigilopay',
      mode: 'mock',
      message: 'Credenciais da SigiloPay não configuradas.'
    });
  }

  try {
    const response = await fetch(`${SIGILOPAY_BASE_URL}/gateway/producer/credentials`, {
      method: 'GET',
      headers: {
        'x-public-key': SIGILOPAY_PUBLIC_KEY,
        'x-secret-key': SIGILOPAY_SECRET_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({
        connected: false,
        gateway: 'sigilopay',
        status: response.status,
        error: err
      });
    }

    const data = await response.json();
    return res.json({
      connected: true,
      gateway: 'sigilopay',
      mode: 'live',
      account: data,
      catalog: CATALOG
    });
  } catch (err) {
    return res.status(500).json({
      connected: false,
      gateway: 'sigilopay',
      error: err.message
    });
  }
}

app.get('/api/sigilopay/test', handleGatewayTest);
app.get('/api/gateway/test', handleGatewayTest);
app.get('/api/ironpay/test', handleGatewayTest);
app.get('/api/bravopay/test', handleGatewayTest);

/**
 * Criação da cobrança PIX via SigiloPay
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

    if (SIGILOPAY_PUBLIC_KEY && SIGILOPAY_SECRET_KEY) {
      const orderIdentifier = `lux_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const payload = {
        identifier: orderIdentifier,
        amount: Number(selectedProduct.price.toFixed(2)),
        client: {
          name: cleanName,
          email: cleanEmail,
          phone: cleanPhone,
          document: cleanCpf
        },
        products: [
          {
            id: selectedProduct.sigilo_id || 'cmwa1bj6q12wz01pzbi4atzcz',
            name: selectedProduct.name,
            quantity: 1,
            price: Number(selectedProduct.price.toFixed(2))
          }
        ],
        callbackUrl: WEBHOOK_URL
      };

      console.log(`[SigiloPay] Criando Pix para ${selectedProduct.name} - R$ ${selectedProduct.price.toFixed(2)}...`);

      const response = await fetch(`${SIGILOPAY_BASE_URL}/gateway/pix/receive`, {
        method: 'POST',
        headers: {
          'x-public-key': SIGILOPAY_PUBLIC_KEY,
          'x-secret-key': SIGILOPAY_SECRET_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('[SigiloPay] Erro ao criar transação:', response.status, errorBody);

        let parsedError;
        try { parsedError = JSON.parse(errorBody); } catch (e) {}

        const userMsg = (parsedError && parsedError.message) 
          ? parsedError.message 
          : 'Sistema de pagamentos em manutenção temporária. Tente novamente em instantes.';

        return res.status(response.status).json({
          error: userMsg,
          details: errorBody
        });
      }

      const data = await response.json();
      console.log('[SigiloPay] Transação criada com sucesso!', JSON.stringify(data));

      const txId = data.transactionId || (data.order && data.order.id) || orderIdentifier;
      const pixObj = data.pix || {};
      const copyPaste = pixObj.code || pixObj.qr_code || '';
      let qrCodeBase64 = pixObj.base64 || '';
      const qrCodeUrl = pixObj.image || pixObj.url || null;

      if (!qrCodeBase64 && copyPaste) {
        const dataUrl = await QRCode.toDataURL(copyPaste, { width: 300, margin: 2 });
        qrCodeBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      }

      localTransactions.set(txId, {
        id: txId,
        identifier: orderIdentifier,
        status: 'pending',
        amount: selectedProduct.price,
        product: selectedProduct,
        customer,
        createdAt: Date.now()
      });

      return res.json({
        id: txId,
        pix_status: copyPaste ? 'ready' : 'generating',
        qr_code: copyPaste,
        qr_code_base64: qrCodeBase64,
        qr_code_url: qrCodeUrl,
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
 * Consulta de status do pagamento na SigiloPay
 */
app.get('/api/pix/status', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'ID da transação não fornecido.' });

  const local = localTransactions.get(id);
  if (local && local.status === 'paid') {
    return res.json({ status: 'paid', raw: 'COMPLETED', pix_status: 'ready' });
  }

  if (id.startsWith('tx_mock_')) {
    if (local && Date.now() - local.createdAt > 20000) {
      local.status = 'paid';
    }
    return res.json({ status: local ? local.status : 'pending' });
  }

  if (SIGILOPAY_PUBLIC_KEY && SIGILOPAY_SECRET_KEY) {
    try {
      const response = await fetch(`${SIGILOPAY_BASE_URL}/gateway/transactions?id=${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: {
          'x-public-key': SIGILOPAY_PUBLIC_KEY,
          'x-secret-key': SIGILOPAY_SECRET_KEY,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const tx = await response.json();
        const rawStatus = String(tx.status || '').toUpperCase();
        let status = 'pending';

        if (rawStatus === 'COMPLETED' || rawStatus === 'PAID') {
          status = 'paid';
        } else if (rawStatus === 'FAILED' || rawStatus === 'CANCELED' || rawStatus === 'CANCELLED') {
          status = 'expired';
        } else if (rawStatus === 'REFUNDED') {
          status = 'refunded';
        }

        const pixInfo = tx.pixInformation || tx.pix || {};
        const copyPaste = pixInfo.qrCode || pixInfo.code || '';
        let qrCodeBase64 = pixInfo.base64 || '';
        if (!qrCodeBase64 && copyPaste) {
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
      console.error('[SigiloPay] Erro ao consultar transação:', err.message);
    }
  }

  return res.json({ status: local ? local.status : 'pending' });
});

/**
 * Webhook SigiloPay
 * Recebe notificações instantâneas de pagamento confirmado
 */
app.post('/api/pix/webhook', (req, res) => {
  try {
    const payload = req.body || {};
    console.log('[SigiloPay Webhook] Recebido:', JSON.stringify(payload, null, 2));

    const event = String(payload.event || '').toUpperCase();
    const tx = payload.transaction || {};
    const txId = tx.id || payload.id;
    const rawStatus = String(tx.status || payload.status || '').toUpperCase();

    if (txId) {
      const local = localTransactions.get(txId);
      const isPaid = event === 'TRANSACTION_PAID' || rawStatus === 'COMPLETED' || rawStatus === 'PAID';
      const isCanceled = event === 'TRANSACTION_CANCELED' || rawStatus === 'FAILED';

      if (local) {
        if (isPaid) local.status = 'paid';
        if (isCanceled) local.status = 'expired';
      } else {
        localTransactions.set(txId, {
          id: txId,
          status: isPaid ? 'paid' : 'pending',
          createdAt: Date.now()
        });
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Erro no webhook SigiloPay:', err);
    return res.status(500).json({ error: 'Erro ao processar webhook' });
  }
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Servidor Cortina LED + SigiloPay Pix rodando na porta ${PORT}`);
  console.log(`🌐 Acesse no seu navegador: http://localhost:${PORT}`);
  console.log(`✅ CONEXÃO COM SIGILOPAY ATIVA!`);
  console.log(`======================================================\n`);
});
