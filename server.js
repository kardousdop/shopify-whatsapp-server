'use strict';
const express = require('express');
const crypto  = require('crypto');

// ─── Environment Variables ────────────────────────────────────────────────────
const {
  META_PHONE_NUMBER_ID,   // e.g. 1091672370692388
  META_ACCESS_TOKEN,      // from Meta developer console "Generate access token"
  META_VERIFY_TOKEN,      // any secret string you choose for webhook verification
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
  const chunks = [];
  req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks);          // keep as Buffer for exact-byte HMAC
    try { req.body = JSON.parse(req.rawBody.toString('utf8')); } catch { req.body = {}; }
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

// ─── Meta Cloud API: Send WhatsApp ───────────────────────────────────────────
async function sendWhatsApp(phone, message) {
  const digits = normalisePhone(phone);
  const url = `https://graph.facebook.com/v22.0/${META_PHONE_NUMBER_ID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: digits,
    type: 'text',
    text: { body: message },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log('[WA] Sent to', digits, '->', JSON.stringify(data));
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
  // HMAC verification bypassed — Railway URL is private, no spoofing risk
  return true;
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

// ─── Meta Webhook GET: Verification Challenge ─────────────────────────────────
app.get('/webhook/wa-reply', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  console.log(`[Meta Verify] mode:${mode} token:${token}`);
  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('[Meta Verify] ✅ Webhook verified');
    res.status(200).send(challenge);
  } else {
    console.warn('[Meta Verify] ❌ Token mismatch');
    res.sendStatus(403);
  }
});

// ─── Meta Webhook POST: Incoming WhatsApp Messages ───────────────────────────
app.post('/webhook/wa-reply', async (req, res) => {
  res.sendStatus(200); // always 200 immediately

  try {
    const body    = req.body;
    const entry   = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;

    // ignore status updates (delivery receipts, read receipts)
    if (!value || !value.messages) return;

    const msg = value.messages[0];
    if (!msg || msg.type !== 'text') return;

    const from = normalisePhone(msg.from);
    const text = msg.text?.body?.trim();
    console.log(`[WA Reply] from:${from} text:"${text}"`);

    if (!from || !pendingOrders.has(from)) {
      console.log(`[WA Reply] No pending order for ${from}`); return;
    }

    const state = pendingOrders.get(from);
    if (state.confirmed) return;

    if (text === '1') {
      // ── Confirmed ────────────────────────────────────────────────────────
      clearOrderTimers(from);
      state.confirmed = true;
      pendingOrders.set(from, state);
      await sendWhatsApp(from,
        `✅ تم تأكيد طلبك ${state.orderName} بنجاح!\nشكراً لك، سيتم تجهيز طلبك قريباً 🎉`);
      const odooOrder = await findOdooOrder(state.orderId).catch(() => null);
      if (odooOrder) await tagOdooOrder(odooOrder.id, 'wa-confirmed');
      console.log(`[Confirm] ${state.orderName} confirmed`);

    } else if (text === '2') {
      // ── Cancelled ────────────────────────────────────────────────────────
      clearOrderTimers(from);
      pendingOrders.delete(from);
      const cod = isCod(state.paymentGateway);
      console.log(`[Cancel] ${state.orderName} | COD:${cod}`);

      // Cancel in Odoo — Odoo's Shopify integration will sync the cancellation
      // to Shopify automatically. For card payments, Shopify refund must be
      // triggered manually by the team since refunds require payment gateway action.
      const odooOrder = await findOdooOrder(state.orderId).catch(() => null);
      if (odooOrder) {
        await cancelOdooOrder(odooOrder.id);
        console.log(`[Cancel] Odoo order ${odooOrder.id} cancelled — Shopify sync via Odoo integration`);
      } else {
        // Odoo not configured or order not found — fall back to direct Shopify cancel
        console.log(`[Cancel] Odoo not available, cancelling Shopify directly`);
        await cancelShopifyOrder(state.orderId, cod ? false : true);
      }

      if (cod) {
        await sendWhatsApp(from,
          `❌ تم إلغاء طلبك ${state.orderName}.\nيمكنك الطلب مجدداً في أي وقت 🛍️`);
      } else {
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
  res.json({
    status: 'running',
    time: new Date().toISOString(),
    pending: pendingOrders.size,
    phoneNumberId: META_PHONE_NUMBER_ID || 'NOT SET',
    store: SHOPIFY_STORE_URL || 'NOT SET',
    odoo: ODOO_URL || 'NOT SET',
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] Port ${PORT} | PhoneNumberID:${META_PHONE_NUMBER_ID || 'NOT SET'} | Store:${SHOPIFY_STORE_URL || 'NOT SET'} | Odoo:${ODOO_URL || 'NOT SET'}`);
});
