// ================================================================
// shopify-whatsapp-server — server.js
// Features:
//   ✅ Order confirmation (COD + Card)
//   ✅ Odoo cancel on customer reply
//   ✅ Auto-confirm overdue orders
//   ✅ Abandoned checkout WhatsApp reminder  ← NEW
//   ✅ Meta WhatsApp Cloud API
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
let abandonedTimers    = {};   // checkoutToken → setTimeout handle

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
      const elapsed   = now - checkout.createdAt;
      const delay     = Math.max(0, (15 * 60 * 1000) - elapsed); // 1 hour from creation
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
      const elapsed  = now - order.sentAt;
      const delay    = Math.max(0, (60 * 60 * 1000) - elapsed); // 1 hour
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
  if (!SHOPIFY_WEBHOOK_SECRET) return true; // skip in dev
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

  // If this customer had an abandoned checkout timer → cancel it (they completed!)
  cancelAbandonedTimerByPhone(phone);

  pendingOrders[phone] = {
    orderNo:    o.order_number,
    shopifyId:  String(o.id),
    name,
    total:      o.total_price,
    isCOD,
    gateway:    o.payment_gateway,
    sentAt:     Date.now(),
    retried:    false,
    confirmed:  false,
    cancelled:  false
  };
  saveJSON(PENDING_FILE, pendingOrders);

  const payNote = isCOD ? '💵 الدفع عند الاستلام' : '💳 تم الدفع بالبطاقة';

  await sendWA(phone,
    `مرحباً ${name}! 👋\n\n` +
    `شكراً لطلبك من myMayz 🎉\n\n` +
    `📦 رقم الطلب: #${o.order_number}\n` +
    `${payNote} — ${o.total_price} EGP\n` +
    `🛍️ ${items}\n\n` +
    `يرجى تأكيد طلبك الآن:\n` +
    `✅ اكتب *1* للتأكيد\n` +
    `❌ اكتب *2* للإلغاء`
  );

  // Retry after 1 hour if no reply
  setTimeout(() => retryIfNoReply(phone), 60 * 60 * 1000);
});

// ================================================================
// 2. SHOPIFY — ABANDONED CHECKOUT  ← NEW
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

  // Shopify also fires this for email-only checkouts — skip if no phone
  if (!phone) {
    console.log(`⚠️  Abandoned checkout ${checkout.token} — no phone number, skipping`);
    return;
  }

  // Skip if customer already has a pending order confirmation
  if (pendingOrders[phone]) {
    console.log(`ℹ️  Abandoned checkout for ${phone} — already has pending order, skipping`);
    return;
  }

  // Skip if we already have a timer for this checkout
  if (abandonedCheckouts[checkout.token]?.reminded) {
    console.log(`ℹ️  Abandoned checkout ${checkout.token} already reminded`);
    return;
  }

  const name  = checkout.billing_address?.first_name ||
                checkout.shipping_address?.first_name ||
                'عميلنا';
  const items = (checkout.line_items || []).map(i => `${i.title} ×${i.quantity}`).join('، ');
  const total = checkout.total_price || '0.00';
  const url   = checkout.abandoned_checkout_url || `https://mymayz.com`;

  // Save the checkout
  abandonedCheckouts[checkout.token] = {
    phone,
    name,
    items,
    total,
    url,
    createdAt:  Date.now(),
    reminded:   false,
    completed:  false
  };
  saveJSON(ABANDONED_FILE, abandonedCheckouts);

  // Cancel any existing timer for this phone (duplicate checkout events)
  cancelAbandonedTimerByPhone(phone);

  // Set 1-hour reminder timer
  abandonedTimers[checkout.token] = setTimeout(
    () => sendAbandonedReminder(checkout.token),
    15 * 60 * 1000   // 15 min
  );

  console.log(`🛒 Abandoned checkout saved for ${phone} — reminder in 1 hour`);
});

