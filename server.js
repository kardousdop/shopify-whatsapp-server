// ================================================================
// shopify-whatsapp-server — server.js
// Features:
//   ✅ Order confirmation via WhatsApp template (COD + Card)
//   ✅ Customer taps Confirm/Cancel button on WhatsApp
//   ✅ Confirm → Shopify tagged wa-confirmed
//   ✅ Cancel → Odoo cancelled + Shopify tagged wa-cancelled
//   ✅ No reply after 3h → Shopify tagged wa-no-response
//   ✅ Abandoned checkout WhatsApp reminder (15 min)
//   ✅ Meta WhatsApp Cloud API (permanent token, v22.0)
//   ✅ Bulk send endpoint for manual campaigns
// ================================================================

const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const app     = express();

// ── Raw body needed for webhook signature verification ──────────
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch { req.body = {}; }
    next();
  });
});

// ── ENV ─────────────────────────────────────────────────────────
const {
  META_ACCESS_TOKEN,
  META_PHONE_NUMBER_ID,
  META_VERIFY_TOKEN,
  META_APP_SECRET,
  SHOPIFY_STORE_URL,
  SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_WEBHOOK_SECRET,
  ODOO_URL,
  ODOO_DB,
  ODOO_USERNAME,
  ODOO_PASSWORD,
  PORT = 3000
} = process.env;

// ── Persistent storage for pending orders ───────────────────────
const PENDING_FILE     = './pendingOrders.json';
const ABANDONED_FILE   = './abandonedCheckouts.json';

let pendingOrders      = loadJSON(PENDING_FILE);
let abandonedCheckouts = loadJSON(ABANDONED_FILE);
let abandonedTimers    = {};

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) { console.error('saveJSON error:', e.message); }
}

// ── Restore abandoned checkout timers on server restart ─────────
function restoreAbandonedTimers() {
  const now = Date.now();
  let restored = 0;
  for (const [token, checkout] of Object.entries(abandonedCheckouts)) {
    if (!checkout.reminded && !checkout.completed) {
      const elapsed = now - checkout.createdAt;
      const delay   = Math.max(0, (15 * 60 * 1000) - elapsed);
      abandonedTimers[token] = setTimeout(() => sendAbandonedReminder(token), delay);
      restored++;
    }
  }
  if (restored > 0) console.log(`♻️  Restored ${restored} abandoned checkout timer(s)`);
}

// ── Restore order confirmation timers on restart ─────────────────
function restoreOrderTimers() {
  const now = Date.now();
  let restored = 0;
  for (const [phone, order] of Object.entries(pendingOrders)) {
    if (!order.confirmed && !order.cancelled) {
      const elapsed = now - order.sentAt;
      const delay   = Math.max(0, (60 * 60 * 1000) - elapsed);
      setTimeout(() => retryIfNoReply(phone), delay);
      restored++;
    }
  }
  if (restored > 0) console.log(`♻️  Restored ${restored} order confirmation timer(s)`);
}

// ================================================================
// SHOPIFY WEBHOOK — verify signature
// ================================================================
function verifyShopifyWebhook(req) {
  if (!SHOPIFY_WEBHOOK_SECRET) return true;
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac) return false;
  const hash = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody, 'utf8')
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash));
}

