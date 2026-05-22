// ================================================================
// shopify-whatsapp-server — server.js
// Features:
// ✅ Order confirmation (COD + Card) — WhatsApp templates
// ✅ Customer cancel reply via WhatsApp
// ✅ Auto-confirm overdue orders
// ✅ Abandoned checkout WhatsApp reminder
// ✅ Meta WhatsApp Cloud API (templates only — no free-form)
// ✅ Shopify order tagging (COD-Confirmed / Card-Confirmed / COD-Cancelled)
// ✅ Bulk send endpoint for manual campaigns
// ℹ️  Odoo integration removed — cancellations handled manually in Odoo
// ================================================================

const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const returnsRouter = require('./returns-routes');
const app = express();

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
  ADMIN_SECRET = 'mymayz-admin-2024',
  PORT = 3000
} = process.env;

// WhatsApp Business Account ID (for template submission)
const WABA_ID = process.env.WABA_ID || '900960922811775';

// ── Order template names (must match approved Meta templates) ────
const ORDER_TEMPLATES = {
  confirmation:   'order_confirmation',    // params: name, order#, payNote, total, items
  reminder:       'order_reminder',        // params: name, order#
  auto_confirmed: 'order_autoconfirmed',   // params: name, order#
  confirmed:      'order_confirmed',       // params: name, order#
  cancelled_cod:  'order_cancelled_cod',   // params: name, order#
  cancelled_card: 'order_cancelled_card',  // params: name, order#, refundInfo
};

// ── Persistent storage for pending orders ───────────────────────
const PENDING_FILE   = './pendingOrders.json';
const ABANDONED_FILE = './abandonedCheckouts.json';

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
  if (restored > 0) console.log(`♻️ Restored ${restored} abandoned checkout timer(s)`);
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
  if (restored > 0) console.log(`♻️ Restored ${restored} order confirmation timer(s)`);
}

// ================================================================
// SHOPIFY WEBHOOK — verify signature
// ================================================================
function verifyShopifyWebhook(req) {
  if (!SHOPIFY_WEBHOOK_SECRET) {
    console.warn('⚠️ SHOPIFY_WEBHOOK_SECRET not set — skipping HMAC check');
    return true;
  }
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac) return false;
  const hash = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody, 'utf8')
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash));
}

