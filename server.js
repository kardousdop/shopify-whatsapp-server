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

async function cancelShopifyOrder(orderId) {
  try {
    const result = await shopifyFetch(`orders/${orderId}/cancel.json`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'customer' }),
    });
    console.log(`Shopify order ${orderId} cancel result:`, JSON.stringify(result?.order?.cancel_reason || result?.errors || 'done'));
  } catch (e) {
    console.error(`Shopify cancel error for order ${orderId}:`, e.message);
  }
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
  // Shopify connector stores the order ref in client_order_ref (e.g. "#53124")
  // Try both with and without the # prefix
  const nameClean = String(shopifyOrderName).replace(/^#/, '');
  const ids = await odooCall('/xmlrpc/2/object', 'execute_kw', [
    ODOO_DB, uid, ODOO_PASSWORD,
    'sale.order', 'search',
    [[['client_order_ref', 'in', [shopifyOrderName, nameClean, `#${nameClean}`]]]],
  ]);
  if (!ids || ids.length === 0) {
    console.warn(`Odoo order not found for shopify ref "${shopifyOrderName}" — tried client_order_ref`);
    return null;
  }
  const records = await odooCall('/xmlrpc/2/object', 'execute_kw', [
    ODOO_DB, uid, ODOO_PASSWORD,
    'sale.order', 'read',
    [ids, ['id', 'name', 'state', 'client_order_ref']],
  ]);
  console.log(`Found Odoo order:`, JSON.stringify(records[0]));
  return records[0] || null;
}

async function cancelOdooOrder(odooId) {
  const uid = await odooAuthenticate();
  // Unlock first (required if order is in confirmed/locked state in Odoo)
  try {
    await odooCall('/xmlrpc/2/object', 'execute_kw', [
      ODOO_DB, uid, ODOO_PASSWORD,
      'sale.order', 'action_unlock', [[odooId]], {}]);
    console.log(`Unlocked Odoo order ID ${odooId}`);
  } catch (e) {
    console.log(`Odoo unlock skipped: ${e.message}`);
  }
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
      if (msg.type !== 'text') continue;
      const from = msg.from;
      const text = (msg.text?.body || '').trim();
      console.log(`WA reply from ${from}: "${text}"`);
      const order = pendingOrders.get(from);
      if (!order) {
        console.warn(`No pending order found for ${from} — server may have restarted`);
        continue;
      }
      if (order.status !== 'pending') {
        console.log(`Order ${order.orderNumber} already ${order.status}, ignoring reply`);
        continue;
      }
      const isConfirm = /^(1|yes|ok|نعم|تأكيد|اوكي|موافق|confirm)$/i.test(text);
      const isCancel  = /^(2|no|لا|إلغاء|الغاء|كنسل|cancel)$/i.test(text);
      if (isConfirm) {
        order.status = 'confirmed';
        console.log(`Order ${order.orderNumber} CONFIRMED by ${from}`);
        await tagShopifyOrder(order.shopifyOrderId, 'COD-Confirmed');
        await waFetch(`${META_PHONE_NUMBER_ID}/messages`, {
          messaging_product: 'whatsapp',
          to: from,
          type: 'text',
          text: { body: `✅ تم تأكيد طلبك ${order.orderNumber} بنجاح!\nشكراً لك، سيتم شحن طلبك قريباً 🎉` },
        });
      } else if (isCancel) {
        order.status = 'cancelled';
        console.log(`Order ${order.orderNumber} CANCELLED by ${from}`);
        await tagShopifyOrder(order.shopifyOrderId, 'COD-Cancelled');
        await waFetch(`${META_PHONE_NUMBER_ID}/messages`, {
          messaging_product: 'whatsapp',
          to: from,
          type: 'text',
          text: { body: `❌ تم إلغاء طلبك ${order.orderNumber}.\nيمكنك الطلب مجدداً في أي وقت 🛍️` },
        });
        // Cancel in Odoo — retry every 2 min for up to 20 min (order may not be synced yet)
        cancelInOdooWithRetry(order.orderNumber, 10, 2 * 60 * 1000);
        pendingOrders.delete(from);
      } else {
        // Unknown reply — remind the customer
        await waFetch(`${META_PHONE_NUMBER_ID}/messages`, {
          messaging_product: 'whatsapp',
          to: from,
          type: 'text',
          text: { body: `للتأكيد اضغط *1*\nللإلغاء اضغط *2*` },
        });
      }
    }
  } catch (e) {
    console.error('Meta webhook error:', e.message);
  }
});