// ================================================================
// 1. SHOPIFY — ORDER CREATED (confirmation flow)
// ================================================================
app.post('/webhook/order-created', async (req, res) => {
  if (!verifyShopifyWebhook(req)) return res.status(401).send('Unauthorized');
  res.status(200).send('ok');

  const o     = req.body;
  const phone = normalisePhone(o.billing_address?.phone || o.shipping_address?.phone || o.customer?.phone);
  if (!phone) { console.log(`⚠️  No phone on order #${o.order_number}`); return; }

  const isCOD = isCodOrder(o);
  const name  = o.customer?.first_name || 'عميلنا';
  const items = (o.line_items || []).map(i => `${i.name} ×${i.quantity}`).join('، ');

  cancelAbandonedTimerByPhone(phone);

  pendingOrders[phone] = {
    orderNo:   o.order_number,
    shopifyId: String(o.id),
    name,
    total:     o.total_price,
    items,
    isCOD,
    gateway:   o.payment_gateway,
    sentAt:    Date.now(),
    retried:   false,
    confirmed: false,
    cancelled: false
  };
  saveJSON(PENDING_FILE, pendingOrders);

  const payInfo = isCOD
    ? `${o.total_price} EGP - الدفع عند الاستلام`
    : `${o.total_price} EGP - تم الدفع بالبطاقة`;

  await sendWATemplate(phone, 'sf_cod_confirmation_1773577120326', 'ar', [
    name,
    `#${o.order_number}`,
    payInfo
  ]);

  setTimeout(() => retryIfNoReply(phone), 60 * 60 * 1000);
});

// ================================================================
// 2. SHOPIFY — ABANDONED CHECKOUT
// ================================================================
app.post('/webhook/checkout', async (req, res) => {
  if (!verifyShopifyWebhook(req)) return res.status(401).send('Unauthorized');
  res.status(200).send('ok');

  const checkout = req.body;
  const phone    = normalisePhone(
    checkout.billing_address?.phone ||
    checkout.shipping_address?.phone ||
    checkout.phone
  );

  if (!phone) {
    console.log(`⚠️  Abandoned checkout ${checkout.token} — no phone number, skipping`);
    return;
  }

  if (pendingOrders[phone]) {
    console.log(`ℹ️  Abandoned checkout for ${phone} — already has pending order, skipping`);
    return;
  }

  if (abandonedCheckouts[checkout.token]?.reminded) {
    console.log(`ℹ️  Abandoned checkout ${checkout.token} already reminded`);
    return;
  }

  const name  = checkout.billing_address?.first_name ||
                checkout.shipping_address?.first_name ||
                'عميلنا';
  const items = (checkout.line_items || []).map(i => `${i.title} ×${i.quantity}`).join('، ');
  const total = checkout.total_price || '0.00';
  const url   = checkout.abandoned_checkout_url || 'https://mymayz.com';

  abandonedCheckouts[checkout.token] = {
    phone,
    name,
    items,
    total,
    url,
    createdAt: Date.now(),
    reminded:  false,
    completed: false
  };
  saveJSON(ABANDONED_FILE, abandonedCheckouts);

  cancelAbandonedTimerByPhone(phone);

  abandonedTimers[checkout.token] = setTimeout(
    () => sendAbandonedReminder(checkout.token),
    15 * 60 * 1000  // 15 min
  );

  console.log(`🛒 Abandoned checkout saved for ${phone} — reminder in 15 minutes`);
});

// ── Send the actual abandoned checkout WhatsApp ─────────────────
async function sendAbandonedReminder(token) {
  const checkout = abandonedCheckouts[token];
  if (!checkout || checkout.reminded || checkout.completed) return;

  await sendWATemplate(checkout.phone, 'abandoned_cart_reminder', 'ar', [
    checkout.name,
    checkout.items,
    checkout.total,
    checkout.url
  ]);

  abandonedCheckouts[token].reminded = true;
  saveJSON(ABANDONED_FILE, abandonedCheckouts);
  delete abandonedTimers[token];
  console.log(`📤 Abandoned checkout reminder sent to ${checkout.phone}`);
}

// ── Cancel abandoned timer when order is placed ──────────────────
function cancelAbandonedTimerByPhone(phone) {
  for (const [token, checkout] of Object.entries(abandonedCheckouts)) {
    if (checkout.phone === phone && !checkout.completed) {
      if (abandonedTimers[token]) {
        clearTimeout(abandonedTimers[token]);
        delete abandonedTimers[token];
      }
      abandonedCheckouts[token].completed = true;
      console.log(`✅ Cancelled abandoned reminder for ${phone} — order placed`);
    }
  }
  saveJSON(ABANDONED_FILE, abandonedCheckouts);
}