// ── Simple admin auth middleware ─────────────────────────────────
function requireAdminAuth(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret !== ADMIN_SECRET) {
    console.warn('[Admin] Unauthorized request from', req.ip);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ================================================================
// 1. SHOPIFY — ORDER CREATED (confirmation flow)
// ================================================================
app.post('/webhook/order-created', async (req, res) => {
  if (!verifyShopifyWebhook(req)) return res.status(401).send('Unauthorized');
  res.status(200).send('ok');

  const o     = req.body;
  const phone = normalisePhone(o.billing_address?.phone || o.shipping_address?.phone || o.customer?.phone);
  if (!phone) { console.log(`⚠️ No phone on order #${o.order_number}`); return; }

  const isCOD  = isCodOrder(o);
  const name   = o.customer?.first_name || 'عميلنا';
  const items  = (o.line_items || []).map(i => `${i.name} ×${i.quantity}`).join('، ');
  const payNote = isCOD ? 'الدفع عند الاستلام' : 'تم الدفع بالبطاقة';

  cancelAbandonedTimerByPhone(phone);

  pendingOrders[phone] = {
    orderNo:   o.order_number,
    shopifyId: String(o.id),
    name,
    total:     o.total_price,
    isCOD,
    gateway:   o.payment_gateway,
    sentAt:    Date.now(),
    retried:   false,
    confirmed: false,
    cancelled: false
  };
  saveJSON(PENDING_FILE, pendingOrders);

  await sendWATemplate(phone, ORDER_TEMPLATES.confirmation, 'ar', [
    name, String(o.order_number), payNote, String(o.total_price), items
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
    console.log(`⚠️ Abandoned checkout ${checkout.token} — no phone number, skipping`);
    return;
  }

  if (pendingOrders[phone]) {
    console.log(`ℹ️ Abandoned checkout for ${phone} — already has pending order, skipping`);
    return;
  }

  if (abandonedCheckouts[checkout.token]?.reminded) {
    console.log(`ℹ️ Abandoned checkout ${checkout.token} already reminded`);
    return;
  }

  const name  = checkout.billing_address?.first_name ||
                checkout.shipping_address?.first_name ||
                'عميلنا';
  const items = (checkout.line_items || []).map(i => `${i.title} ×${i.quantity}`).join('، ');
  const total = checkout.total_price || '0.00';
  const url   = checkout.abandoned_checkout_url || 'https://mymayz.com';

  abandonedCheckouts[checkout.token] = {
    phone, name, items, total, url,
    createdAt: Date.now(),
    reminded:  false,
    completed: false
  };
  saveJSON(ABANDONED_FILE, abandonedCheckouts);

  cancelAbandonedTimerByPhone(phone);

  abandonedTimers[checkout.token] = setTimeout(
    () => sendAbandonedReminder(checkout.token),
    15 * 60 * 1000
  );

  console.log(`🛒 Abandoned checkout saved for ${phone} — reminder in 15 min`);
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

  const msg   = value.messages[0];
  const from  = normalisePhone(msg.from);
  const reply = (msg.text?.body || '').trim();

  console.log(`💬 WA reply from ${from}: "${reply}"`);

  const order = pendingOrders[from];
  if (!order) return;

  // ── Customer confirmed ────────────────────────────────────────
  if (reply === '1') {
    order.confirmed = true;
    saveJSON(PENDING_FILE, pendingOrders);

    await sendWATemplate(from, ORDER_TEMPLATES.confirmed, 'ar', [
      order.name, String(order.orderNo)
    ]);

    const shopifyTag = order.isCOD ? 'COD-Confirmed' : 'Card-Confirmed';
    await tagShopifyOrder(order.shopifyId, shopifyTag);
    delete pendingOrders[from];
    saveJSON(PENDING_FILE, pendingOrders);

  // ── Customer cancelled ────────────────────────────────────────
  } else if (reply === '2') {
    order.cancelled = true;
    saveJSON(PENDING_FILE, pendingOrders);

    if (order.isCOD) {
      // COD — no charge to refund; team will cancel in Odoo manually
      await sendWATemplate(from, ORDER_TEMPLATES.cancelled_cod, 'ar', [
        order.name, String(order.orderNo)
      ]);
      await tagShopifyOrder(order.shopifyId, 'COD-Cancelled');

    } else {
      // Card — attempt Shopify refund; team will cancel in Odoo manually
      const refund = await shopifyRefund(order.shopifyId);
      const refundInfo = refund.success
        ? `سيتم استرداد ${refund.amount} EGP تلقائياً خلال 3-7 أيام عمل حسب بنكك 🙏`
        : 'سيتم معالجة الاسترداد يدوياً خلال 24 ساعة 🙏';

      await sendWATemplate(from, ORDER_TEMPLATES.cancelled_card, 'ar', [
        order.name, String(order.orderNo), refundInfo
      ]);
      await tagShopifyOrder(order.shopifyId, 'COD-Cancelled');
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

  await sendWATemplate(phone, ORDER_TEMPLATES.reminder, 'ar', [
    order.name, String(order.orderNo)
  ]);

  setTimeout(() => autoConfirmIfNoReply(phone), 3 * 60 * 60 * 1000);
}

async function autoConfirmIfNoReply(phone) {
  const order = pendingOrders[phone];
  if (!order || order.confirmed || order.cancelled) return;

  order.confirmed = true;
  saveJSON(PENDING_FILE, pendingOrders);

  console.log(`⏰ Auto-confirming order #${order.orderNo} for ${phone} — no reply in 4 hours`);

  await sendWATemplate(phone, ORDER_TEMPLATES.auto_confirmed, 'ar', [
    order.name, String(order.orderNo)
  ]);

  const shopifyTag = order.isCOD ? 'COD-Confirmed' : 'Card-Confirmed';
  await tagShopifyOrder(order.shopifyId, shopifyTag);

  delete pendingOrders[phone];
  saveJSON(PENDING_FILE, pendingOrders);
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
// SHOPIFY ORDER TAGGING
// ================================================================
async function tagShopifyOrder(shopifyOrderId, tag) {
  try {
    const base    = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${shopifyOrderId}`;
    const headers = { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' };

    const r    = await fetch(`${base}.json?fields=id,tags`, { headers });
    const data = await r.json();
    const currentTags = data.order?.tags || '';
    const tagsList    = currentTags.split(',').map(t => t.trim()).filter(t => t);

    if (!tagsList.includes(tag)) {
      tagsList.push(tag);
      await fetch(`${base}.json`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ order: { id: shopifyOrderId, tags: tagsList.join(', ') } })
      });
      console.log(`🏷️ Shopify: tagged order ${shopifyOrderId} with "${tag}" ✅`);
    }
  } catch(e) {
    console.error('Shopify tag error:', e.message);
  }
}

// ================================================================
// META WHATSAPP — send template message
// ================================================================
async function sendWATemplate(phone, templateName, languageCode, params) {
  try {
    const components = params.length > 0 ? [{
      type: 'body',
      parameters: params.map(p => ({ type: 'text', text: String(p) }))
    }] : [];

    const r = await fetch(
      `https://graph.facebook.com/v19.0/${META_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
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
      console.error(`❌ WA template error to ${phone} [${templateName}]:`, JSON.stringify(data.error));
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
  let p = String(phone).replace(/[\s\-\(\)\+]/g, '');
  if (p.startsWith('0')) p = '20' + p.slice(1);
  if (!p.startsWith('20') && p.length >= 10) p = '20' + p;
  return p;
}

function isCodOrder(order) {
  // Only trust the payment gateway — do NOT use financial_status (it is 'pending'
  // for a few seconds on card orders too, which would misclassify them as COD).
  return ['cash_on_delivery', 'cod', 'manual'].includes(
    (order.payment_gateway || '').toLowerCase()
  );
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
// ADMIN — list pending orders  (requires x-admin-secret header)
// ================================================================
app.get('/admin/pending', requireAdminAuth, (req, res) => {
  res.json(pendingOrders);
});

// ================================================================
// ADMIN — BULK SEND  (requires x-admin-secret header)
// POST /admin/bulk-send
// Body: { "orders": [ { "phone", "firstName", "name", "shopifyId", "total", "items", "isCOD" } ] }
// ================================================================
app.post('/admin/bulk-send', requireAdminAuth, async (req, res) => {
  const orders = req.body.orders || [];
  if (!orders.length) return res.json({ sent: 0, failed: 0, errors: ['No orders provided'] });

  console.log(`📤 Bulk send started for ${orders.length} orders`);
  let sent = 0, failed = 0, errors = [];

  for (const o of orders) {
    if (!o.phone) { failed++; errors.push(`${o.name}: no phone`); continue; }

    try {
      await sendWATemplate(o.phone, ORDER_TEMPLATES.confirmation, 'ar', [
        o.firstName || 'عميلنا',
        String(o.name),
        'الدفع عند الاستلام',
        String(o.total),
        String(o.items)
      ]);

      pendingOrders[o.phone] = {
        orderNo:   o.name,
        shopifyId: String(o.shopifyId || ''),
        name:      o.firstName || 'عميلنا',
        total:     o.total,
        isCOD:     o.isCOD !== false,
        gateway:   'cash_on_delivery',
        sentAt:    Date.now(),
        retried:   false,
        confirmed: false,
        cancelled: false
      };
      saveJSON(PENDING_FILE, pendingOrders);
      setTimeout(() => retryIfNoReply(o.phone), 60 * 60 * 1000);

      console.log(`✅ Bulk sent + registered: ${o.name} → ${o.phone}`);
      sent++;
    } catch(e) {
      failed++;
      errors.push(`${o.name}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 350));
  }

  saveJSON(PENDING_FILE, pendingOrders);
  console.log(`📤 Bulk send done: ${sent} sent, ${failed} failed`);
  res.json({ sent, failed, errors });
});

// ================================================================
// ADMIN — TEST ABANDONED CHECKOUT REMINDER
// GET /admin/test-abandoned?phone=201004444558&secret=...
// ================================================================
app.get('/admin/test-abandoned', requireAdminAuth, async (req, res) => {
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
// SUBMIT ORDER TEMPLATES TO META  (requires x-admin-secret)
// GET /submit-order-templates?secret=...
// Submits all 6 order templates for Meta review.
// Run once — re-running is safe (Meta will reject duplicates gracefull==============================================================
app.get('/submit-order-templates', requireAdminAuth, async (req, res) => {
  const url = `https://graph.facebook.com/v19.0/${WABA_ID}/message_templates`;
  const headers = {
    'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
    'Content-Type':  'application/json'
  };

  const templates = [
    {
      name: 'order_confirmation',
      body: 'مرحباً {{1}}! 👋\n\nشكراً لطلبك من myMayz 🎉\n\n📦 رقم الطلب: #{{2}}\n{{3}} — {{4}} EGP\n🛍️ {{5}}\n\nيرجى تأكيد طلبك الآن:\n✅ اكتب *1* للتأكيد\n❌ اكتب *2* للإلغاء\n\n— فريق myMayz 🌿',
      example: [['أحمد', '53760', 'الدفع عند الاستلام', '299', 'Alkaline Clay Water Bottle ×1']]
    },
    {
      name: 'order_reminder',
      body: 'مرحباً {{1}}! ⏰\n\nلاحظنا أنك لم تؤكد طلبك #{{2}} بعد\n\n✅ رد *1* للتأكيد\n❌ رد *2* للإلغاء\n\nإذا لم نتلقَ ردًا، سيتم تأكيد الطلب تلقائياً خلال 3 ساعات.\n\n— فريق myMayz 🌿',
      example: [['أحمد', '53760']]
    },
    {
      name: 'order_autoconfirmed',
      body: 'مرحباً {{1}}! ✅\n\nتم تأكيد طلبك #{{2}} تلقائياً\n\nسيتم التجهيز والشحن قريباً 🚚\n\nشكراً لثقتك في myMayz 🙏\n\n— فريق myMayz 🌿',
      example: [['أحمد', '53760']]
    },
    {
      name: 'order_confirmed',
      body: 'مرحباً {{1}}! 🎉\n\nتم تأكيد طلبك #{{2}} بنجاح ✅\n\nسيتم التجهيز والشحن قريباً\n\nشكراً لثقتك في myMayz 🙏\n\n— فريق myMayz 🌿',
      example: [['أحمد', '53760']]
    },
    {
      name: 'order_cancelled_cod',
      body: 'مرحباً {{1}}!\n\nتم استلام طلب الإلغاء لطلبك #{{2}} ✅\n\nلا توجد مبالغ محصلة (الدفع عند الاستلام).\nسيتم إلغاء الطلب خلال 24 ساعة 🙏\n\nيمكنك الطلب مرة أخرى في أي وقت ❤️\n\n— فريق myMayz 🌿',
      example: [['أحمد', '53760']]
    },
    {
      name: 'order_cancelled_card',
      body: 'مرحباً {{1}}!\n\nتم إلغاء طلبك #{{2}} ✅\n\n{{3}}\n\n— فريق myMayz 🌿',
      example: [['أحمد', '53760', 'سيتم استرداد 299 EGP تلقائياً خلال 3-7 أيام عمل حسب بنكك 🙏']]
    }
  ];

  const results = [];
  for (const tpl of templates) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name:     tpl.name,
          language: 'ar',
          category: 'UTILITY',
          components: [{
            type: 'BODY',
            text: tpl.body,
            example: { body_text: tpl.example }
          }]
        })
      });
      const data = await r.json();
      results.push({ name: tpl.name, ok: r.ok, data });
      console.log(`📋 Template "${tpl.name}": ${r.ok ? '✅ submitted' : '❌ ' + JSON.stringify(data.error)}`);
    } catch(e) {
      results.push({ name: tpl.name, ok: false, error: e.message });
    }
  }

  res.json({ submitted: results.length, results });
});

// ================================================================
// START
// ================================================================
app.use('/returns', returnsRouter);

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  restoreOrderTimers();
  restoreAbandonedTimers();
});
