'use strict';
const express = require('express');
const crypto  = require('crypto');

// ─── Environment Variables ────────────────────────────────────────────────────
const {
  ULTRAMSG_INSTANCE_ID,
  ULTRAMSG_TOKEN,
  SHOPIFY_STORE_URL,
  SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_WEBHOOK_SECRET,
  ODOO_URL,
  ODOO_DB,
  ODOO_USERNAME,
  ODOO_PASSWORD,
  PORT = 3000,
} = process.env;

const app = express();

// ─── Body Parsing (raw for HMAC verification) ─────────────────────────────────
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch { req.body = {}; }
    next();
  });
});

// ─── In-Memory Order State ────────────────────────────────────────────────────
// key: normalised phone  →  { orderId, orderName, paymentGateway, timer1, timer2, confirmed }
const pendingOrders = new Map();

// ─── Phone Normalisation ──────────────────────────────────────────────────────
function normalisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 11) return '20' + digits.slice(1);
  return digits;
}

// ─── UltraMsg: Send WhatsApp ──────────────────────────────────────────────────
async function sendWhatsApp(phone, message) {
  const digits = normalisePhone(phone);
  const to = '+' + digits;
  const url = `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`;
  const params = new URLSearchParams({ token: ULTRAMSG_TOKEN, to, body: message, priority: 1 });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  console.log('[WA] Sent to', to, '->', JSON.stringify(data));
  return data;
}

// ─── Arabic WhatsApp Message ──────────────────────────────────────────────────
function buildConfirmMessage(orderName, total, currency) {
  return (
    `مرحباً 👋\n` +
    `شكراً لطلبك من myMayz!\n\n` +
    `📦 رقم الطلب: ${orderName}\n` +
    `💰 المبلغ: ${total} ${currency}\n\n` +
    `لتأكيد الطلب اضغط *1*\n` +
    `لإلغاء الطلب اضغط *2*\n\n` +
    `سيتم تأكيد طلبك تلقائياً بعد 4 ساعات إذا لم تستجب.`
  );
}

// ─── Odoo JSON-RPC ────────────────────────────────────────────────────────────
let odooUid = null;

async function odooCall(model, method, args, kwargs = {}) {
  if (!ODOO_URL || ODOO_URL === 'PLACEHOLDER') return null;
  if (!odooUid) {
    const r = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc:'2.0', method:'call', id:1,
        params: { model:'res.users', method:'authenticate',
          args:[ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}], kwargs:{} } }),
    });
    const d = await r.json();
    odooUid = d.result;
    if (!odooUid) { console.error('[Odoo] Auth failed'); return null; }
    console.log('[Odoo] Authenticated uid:', odooUid);
  }
  const r = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc:'2.0', method:'call', id:2,
      params: { model, method, args, kwargs } }),
  });
  const d = await r.json();
  return d.result;
}

async function findOdooOrder(shopifyOrderId) {
  const orders = await odooCall('sale.order', 'search_read',
    [[['client_order_ref', 'like', String(shopifyOrderId)]]],
    { fields: ['id','name','state'], limit: 1 });
  return orders && orders[0];
}

async function tagOdooOrder(odooOrderId, tagName) {
  try {
    await odooCall('sale.order', 'message_post', [[odooOrderId]],
      { body: `[WhatsApp] ${tagName}` });
    console.log(`[Odoo] Tagged order ${odooOrderId}: ${tagName}`);
  } catch (e) { console.error('[Odoo] Tag error:', e.message); }
}

async function cancelOdooOrder(odooOrderId) {
  try {
    await odooCall('sale.order', 'action_cancel', [[odooOrderId]]);
    console.log('[Odoo] Cancelled order', odooOrderId);
  } catch (e) { console.error('[Odoo] Cancel error:', e.message); }
}

// ─── Shopify API ──────────────────────────────────────────────────────────────
async function shopifyApi(path, method = 'GET', body = null) {
  const url = `https://${SHOPIFY_STORE_URL}/admin/api/2025-10${path}`;
  const opts = {
    method,
    headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  return (await fetch(url, opts)).json();
}

async function cancelShopifyOrder(orderId, refund = false) {
  try {
    await shopifyApi(`/orders/${orderId}/cancel.json`, 'POST',
      { reason:'customer', refund });
    console.log(`[Shopify] Cancelled order ${orderId} refund=${refund}`);
  } catch (e) { console.error('[Shopify] Cancel error:', e.message); }
}

function isCod(gateway) {
  if (!gateway) return false;
  const g = gateway.toLowerCase();
  return g.includes('cash') || g.includes('cod') || g === 'manual';
}

// ─── Timer cleanup ────────────────────────────────────────────────────────────
function clearOrderTimers(phone) {
  const s = pendingOrders.get(phone);
  if (!s) return;
  if (s.timer1) clearTimeout(s.timer1);
  if (s.timer2) clearTimeout(s.timer2);
}

async function handleNoResponse(phone, orderId, orderName) {
  console.log(`[Timer] No response from ${phone} — tagging wa-no-response`);
  pendingOrders.delete(phone);
  const odooOrder = await findOdooOrder(orderId).catch(() => null);
  if (odooOrder) await tagOdooOrder(odooOrder.id, 'wa-no-response');
}

// ─── Verify Shopify HMAC ──────────────────────────────────────────────────────
function verifyShopifyHmac(req) {
  if (!SHOPIFY_WEBHOOK_SECRET || SHOPIFY_WEBHOOK_SECRET === 'PLACEHOLDER') return true;
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!hmacHeader) return false;
  const digest = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody, 'utf8').digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch { return false; }
}