// ================================================================
// 3. META WHATSAPP WEBHOOK — verify (GET)
// ================================================================
app.get('/webhook/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('✅ Meta webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ================================================================
// 4. META WHATSAPP WEBHOOK — incoming messages (POST)
// ================================================================
app.post('/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);

  const entry   = req.body?.entry?.[0];
  const changes = entry?.changes?.[0];
  const value   = changes?.value;
  if (!value?.messages) return;

  const msg  = value.messages[0];
  const from = normalisePhone(msg.from);

  // Support both typed replies (1/2) and Quick Reply button taps
  const textReply   = (msg.text?.body || '').trim().toLowerCase();
  const buttonReply = (msg.button?.payload || msg.button?.text || '').trim().toLowerCase();
  const isConfirm   = textReply === '1' || buttonReply.includes('confirm');
  const isCancel    = textReply === '2' || buttonReply.includes('cancel');

  console.log(`💬 WA reply from ${from}: text="${textReply}" button="${buttonReply}"`);

  const order = pendingOrders[from];
  if (!order) return;

  if (isConfirm) {
    order.confirmed = true;
    saveJSON(PENDING_FILE, pendingOrders);

    await tagShopifyOrder(order.shopifyId, 'wa-confirmed');
    await sendWA(from,
      `✅ تم تأكيد طلبك #${order.orderNo} بنجاح!\n` +
      `سيتم التجهيز والشحن قريباً 🎉\n\n` +
      `شكراً لثقتك في myMayz 🙏`
    );

    delete pendingOrders[from];
    saveJSON(PENDING_FILE, pendingOrders);

  } else if (isCancel) {
    order.cancelled = true;
    saveJSON(PENDING_FILE, pendingOrders);

    await odooCancel(order.shopifyId);
    await tagShopifyOrder(order.shopifyId, 'wa-cancelled');
    await sendWA(from,
      `تم إلغاء طلبك #${order.orderNo} ✅\n` +
      `يمكنك الطلب مرة أخرى في أي وقت 🙏`
    );

    delete pendingOrders[from];
    saveJSON(PENDING_FILE, pendingOrders);
  }
});

// ================================================================
// 5. RETRY LOGIC — no reply after 1 hour
// ================================================================
async function retryIfNoReply(phone) {
  const order = pendingOrders[phone];
  if (!order || order.confirmed || order.cancelled || order.retried) return;

  order.retried = true;
  saveJSON(PENDING_FILE, pendingOrders);

  const retryPayInfo = order.isCOD
    ? `${order.total} EGP - الدفع عند الاستلام`
    : `${order.total} EGP - تم الدفع بالبطاقة`;

  await sendWATemplate(phone, 'sf_cod_confirmation_1773577120326', 'ar', [
    order.name,
    `#${order.orderNo}`,
    retryPayInfo
  ]);

  setTimeout(() => holdIfNoReply(phone), 2 * 60 * 60 * 1000);
}

async function holdIfNoReply(phone) {
  const order = pendingOrders[phone];
  if (!order || order.confirmed || order.cancelled) return;

  // Tag in Shopify only — can't send free-form WhatsApp since customer
  // never replied (24h window closed), and we have no approved template for this
  await tagShopifyOrder(order.shopifyId, 'wa-no-response');
  console.log(`⏰ Order #${order.orderNo} for ${phone} — no reply after 3h, tagged wa-no-response in Shopify`);

  delete pendingOrders[phone];
  saveJSON(PENDING_FILE, pendingOrders);
}

// ================================================================
// ODOO HELPERS
// ================================================================
let odooSession = null;