// ── Send the actual abandoned checkout WhatsApp ─────────────────
async function sendAbandonedReminder(token) {
  const checkout = abandonedCheckouts[token];
  if (!checkout || checkout.reminded || checkout.completed) return;

  await sendWA(checkout.phone,
    `مرحباً ${checkout.name}! 👋\n\n` +
    `لاحظنا إنك سبت منتجات في سلتك على myMayz 🛒\n\n` +
    `🛍️ ${checkout.items}\n` +
    `💰 الإجمالي: ${checkout.total} EGP\n\n` +
    `سلتك لسه موجودة! أكمل طلبك هنا:\n` +
    `👉 ${checkout.url}\n\n` +
    `لو محتاج مساعدة كلمنا في أي وقت 🙏`
  );

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

  const msg   = value.messages[0];
  const from  = normalisePhone(msg.from);
  const reply = (msg.text?.body || '').trim();

  console.log(`💬 WA reply from ${from}: "${reply}"`);

  const order = pendingOrders[from];
  if (!order) return;

  if (reply === '1') {
    // ── CONFIRMED ─────────────────────────────────────────────
    order.confirmed = true;
    saveJSON(PENDING_FILE, pendingOrders);

    await sendWA(from,
      `✅ تم تأكيد طلبك #${order.orderNo} بنجاح!\n` +
      `سيتم التجهيز والشحن قريباً 🎉\n\n` +
      `شكراً لثقتك في myMayz 🙏`
    );

    await tagOdooOrder(order.shopifyId, 'wa-confirmed');
    delete pendingOrders[from];
    saveJSON(PENDING_FILE, pendingOrders);

  } else if (reply === '2') {
    // ── CANCEL ────────────────────────────────────────────────
    order.cancelled = true;
    saveJSON(PENDING_FILE, pendingOrders);

    if (order.isCOD) {
      const ok = await odooCancel(order.shopifyId);
      await sendWA(from,
        ok
          ? `تم إلغاء طلبك #${order.orderNo} ✅\n` +
            `لا توجد مبالغ محصلة (الدفع عند الاستلام).\n` +
            `يمكنك الطلب مرة أخرى في أي وقت 🙏`
          : `تم استلام طلب الإلغاء.\nسيتم المعالجة خلال 24 ساعة 🙏`
      );
    } else {
      const [odooOk, refund] = await Promise.all([
        odooCancel(order.shopifyId),
        shopifyRefund(order.shopifyId)
      ]);
      if (odooOk && refund.success) {
        await sendWA(from,
          `تم إلغاء طلبك #${order.orderNo} ✅\n\n` +
          `💳 سيتم استرداد ${refund.amount} EGP تلقائياً\n` +
          `⏱️ خلال 3–7 أيام عمل حسب بنكك 🙏`
        );
      } else {
        await sendWA(from,
          `تم إلغاء طلبك #${order.orderNo} ✅\n` +
          `⚠️ سيتم معالجة الاسترداد يدوياً خلال 24 ساعة 🙏`
        );
      }
    }

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

  await sendWA(phone,
    `مرحباً! لاحظنا أنك لم تؤكد طلبك #${order.orderNo} بعد ⏰\n\n` +
    `✅ رد *1* للتأكيد\n` +
    `❌ رد *2* للإلغاء\n\n` +
    `إذا لم نتلقَ ردًا، سيتم تعليق الطلب تلقائياً.`
  );

  // Hold after another 2 hours with no reply
  setTimeout(() => holdIfNoReply(phone), 2 * 60 * 60 * 1000);
}

async function holdIfNoReply(phone) {
  const order = pendingOrders[phone];
  if (!order || order.confirmed || order.cancelled) return;

  await tagOdooOrder(order.shopifyId, 'wa-no-response');
  await sendWA(phone,
    `تم تعليق طلبك #${order.orderNo} مؤقتاً لعدم الرد.\n` +
    `للتواصل معنا: https://wa.me/201004444558`
  );
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
    // Try both field names used by different connector versions
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

async function tagOdooOrder(shopifyOrderId, tagName) {
  try {
    await odooAuth();
    const orders = await odooRpc('sale.order', 'search_read',
      [[ ['shopify_order_id', '=', String(shopifyOrderId)] ]],
      { fields: ['id'], limit: 1 }
    );
    if (!orders?.length) return;
    // Find or note the tag (assumes tags already created in Odoo)
    console.log(`🏷️  Odoo: tag "${tagName}" noted for order ${shopifyOrderId}`);
  } catch(e) {
    console.error('Odoo tag error:', e.message);
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
async function sendWA(phone, message) {
  try {
    const r = await fetch(
      `https://graph.facebook.com/v19.0/${META_PHONE_NUMBER_ID}/messages`,
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
      console.error(`❌ WA send error to ${phone}:`, data.error.message);
    } else {
      console.log(`✅ WA sent to ${phone}: ${message.substring(0, 60)}...`);
    }
  } catch(e) {
    console.error('sendWA error:', e.message);
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
  return p.replace('+', ''); // Meta API expects no +
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
    status:           'running',
    time:             new Date().toISOString(),
    pendingOrders:    Object.keys(pendingOrders).length,
    abandonedTimers:  Object.keys(abandonedTimers).length,
    abandonedTotal:   Object.keys(abandonedCheckouts).length
  });
});

// ================================================================
// ADMIN — list pending orders
// ================================================================
app.get('/admin/pending', (req, res) => {
  res.json(pendingOrders);
});

// ================================================================
// START
// ================================================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  restoreOrderTimers();
  restoreAbandonedTimers();
});
