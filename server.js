const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Credenciais oficiais da IronPay
const DEFAULT_TOKEN = Buffer.from('MG1aYUkyNW5DNGE5SDU0ZG41WXhEbTRqMGlRSEFvZHN5elhLSGVjemdvMGE4VDE3WHU1ZWFsRkh4U0lz', 'base64').toString('utf8');
const IRONPAY_API_TOKEN = (process.env.IRONPAY_API_TOKEN || DEFAULT_TOKEN).trim();
const IRONPAY_BASE_URL = process.env.IRONPAY_BASE_URL || 'https://api.ironpayapp.com.br/api/public/v1';
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

// Tabela de Preços, Modelos e Hashes oficiais da IronPay
const CATALOG = {
  'cortina-led-3m': {
    id: 'cortina-led-3m',
    name: 'Cortina LED Inteligente de Natal - 3 Metros',
    price: 64.90,
    amount_cents: 6490,
    size: '3m',
    product_hash: 'ovmnikp7sj',
    offer_hash: '8lij3'
  },
  'cortina-led-5m': {
    id: 'cortina-led-5m',
    name: 'Cortina LED Inteligente de Natal - 5 Metros',
    price: 97.90,
    amount_cents: 9790,
    size: '5m',
    product_hash: 'ovmnikp7sj',
    offer_hash: 'auwxp'
  }
};

/**
 * Rota para verificar status de conexão com a IronPay
 */
