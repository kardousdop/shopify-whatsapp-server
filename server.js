'use strict';
const express = require('express');
const crypto  = require('crypto');
const xmlrpc  = require('xmlrpc');

// ── Environment Variables ──────────────────────────────────────────────────
const {
  META_PHONE_NUMBER_ID,
  META_ACCESS_TOKEN,
  META_APP_SECRET,
  META_VERIFY_TOKEN,
  SHOPIFY_WEBHOOK_SECRET,
  SHOPIFY_STORE_URL,
  SHOPIFY_ADMIN_TOKEN,
  ODOO_URL,
  ODOO_DB,
  ODOO_USERNAME,
  ODOO_PASSWORD,
  PORT = 3000,
} = process.env;

const TEMPLATE_NAME = 'sf_cod_confirmation_1773577120326';
const TEMPLATE_LANG = 'ar';
const GRAPH_VER     = 'v22.0';

const app = express();

// phone => { shopifyOrderId, shopifyOrderName, odooOrderId }
const pendingOrders = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────

function appSecretProof() {
  return crypto.createHmac('sha256', META_APP_SECRET).update(META_ACCESS_TOKEN).digest('hex');
}

function verifyShopifyHmac(rawBody, signature) {
  if (!signature) return false;
  const computed = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature)); }
  catch { return false; }
}

function normalizePhone(phone) {
  if (!phone) return null;
  let d = phone.replace(/\D/g, '');
  if (d.startsWith('0')) d = '20' + d.slice(1);
  if (d.length === 10 && d.startsWith('1')) d = '20' + d;
  return d || null;
}

// ── Odoo ───────────────────────────────────────────────────────────────────

function odooClient(path) {
  const u = new URL(ODOO_URL);
  const opts = {
    host: u.hostname,
    port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
    path,
  };
  return u.protocol === 'https:'
    ? xmlrpc.createSecureClient(opts)
    : xmlrpc.createClient(opts);
}

async function odooLogin() {
  return new Promise((resolve, reject) => {
    odooClient('/xmlrpc/2/common').methodCall(
      'authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}],
      (err, uid) => (err || !uid ? reject(err || new Error('Odoo auth failed')) : resolve(uid))
    );
  });
}

async function odooExecute(model, method, args, kwargs = {}) {
  const uid = await odooLogin();
  return new Promise((resolve, reject) => {
    odooClient('/xmlrpc/2/object').methodCall(
      'execute_kw', [ODOO_DB, uid, ODOO_PASSWORD, model, method, args, kwargs],
      (err, result) => (err ? reject(err) : resolve(result))
    );
  });
}

async function findOdooOrder(shopifyOrderName) {
  const rows = await odooExecute(
    'sale.order', 'search_read',
    [[['client_order_ref', '=', String(shopifyOrderName)]]],
    { fields: ['id', 'name', 'state'], limit: 1 }
  );
  return rows[0] || null;
}

// ── WhatsApp ───────────────────────────────────────────────────────────────

async function waFetch(endpoint, body) {
  const proof = appSecretProof();
  const url = `https://graph.facebook.com/${GRAPH_VER}/${endpoint}?appsecret_proof=${proof}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${META_ACCESS_TOKEN}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log('[WhatsApp]', JSON.stringify(data));
  return data;
}

async function sendConfirmationTemplate(to, firstName, orderNumber, totalPrice) {
  return waFetch(`${META_PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: TEMPLATE_NAME,
      language: { code: TEMPLATE_LANG },
      components: [{
        type: 'body',
        parameters: [
          { type: 'text', parameter_name: 'customer_first_name', text: String(firstName) },
          { type: 'text', parameter_name: 'order_number',        text: String(orderNumber) },
          { type: 'text', parameter_name: 'total_price',         text: String(totalPrice) },
        ],
      }],
    },
  });
}

async function sendText(to, text) {
  return waFetch(`${META_PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
}

// ── Routes ─────────────────────────────────────────────────────────────────

// Meta webhook verification
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === META_VERIFY_TOKEN) {
    console.log('[Meta] Webhook verified');
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// Incoming WhatsApp messages
app.post('/webhook', express.json(), async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    let reply = '';
    if (message.type === 'button')      reply = message.button?.payload || message.button?.text || '';
    else if (message.type === 'text')   reply = message.text?.body?.trim() || '';

    console.log(`[WA Reply] from=${from} text="${reply}"`);

    const order = pendingOrders.get(from);
    if (!order) return;

    const isConfirm = reply === '1' || /confirm/i.test(reply);
    const isCancel  = reply === '2' || /cancel/i.test(reply);

    if (isConfirm && order.odooOrderId) {
      await odooExecute('sale.order', 'action_confirm', [[order.odooOrderId]]);
      await sendText(from, `تم تأكيد طلبك ${order.shopifyOrderName}. شكراً!`);
      pendingOrders.delete(from);
    } else if (isCancel && order.odooOrderId) {
      await odooExecute('sale.order', 'action_cancel', [[order.odooOrderId]]);
      await sendText(from, `تم إلغاء طلبك ${order.shopifyOrderName}.`);
      pendingOrders.delete(from);
    }
  } catch (err) {
    console.error('[WA Reply Error]', err.message);
  }
});

// Shopify order webhook
app.post('/webhook/shopify', express.raw({ type: '*/*' }), async (req, res) => {
  const sig = req.headers['x-shopify-hmac-sha256'];
  if (!verifyShopifyHmac(req.body, sig)) {
    console.warn('[Shopify] HMAC failed');
    return res.sendStatus(401);
  }
  res.sendStatus(200);

  try {
    const order = JSON.parse(req.body.toString());

    // COD only
    const gateway = (order.payment_gateway || order.gateway || '').toLowerCase();
    const isCOD = ['cash_on_delivery', 'cod', 'manual'].includes(gateway);
    if (!isCOD) {
      console.log(`[Shopify] Skipped order ${order.name} — gateway: ${gateway}`);
      return;
    }

    console.log(`[Shopify] COD order: ${order.name}`);

    const phone = normalizePhone(
      order.shipping_address?.phone || order.billing_address?.phone || order.customer?.phone
    );
    if (!phone) {
      console.warn(`[Shopify] No phone for order ${order.name}`);
      return;
    }

    const firstName  = order.customer?.first_name || order.shipping_address?.first_name || 'عزيزي العميل';
    const orderNum   = String(order.order_number || order.name);
    const totalPrice = `${order.total_price} ${order.currency}`;

    // Look up Odoo order
    let odooOrder = null;
    try { odooOrder = await findOdooOrder(order.name); }
    catch (e) { console.error('[Odoo] lookup failed:', e.message); }

    pendingOrders.set(phone, {
      shopifyOrderId:   order.id,
      shopifyOrderName: order.name,
      odooOrderId:      odooOrder?.id || null,
    });

    await sendConfirmationTemplate(phone, firstName, orderNum, totalPrice);
  } catch (err) {
    console.error('[Shopify Error]', err.message);
  }
});

// Health check
app.get('/', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`[Server] Listening on port ${PORT}`));