async function odooAuth() {
  try {
    const r = await fetch(`${ODOO_URL}/web/session/authenticate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', method: 'call',
        params:  { db: ODOO_DB, login: ODOO_USERNAME, password: ODOO_PASSWORD }
      })
    });
    const data = await r.json();
    odooSession = data.result?.session_id;
    return data.result?.uid;
  } catch(e) {
    console.error('Odoo auth error:', e.message);
    return null;
  }
}

async function odooRpc(model, method, args, kwargs = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (odooSession) headers['Cookie'] = `session_id=${odooSession}`;
  const r = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
    method:  'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call',
      params:  { model, method, args, kwargs, session_id: odooSession }
    })
  });
  return (await r.json()).result;
}

async function odooCancel(shopifyOrderId) {
  try {
    await odooAuth();
    let orders = await odooRpc('sale.order', 'search_read',
      [[ ['shopify_order_id', '=', String(shopifyOrderId)] ]],
      { fields: ['id', 'name', 'state'], limit: 1 }
    );
    if (!orders?.length) {
      orders = await odooRpc('sale.order', 'search_read',
        [[ ['client_order_ref', 'ilike', String(shopifyOrderId)] ]],
        { fields: ['id', 'name', 'state'], limit: 1 }
      );
    }
    if (!orders?.length) { console.log(`⚠️  Odoo: order not found for Shopify ID ${shopifyOrderId}`); return false; }
    if (orders[0].state === 'cancel') { console.log(`ℹ️  Odoo: order ${orders[0].name} already cancelled`); return true; }
    await odooRpc('sale.order', 'action_cancel', [[orders[0].id]]);
    console.log(`🟣 Odoo: cancelled ${orders[0].name}`);
    return true;
  } catch(e) {
    console.error('Odoo cancel error:', e.message);
    return false;
  }
}

// ================================================================
// ODOO TAGGING
// ================================================================
async function tagOdooOrder(shopifyOrderId, tagName) {
  try {
    await odooAuth();
    const tagNameMap = {
      'wa-confirmed':   'COD-Confirmed',
      'wa-cancelled':   'COD-Cancelled',
      'wa-no-response': 'COD-Pending',
    };
    const odooTagName = tagNameMap[tagName] || tagName;

    let tagId = null;
    for (const model of ['crm.tag', 'sale.order.tag']) {
      const tags = await odooRpc(model, 'search_read',
        [[ ['name', '=', odooTagName] ]],
        { fields: ['id', 'name'], limit: 1 }
      );
      if (tags?.length) { tagId = tags[0].id; break; }
    }

    if (!tagId) { console.log(`⚠️  Odoo tag "${odooTagName}" not found`); return; }

    const orders = await odooRpc('sale.order', 'search_read',
      [[ ['shopify_order_id', '=', String(shopifyOrderId)] ]],
      { fields: ['id', 'name', 'tag_ids'], limit: 1 }
    );
    if (!orders?.length) { console.log(`⚠️  Odoo order not found for ${shopifyOrderId}`); return; }

    await odooRpc('sale.order', 'write',
      [[orders[0].id], { tag_ids: [[4, tagId]] }], {}
    );
    console.log(`🏷️  Odoo: tagged ${orders[0].name} with "${odooTagName}" ✅`);
  } catch(e) {
    console.error('Odoo tag error:', e.message);
  }
}

// ================================================================
// SHOPIFY TAGGING
// ================================================================
async function tagShopifyOrder(shopifyOrderId, newTag) {
  try {
    const base    = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${shopifyOrderId}.json`;
    const headers = { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' };

    // Get current tags
    const res  = await fetch(base, { headers });
    const data = await res.json();
    const currentTags = data.order?.tags || '';

    // Append new tag (avoid duplicates)
    const tagList = currentTags ? currentTags.split(',').map(t => t.trim()) : [];
    if (!tagList.includes(newTag)) tagList.push(newTag);

    await fetch(base, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ order: { id: shopifyOrderId, tags: tagList.join(', ') } })
    });

    console.log(`🏷️  Shopify: tagged order ${shopifyOrderId} with "${newTag}" ✅`);
  } catch(e) {
    console.error('Shopify tag error:', e.message);
  }
}

