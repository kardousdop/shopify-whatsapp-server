'use strict';
const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const {
  META_PHONE_NUMBER_ID, META_ACCESS_TOKEN, META_APP_SECRET, META_VERIFY_TOKEN,
  SHOPIFY_WEBHOOK_SECRET, SHOPIFY_STORE_URL, SHOPIFY_ADMIN_TOKEN,
  ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, PORT = 3000,
} = process.env;

const GRAPH_VER = 'v22.0';

const app = express();

// Capture raw body for Shopify HMAC
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// ─── Persistent Orders (survives server restarts) ─────────────────────────────
const ORDERS_FILE = path.join('/tmp', 'pending_orders.json');

function loadOrders() {
  try {
    if (fs.existsSync(ORDERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
      console.log(`[Store] Loaded ${Object.keys(data).length} pending orders from disk`);
      return new Map(Object.entries(data));
    }
  } catch (e) { console.error('[Store] Load error:', e.message); }
  return new Map();
}

function saveOrders(map) {
  try {
    const obj = {};
    for (const [k, v] of map) obj[k] = v;
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(obj), 'utf8');
  } catch (e) { console.error('[Store] Save error:', e.message); }
}

const pendingOrders   = loadOrders(); // phone → { shopifyOrderId, orderNumber, totalPrice, status }
const pendingCheckouts = new Map();   // token → { phone, timer } (timers can't be persisted)

// ─── Phone normalization ──────────────────────────────────────────────────────
function normalizePhone(phone) {
  if (!phone) return null;
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('0') && d.length === 11) return '20' + d.slice(1);
  return d;
}

// ─── WhatsApp Cloud API ───────────────────────────────────────────────────────
async function waFetch(path, body) {
  const url = `https://graph.facebook.com/${GRAPH_VER}/${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) console.error('WA error:', JSON.stringify(json));
  return json;
}

async function sendWA(to, text) {
  return waFetch(`${META_PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
}

function buildOrderMessage(firstName, orderNumber, totalPrice) {
  return (
    `مرحباً ${firstName || 'عزيزي العميل'} 👋\n` +
    `شكراً لطلبك من myMayz!\n\n` +
    `📦 رقم الطلب: ${orderNumber}\n` +
    `💰 المبلغ: ${totalPrice} EGP\n\n` +
    `لتأكيد طلبك اضغط *1*\n` +
    `لإلغاء طلبك اضغط *2*\n\n` +
    `سيتم تأكيد طلبك تلقائياً بعد 4 ساعات إذا لم تستجب.`
  );
}

// ─── Shopify API ──────────────────────────────────────────────────────────────
function verifyShopifyHmac(req) {
  // Bypassed — Railway URL is private
  return true;
}

async function shopifyFetch(path, opts = {}) {
  const url = `https://${SHOPIFY_STORE_URL}/admin/api/2025-10/${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  return res.json();
}

async function tagShopifyOrder(orderId, newTag) {
  try {
    const data = await shopifyFetch(`orders/${orderId}.json`);
    const current = (data.order?.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    const filtered = current.filter(t => !t.startsWith('COD-'));
    filtered.push(newTag);
    await shopifyFetch(`orders/${orderId}.json`, {
      method: 'PUT',
      body: JSON.stringify({ order: { id: orderId, tags: filtered.join(', ') } }),
    });
    console.log(`Tagged order ${orderId} as ${newTag}`);
  } catch (e) {
    console.error('Tag error:', e.message);
  }
}

// ─── Odoo JSON-RPC ────────────────────────────────────────────────────────────
let odooSessionUid    = null;
let odooSessionDb     = null;
let odooSessionCookie = null;  // session_id cookie required for call_kw

async function odooRpc(endpoint, params, cookie = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;

  const r = await fetch(`${ODOO_URL}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', id: 1, params }),
  });

  // Capture session cookie from auth response
  const setCookie = r.headers.get('set-cookie');
  if (setCookie) {
    const match = setCookie.match(/session_id=[^;]+/);
    if (match) odooSessionCookie = match[0];
  }

  const d = await r.json();
  if (d.error) throw new Error(JSON.stringify(d.error));
  return d.result;
}

