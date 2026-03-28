const express = require('express');
const app = express();
app.use(express.json());

// ─── Environment Variables ───────────────────────────────────────────────────
const {
  META_PHONE_NUMBER_ID,   // e.g. 123456789012345
  META_ACCESS_TOKEN,      // permanent token from Meta for Developers
  META_VERIFY_TOKEN,      // any secret string you choose for webhook verification
  SHOPIFY_STORE_URL,      // mymayzshop.myshopify.com
  SHOPIFY_ADMIN_TOKEN,    // shpat_... or offline token
  ODOO_URL,               // https://yourstore.odoo.com
  ODOO_DB,
  ODOO_USERNAME,
  ODOO_PASSWORD,
  PORT = 3000,
} = process.env;

// ─── In-memory pending orders ─────────────────────────────────────────────────
// key: customer phone (E.164 without +), value: order info + timers
const pendingOrders = {};

// ─── Arabic message templates ─────────────────────────────────────────────────
function msgConfirmation(orderName, isCOD, total, currency) {
  const payLabel = isCOD ? 'الدفع عند الاستلام' : 'بطاقة ائتمان';
  return (
    `مرحباً! تم استلام طلبك *${orderName}* بنجاح 🎉\n` +
    `طريقة الدفع: ${payLabel}\n` +
    `المبلغ الإجمالي: ${total} ${currency}\n\n` +
    `الرجاء تأكيد طلبك:\n` +
    `*1* - تأكيد الطلب ✅\n` +
    `*2* - إلغاء الطلب ❌`
  );
}
function msgConfirmed(orderName) {
  return `شكراً! تم تأكيد طلبك *${orderName}* وسيتم تجهيزه قريباً 🚀`;
}
function msgCancelledCOD(orderName) {
  return `تم إلغاء طلبك *${orderName}* بنجاح. نأمل خدمتك في المرة القادمة 🙏`;
}
function msgCancelledCard(orderName, amount, currency) {
  return (
    `تم إلغاء طلبك *${orderName}* وسيتم استرداد مبلغ ${amount} ${currency} خلال 5-7 أيام عمل إلى بطاقتك 💳\n` +
    `شكراً لتعاملك معنا 🙏`
  );
}
function msgRetry(orderName) {
  return (
    `تذكير: طلبك *${orderName}* لا يزال ينتظر تأكيدك.\n\n` +
    `*1* - تأكيد الطلب ✅\n` +
    `*2* - إلغاء الطلب ❌\n\n` +
    `إذا لم نتلقَّ ردك سيُوقف الطلب تلقائياً.`
  );
}

// ─── Meta WhatsApp Cloud API ──────────────────────────────────────────────────
async function sendWhatsApp(phone, message) {
  // phone should be E.164 digits only, no "+"
  const digits = phone.replace(/\D/g, '');
  const url = `https://graph.facebook.com/v19.0/${META_PHONE_NUMBER_ID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: digits,
    type: 'text',
    text: { body: message },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log('[WA] Sent to', digits, '->', JSON.stringify(data));
  return data;
}

// ─── Odoo helpers ─────────────────────────────────────────────────────────────
let odooSession = null;
async function getOdooSession() {
  if (odooSession) return odooSession;
  const res = await fetch(`${ODOO_URL}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: 1,
      params: { db: ODOO_DB, login: ODOO_USERNAME, password: ODOO_PASSWORD },
    }),
  });
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/session_id=([^;]+)/);
  if (match) odooSession = match[1];
  const data = await res.json();
  console.log('[Odoo] Auth uid:', data.result?.uid);
  return odooSession;
}