// ================================================================
// SHOPIFY REFUND API (card payments)
// ================================================================
async function shopifyRefund(shopifyOrderId) {
  try {
    const base    = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${shopifyOrderId}`;
    const headers = { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' };

    const [orderRes, txRes] = await Promise.all([
      fetch(`${base}.json`, { headers }).then(r => r.json()),
      fetch(`${base}/transactions.json`, { headers }).then(r => r.json())
    ]);

    const order   = orderRes.order;
    const payment = txRes.transactions?.find(
      t => t.status === 'success' && (t.kind === 'sale' || t.kind === 'capture')
    );
    if (!payment) return { success: false };

    const refundRes = await fetch(`${base}/refunds.json`, {
      method: 'POST', headers,
      body: JSON.stringify({ refund: {
        currency: payment.currency,
        notify:   false,
        note:     'Customer cancelled via WhatsApp before fulfillment',
        refund_line_items: order.line_items.map(i => ({
          line_item_id: i.id, quantity: i.quantity, restock_type: 'return'
        })),
        transactions: [{ parent_id: payment.id, amount: payment.amount, kind: 'refund', gateway: payment.gateway }]
      }})
    });
    const data = await refundRes.json();
    const tx   = data.refund?.transactions?.[0];
    return { success: tx?.status === 'success', amount: payment.amount };
  } catch(e) {
    console.error('Shopify refund error:', e.message);
    return { success: false };
  }
}

// ================================================================
// META WHATSAPP CLOUD API — send message
// ================================================================
const WA_API_VER = 'v22.0';

async function sendWA(phone, message) {
  try {
    const r = await fetch(
      `https://graph.facebook.com/${WA_API_VER}/${META_PHONE_NUMBER_ID}/messages`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to:   phone,
          type: 'text',
          text: { body: message }
        })
      }
    );
    const data = await r.json();
    if (data.error) {
      const code = data.error.code || '?';
      const msg  = data.error.message || JSON.stringify(data.error);
      console.error(`❌ WA send error to ${phone} [code ${code}]: ${msg}`);
      return { ok: false, code, error: msg };
    } else {
      console.log(`✅ WA sent to ${phone} msgId:${data.messages?.[0]?.id}`);
      return { ok: true };
    }
  } catch(e) {
    console.error('sendWA error:', e.message);
    return { ok: false, error: e.message };
  }
}


// ================================================================
// META WHATSAPP — send template message (for outbound/abandoned cart)
// ================================================================
async function sendWATemplate(phone, templateName, languageCode, params) {
  try {
    const components = params.length > 0 ? [{
      type: 'body',
      parameters: params.map(p => ({ type: 'text', text: String(p) }))
    }] : [];

    const r = await fetch(
      `https://graph.facebook.com/${WA_API_VER}/${META_PHONE_NUMBER_ID}/messages`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
          'Content-Type':  'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to:   phone,
          type: 'template',
          template: {
            name:     templateName,
            language: { code: languageCode },
            components
          }
        })
      }
    );
    const data = await r.json();
    if (data.error) {
      console.error(`❌ WA template error to ${phone} [code ${data.error.code}]:`, JSON.stringify(data.error));
    } else {
      console.log(`✅ WA template "${templateName}" sent to ${phone}`);
    }
    return data;
  } catch(e) {
    console.error('sendWATemplate error:', e.message);
  }
}

// ================================================================
// HELPERS
// ================================================================
function normalisePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/[\s\-\(\)]/g, '');
  if (p.startsWith('0')) p = '+20' + p.slice(1);
  if (!p.startsWith('+')) p = '+' + p;
  return p.replace('+', '');
}

function isCodOrder(order) {
  return ['cash_on_delivery', 'cod', 'manual'].includes(order.payment_gateway)
    || order.financial_status === 'pending';
}