// ─── Shopify Webhook: Order Created ──────────────────────────────────────────
app.post('/webhook/order-created', async (req, res) => {
  res.sendStatus(200);
  if (!verifyShopifyHmac(req)) { console.warn('[Webhook] HMAC failed'); return; }

  try {
    const order = req.body;
    if (!order || !order.id) return;

    const orderId        = order.id;
    const orderName      = order.name || `#${orderId}`;
    const total          = order.total_price || '0';
    const currency       = order.currency || 'EGP';
    const paymentGateway = (order.payment_gateway_names || [])[0] || order.gateway || '';
    const rawPhone       = order.shipping_address?.phone || order.billing_address?.phone
                          || order.phone || order.customer?.phone || null;

    if (!rawPhone) { console.log(`[Order] ${orderName} — no phone, skipping`); return; }

    const phone = normalisePhone(rawPhone);
    if (!phone) return;

    console.log(`[Order] ${orderName} | phone:${phone} | gateway:${paymentGateway}`);

    clearOrderTimers(phone);
    await sendWhatsApp(phone, buildConfirmMessage(orderName, total, currency));

    const timer1 = setTimeout(async () => {
      const s = pendingOrders.get(phone);
      if (!s || s.confirmed) return;
      console.log(`[Timer1] Retry for ${phone} order ${orderName}`);
      await sendWhatsApp(phone,
        `تذكير ⏰: لم نتلقَ ردك بعد.\n\n` + buildConfirmMessage(orderName, total, currency));
      const timer2 = setTimeout(() => handleNoResponse(phone, orderId, orderName), 2 * 60 * 60 * 1000);
      pendingOrders.set(phone, { ...pendingOrders.get(phone), timer2 });
    }, 2 * 60 * 60 * 1000);

    pendingOrders.set(phone, { orderId, orderName, paymentGateway, timer1, timer2: null, confirmed: false });

  } catch (err) { console.error('[Order Webhook] Error:', err); }
});

// ─── UltraMsg Webhook: Incoming Reply ────────────────────────────────────────
app.post('/webhook/wa-reply', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body || body.event_type !== 'message_received') return;
    const msg = body.data;
    if (!msg || msg.type !== 'chat') return;

    const from = normalisePhone((msg.from || '').replace(/@c\.us$/, ''));
    const text = (msg.body || '').trim();
    console.log(`[WA Reply] from:${from} text:"${text}"`);

    if (!from || !pendingOrders.has(from)) {
      console.log(`[WA Reply] No pending order for ${from}`); return;
    }

    const state = pendingOrders.get(from);
    if (state.confirmed) return;

    if (text === '1') {
      clearOrderTimers(from);
      state.confirmed = true;
      pendingOrders.set(from, state);
      await sendWhatsApp(from,
        `✅ تم تأكيد طلبك ${state.orderName} بنجاح!\nشكراً لك، سيتم تجهيز طلبك قريباً 🎉`);
      const odooOrder = await findOdooOrder(state.orderId).catch(() => null);
      if (odooOrder) await tagOdooOrder(odooOrder.id, 'wa-confirmed');
      console.log(`[Confirm] ${state.orderName} confirmed`);

    } else if (text === '2') {
      clearOrderTimers(from);
      pendingOrders.delete(from);
      const cod = isCod(state.paymentGateway);
      console.log(`[Cancel] ${state.orderName} | COD:${cod}`);

      if (cod) {
        await cancelShopifyOrder(state.orderId, false);
        const odooOrder = await findOdooOrder(state.orderId).catch(() => null);
        if (odooOrder) await cancelOdooOrder(odooOrder.id);
        await sendWhatsApp(from,
          `❌ تم إلغاء طلبك ${state.orderName}.\nيمكنك الطلب مجدداً في أي وقت 🛍️`);
      } else {
        await cancelShopifyOrder(state.orderId, true);
        await sendWhatsApp(from,
          `❌ تم إلغاء طلبك ${state.orderName} وسيتم رد المبلغ خلال 3-5 أيام عمل 💳`);
      }

    } else {
      await sendWhatsApp(from, `للتأكيد اضغط *1*\nللإلغاء اضغط *2*`);
    }

  } catch (err) { console.error('[WA Reply] Error:', err); }
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'running', time: new Date().toISOString(), pending: pendingOrders.size });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] Port ${PORT} | UltraMsg:${ULTRAMSG_INSTANCE_ID || 'NOT SET'} | Store:${SHOPIFY_STORE_URL || 'NOT SET'} | Odoo:${ODOO_URL || 'NOT SET'}`);
});