async function odoo(model, method, args, kwargs = {}) {
  const session = await getOdooSession();
  const res = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `session_id=${session}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: Date.now(),
      params: { model, method, args, kwargs },
    }),
  });
  const data = await res.json();
  if (data.error) { console.error('[Odoo] Error:', JSON.stringify(data.error)); throw new Error(data.error.message); }
  return data.result;
}

async function findOdooOrder(shopifyOrderName) {
  const results = await odoo('sale.order', 'search_read',
    [[['client_order_ref', '=', shopifyOrderName]]],
    { fields: ['id', 'name', 'state', 'tag_ids'], limit: 1 }
  );
  return results?.[0];
}

async function getTagId(tagName) {
  const results = await odoo('crm.tag', 'search_read', [[['name', '=', tagName]]], { fields: ['id'], limit: 1 });
  if (results?.[0]) return results[0].id;
  return await odoo('crm.tag', 'create', [{ name: tagName }]);
}

async function addTagToOrder(odooOrderId, tagName) {
  const tagId = await getTagId(tagName);
  await odoo('sale.order', 'write', [[odooOrderId], { tag_ids: [[4, tagId]] }]);
  console.log(`[Odoo] Tagged order ${odooOrderId} with "${tagName}"`);
}

async function cancelOdooOrder(odooOrderId) {
  await odoo('sale.order', 'action_cancel', [[odooOrderId]]);
  console.log(`[Odoo] Cancelled order ${odooOrderId}`);
}

// ─── Shopify helpers ──────────────────────────────────────────────────────────
async function shopifyCancel(shopifyOrderId) {
  const res = await fetch(
    `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${shopifyOrderId}/cancel.json`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN },
      body: JSON.stringify({ reason: 'customer', email: false }),
    }
  );
  const data = await res.json();
  console.log('[Shopify] Cancel:', JSON.stringify(data).slice(0, 100));
  return data;
}

async function shopifyRefund(shopifyOrderId, amount, currency) {
  const txRes = await fetch(
    `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${shopifyOrderId}/transactions.json`,
    { headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN } }
  );
  const txData = await txRes.json();
  const saleTx = (txData.transactions || []).find(t => t.kind === 'sale' || t.kind === 'capture');

  const res = await fetch(
    `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${shopifyOrderId}/refunds.json`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN },
      body: JSON.stringify({
        refund: {
          currency,
          notify: true,
          transactions: saleTx ? [{ parent_id: saleTx.id, amount, kind: 'refund', gateway: saleTx.gateway }] : [],
        },
      }),
    }
  );
  const data = await res.json();
  console.log('[Shopify] Refund:', JSON.stringify(data).slice(0, 100));
  return data;
}

// ─── Phone normalisation ──────────────────────────────────────────────────────
function normalisePhone(raw) {
  if (!raw) return null;
  let phone = raw.replace(/\D/g, '');
  if (phone.startsWith('0')) phone = '20' + phone.slice(1); // Egypt default
  return phone; // digits only, no "+"
}

// ─── Shopify Webhook: Order Created ──────────────────────────────────────────
app.post('/webhook/order-created', async (req, res) => {
  res.sendStatus(200); // ack immediately

  try {
    const order = req.body;
    const shopifyOrderId = String(order.id);
    const orderName = order.name;
    const total = order.total_price;
    const currency = order.currency;
    const phone = normalisePhone(
      order.billing_address?.phone || order.shipping_address?.phone || order.phone
    );
    const gateway = (order.payment_gateway_names || [])[0] || '';
    const isCOD = /cod|cash/i.test(gateway) || /cod/i.test(order.payment_terms?.payment_terms_name || '');

    console.log(`[Order] ${orderName} | phone:${phone} | gateway:${gateway} | COD:${isCOD}`);

    if (!phone) { console.warn('[Order] No phone, skipping.'); return; }

    await sendWhatsApp(phone, msgConfirmation(orderName, isCOD, total, currency));

    // Schedule retry after 2h → tag no-response after another 2h
    const retryTimer = setTimeout(async () => {
      if (!pendingOrders[phone]) return;
      await sendWhatsApp(phone, msgRetry(orderName));

      pendingOrders[phone].noReplyTimer = setTimeout(async () => {
        if (!pendingOrders[phone]) return;
        try {
          const odooOrder = await findOdooOrder(orderName);
          if (odooOrder) await addTagToOrder(odooOrder.id, 'wa-no-response');
        } catch (e) { console.error('[NoReply] Odoo error:', e.message); }
        delete pendingOrders[phone];
      }, 2 * 60 * 60 * 1000);
    }, 2 * 60 * 60 * 1000);

    pendingOrders[phone] = { shopifyOrderId, orderName, isCOD, total, currency, retryTimer };

  } catch (err) {
    console.error('[Order Webhook] Error:', err.message);
  }
});

// ─── Meta Webhook: Verification (GET) ────────────────────────────────────────
app.get('/webhook/wa-reply', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('[Meta] Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── Meta Webhook: Incoming Message (POST) ───────────────────────────────────
app.post('/webhook/wa-reply', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from; // digits only, no "+"
    const text = (msg.text?.body || '').trim();
    console.log(`[WA Reply] from:${from} text:"${text}"`);

    const pending = pendingOrders[from];
    if (!pending) { console.log('[WA Reply] No pending order for', from); return; }

    // Clear timers
    clearTimeout(pending.retryTimer);
    clearTimeout(pending.noReplyTimer);

    if (text === '1') {
      // CONFIRMED
      try {
        const odooOrder = await findOdooOrder(pending.orderName);
        if (odooOrder) await addTagToOrder(odooOrder.id, 'wa-confirmed');
      } catch (e) { console.error('[Confirm] Odoo:', e.message); }
      await sendWhatsApp(from, msgConfirmed(pending.orderName));
      delete pendingOrders[from];

    } else if (text === '2') {
      // CANCELLED
      try {
        const odooOrder = await findOdooOrder(pending.orderName);
        if (odooOrder) {
          await cancelOdooOrder(odooOrder.id);
          await addTagToOrder(odooOrder.id, 'wa-cancelled');
        }
      } catch (e) { console.error('[Cancel] Odoo:', e.message); }

      if (pending.isCOD) {
        try { await shopifyCancel(pending.shopifyOrderId); } catch (e) { console.error('[Cancel COD]', e.message); }
        await sendWhatsApp(from, msgCancelledCOD(pending.orderName));
      } else {
        try { await shopifyRefund(pending.shopifyOrderId, pending.total, pending.currency); } catch (e) { console.error('[Refund]', e.message); }
        await sendWhatsApp(from, msgCancelledCard(pending.orderName, pending.total, pending.currency));
      }
      delete pendingOrders[from];

    } else {
      console.log('[WA Reply] Unrecognised reply:', text);
    }
  } catch (err) {
    console.error('[WA Reply Webhook] Error:', err.message);
  }
});

// ─── Shopify OAuth Callback (one-time token capture) ─────────────────────────
app.get('/oauth/callback', async (req, res) => {
  const { code, shop } = req.query;
  if (!code || !shop) return res.status(400).send('Missing code or shop');
  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });
    const data = await tokenRes.json();
    console.log('🔑 SHOPIFY TOKEN CAPTURED:', JSON.stringify(data));
    res.send(`<h1>✅ Token captured!</h1><pre>${JSON.stringify(data, null, 2)}</pre>`);
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'running', time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