async function odooEnsureSession() {
  if (odooSessionUid && odooSessionCookie) return;

  // Auto-discover DB name (Odoo Online uses a different internal name)
  let db = ODOO_DB;
  try {
    const dbs = await odooRpc('/web/database/list', {});
    if (Array.isArray(dbs) && dbs.length > 0) {
      console.log('[Odoo] Available DBs:', dbs);
      db = dbs.includes(ODOO_DB) ? ODOO_DB : dbs[0];
      console.log('[Odoo] Using DB:', db);
    }
  } catch (e) {
    console.warn('[Odoo] Could not list DBs:', e.message, '— using env ODOO_DB:', ODOO_DB);
  }

  const session = await odooRpc('/web/session/authenticate', {
    db, login: ODOO_USERNAME, password: ODOO_PASSWORD,
  });
  if (!session?.uid) throw new Error(`Odoo auth failed — db:${db} user:${ODOO_USERNAME}`);
  odooSessionUid = session.uid;
  odooSessionDb  = session.db || db;
  console.log(`[Odoo] Authenticated — uid:${odooSessionUid} db:${odooSessionDb} cookie:${odooSessionCookie}`);
}

async function odooCallKw(model, method, args, kwargs = {}) {
  await odooEnsureSession();
  try {
    return await odooRpc('/web/dataset/call_kw', { model, method, args, kwargs }, odooSessionCookie);
  } catch (e) {
    // Session expired — re-authenticate once and retry
    if (e.message.includes('SessionExpired') || e.message.includes('Session expired')) {
      console.warn('[Odoo] Session expired — re-authenticating...');
      odooSessionUid = null;
      odooSessionCookie = null;
      await odooEnsureSession();
      return await odooRpc('/web/dataset/call_kw', { model, method, args, kwargs }, odooSessionCookie);
    }
    throw e;
  }
}

