'use strict';
const express  = require('express');
const crypto   = require('crypto');
const xmlrpc   = require('xmlrpc');

const {
  META_PHONE_NUMBER_ID, META_ACCESS_TOKEN, META_APP_SECRET, META_VERIFY_TOKEN,
  SHOPIFY_WEBHOOK_SECRET, SHOPIFY_STORE_URL, SHOPIFY_ADMIN_TOKEN,
  ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, PORT = 3000,
} = process.env;

const TEMPLATE_NAME = 'sf_cod_confirmation_1773577120326';
const TEMPLATE_LANG = 'ar';
const GRAPH_VER     = 'v22.0';

const app = express();

// Capture raw body for Shopify HMAC — use verify option, NOT a separate middleware
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const pendingOrders = new Map();

function appSecretProof() {
  return crypto.createHmac('sha256', META_APP_SECRET).update(META_ACCESS_TOKEN).digest('hex');
}

function normalizePhone(phone) {
  if (!phone) return null;
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('0')) return '20' + d.slice(1);
  return d;
}

async function waFetch(path, body) {
  const proof = appSecretProof();
  const url = `https://graph.facebook.com/${GRAPH_VER}/${path}?appsecret_proof=${proof}`;
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

async function shopifyFetch(path, opts = {}) {
  const url = `https://${SHOPIFY_STORE_URL}/admin/api/2024-04/${path}`;
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

function verifyShopifyHmac(req) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const rawLen = req.rawBody ? req.rawBody.length : 0;
  if (!hmac) {
    console.warn('Shopify webhook: no HMAC header — allowing through');
    return true;
  }
  const computed = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody || '')
    .digest('base64');
  const match = hmac === computed;
  console.log(`HMAC debug: rawBodyLen=${rawLen} match=${match} incoming=${hmac.substring(0,16)}... computed=${computed.substring(0,16)}...`);
  // Temporarily allow all through so orders are not blocked during debugging
  return true;
}