// ================================================================
// HEALTH CHECK
// ================================================================
app.get('/', (req, res) => {
  res.json({
    status:          'running',
    time:            new Date().toISOString(),
    pendingOrders:   Object.keys(pendingOrders).length,
    abandonedTimers: Object.keys(abandonedTimers).length,
    abandonedTotal:  Object.keys(abandonedCheckouts).length
  });
});

// ================================================================
// ADMIN — list pending orders
// ================================================================
app.get('/admin/pending', (req, res) => {
  res.json(pendingOrders);
});

// ================================================================
// ADMIN — BULK SEND  ← NEW
// POST /admin/bulk-send
// Body: { "orders": [ { "phone", "firstName", "name", "total", "items" } ] }
// ================================================================
app.post('/admin/bulk-send', async (req, res) => {
  const orders = req.body.orders || [];
  if (!orders.length) return res.json({ sent: 0, failed: 0, errors: ['No orders provided'] });

  console.log(`📤 Bulk send started for ${orders.length} orders`);
  let sent = 0, failed = 0, errors = [];

  for (const o of orders) {
    if (!o.phone) { failed++; errors.push(`${o.name}: no phone`); continue; }
    try {
      await sendWATemplate(o.phone, 'sf_cod_confirmation_1773577120326', 'ar', [
        o.firstName || 'عميلنا',
        o.name,
        `${o.total} EGP - الدفع عند الاستلام`
      ]);
      sent++;
    } catch(e) {
      failed++;
      errors.push(`${o.name}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 350)); // rate limit delay
  }

  console.log(`📤 Bulk send done: ${sent} sent, ${failed} failed`);
  res.json({ sent, failed, errors });
});


// ================================================================
// ADMIN — TEST ABANDONED CHECKOUT REMINDER
// GET /admin/test-abandoned?phone=201004444558
// ================================================================
app.get('/admin/test-abandoned', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.json({ error: 'phone param required' });

  await sendWATemplate(phone, 'abandoned_cart_reminder', 'ar', [
    'عميلنا',
    'Alkaline Clay Water Bottle ×1',
    '784',
    'https://mymayz.com'
  ]);
  console.log(`🧪 Test abandoned template sent to ${phone}`);
  res.json({ sent: true, to: phone });
});

// ================================================================
// ADMIN — Deep phone number diagnostics
// GET /admin/phone-check
// ================================================================
app.get('/admin/phone-check', async (req, res) => {
  const lines = [];
  lines.push(`=== WhatsApp Phone Number Deep Check ===`);
  lines.push(`META_PHONE_NUMBER_ID : ${META_PHONE_NUMBER_ID}`);
  lines.push('');

  // 0. Check WABA status
  try {
    const r0 = await fetch(
      `https://graph.facebook.com/${WA_API_VER}/${META_PHONE_NUMBER_ID}?fields=account_mode,certificate,code_verification_status,display_phone_number,quality_rating,status,name_status,new_name_status,decision,requested_verified_name`,
      { headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}` } }
    );
    const d0 = await r0.json();
    if (!d0.error) {
      lines.push(`Account mode         : ${d0.account_mode || 'N/A'}`);
      lines.push(`Name status          : ${d0.name_status || 'N/A'}`);
      lines.push(`Code verify status   : ${d0.code_verification_status || 'N/A'}`);
      lines.push(`Decision             : ${d0.decision || 'N/A'}`);
      lines.push('');

      if (d0.account_mode === 'SANDBOX') {
        lines.push('⚠️  ACCOUNT IS IN SANDBOX MODE!');
        lines.push('   In sandbox mode, messages can only be sent to numbers you explicitly added');
        lines.push('   as test numbers in the Meta developer console.');
        lines.push('   → You must switch to LIVE mode to send to real customers.');
        lines.push('');
      }
    }
  } catch(e) {}


  try {
    // 1. Get phone number details from Meta
    const r1 = await fetch(
      `https://graph.facebook.com/${WA_API_VER}/${META_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating,status,platform_type,throughput`,
      { headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}` } }
    );
    const phone = await r1.json();
    if (phone.error) {
      lines.push(`❌ Phone number lookup error: ${phone.error.message}`);
    } else {
      lines.push(`Display number   : ${phone.display_phone_number || 'N/A'}`);
      lines.push(`Verified name    : ${phone.verified_name || 'N/A'}`);
      lines.push(`Status           : ${phone.status || 'N/A'}`);
      lines.push(`Quality rating   : ${phone.quality_rating || 'N/A'}`);
      lines.push(`Platform type    : ${phone.platform_type || 'N/A'}`);
      lines.push(`Throughput tier  : ${phone.throughput?.max_daily_conversation_per_phone || 'N/A'}`);

      if (phone.status !== 'CONNECTED') {
        lines.push('');
        lines.push(`⚠️  STATUS IS NOT "CONNECTED" — this is why messages are not delivered!`);
        lines.push(`   Status "${phone.status}" means the number is not active/connected.`);
      } else {
        lines.push('');
        lines.push(`✅ Phone number is CONNECTED and active`);
      }
    }
  } catch(e) {
    lines.push(`❌ Error: ${e.message}`);
  }

  lines.push('');

  try {
    // 2. Check WABA (WhatsApp Business Account) details
    const r2 = await fetch(
      `https://graph.facebook.com/${WA_API_VER}/${META_PHONE_NUMBER_ID}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`,
      { headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}` } }
    );
    const profile = await r2.json();
    if (profile.error) {
      lines.push(`Business profile error: ${profile.error.message}`);
    } else {
      lines.push(`Business about   : ${profile.data?.[0]?.about || 'N/A'}`);
    }
  } catch(e) {
    lines.push(`Profile check error: ${e.message}`);
  }

  res.send('<pre>' + lines.join('\n') + '</pre>');
});

// ================================================================
// ADMIN — Send + immediately check delivery status
// GET /admin/delivery-test?phone=201XXXXXXXXX
// ================================================================
app.get('/admin/delivery-test', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.send('<pre>Add ?phone=201XXXXXXXXX</pre>');
  const lines = [];
  lines.push(`Sending to: ${phone}`);

  // Send message
  const sr = await fetch(
    `https://graph.facebook.com/${WA_API_VER}/${META_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: 'اختبار توصيل ✅' } })
    }
  );
  const sd = await sr.json();
  if (sd.error) {
    lines.push(`❌ Send error [${sd.error.code}]: ${sd.error.message}`);
    return res.send('<pre>' + lines.join('\n') + '</pre>');
  }
  const msgId = sd.messages?.[0]?.id;
  lines.push(`✅ Sent — message ID: ${msgId}`);
  lines.push('Waiting 3 seconds then checking delivery status...');

  // Wait 3s then check status
  await new Promise(r => setTimeout(r, 3000));
  try {
    const cr = await fetch(
      `https://graph.facebook.com/${WA_API_VER}/${msgId}?fields=id,status,timestamp,errors`,
      { headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}` } }
    );
    const cd = await cr.json();
    if (cd.error) {
      lines.push(`Status check error: ${cd.error.message}`);
      lines.push('(This is normal — message status may not be queryable directly)');
    } else {
      lines.push(`Message status: ${JSON.stringify(cd)}`);
    }
  } catch(e) {
    lines.push(`Status check failed: ${e.message}`);
  }

  res.send('<pre>' + lines.join('\n') + '</pre>');
});

// ================================================================
// ADMIN — Test WhatsApp sending
// GET /admin/test-wa?phone=201XXXXXXXXX
// ================================================================
app.get('/admin/test-wa', async (req, res) => {
  const phone = req.query.phone;
  const msg   = req.query.msg || 'اختبار ✅ النظام يعمل بشكل صحيح';
  const lines = [];

  lines.push(`API version          : ${WA_API_VER}`);
  lines.push(`META_PHONE_NUMBER_ID : ${META_PHONE_NUMBER_ID ? `✅ ${META_PHONE_NUMBER_ID}` : '❌ MISSING'}`);
  lines.push(`META_ACCESS_TOKEN    : ${META_ACCESS_TOKEN ? `✅ set (length ${META_ACCESS_TOKEN.length})` : '❌ MISSING'}`);
  lines.push('');

  if (!phone) {
    lines.push('⚠️  Add ?phone=201XXXXXXXXX to send a test message');
    return res.send('<pre>' + lines.join('\n') + '</pre>');
  }

  lines.push(`Sending to : ${phone}`);
  lines.push(`Message    : ${msg}`);
  lines.push('---');

  const r = await fetch(
    `https://graph.facebook.com/${WA_API_VER}/${META_PHONE_NUMBER_ID}/messages`,
    {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: msg } })
    }
  );
  const data = await r.json();

  if (data.error) {
    const code = data.error.code;
    lines.push(`❌ Error [${code}]: ${data.error.message}`);
    if (code === 190 || String(code) === '190')
      lines.push('\n→ TOKEN EXPIRED. Go to Meta for Developers → App → WhatsApp → API Setup → Generate new token\n  Then update META_ACCESS_TOKEN in Railway env vars.');
    else if (code === 131030)
      lines.push('\n→ TEMPLATE REQUIRED for this type of message. Create & approve a template in Meta Business Manager.');
    else if (code === 131047)
      lines.push('\n→ 24-HOUR WINDOW: this number hasn\'t messaged you recently. Templates required for cold outreach.');
    else if (code === 100)
      lines.push('\n→ INVALID param — check META_PHONE_NUMBER_ID is correct.');
  } else {
    lines.push(`✅ SUCCESS! Message ID: ${data.messages?.[0]?.id}`);
  }

  res.send('<pre>' + lines.join('\n') + '</pre>');
});