async function findOdooOrder(shopifyOrderName) {
  const nameClean = String(shopifyOrderName).replace(/^#/, '');
  const variants  = [shopifyOrderName, nameClean, `#${nameClean}`];

  const byName = await odooCallKw('sale.order', 'search', [[['name', 'in', variants]]]);
  const byRef  = await odooCallKw('sale.order', 'search', [[['client_order_ref', 'in', variants]]]);
  const ids    = [...new Set([...(byName || []), ...(byRef || [])])];

  if (!ids.length) {
    console.warn(`[Odoo] Order not found for "${shopifyOrderName}"`);
    return null;
  }
  const records = await odooCallKw('sale.order', 'read',
    [ids, ['id', 'name', 'state', 'client_order_ref']]);
  console.log('[Odoo] Found order:', JSON.stringify(records[0]));
  return records[0] || null;
}

async function cancelOdooOrder(odooId) {
  // 1. Unlock (needed if state is "sale" / locked)
  try {
    await odooCallKw('sale.order', 'action_unlock', [[odooId]]);
    console.log(`[Odoo] Unlocked order ${odooId}`);
  } catch (e) {
    console.log(`[Odoo] Unlock skipped: ${e.message}`);
  }

  // 2. Cancel
  await odooCallKw('sale.order', 'action_cancel', [[odooId]]);
  console.log(`[Odoo] Cancelled order ${odooId}`);

  // 3. Sync cancellation to Shopify via connector button
  const methods = [
    'action_cancel_in_shopify',
    'shopify_cancel_order',
    'cancel_in_shopify',
    'action_shopify_cancel',
  ];
  let synced = false;
  for (const m of methods) {
    try {
      await odooCallKw('sale.order', m, [[odooId]]);
      console.log(`[Odoo] Cancel-In-Shopify triggered via: ${m}`);
      synced = true;
      break;
    } catch (e) {
      console.log(`[Odoo] ${m}: not found`);
    }
  }
  if (!synced) console.warn('[Odoo] Cancel-In-Shopify method not found — may need manual sync');
}

// Retry until Shopify→Odoo sync happens (can take up to 45 min)
async function cancelInOdooWithRetry(orderNumber, retriesLeft, intervalMs) {
  try {
    const odooOrder = await findOdooOrder(orderNumber);
    if (odooOrder) {
      await cancelOdooOrder(odooOrder.id);
      return;
    }
  } catch (e) {
    console.error(`[Odoo] Retry cancel error for ${orderNumber}:`, e.message);
    // Reset cached session on auth errors so next retry re-authenticates
    odooSessionUid = null;
  }

  if (retriesLeft <= 0) {
    console.warn(`[Odoo] Gave up cancelling ${orderNumber} after all retries`);
    return;
  }
  console.log(`[Odoo] ${orderNumber} not in Odoo yet — retry in ${intervalMs / 60000}m (${retriesLeft} left)`);
  setTimeout(() => cancelInOdooWithRetry(orderNumber, retriesLeft - 1, intervalMs), intervalMs);
}

// ─── Auto-Confirm Logic ───────────────────────────────────────────────────────
function scheduleAutoConfirm(phone, shopifyOrderId, orderNumber, createdAt) {
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  const elapsed    = Date.now() - createdAt;
  const remaining  = Math.max(FOUR_HOURS - elapsed, 0);

  console.log(`[AutoConfirm] ${orderNumber} — auto-confirm in ${Math.round(remaining / 60000)} min`);

  setTimeout(async () => {
    const current = pendingOrders.get(phone);
    if (!current || current.shopifyOrderId !== shopifyOrderId || current.status !== 'pending') return;
    console.log(`[AutoConfirm] ${orderNumber} — 4h elapsed, confirming now`);
    current.status = 'confirmed';
    pendingOrders.set(phone, current);
    saveOrders(pendingOrders);
    await tagShopifyOrder(shopifyOrderId, 'COD-Confirmed');
    await sendWA(phone, `✅ تم تأكيد طلبك ${orderNumber} تلقائياً.\nشكراً لك، سيتم شحن طلبك قريباً 🎉`);
  }, remaining);
}

// Restore timers for all pending orders loaded from disk on startup
for (const [phone, order] of pendingOrders) {
  if (order.status === 'pending' && order.createdAt) {
    scheduleAutoConfirm(phone, order.shopifyOrderId, order.orderNumber, order.createdAt);
  }
}

// ─── Meta Webhook: Verify ─────────────────────────────────────────────────────
app.get('/webhook/meta', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === META_VERIFY_TOKEN) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// ─── Meta Webhook: WhatsApp Replies ──────────────────────────────────────────
app.post('/webhook/meta', async (req, res) => {
  res.sendStatus(200);
  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    for (const msg of messages || []) {
      if (msg.type !== 'text') continue;
      const from = msg.from;
      const text = (msg.text?.body || '').trim();
      console.log(`[WA Reply] from:${from} text:"${text}"`);

      const order = pendingOrders.get(from);
      if (!order) {
        console.warn(`[WA Reply] No pending order for ${from}`);
        continue;
      }
      if (order.status !== 'pending') {
        console.log(`[WA Reply] Order ${order.orderNumber} already ${order.status}`);
        continue;
      }

      const isConfirm = /^(1|yes|ok|نعم|تأكيد|اوكي|موافق|confirm)$/i.test(text);
      const isCancel  = /^(2|no|لا|إلغاء|الغاء|كنسل|cancel)$/i.test(text);

      if (isConfirm) {
        order.status = 'confirmed';
        pendingOrders.set(from, order);
        saveOrders(pendingOrders);
        console.log(`[Confirm] ${order.orderNumber} confirmed by ${from}`);
        await tagShopifyOrder(order.shopifyOrderId, 'COD-Confirmed');
        await sendWA(from, `✅ تم تأكيد طلبك ${order.orderNumber} بنجاح!\nشكراً لك، سيتم شحن طلبك قريباً 🎉`);

      } else if (isCancel) {
        order.status = 'cancelled';
        pendingOrders.set(from, order);
        saveOrders(pendingOrders);
        console.log(`[Cancel] ${order.orderNumber} cancelled by ${from}`);
        await tagShopifyOrder(order.shopifyOrderId, 'COD-Cancelled');
        await sendWA(from, `❌ تم إلغاء طلبك ${order.orderNumber}.\nيمكنك الطلب مجدداً في أي وقت 🛍️`);
        cancelInOdooWithRetry(order.orderNumber, 20, 3 * 60 * 1000);
        pendingOrders.delete(from);
        saveOrders(pendingOrders);

      } else {
        await sendWA(from, `للتأكيد اضغط *1*\nللإلغاء اضغط *2*`);
      }
    }
  } catch (e) {
    console.error('[WA Reply] Error:', e.message);
  }
});

