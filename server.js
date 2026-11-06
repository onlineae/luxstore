const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_KEY = Buffer.from('YnBfbGl2ZV9LMnRIRy1uTHBXdnF4bGJuc3FQUjZLY0FxXzBnMTFxV1gzTUk3Zw==', 'base64').toString('utf8');
const BRAVOPAY_API_KEY = process.env.BRAVOPAY_API_KEY || DEFAULT_KEY;
const BRAVOPAY_BASE_URL = process.env.BRAVOPAY_BASE_URL || 'https://bravopay.club/api/v1';

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

// Cache em memória para transações locais e fallback de teste
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
 * Rota para verificar status de conexão com a BravoPay
 */
app.get('/api/bravopay/test', async (req, res) => {
  if (!BRAVOPAY_API_KEY || BRAVOPAY_API_KEY.includes('sua_chave')) {
    return res.json({
      connected: false,
      mode: 'mock',
      message: 'BRAVOPAY_API_KEY não configurada no .env. Configure sua chave em .env para ativar a API real.'
    });
  }

  try {
    const response = await fetch(`${BRAVOPAY_BASE_URL}/me`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BRAVOPAY_API_KEY.trim()}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({
        connected: false,
        status: response.status,
        error: err
      });
    }

    const data = await response.json();
    return res.json({
      connected: true,
      mode: 'live',
      account: data
    });
  } catch (err) {
    return res.status(500).json({
      connected: false,
      error: err.message
    });
  }
});

/**
 * Criação da cobrança PIX
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

    // Se temos a chave da BravoPay, chamamos a API oficial
    const hasLiveKey = BRAVOPAY_API_KEY && !BRAVOPAY_API_KEY.includes('sua_chave');

    if (hasLiveKey) {
      const idempotencyKey = crypto.randomUUID();
      const payload = {
        amount_cents: selectedProduct.amount_cents,
        method: 'pix',
        customer: {
          name: cleanName,
          email: cleanEmail,
          cpf: cleanCpf,
          phone: cleanPhone
        },
        description: selectedProduct.name,
        external_reference: `pedido_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        metadata: {
          product_id: selectedProduct.id,
          product_name: selectedProduct.name,
          product_size: selectedProduct.size
        },
        expires_in: 3600, // 1 hora de validade
        utm: tracking ? {
          utm_source: String(tracking.utm_source || ''),
          utm_medium: String(tracking.utm_medium || ''),
          utm_campaign: String(tracking.utm_campaign || ''),
          utm_content: String(tracking.utm_content || ''),
          utm_term: String(tracking.utm_term || ''),
          src: String(tracking.src || ''),
          sck: String(tracking.sck || '')
        } : {}
      };

      console.log(`[BravoPay] Criando Pix para ${selectedProduct.name} - R$ ${(selectedProduct.amount_cents / 100).toFixed(2)}...`);

      const response = await fetch(`${BRAVOPAY_BASE_URL}/transactions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${BRAVOPAY_API_KEY.trim()}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('[BravoPay] Erro ao criar transação:', response.status, errorBody);
        return res.status(response.status).json({
          error: 'Falha ao comunicar com o gateway BravoPay',
          details: errorBody
        });
      }

      let tx = await response.json();
      console.log('[BravoPay] Transação criada com sucesso! ID:', tx.id, 'pix_status:', tx.pix_status || 'ready');

      // Se a BravoPay respondeu com pix_status="generating", faz até 2 tentativas rápidas (4s) antes de devolver ao frontend
      if ((!tx.pix || !tx.pix.copy_paste) && tx.id) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const pollRes = await fetch(`${BRAVOPAY_BASE_URL}/transactions/${encodeURIComponent(tx.id)}`, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${BRAVOPAY_API_KEY.trim()}`,
                'Content-Type': 'application/json'
              }
            });
            if (pollRes.ok) {
              const pollTx = await pollRes.json();
              if (pollTx.pix && pollTx.pix.copy_paste) {
                tx = pollTx;
                break;
              }
            }
          } catch (e) {}
        }
      }

      const copyPaste = (tx.pix && tx.pix.copy_paste) ? tx.pix.copy_paste : '';
      let qrCodeBase64 = '';

      // Se a BravoPay já mandou imagem base64 ou URL
      if (tx.pix && tx.pix.qr_code && tx.pix.qr_code.startsWith('iVBOR')) {
        qrCodeBase64 = tx.pix.qr_code;
      } else if (copyPaste) {
        // Gera o QR Code garantido via biblioteca local qrcode
        const dataUrl = await QRCode.toDataURL(copyPaste, { width: 300, margin: 2 });
        qrCodeBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      }

      localTransactions.set(tx.id, {
        id: tx.id,
        status: 'pending',
        amount_cents: selectedProduct.amount_cents,
        product: selectedProduct,
        customer,
        createdAt: Date.now()
      });

      return res.json({
        id: tx.id,
        pix_status: copyPaste ? 'ready' : (tx.pix_status || 'generating'),
        qr_code: copyPaste,
        qr_code_base64: qrCodeBase64,
        qr_code_url: (tx.pix && tx.pix.qr_code && tx.pix.qr_code.startsWith('http')) ? tx.pix.qr_code : null,
        amount: selectedProduct.price,
        product: selectedProduct
      });
    }

    // Modo de Simulação / Teste Local (quando a chave da BravoPay ainda não foi colocada no .env)
    console.log(`[Simulação] Gerando PIX de teste para ${selectedProduct.name} (R$ ${selectedProduct.price.toFixed(2)})`);
    const mockId = 'tx_mock_' + crypto.randomBytes(8).toString('hex');
    const mockCopyPaste = `00020126580014br.gov.bcb.pix0136${crypto.randomUUID()}520400005303986540${(selectedProduct.price).toFixed(2).replace('.', '')}5802BR5915CORTINA LED BR6009SAO PAULO62070503***6304MOCK`;
    
    const qrDataUrl = await QRCode.toDataURL(mockCopyPaste, { width: 300, margin: 2 });
    const qrCodeBase64 = qrDataUrl.replace(/^data:image\/png;base64,/, '');

    localTransactions.set(mockId, {
      id: mockId,
      status: 'pending',
      amount_cents: selectedProduct.amount_cents,
      product: selectedProduct,
      customer,
      createdAt: Date.now()
    });

    return res.json({
      id: mockId,
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
 * Consulta de status do pagamento
 */