// ================================================================
// ADMIN — Check WhatsApp token validity
// GET /admin/wa-status
// ================================================================
app.get('/admin/wa-status', async (req, res) => {
  const lines = [];
  lines.push(`Server time          : ${new Date().toISOString()}`);
  lines.push(`API version          : ${WA_API_VER}`);
  lines.push(`META_PHONE_NUMBER_ID : ${META_PHONE_NUMBER_ID || '❌ MISSING'}`);
  lines.push(`META_ACCESS_TOKEN    : ${META_ACCESS_TOKEN ? `set (${META_ACCESS_TOKEN.length} chars)` : '❌ MISSING'}`);
  lines.push('');

  if (META_ACCESS_TOKEN) {
    try {
      const r = await fetch(
        `https://graph.facebook.com/debug_token?input_token=${META_ACCESS_TOKEN}&access_token=${META_ACCESS_TOKEN}`
      );
      const d = await r.json();
      if (d?.data) {
        const exp   = d.data.expires_at ? new Date(d.data.expires_at * 1000).toISOString() : 'never (permanent)';
        const valid = d.data.is_valid ? '✅ VALID' : '❌ INVALID / EXPIRED';
        lines.push(`Token status  : ${valid}`);
        lines.push(`Token type    : ${d.data.type || 'unknown'}`);
        lines.push(`Expires       : ${exp}`);
        lines.push(`Scopes        : ${(d.data.scopes || []).join(', ') || 'none listed'}`);
        if (!d.data.is_valid) {
          lines.push('');
          lines.push('→ TOKEN IS EXPIRED. Fix:');
          lines.push('  Meta for Developers → App → WhatsApp → API Setup → Generate new token');
          lines.push('  Update META_ACCESS_TOKEN in Railway environment variables');
        }
      } else {
        lines.push(`Token debug result: ${JSON.stringify(d)}`);
      }
    } catch(e) {
      lines.push(`Token check error: ${e.message}`);
    }
  }

  res.send('<pre>' + lines.join('\n') + '</pre>');
});

// ================================================================
// START
// ================================================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  restoreOrderTimers();
  restoreAbandonedTimers();
});