// ─── Shopify Webhook: Order Created ──────────────────────────────────────────
app.post('/webhook/shopify', async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.sendStatus(401);
  res.sendStatus(200);
  try {
    const order = req.body;
    const gateway      = (order.payment_gateway || order.gateway || '').toLowerCase();
    const gatewayNames = (Array.isArray(order.payment_gateway_names) ? order.payment_gateway_names : []).join(',').toLowerCase();
    const allGateways  = (gateway + ',' + gatewayNames).toLowerCase();
    const isEmpty      = allGateways.replace(/,/g, '').trim() === '';
    const isCOD        = isEmpty || ['cash_on_delivery', 'cod', 'manual', 'cash'].some(g => allGateways.includes(g));

    console.log(`[Order] ${order.name} | gateway: "${gateway}" | names: "${gatewayNames}" | isCOD: ${isCOD}`);
    if (!isCOD) { console.log('[Order] Not COD — skipping'); return; }

    const addr       = order.shipping_address || order.billing_address || {};
    const phone      = normalizePhone(addr.phone || order.phone || '');
    const firstName  = addr.first_name || order.customer?.first_name || '';
    const orderNumber = order.name || String(order.order_number);
    const totalPrice = order.total_price;

    if (!phone) { console.warn(`[Order] No phone for ${orderNumber}`); return; }

    console.log(`[Order] Sending WA to ${phone} for ${orderNumber}`);
    const waResult = await sendWA(phone, buildOrderMessage(firstName, orderNumber, totalPrice));
    console.log('[Order] WA result:', JSON.stringify(waResult));

    await tagShopifyOrder(order.id, 'COD-Pending');
    const createdAt = Date.now();
    pendingOrders.set(phone, { shopifyOrderId: order.id, orderNumber, totalPrice, status: 'pending', createdAt });
    saveOrders(pendingOrders);

    scheduleAutoConfirm(phone, order.id, orderNumber, createdAt);

  } catch (e) {
    console.error('[Order Webhook] Error:', e.message, e.stack);
  }
});

// ─── Shopify Webhook: Abandoned Cart ─────────────────────────────────────────
app.post('/webhook/checkout', async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.sendStatus(401);
  res.sendStatus(200);
  try {
    const checkout = req.body;
    if (!checkout?.token || checkout.completed_at) return;

    const phone = normalizePhone(
      checkout.shipping_address?.phone ||
      checkout.billing_address?.phone ||
      checkout.phone || ''
    );
    if (!phone || phone.length < 10) return;

    const token        = checkout.token;
    const checkoutUrl  = checkout.abandoned_checkout_url;
    const lineItems    = checkout.line_items || [];
    const productTitle = lineItems.map(i => i.title).join(', ') || 'منتجاتك';
    const productImage = lineItems[0]?.image_url || null;
    const totalPrice   = checkout.total_price || '0';
    const currency     = checkout.currency || 'EGP';

    if (pendingCheckouts.has(token)) clearTimeout(pendingCheckouts.get(token).timer);

    const timer = setTimeout(async () => {
      pendingCheckouts.delete(token);
      try {
        const data = await shopifyFetch(`checkouts/${token}.json`);
        if (data?.checkout?.completed_at) { console.log(`[Cart] ${token} completed — no reminder`); return; }

        if (productImage) {
          await waFetch(`${META_PHONE_NUMBER_ID}/messages`, {
            messaging_product: 'whatsapp', to: phone,
            type: 'image', image: { link: productImage, caption: productTitle },
          });
        }
        await sendWA(phone,
          `مرحباً! 👋 نسيت شيئاً في سلتك 🛒\n\n` +
          `🛍️ ${productTitle}\n` +
          `💰 الإجمالي: ${totalPrice} ${currency}\n\n` +
          `أكمل طلبك الآن 👇\n${checkoutUrl}`
        );
        console.log(`[Cart] Reminder sent to ${phone}`);
      } catch (e) { console.error('[Cart] Send error:', e.message); }
    }, 15 * 60 * 1000);

    pendingCheckouts.set(token, { phone, timer });
    console.log(`[Cart] Timer set — phone:${phone} token:${token}`);
  } catch (e) {
    console.error('[Cart Webhook] Error:', e.message);
  }
});