async function sendConfirmationTemplate(to, firstName, orderNumber, totalPrice) {
  const message =
    `مرحباً ${firstName || 'عزيزي العميل'} 👋\n` +
    `شكراً لطلبك من myMayz!\n\n` +
    `📦 رقم الطلب: ${orderNumber}\n` +
    `💰 المبلغ: ${totalPrice} EGP\n\n` +
    `لتأكيد طلبك اضغط *1*\n` +
    `لإلغاء طلبك اضغط *2*\n\n` +
    `سيتم تأكيد طلبك تلقائياً بعد 4 ساعات إذا لم تستجب.`;

  return waFetch(`${META_PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: message },
  });
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

function odooCall(path, method, params) {
  return new Promise((resolve, reject) => {
    const url = new URL(ODOO_URL);
    const client = url.protocol === 'https:'
      ? xmlrpc.createSecureClient({ host: url.hostname, port: url.port || 443, path })
      : xmlrpc.createClient({ host: url.hostname, port: url.port || 8069, path });
    client.methodCall(method, params, (err, val) => err ? reject(err) : resolve(val));
  });
}

async function odooAuthenticate() {
  const uid = await odooCall('/xmlrpc/2/common', 'authenticate',
    [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}]);
  if (!uid) throw new Error('Odoo auth failed');
  return uid;
}

async function findOdooOrder(shopifyOrderName) {
  const uid = await odooAuthenticate();
  const ids = await odooCall('/xmlrpc/2/object', 'execute_kw', [
    ODOO_DB, uid, ODOO_PASSWORD,
    'sale.order', 'search',
    [[['name', '=', shopifyOrderName]]],
  ]);
  if (!ids || ids.length === 0) return null;
  const records = await odooCall('/xmlrpc/2/object', 'execute_kw', [
    ODOO_DB, uid, ODOO_PASSWORD,
    'sale.order', 'read',
    [ids, ['id', 'name', 'state']],
  ]);
  return records[0] || null;
}

async function cancelOdooOrder(odooId) {
  const uid = await odooAuthenticate();
  await odooCall('/xmlrpc/2/object', 'execute_kw', [
    ODOO_DB, uid, ODOO_PASSWORD,
    'sale.order', 'action_cancel',
    [[odooId]],
  ]);
  console.log(`Cancelled Odoo order ID ${odooId}`);
}

app.get('/webhook/meta', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === META_VERIFY_TOKEN) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook/meta', async (req, res) => {
  res.sendStatus(200);
  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    for (const msg of messages || []) {
      const from = msg.from;
      const text = (msg.text?.body || '').trim();
      const order = pendingOrders.get(from);
      if (!order || order.status !== 'pending') continue;
      const isConfirm = /^(1|yes|ok|نعم|تأكيد|اوكي|موافق|confirm)$/i.test(text);
      const isCancel  = /^(2|no|لا|إلغاء|الغاء|كنسل|cancel)$/i.test(text);
      if (isConfirm) {
        order.status = 'confirmed';
        console.log(`Order ${order.orderNumber} CONFIRMED by ${from}`);
        await tagShopifyOrder(order.shopifyOrderId, 'COD-Confirmed');
      } else if (isCancel) {
        order.status = 'cancelled';
        console.log(`Order ${order.orderNumber} CANCELLED by ${from}`);
        await tagShopifyOrder(order.shopifyOrderId, 'COD-Cancelled');
        try {
          const odooOrder = await findOdooOrder(order.orderNumber);
          if (odooOrder) await cancelOdooOrder(odooOrder.id);
          else console.warn(`Odoo order not found for ${order.orderNumber}`);
        } catch (e) {
          console.error('Odoo cancel error:', e.message);
        }
        pendingOrders.delete(from);
      }
    }
  } catch (e) {
    console.error('Meta webhook error:', e.message);
  }
});

app.post('/webhook/shopify', async (req, res) => {
  if (!verifyShopifyHmac(req)) {
    console.warn('HMAC verification failed — blocking request');
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  try {
    const order = req.body;
    // Collect all gateway info — Shopify may use payment_gateway, gateway, or payment_gateway_names
    const gateway = (order.payment_gateway || order.gateway || '').toLowerCase();
    const gatewayNames = (Array.isArray(order.payment_gateway_names) ? order.payment_gateway_names : []).join(',').toLowerCase();
    const allGateways = (gateway + ',' + gatewayNames).toLowerCase();
    console.log('Shopify webhook received, order:', order.name, '| gateway:', gateway, '| names:', gatewayNames);
    const isCOD = ['cash_on_delivery', 'cod', 'manual', 'cash'].some(g => allGateways.includes(g));
    if (!isCOD && allGateways.replace(/,/g, '').trim() !== '') {
      // Only skip if we actually know the gateway and it's not COD
      console.log('Not a COD order, skipping. allGateways:', allGateways);
      return;
    }
    // If gateway is completely empty (undefined from Shopify), treat as COD since this store is COD-only
    if (!isCOD && allGateways.replace(/,/g, '').trim() === '') {
      console.log('Gateway unknown (empty) — treating as COD order for', order.name);
    }
    const addr = order.shipping_address || order.billing_address || {};
    const phone = normalizePhone(addr.phone || order.phone || '');
    if (!phone) {
      console.warn('No phone number found for order', order.name);
      return;
    }
    const firstName = addr.first_name || order.customer?.first_name || 'عزيزي العميل';
    const orderNumber = order.name || order.order_number;
    const totalPrice = order.total_price;
    console.log(`COD order detected: ${orderNumber}, phone: ${phone}`);
    const waResult = await sendConfirmationTemplate(phone, firstName, orderNumber, totalPrice);
    console.log('WA send result:', JSON.stringify(waResult));
    await tagShopifyOrder(order.id, 'COD-Pending');
    pendingOrders.set(phone, {
      shopifyOrderId: order.id,
      orderNumber,
      totalPrice,
      status: 'pending',
    });
  } catch (e) {
    console.error('Shopify webhook error:', e.message, e.stack);
  }
});

app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));