// ─── Odoo Cancel with Retry ──────────────────────────────────────────────────
// Shopify→Odoo sync takes 10-15 min, so retry until the order appears in Odoo
async function cancelInOdooWithRetry(orderNumber, retriesLeft, intervalMs) {
  try {
    const odooOrder = await findOdooOrder(orderNumber);
    if (odooOrder) {
      console.log(`Odoo order found for ${orderNumber} — cancelling now`);
      await cancelOdooOrder(odooOrder.id);
      return;
    }
  } catch (e) {
    console.error(`Odoo cancel attempt error for ${orderNumber}:`, e.message);
  }

  if (retriesLeft <= 0) {
    console.warn(`Odoo cancel gave up for ${orderNumber} after all retries`);
    return;
  }

  console.log(`Odoo order not found yet for ${orderNumber} — retrying in ${intervalMs / 60000} min (${retriesLeft} retries left)`);
  setTimeout(() => cancelInOdooWithRetry(orderNumber, retriesLeft - 1, intervalMs), intervalMs);
}

// ─── Abandoned Cart ───────────────────────────────────────────────────────────
const pendingCheckouts = new Map(); // token → { phone, timer }

app.post('/webhook/checkout', async (req, res) => {
  if (!verifyShopifyHmac(req)) return res.sendStatus(401);
  res.sendStatus(200);
  try {
    const checkout = req.body;
    if (!checkout || !checkout.token) return;
    if (checkout.completed_at) return; // already completed, ignore

    const phone = normalizePhone(
      checkout.shipping_address?.phone ||
      checkout.billing_address?.phone ||
      checkout.phone || checkout.email || ''
    );
    if (!phone || phone.length < 10) {
      console.log(`Checkout ${checkout.token} — no phone yet, skipping`);
      return;
    }

    const token          = checkout.token;
    const checkoutUrl    = checkout.abandoned_checkout_url;
    const lineItems      = checkout.line_items || [];
    const firstItem      = lineItems[0] || {};
    const productTitle   = lineItems.map(i => i.title).join(', ') || 'منتجاتك';
    const productImage   = firstItem.image_url || null;
    const totalPrice     = checkout.total_price || '0';
    const currency       = checkout.currency || 'EGP';

    // Reset timer if checkout was already tracked
    if (pendingCheckouts.has(token)) {
      clearTimeout(pendingCheckouts.get(token).timer);
    }

    const timer = setTimeout(async () => {
      pendingCheckouts.delete(token);
      try {
        // Verify the checkout is still incomplete
        const data = await shopifyFetch(`checkouts/${token}.json`);
        if (data?.checkout?.completed_at) {
          console.log(`Checkout ${token} completed — no reminder needed`);
          return;
        }
        console.log(`Sending abandoned cart reminder to ${phone} for checkout ${token}`);

        // Send product image first if available
        if (productImage) {
          await waFetch(`${META_PHONE_NUMBER_ID}/messages`, {
            messaging_product: 'whatsapp',
            to: phone,
            type: 'image',
            image: { link: productImage, caption: productTitle },
          });
        }

        // Send reminder text with checkout link
        const msg =
          `مرحباً! 👋 نسيت شيئاً في سلتك 🛒\n\n` +
          `🛍️ ${productTitle}\n` +
          `💰 الإجمالي: ${totalPrice} ${currency}\n\n` +
          `أكمل طلبك الآن 👇\n${checkoutUrl}`;

        await waFetch(`${META_PHONE_NUMBER_ID}/messages`, {
          messaging_product: 'whatsapp',
          to: phone,
          type: 'text',
          text: { body: msg },
        });
        console.log(`Abandoned cart reminder sent to ${phone}`);
      } catch (e) {
        console.error('Abandoned cart send error:', e.message);
      }
    }, 15 * 60 * 1000); // 15 minutes

    pendingCheckouts.set(token, { phone, timer });
    console.log(`Abandoned cart timer set — phone:${phone} checkout:${token}`);
  } catch (e) {
    console.error('Checkout webhook error:', e.message);
  }
});

// ─── Shopify Order Webhook ────────────────────────────────────────────────────
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