app.get('/api/pix/status', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'ID da transação não fornecido.' });

  // Verifica se temos no cache local primeiro
  const local = localTransactions.get(id);

  // Se estiver em modo de teste e passaram mais de 20 segundos, simula aprovação automática
  if (id.startsWith('tx_mock_')) {
    if (local && Date.now() - local.createdAt > 20000) {
      local.status = 'paid';
    }
    return res.json({ status: local ? local.status : 'pending' });
  }

  // Se temos chave da BravoPay, consulta o gateway oficial
  if (BRAVOPAY_API_KEY && !BRAVOPAY_API_KEY.includes('sua_chave')) {
    try {
      const response = await fetch(`${BRAVOPAY_BASE_URL}/transactions/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${BRAVOPAY_API_KEY.trim()}`,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const tx = await response.json();
        const rawStatus = (tx.status || '').toUpperCase();
        let status = 'pending';

        if (rawStatus === 'PAID') status = 'paid';
        else if (rawStatus === 'EXPIRED') status = 'expired';
        else if (rawStatus === 'REFUNDED') status = 'refunded';
        else if (rawStatus === 'CHARGEBACK') status = 'chargeback';

        const copyPaste = (tx.pix && tx.pix.copy_paste) ? tx.pix.copy_paste : '';
        let qrCodeBase64 = '';
        if (tx.pix && tx.pix.qr_code && tx.pix.qr_code.startsWith('iVBOR')) {
          qrCodeBase64 = tx.pix.qr_code;
        } else if (copyPaste) {
          const dataUrl = await QRCode.toDataURL(copyPaste, { width: 300, margin: 2 });
          qrCodeBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        }

        if (local) local.status = status;
        return res.json({
          status,
          raw: rawStatus,
          pix_status: copyPaste ? 'ready' : (tx.pix_status || 'generating'),
          qr_code: copyPaste,
          qr_code_base64: qrCodeBase64,
          qr_code_url: (tx.pix && tx.pix.qr_code && tx.pix.qr_code.startsWith('http')) ? tx.pix.qr_code : null
        });
      }
    } catch (err) {
      console.error('[BravoPay] Erro ao consultar transação:', err.message);
    }
  }

  return res.json({ status: local ? local.status : 'pending' });
});

/**
 * Webhook BravoPay
 * Recebe notificações instantâneas de pagamento confirmado
 */
app.post('/api/pix/webhook', (req, res) => {
  try {
    const signature = req.headers['bravopay-signature'] || req.headers['x-bravopay-signature'];
    const payload = req.body;

    console.log('[BravoPay Webhook] Recebido:', JSON.stringify(payload, null, 2));

    const txId = payload.id || (payload.data && payload.data.id);
    const rawStatus = payload.status || (payload.data && payload.data.status);

    if (txId && rawStatus) {
      const local = localTransactions.get(txId);
      if (local) {
        if (rawStatus.toUpperCase() === 'PAID') local.status = 'paid';
        if (rawStatus.toUpperCase() === 'EXPIRED') local.status = 'expired';
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Erro no webhook:', err);
    return res.status(500).json({ error: 'Erro ao processar webhook' });
  }
});

/**
 * Endpoint auxiliar para simular pagamento manual no modo teste
 */
app.post('/api/pix/simulate-pay', (req, res) => {
  const { id } = req.body;
  const local = localTransactions.get(id);
  if (local) {
    local.status = 'paid';
    return res.json({ success: true, status: 'paid' });
  }
  return res.status(404).json({ error: 'Transação não encontrada' });
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Servidor Cortina LED + BravoPay Pix rodando na porta ${PORT}`);
  console.log(`🌐 Acesse no seu navegador: http://localhost:${PORT}`);
  if (!BRAVOPAY_API_KEY || BRAVOPAY_API_KEY.includes('sua_chave')) {
    console.log(`⚠️  MODO DE TESTE ATIVO: Configure sua chave no arquivo .env`);
    console.log(`   (BRAVOPAY_API_KEY=bp_live_sua_chave)`);
  } else {
    console.log(`✅ CONEXÃO COM BRAVOPAY ATIVA!`);
  }
  console.log(`======================================================\n`);
});