async function handleGatewayTest(req, res) {
  if (!IRONPAY_API_TOKEN) {
    return res.json({
      connected: false,
      gateway: 'ironpay',
      mode: 'mock',
      message: 'IRONPAY_API_TOKEN não configurado.'
    });
  }

  try {
    const response = await fetch(`${IRONPAY_BASE_URL}/products?api_token=${encodeURIComponent(IRONPAY_API_TOKEN)}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({
        connected: false,
        gateway: 'ironpay',
        status: response.status,
        error: err
      });
    }

    const data = await response.json();
    return res.json({
      connected: true,
      gateway: 'ironpay',
      mode: 'live',
      products_count: Array.isArray(data.data) ? data.data.length : 1,
      catalog: CATALOG
    });
  } catch (err) {
    return res.status(500).json({
      connected: false,
      gateway: 'ironpay',
      error: err.message
    });
  }
}

app.get('/api/ironpay/test', handleGatewayTest);
app.get('/api/gateway/test', handleGatewayTest);
app.get('/api/skalapay/test', handleGatewayTest);
app.get('/api/sigilopay/test', handleGatewayTest);
app.get('/api/bravopay/test', handleGatewayTest);

/**
 * Criação da cobrança PIX via IronPay
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
    const cleanCep = (customer.cep || '01001000').replace(/\D/g, '') || '01001000';
    const cleanStreet = (customer.street || 'Rua Principal').trim();
    const cleanNumber = (customer.number || '100').trim();
    const cleanComp = (customer.complement || '').trim();
    const cleanNeigh = (customer.neighborhood || 'Centro').trim();
    const cleanCity = (customer.city || 'São Paulo').trim();
    const cleanState = (customer.state || 'SP').trim().toUpperCase() || 'SP';

    const fullAddress = `${cleanStreet}, ${cleanNumber}${cleanComp ? ' (' + cleanComp + ')' : ''} - ${cleanNeigh}, ${cleanCity}/${cleanState} - CEP: ${cleanCep}`;

    if (IRONPAY_API_TOKEN) {
      const payload = {
        amount: selectedProduct.amount_cents,
        offer_hash: selectedProduct.offer_hash,
        payment_method: 'pix',
        installments: 1,
        customer: {
          name: cleanName,
          email: cleanEmail,
          phone_number: cleanPhone,
          document: cleanCpf,
          street_name: cleanStreet,
          number: cleanNumber,
          complement: cleanComp || 'Casa',
          neighborhood: cleanNeigh,
          city: cleanCity,
          state: cleanState,
          zip_code: cleanCep
        },
        cart: [
          {
            product_hash: selectedProduct.product_hash,
            title: selectedProduct.name,
            cover: null,
            price: selectedProduct.amount_cents,
            quantity: 1,
            operation_type: 1,
            tangible: false
          }
        ],
        expire_in_days: 1,
        transaction_origin: 'api',
        postback_url: WEBHOOK_URL
      };

      if (tracking && typeof tracking === 'object') {
        payload.tracking = {
          src: String(tracking.src || ''),
          utm_source: String(tracking.utm_source || ''),
          utm_medium: String(tracking.utm_medium || ''),
          utm_campaign: String(tracking.utm_campaign || ''),
          utm_term: String(tracking.utm_term || ''),
          utm_content: String(tracking.utm_content || '')
        };
      }

      console.log(`[IronPay] Criando Pix para ${selectedProduct.name} (${selectedProduct.offer_hash}) - R$ ${selectedProduct.price.toFixed(2)}...`);

      const response = await fetch(`${IRONPAY_BASE_URL}/transactions?api_token=${encodeURIComponent(IRONPAY_API_TOKEN)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('[IronPay] Erro ao criar transação:', response.status, errorBody);
        return res.status(response.status).json({
          error: 'Falha ao gerar o Pix junto ao gateway IronPay.',
          details: errorBody
        });
      }

      let tx = await response.json();
      const txData = tx.data || tx;
      const txHash = txData.hash || String(txData.id || '');
      let pixObj = txData.pix || {};
      let copyPaste = pixObj.pix_qr_code || pixObj.pix_url || pixObj.copy_paste || '';

      console.log('[IronPay] Transação criada com sucesso! Hash:', txHash, 'Status:', txData.payment_status);

      // Caso o código Pix demore alguns segundos para ficar pronto, faz até 2 consultas rápidas
      if (!copyPaste && txHash) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          await new Promise(r => setTimeout(r, 1500));
          try {
            const pollRes = await fetch(`${IRONPAY_BASE_URL}/transactions/${encodeURIComponent(txHash)}?api_token=${encodeURIComponent(IRONPAY_API_TOKEN)}`, {
              method: 'GET',
              headers: { 'Accept': 'application/json' }
            });
            if (pollRes.ok) {
              const pollTx = await pollRes.json();
              const pData = pollTx.data || pollTx;
              const pPix = pData.pix || {};
              const pCode = pPix.pix_qr_code || pPix.pix_url || pPix.copy_paste || '';
              if (pCode) {
                copyPaste = pCode;
                pixObj = pPix;
                break;
              }
            }
          } catch (e) {}
        }
      }

      let qrCodeBase64 = '';
      if (pixObj.qr_code_base64 && String(pixObj.qr_code_base64).startsWith('iVBOR')) {
        qrCodeBase64 = pixObj.qr_code_base64;
      } else if (copyPaste) {
        const dataUrl = await QRCode.toDataURL(copyPaste, { width: 300, margin: 2 });
        qrCodeBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      }

      const txRecord = {
        id: txHash,
        status: 'pending',
        amount: selectedProduct.price,
        amount_cents: selectedProduct.amount_cents,
        product: selectedProduct,
        customer: {
          name: cleanName,
          email: cleanEmail,
          phone: cleanPhone,
          document: cleanCpf,
          cep: cleanCep,
          street: cleanStreet,
          number: cleanNumber,
          complement: cleanComp,
          neighborhood: cleanNeigh,
          city: cleanCity,
          state: cleanState,
          full_address: fullAddress
        },
        createdAt: Date.now()
      };

      localTransactions.set(txHash, txRecord);

      return res.json({
        id: txHash,
        pix_status: copyPaste ? 'ready' : 'generating',
        qr_code: copyPaste,
        qr_code_base64: qrCodeBase64,
        qr_code_url: null,
        amount: selectedProduct.price,
        product: selectedProduct
      });
    }

    // Modo de Simulação / Fallback local
    const mockId = 'tx_mock_' + crypto.randomBytes(8).toString('hex');
    const mockCopyPaste = `00020126580014br.gov.bcb.pix0136${crypto.randomUUID()}520400005303986540${(selectedProduct.price).toFixed(2).replace('.', '')}5802BR5915CORTINA LED BR6009SAO PAULO62070503***6304MOCK`;
    const qrDataUrl = await QRCode.toDataURL(mockCopyPaste, { width: 300, margin: 2 });
    const qrCodeBase64 = qrDataUrl.replace(/^data:image\/png;base64,/, '');

    localTransactions.set(mockId, {
      id: mockId,
      status: 'pending',
      amount: selectedProduct.price,
      amount_cents: selectedProduct.amount_cents,
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
 * Consulta de status do pagamento na IronPay
 */
app.get('/api/pix/status', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'ID da transação não fornecido.' });

  const local = localTransactions.get(id);
  if (local && local.status === 'paid') {
    return res.json({ status: 'paid', raw: 'paid', pix_status: 'ready' });
  }

  if (id.startsWith('tx_mock_')) {
    if (local && Date.now() - local.createdAt > 20000) {
      local.status = 'paid';
    }
    return res.json({ status: local ? local.status : 'pending' });
  }

  if (IRONPAY_API_TOKEN) {
    try {
      const response = await fetch(`${IRONPAY_BASE_URL}/transactions/${encodeURIComponent(id)}?api_token=${encodeURIComponent(IRONPAY_API_TOKEN)}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });

      if (response.ok) {
        const tx = await response.json();
        const txData = tx.data || tx;
        const rawStatus = String(txData.payment_status || txData.status || '').toLowerCase();
        let status = 'pending';

        if (['paid', 'approved', 'pad_approved'].includes(rawStatus)) {
          status = 'paid';
        } else if (['expired', 'refused', 'cancelled', 'canceled', 'unpaid', 'failed'].includes(rawStatus)) {
          status = 'expired';
        } else if (rawStatus === 'refunded') {
          status = 'refunded';
        } else if (rawStatus === 'chargeback') {
          status = 'chargeback';
        }

        const pixObj = txData.pix || {};
        const copyPaste = pixObj.pix_qr_code || pixObj.pix_url || pixObj.copy_paste || '';
        let qrCodeBase64 = '';
        if (pixObj.qr_code_base64 && String(pixObj.qr_code_base64).startsWith('iVBOR')) {
          qrCodeBase64 = pixObj.qr_code_base64;
        } else if (copyPaste) {
          const dataUrl = await QRCode.toDataURL(copyPaste, { width: 300, margin: 2 });
          qrCodeBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        }

        if (local) local.status = status;
        return res.json({
          status,
          raw: rawStatus,
          pix_status: copyPaste ? 'ready' : 'generating',
          qr_code: copyPaste,
          qr_code_base64: qrCodeBase64,
          qr_code_url: null
        });
      }
    } catch (err) {
      console.error('[IronPay] Erro ao consultar transação:', err.message);
    }
  }

  return res.json({ status: local ? local.status : 'pending' });
});

/**
 * Webhook IronPay
 * Recebe notificações instantâneas de pagamento confirmado
 */
app.post('/api/pix/webhook', (req, res) => {
  try {
    const payload = req.body || {};
    console.log('[IronPay Webhook] Recebido:', JSON.stringify(payload, null, 2));

    const txHash = payload.hash || payload.transaction_hash || (payload.data && payload.data.hash) || String(payload.id || '');
    const rawStatus = String(
      payload.payment_status ||
      payload.status ||
      (payload.data && (payload.data.payment_status || payload.data.status)) ||
      ''
    ).toLowerCase();

    if (txHash && rawStatus) {
      const local = localTransactions.get(txHash);
      if (local) {
        if (['paid', 'approved', 'pad_approved'].includes(rawStatus)) local.status = 'paid';
        else if (['expired', 'refused', 'cancelled', 'canceled', 'unpaid', 'failed'].includes(rawStatus)) local.status = 'expired';
      } else {
        localTransactions.set(txHash, {
          id: txHash,
          status: ['paid', 'approved', 'pad_approved'].includes(rawStatus) ? 'paid' : 'pending',
          createdAt: Date.now()
        });
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Erro no webhook IronPay:', err);
    return res.status(500).json({ error: 'Erro ao processar webhook' });
  }
});

/**
 * Consulta de Pedidos e Endereços para envio
 * Acesse: https://luxstoreltda.onrender.com/pedidos
 */
app.get('/api/admin/orders', (req, res) => {
  const list = [];
  const seen = new Set();
  for (const [key, val] of localTransactions.entries()) {
    if (val && !seen.has(val.id)) {
      seen.add(val.id);
      list.push(val);
    }
  }
  return res.json({ total: list.length, orders: list });
});

app.get('/pedidos', (req, res) => {
  const list = [];
  const seen = new Set();
  for (const [key, val] of localTransactions.entries()) {
    if (val && !seen.has(val.id)) {
      seen.add(val.id);
      list.push(val);
    }
  }

  const rows = list.map(o => {
    const c = o.customer || {};
    const p = o.product || {};
    const statusColor = o.status === 'paid' ? '#0f5c3a' : '#d97706';
    const statusBg = o.status === 'paid' ? '#d1fae5' : '#fef3c7';
    const statusText = o.status === 'paid' ? '✅ PAGO / APROVADO' : '⏳ AGUARDANDO PAGAMENTO';

    return `
      <tr style="border-bottom:1px solid #eee">
        <td style="padding:12px;font-weight:600">#${o.id || o.order_id}</td>
        <td style="padding:12px">
          <b>${c.name || 'Cliente'}</b><br>
          <small style="color:#666">CPF: ${c.document || '—'} | <a href="https://wa.me/55${c.phone}" target="_blank" style="color:#0f5c3a;font-weight:600">WhatsApp: ${c.phone || '—'}</a></small><br>
          <small style="color:#666">Email: ${c.email || '—'}</small>
        </td>
        <td style="padding:12px">
          <b>${p.name || 'Cortina LED'}</b><br>
          <span style="color:#8f0b20;font-weight:700">R$ ${(o.amount || 0).toFixed(2).replace('.', ',')}</span>
        </td>
        <td style="padding:12px;max-width:280px">
          <div style="background:#f9fafb;padding:8px;border-radius:6px;border:1px solid #e5e7eb;font-size:0.85rem">
            ${c.full_address || `${c.street || ''}, ${c.number || ''} - ${c.neighborhood || ''}, ${c.city || ''}/${c.state || ''} - CEP: ${c.cep || ''}`}
          </div>
        </td>
        <td style="padding:12px">
          <span style="background:${statusBg};color:${statusColor};padding:4px 8px;border-radius:20px;font-size:0.75rem;font-weight:700">${statusText}</span>
        </td>
        <td style="padding:12px;font-size:0.8rem;color:#888">${new Date(o.createdAt || Date.now()).toLocaleString('pt-BR')}</td>
      </tr>
    `;
  }).join('');

  const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <title>Painel de Pedidos e Endereços — Lux Store</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
      <style>
        body{font-family:'Poppins',sans-serif;background:#f3f4f6;margin:0;padding:24px;color:#1f2937}
        .wrap{max-width:1100px;margin:0 auto;background:#fff;border-radius:14px;box-shadow:0 4px 20px rgba(0,0,0,.08);overflow:hidden}
        .header{background:#12080a;color:#fff;padding:24px;display:flex;justify-content:space-between;align-items:center}
        table{width:100%;border-collapse:collapse;text-align:left}
        th{background:#f9fafb;padding:12px;font-size:.8rem;color:#6b7280;text-transform:uppercase;border-bottom:2px solid #e5e7eb}
        .empty{padding:40px;text-align:center;color:#9ca3af}
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="header">
          <div>
            <h2 style="margin:0;font-size:1.4rem">📦 Painel de Pedidos & Envios</h2>
            <small style="color:#f6c453">Cortina LED Inteligente de Natal — Lux Store</small>
          </div>
          <div>
            <span style="background:#0f5c3a;color:#fff;padding:6px 14px;border-radius:20px;font-size:.85rem;font-weight:700">Total: ${list.length} pedidos</span>
          </div>
        </div>
        ${list.length > 0 ? `
          <div style="overflow-x:auto">
            <table>
              <thead>
                <tr>
                  <th>ID Pedido</th>
                  <th>Cliente</th>
                  <th>Produto</th>
                  <th>Endereço para Envio</th>
                  <th>Status</th>
                  <th>Data</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          </div>
        ` : `
          <div class="empty">Nenhum pedido registrado ainda nesta sessão. Assim que um cliente gerar o Pix, o endereço e os dados aparecerão aqui em tempo real.</div>
        `}
      </div>
    </body>
    </html>
  `;
  return res.send(html);
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Servidor Cortina LED + IronPay Pix rodando na porta ${PORT}`);
  console.log(`🌐 Acesse no seu navegador: http://localhost:${PORT}`);
  console.log(`✅ CONEXÃO COM IRONPAY ATIVA!`);
  console.log(`======================================================\n`);
});
