'use strict';
const express  = require('express');
const crypto   = require('crypto');
const xmlrpc   = require('xmlrpc');

// ─── Environment Variables ────────────────────────────────────────────────────
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

// Raw body capture for Shopify HMAC verification
app.use((req, res, next) => {
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', () => { req.rawBody = raw; next(); });
});
app.use(express.json());

// In-memory map: normalizedPhone => { shopifyOrderId, orderNumber, totalPrice, status }
const pendingOrders = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VER}/${path}?appsecret_proof=${proof}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  return res.json();
}

async function shopifyFetch(path, opts = {}) {
  const res = await fetch(
    `https://${SHOPIFY_STORE_URL}/admin/api/2024-04/${path}`,
    {
      ...opts,
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    }
  );
  return res.json();
}

function verifyShopifyHmac(req) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac || !SHOPIFY_WEBHOOK_SECRET) return false;
  const computed = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody || '')
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(computed));
  } catch { return false; }
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

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

// ─── Shopify Tagging ──────────────────────────────────────────────────────────

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
    console.log(`[TAG] Order ${orderId} → ${newTag}`);
  } catch (e) {
    console.error('[TAG] Error:', e.message);
  }
}

// ─── Odoo XML-RPC ────────────────────────────────────────────────────────────

function odooClient(path) {
  const u = new URL(ODOO_URL);
  return u.protocol === 'https:'
    ? xmlrpc.createSecureClient({ host: u.hostname, port: 443, path })
    : xmlrpc.createClient({ host: u.hostname, port: Number(u.port) || 80, path });
}

function odooCall(client, method, params) {
  return new Promise((resolve, reject) =>
    client.methodCall(method, params, (err, val) => (err ? reject(err) : resolve(val)))
  );
}

async function odooAuthenticate() {
  const client = odooClient('/xmlrpc/2/common');
  return odooCall(client, 'authenticate', [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}]);
}

async function findOdooOrder(shopifyOrderName) {
  try {
    const uid = await odooAuthenticate();
    const client = odooClient('/xmlrpc/2/object');
    const rows = await odooCall(client, 'execute_kw', [
      ODOO_DB, uid, ODOO_PASSWORD,
      'sale.order', 'search_read',
      [[['name', 'like', shopifyOrderName]]],
      { fields: ['id', 'name', 'state'], limit: 1 },
    ]);
    return rows[0] || null;
  } catch (e) {
    console.error('[ODOO] findOdooOrder error:', e.message);
    return null;
  }
}

async function cancelOdooOrder(odooId) {
  const uid = await odooAuthenticate();
  const client = odooClient('/xmlrpc/2/object');
  return odooCall(client, 'execute_kw', [
    ODOO_DB, uid, ODOO_PASSWORD,
    'sale.order', 'action_cancel',
    [[odooId]],
  ]);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => res.json({ status: 'ok', service: 'shopify-whatsapp-server' }));

// Meta webhook verification (GET)
app.get('/webhook/meta', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === META_VERIFY_TOKEN) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// Meta incoming WhatsApp messages (POST)
app.post('/webhook/meta', async (req, res) => {
  res.sendStatus(200); // always ack immediately

  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return;

    for (const msg of messages) {
      if (msg.type !== 'text') continue;

      const from = msg.from; // e.g. "201001512676"
      const text = (msg.text?.body || '').trim();
      console.log(`[WA-IN] from=${from} text="${text}"`);

      const order = pendingOrders.get(from);
      if (!order) { console.log(`[WA-IN] No pending order for ${from}`); continue; }
      if (order.status !== 'pending') continue;

      const isConfirm = /^(1|yes|ok|نعم|تأكيد|اوكي|موافق|confirm)$/i.test(text);
      const isCancel  = /^(2|no|لا|إلغاء|الغاء|كنسل|cancel)$/i.test(text);

      if (isConfirm) {
        console.log(`[CONFIRM] Order ${order.orderNumber}`);
        order.status = 'confirmed';
        await tagShopifyOrder(order.shopifyOrderId, 'COD-Confirmed');

      } else if (isCancel) {
        console.log(`[CANCEL] Order ${order.orderNumber} — cancelling in Odoo`);
        order.status = 'cancelled';

        // 1. Tag Shopify as COD-Cancelled (tag only, Odoo handles actual cancellation)
        await tagShopifyOrder(order.shopifyOrderId, 'COD-Cancelled');

        // 2. Cancel in Odoo → Odoo's sync will cancel the Shopify order itself
        const odooOrder = await findOdooOrder(order.orderNumber);
        if (odooOrder) {
          await cancelOdooOrder(odooOrder.id);
          console.log(`[ODOO] Order ${odooOrder.id} cancelled`);
        } else {
          console.warn(`[ODOO] Could not find order ${order.orderNumber}`);
        }

        pendingOrders.delete(from);
      }
    }
  } catch (e) {
    console.error('[WA-IN] Error:', e.message);
  }
});

// Shopify orders/create webhook (POST)
app.post('/webhook/shopify', async (req, res) => {
  if (!verifyShopifyHmac(req)) {
    console.warn('[SHOPIFY] HMAC mismatch — rejected');
    return res.sendStatus(401);
  }
  res.sendStatus(200);

  const order   = req.body;
  const gateway = (order.payment_gateway || order.gateway || '').toLowerCase();
  const isCOD   = ['cash_on_delivery', 'cod', 'manual'].includes(gateway);

  if (!isCOD) {
    console.log(`[SHOPIFY] Order ${order.name} skipped (gateway: ${gateway})`);
    return;
  }

  const phone = normalizePhone(
    order.shipping_address?.phone || order.billing_address?.phone || order.phone
  );

  if (!phone) {
    console.warn(`[SHOPIFY] Order ${order.name}: no phone number found`);
    return;
  }

  const firstName   = order.customer?.first_name || order.billing_address?.first_name || 'عميل';
  const orderNumber = order.name;
  const totalPrice  = `${order.total_price} ${order.currency || 'EGP'}`;

  console.log(`[SHOPIFY] COD order ${orderNumber} | phone=${phone}`);

  try {
    // 1. Send WhatsApp confirmation
    const waResult = await sendConfirmationTemplate(phone, firstName, orderNumber, totalPrice);
    console.log('[WA-OUT]', JSON.stringify(waResult));

    // 2. Tag Shopify order as COD-Pending
    await tagShopifyOrder(order.id, 'COD-Pending');

    // 3. Store in pending map for reply tracking
    pendingOrders.set(phone, {
      shopifyOrderId: order.id,
      orderNumber,
      totalPrice,
      status: 'pending',
    });

  } catch (e) {
    console.error(`[SHOPIFY] Error processing ${orderNumber}:`, e.message);
  }
});

app.listen(PORT, () => console.log(`✅ Server listening on port ${PORT}`));