// ─── Admin: Test Odoo cancel (remove after confirmed working) ─────────────────
app.get('/admin/cancel-odoo/:odooId', async (req, res) => {
  const odooId = parseInt(req.params.odooId);
  const results = [];
  try {
    // List DBs
    try {
      const dbs = await odooRpc('/web/database/list', {});
      results.push(`Available DBs: ${JSON.stringify(dbs)}`);
    } catch (e) { results.push(`DB list: ${e.message}`); }

    // Authenticate
    let db = ODOO_DB;
    try {
      const dbs = await odooRpc('/web/database/list', {});
      if (Array.isArray(dbs) && dbs.length > 0) db = dbs[0];
    } catch (_) {}
    const session = await odooRpc('/web/session/authenticate', {
      db, login: ODOO_USERNAME, password: ODOO_PASSWORD,
    });
    results.push(`Auth: uid=${session?.uid} db=${session?.db} cookie:${odooSessionCookie}`);
    if (!session?.uid) { res.send('<pre>' + results.join('\n') + '</pre>'); return; }

    // Cache session for reuse
    odooSessionUid = session.uid;
    odooSessionDb  = session.db || db;
    const cookie   = odooSessionCookie;

    // Read order
    const records = await odooRpc('/web/dataset/call_kw', {
      model: 'sale.order', method: 'read',
      args: [[odooId], ['id', 'name', 'state', 'client_order_ref']], kwargs: {},
    }, cookie);
    results.push(`Order: ${JSON.stringify(records?.[0])}`);

    // Unlock
    try {
      await odooRpc('/web/dataset/call_kw', {
        model: 'sale.order', method: 'action_unlock', args: [[odooId]], kwargs: {},
      }, cookie);
      results.push('Unlock: OK');
    } catch (e) { results.push(`Unlock skipped: ${e.message}`); }

    // Cancel
    await odooRpc('/web/dataset/call_kw', {
      model: 'sale.order', method: 'action_cancel', args: [[odooId]], kwargs: {},
    }, cookie);
    results.push('Cancel in Odoo: OK ✅');

    // Try Cancel-In-Shopify methods
    const methods = ['action_cancel_in_shopify', 'shopify_cancel_order', 'cancel_in_shopify', 'action_shopify_cancel'];
    for (const m of methods) {
      try {
        await odooRpc('/web/dataset/call_kw', {
          model: 'sale.order', method: m, args: [[odooId]], kwargs: {},
        }, cookie);
        results.push(`Cancel In Shopify: ✅ via ${m}`);
        break;
      } catch (e) { results.push(`${m}: ❌ ${e.message.slice(0, 80)}`); }
    }
  } catch (e) { results.push(`FATAL ERROR: ${e.message}`); }
  res.send('<pre>' + results.join('\n') + '</pre>');
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    time: new Date().toISOString(),
    pending_orders: pendingOrders.size,
    pending_carts: pendingCheckouts.size,
    odoo: ODOO_URL || 'NOT SET',
    store: SHOPIFY_STORE_URL || 'NOT SET',
  });
});

app.listen(PORT, () => console.log(`✅ Server on port ${PORT} | store:${SHOPIFY_STORE_URL} | odoo:${ODOO_URL}`));
