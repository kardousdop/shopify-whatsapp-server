// ================================================================
// shopify-whatsapp-server — server.js
// Last deploy: 2026-05-30 08:10 UTC
// Features:
// ✅ COD orders  — confirmation flow (1/2 reply) → COD-Confirmed / COD-Cancelled
// ✅ Paid orders — simple receipt message → tagged 'Paid' immediately, no reply needed
// ✅ Auto-confirm overdue COD orders after 4 hours
// ✅ Abandoned checkout WhatsApp reminder — Supabase-backed queue
// ✅ Meta WhatsApp Cloud API (templates only — no free-form)
// ✅ Shopify order tagging (COD-Confirmed / COD-Cancelled / Paid)
// ✅ Bulk send endpoint for manual campaigns
// ✅ Inbound WA messages stored in mm_wa_inbox (Supabase)
// ✅ Admin inbox endpoint GET /wa/inbox
// ✅ Admin reply endpoint POST /wa/reply
// ℹ️ Odoo integration removed — cancellations handled manually in Odoo
// ================================================================

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const returnsRouter = require('./returns-routes');
const app = express();

// ── CORS — allow browser requests from any origin ───────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-secret,x-returns-secret');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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
  META_APP_SECRET,
  SHOPIFY_STORE_URL,
  SHOPIFY_ADMIN_TOKEN,
  SHOPIFY_WEBHOOK_SECRET,
  SUPABASE_URL,
  SUPABASE_KEY,
  ADMIN_SECRET = 'mymayz-admin-2024',
  PORT = 3000
} = process.env;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'mymayz-verify-2024';
// Owner number that receives the daily WhatsApp delivery report + instant problem alerts
const OWNER_PHONE = process.env.OWNER_PHONE || '201004444558';

// WhatsApp Business Account ID (for template submission)
const WABA_ID = process.env.WABA_ID || '900960922811775';

// Abandoned-checkout reminder: 10% discount code shown in the message and
// pre-applied on the recovery link. Template cart_reminder_discount ({{1}} name,
// {{2}} items, {{3}} total, {{4}} code, {{5}} url); falls back to the old
// 4-param cart_reminder until the new template is approved by Meta.
const ABANDONED_DISCOUNT_CODE = process.env.ABANDONED_DISCOUNT_CODE || 'SBYGWOL10';
const ABANDONED_TEMPLATE      = process.env.ABANDONED_TEMPLATE || 'cart_reminder_discount';
function withDiscount(url) {
  if (!url || !ABANDONED_DISCOUNT_CODE || /[?&]discount=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'discount=' + encodeURIComponent(ABANDONED_DISCOUNT_CODE);
}

// ── Supabase client ──────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Order template names (must match approved Meta templates) ────
const ORDER_TEMPLATES = {
  confirmation:   'order_confirmation',   // COD only — params: name, order#, payNote, total, items
  paid_received:  'order_received_paid',  // Paid only — params: name, order#
  reminder:       'order_reminder',       // params: name, order#
  auto_confirmed: 'order_autoconfirmed',  // params: name, order#
  confirmed:      'order_confirmed',      // params: name, order#
  cancelled_cod:  'order_cancelled_cod',  // params: name, order#
  cancelled_card: 'order_cancelled_card', // params: name, order#, refundInfo
};

// ── Pending orders — in-memory map + Supabase persistence ────────
// Supabase table: mm_pending_orders (phone text PK, data jsonb, created_at timestamptz)
let pendingOrders = {};   // phone → order object (fast in-memory lookup)

async function savePendingOrder(phone, order) {
  pendingOrders[phone] = order;
  try {
    await supabase.from('mm_pending_orders').upsert({ phone, data: order }, { onConflict: 'phone' });
  } catch(e) { console.error('savePendingOrder error:', e.message); }
}

async function deletePendingOrder(phone) {
  delete pendingOrders[phone];
  try { await supabase.from('mm_pending_orders').delete().eq('phone', phone); }
  catch(e) { console.error('deletePendingOrder error:', e.message); }
}

async function loadAllPendingOrders() {
  try {
    const { data, error } = await supabase.from('mm_pending_orders').select('phone, data');
    if (error) { console.error('loadAllPendingOrders error:', error.message); return; }
    (data || []).forEach(row => { pendingOrders[row.phone] = row.data; });
    console.log(`♻️ Loaded ${(data||[]).length} pending order(s) from Supabase`);
  } catch(e) { console.error('loadAllPendingOrders exception:', e.message); }
}

// ── Restore order confirmation timers on restart ─────────────────
async function restoreOrderTimers() {
  await loadAllPendingOrders();
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
// 1. SHOPIFY — ORDER CREATED
//    COD  → send confirmation request (reply 1/2), save to pendingOrders
//    Paid → send simple receipt message, tag 'Paid' immediately
// ================================================================
app.post('/webhook/order-created', async (req, res) => {
  if (!verifyShopifyWebhook(req)) return res.status(401).send('Unauthorized');
  res.status(200).send('ok');

  const o     = req.body;
  const phone = normalisePhone(o.billing_address?.phone || o.shipping_address?.phone || o.customer?.phone);
  if (!phone) { console.log(`⚠️ No phone on order #${o.order_number}`); return; }

  const isCOD = isCodOrder(o);
  const name  = o.customer?.first_name || 'عميلنا';

  await cancelAbandonedTimerByPhone(phone);

  if (isCOD) {
    // ── COD: ask customer to confirm (1) or cancel (2) ──────────
    const items   = (o.line_items || []).map(i => `${i.name} ×${i.quantity}`).join('، ');
    const payNote = 'الدفع عند الاستلام';

    await savePendingOrder(phone, {
      orderNo:  o.order_number,
      shopifyId: String(o.id),
      name,
      total:    o.total_price,
      isCOD:    true,
      gateway:  o.payment_gateway,
      sentAt:   Date.now(),
      retried:  false,
      confirmed: false,
      cancelled: false
    });

    await sendWATemplate(phone, ORDER_TEMPLATES.confirmation, 'ar', [
      name, String(o.order_number), payNote, String(o.total_price), items
    ]);

    setTimeout(() => retryIfNoReply(phone), 60 * 60 * 1000);
    console.log(`📦 COD order #${o.order_number} — confirmation sent to ${phone}`);

  } else {
    // ── Paid: send simple receipt, tag immediately, no pending state ──
    await sendWATemplate(phone, ORDER_TEMPLATES.paid_received, 'ar', [
      name, String(o.order_number)
    ]);
    await tagShopifyOrder(String(o.id), 'Paid');
    console.log(`💳 Paid order #${o.order_number} — receipt sent to ${phone}, tagged 'Paid'`);
  }
});

// ================================================================
// 2. SHOPIFY — ABANDONED CHECKOUT (Supabase-backed persistent queue)
// ================================================================
app.post('/webhook/checkout', async (req, res) => {
  if (!verifyShopifyWebhook(req)) return res.status(401).send('Unauthorized');
  res.status(200).send('ok');

  const checkout = req.body;
  let phone = normalisePhone(
    checkout.billing_address?.phone ||
    checkout.shipping_address?.phone ||
    checkout.phone
  );

  // ── Fallback: look up phone from Shopify customer account via email ──
  if (!phone && checkout.email) {
    try {
      const custRes = await fetch(
        `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/customers/search.json?query=email:${encodeURIComponent(checkout.email)}&fields=id,phone&limit=1`,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN } }
      );
      const custData = await custRes.json();
      const custPhone = custData.customers?.[0]?.phone;
      if (custPhone) {
        phone = normalisePhone(custPhone);
        console.log(`📞 Resolved phone ${phone} from customer email ${checkout.email}`);
      }
    } catch(e) {
      console.error('Customer phone lookup error:', e.message);
    }
  }

  if (!phone) {
    console.log(`⚠️ Abandoned checkout ${checkout.token} — no phone number (email: ${checkout.email || 'none'}), skipping`);
    return;
  }

  if (pendingOrders[phone]) {
    console.log(`ℹ️ Abandoned checkout for ${phone} — already has pending order, skipping`);
    return;
  }

  const name  = checkout.billing_address?.first_name ||
                checkout.shipping_address?.first_name ||
                'عميلنا';
  const items = (checkout.line_items || []).map(i => `${i.title} ×${i.quantity}`).join('، ');
  const total = checkout.total_price || '0.00';
  const url   = withDiscount(checkout.abandoned_checkout_url || 'https://mymayz.com');

  const scheduledAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('mm_abandoned_checkouts')
    .upsert({
      checkout_token: checkout.token,
      phone,
      cust_name: name,
      items,
      total,
      checkout_url: url,
      scheduled_at: scheduledAt,
      sent: false,
      sent_at: null
    }, { onConflict: 'checkout_token' });

  if (error) {
    console.error('❌ Supabase upsert abandoned checkout error:', error.message);
  } else {
    console.log(`🛒 Abandoned checkout queued for ${phone} — reminder at ${scheduledAt}`);
  }
});

// ================================================================
// 3. CRON — SEND DUE ABANDONED CHECKOUT REMINDERS
// Send one abandoned-cart reminder: discount template first, old template as fallback
// (Meta error 132001 = template not found / not approved yet).
async function sendCartReminder(row) {
  const url = withDiscount(row.checkout_url);
  const data = await sendWATemplate(row.phone, ABANDONED_TEMPLATE, 'ar', [
    row.cust_name, row.items, row.total, ABANDONED_DISCOUNT_CODE, url
  ]);
  if (data?.error) {
    console.warn(`↩️ ${ABANDONED_TEMPLATE} failed (${data.error.code}), falling back to cart_reminder for ${row.phone}`);
    return sendWATemplate(row.phone, 'cart_reminder', 'ar', [row.cust_name, row.items, row.total, url]);
  }
  return data;
}

// GET /cron/send-abandoned?secret=mymayz-admin-2024
// ================================================================
app.get('/cron/send-abandoned', requireAdminAuth, async (req, res) => {
  const now = new Date().toISOString();

  const { data: dueRows, error: fetchError } = await supabase
    .from('mm_abandoned_checkouts')
    .select('*')
    .eq('sent', false)
    .lte('scheduled_at', now);

  if (fetchError) {
    console.error('❌ Cron fetch error:', fetchError.message);
    return res.status(500).json({ error: fetchError.message });
  }

  if (!dueRows || dueRows.length === 0) {
    return res.json({ processed: 0, message: 'No due reminders' });
  }

  console.log(`⏰ Cron: ${dueRows.length} abandoned checkout reminder(s) to send`);
  let sent = 0, failed = 0;

  for (const row of dueRows) {
    try {
      await sendCartReminder(row);

      await supabase
        .from('mm_abandoned_checkouts')
        .update({ sent: true, sent_at: new Date().toISOString() })
        .eq('id', row.id);

      console.log(`📤 Abandoned checkout reminder sent to ${row.phone}`);
      sent++;
    } catch(e) {
      console.error(`❌ Failed to send reminder to ${row.phone}:`, e.message);
      failed++;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  res.json({ processed: dueRows.length, sent, failed });
});

// ── Cancel abandoned checkout reminder when order is placed ─────
async function cancelAbandonedTimerByPhone(phone) {
  try {
    const { error } = await supabase
      .from('mm_abandoned_checkouts')
      .update({ sent: true, sent_at: new Date().toISOString() })
      .eq('phone', phone)
      .eq('sent', false);

    if (error) console.error('cancelAbandonedTimerByPhone error:', error.message);
    else       console.log(`✅ Cancelled abandoned reminder for ${phone} — order placed`);
  } catch(e) {
    console.error('cancelAbandonedTimerByPhone exception:', e.message);
  }
}

// ================================================================
// 4. META WHATSAPP WEBHOOK — verify (GET)
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
// 5. META WHATSAPP WEBHOOK — incoming messages for order flow (POST)
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
    await sendWATemplate(from, ORDER_TEMPLATES.confirmed, 'ar', [order.name, String(order.orderNo)]);
    const shopifyTag = order.isCOD ? 'COD-Confirmed' : 'Card-Confirmed';
    await tagShopifyOrder(order.shopifyId, shopifyTag);
    await deletePendingOrder(from);

  } else if (reply === '2') {
    if (order.isCOD) {
      await sendWATemplate(from, ORDER_TEMPLATES.cancelled_cod, 'ar', [order.name, String(order.orderNo)]);
      await tagShopifyOrder(order.shopifyId, 'COD-Cancelled');
    } else {
      const refund = await shopifyRefund(order.shopifyId);
      const refundInfo = refund.success
        ? `سيتم استرداد ${refund.amount} EGP تلقائياً خلال 3-7 أيام عمل حسب بنكك 🙏`
        : 'سيتم معالجة الاسترداد يدوياً خلال 24 ساعة 🙏';
      await sendWATemplate(from, ORDER_TEMPLATES.cancelled_card, 'ar', [order.name, String(order.orderNo), refundInfo]);
      await tagShopifyOrder(order.shopifyId, 'COD-Cancelled');
    }
    await deletePendingOrder(from);
  }
});

// ================================================================
// 6. RETRY LOGIC — no reply after 1 hour
// ================================================================
async function retryIfNoReply(phone) {
  const order = pendingOrders[phone];
  if (!order || order.confirmed || order.cancelled || order.retried) return;
  order.retried = true;
  await savePendingOrder(phone, order);
  await sendWATemplate(phone, ORDER_TEMPLATES.reminder, 'ar', [order.name, String(order.orderNo)]);
  setTimeout(() => autoConfirmIfNoReply(phone), 3 * 60 * 60 * 1000);
}

async function autoConfirmIfNoReply(phone) {
  const order = pendingOrders[phone];
  if (!order || order.confirmed || order.cancelled) return;
  order.confirmed = true;
  console.log(`⏰ Auto-confirming order #${order.orderNo} for ${phone} — no reply in 4 hours`);
  await sendWATemplate(phone, ORDER_TEMPLATES.auto_confirmed, 'ar', [order.name, String(order.orderNo)]);
  const shopifyTag = order.isCOD ? 'COD-Confirmed' : 'Card-Confirmed';
  await tagShopifyOrder(order.shopifyId, shopifyTag);
  await deletePendingOrder(phone);
}

// ================================================================
// SHOPIFY REFUND API
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
    const payment = txRes.transactions?.find(t => t.status === 'success' && (t.kind === 'sale' || t.kind === 'capture'));
    if (!payment) return { success: false };
    const refundRes = await fetch(`${base}/refunds.json`, {
      method: 'POST', headers,
      body: JSON.stringify({ refund: {
        currency: payment.currency,
        notify: false,
        note: 'Customer cancelled via WhatsApp before fulfillment',
        refund_line_items: order.line_items.map(i => ({ line_item_id: i.id, quantity: i.quantity, restock_type: 'return' })),
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
    const r       = await fetch(`${base}.json?fields=id,tags`, { headers });
    const data    = await r.json();
    const tagsList = (data.order?.tags || '').split(',').map(t => t.trim()).filter(t => t);
    if (!tagsList.includes(tag)) {
      tagsList.push(tag);
      await fetch(`${base}.json`, {
        method: 'PUT', headers,
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
        headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone,
          type: 'template',
          template: { name: templateName, language: { code: languageCode }, components }
        })
      }
    );
    const data = await r.json();
    if (data.error) console.error(`❌ WA template error to ${phone} [${templateName}]:`, JSON.stringify(data.error));
    else            console.log(`✅ WA template "${templateName}" sent to ${phone}`);
    return data;
  } catch(e) {
    console.error('sendWATemplate error:', e.message);
  }
}

// ================================================================
// META WHATSAPP — send free-form text (within 24h window)
// ================================================================
async function sendWAText(phone, message) {
  const r = await fetch(
    `https://graph.facebook.com/v19.0/${META_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: message }
      })
    }
  );
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data;
}

// ================================================================
// WHATSAPP HEALTH MONITORING — daily report + instant alerts to owner
// ================================================================
let _lastOwnerAlert = 0;          // throttle systemic alerts to 1/hour
let _lastDailyReportDay = null;   // Cairo YYYY-MM-DD of the last daily report sent

// Best-effort owner alert (throttled). NOTE: if the account is fully locked,
// this WA send itself will fail — the daily report (and its absence) is the backstop.
async function maybeAlertOwner(message) {
  const now = Date.now();
  if (now - _lastOwnerAlert < 60 * 60 * 1000) return;
  _lastOwnerAlert = now;
  try { await sendWAText(OWNER_PHONE, message); console.log('🔔 Owner alert sent'); }
  catch (e) { console.error('🔔❌ Owner alert FAILED (channel may be down):', e.message); }
}

// Live account health via Graph (works as a read even if messaging is limited)
async function fetchWAHealth() {
  try {
    const r = await fetch(
      `https://graph.facebook.com/v19.0/${META_PHONE_NUMBER_ID}?fields=health_status,quality_rating`,
      { headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}` } }
    );
    const d = await r.json();
    if (d.error) return { ok: false, label: `❗ API/token error ${d.error.code}` };
    const cs = d.health_status?.can_send_message;
    return { ok: cs === 'AVAILABLE', canSend: cs, quality: d.quality_rating,
             label: cs === 'AVAILABLE' ? `✅ AVAILABLE (${d.quality_rating || '—'})` : `❗ ${cs || 'NOT available'}` };
  } catch (e) { return { ok: false, label: `❗ ${e.message}` }; }
}

// Build the last-24h delivery summary text (Arabic) + a problem flag
async function buildDailyReport() {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  let rows = [];
  try {
    const { data } = await supabase
      .from('mm_wa_delivery')
      .select('status,error,created_at')
      .gte('created_at', since);
    rows = data || [];
  } catch (e) { console.warn('buildDailyReport query non-fatal:', e.message); }

  const c = { sent: 0, delivered: 0, read: 0, failed: 0 };
  const failBy = {};
  for (const r of rows) {
    if (c[r.status] !== undefined) c[r.status]++;
    if (r.status === 'failed') {
      const code = (Array.isArray(r.error) && r.error[0]?.code) || r.error?.code || '?';
      failBy[code] = (failBy[code] || 0) + 1;
    }
  }
  const total = rows.length;
  const reached = c.delivered + c.read;        // delivered or read = arrived at the customer
  const health = await fetchWAHealth();
  const failLine = c.failed > 0
    ? `\n⚠️ فشل: ${c.failed}` + (Object.keys(failBy).length ? ` (${Object.entries(failBy).map(([k, v]) => `${v}×${k}`).join(', ')})` : '')
    : '';
  const text =
    `📊 myMayz WhatsApp — آخر ٢٤ ساعة\n` +
    `إجمالي الرسائل: ${total}\n` +
    `✅ وصلت للعميل: ${reached}  (تم التسليم ${c.delivered} · تمت القراءة ${c.read})\n` +
    `⏳ في الانتظار: ${c.sent}` +
    failLine + `\n` +
    `حالة الحساب: ${health.label}`;
  const problem = !health.ok || c.failed > 0;
  // Params for the `daily_wa_report` template (must be single-line, non-empty).
  const failSummary = c.failed > 0
    ? `${c.failed}` + (Object.keys(failBy).length ? ` (${Object.entries(failBy).map(([k, v]) => `${v}×${k}`).join(', ')})` : '')
    : '0';
  const params = [String(total), String(reached), String(c.sent), failSummary, health.label || '—'];
  return { text, problem, counts: c, total, health, params };
}

async function sendDailyReport(reason) {
  const rep = await buildDailyReport();
  // Prefer the approved UTILITY template `daily_wa_report` — templates deliver
  // even when the owner's 24h customer-service window is closed (free-form text
  // fails there with error 131047). Fall back to free-form only if the template
  // isn't approved yet / errors.
  let sentVia = null;
  try {
    const r = await sendWATemplate(OWNER_PHONE, 'daily_wa_report', 'ar', rep.params);
    if (r && r.messages && !r.error) sentVia = 'template';
  } catch (e) { /* fall through to text */ }
  if (!sentVia) {
    const prefix = rep.problem ? '🚨 تنبيه — ' : '';
    try {
      await sendWAText(OWNER_PHONE, prefix + rep.text);
      sentVia = 'text';
    } catch (e) {
      console.error('📊❌ Daily report send failed (template + text both failed):', e.message);
    }
  }
  console.log(`📊 Daily WA report sent via ${sentVia || 'NONE'} (${reason}) — problem=${rep.problem}`);
  return rep;
}

// Internal scheduler — fires the daily report once per day at ~09:00 Africa/Cairo.
// Self-contained (no external cron needed); the server runs 24/7 on Railway.
function startWAReportScheduler() {
  setInterval(async () => {
    try {
      const cairo = new Date().toLocaleString('en-CA', { timeZone: 'Africa/Cairo', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
      // cairo like "2026-06-19, 09" → split date + hour
      const [datePart, hourPart] = cairo.split(', ');
      const hour = parseInt(hourPart, 10);
      if (hour >= 9 && _lastDailyReportDay !== datePart) {
        _lastDailyReportDay = datePart;
        await sendDailyReport('scheduled-09:00-Cairo');
      }
    } catch (e) { console.warn('WA report scheduler tick non-fatal:', e.message); }
  }, 10 * 60 * 1000); // check every 10 minutes
  console.log('🕘 WhatsApp daily-report scheduler started (09:00 Africa/Cairo)');
}

// Internal scheduler — flushes due abandoned-checkout reminders every 5 min.
// Self-contained (no external cron). Same logic as the standalone
// GET /cron/send-abandoned route, which is left untouched for manual runs; this
// just guarantees the queue never sits unsent waiting on an external scheduler.
async function sendDueAbandoned() {
  const now = new Date().toISOString();
  const { data: dueRows, error } = await supabase
    .from('mm_abandoned_checkouts')
    .select('*')
    .eq('sent', false)
    .lte('scheduled_at', now);
  if (error) { console.warn('abandoned scheduler fetch non-fatal:', error.message); return; }
  if (!dueRows || dueRows.length === 0) return;
  console.log(`🛒 Scheduler: ${dueRows.length} abandoned reminder(s) due`);
  for (const row of dueRows) {
    try {
      await sendCartReminder(row);
      await supabase
        .from('mm_abandoned_checkouts')
        .update({ sent: true, sent_at: new Date().toISOString() })
        .eq('id', row.id);
      console.log(`📤 Abandoned reminder sent to ${row.phone}`);
    } catch (e) {
      console.error(`❌ Abandoned reminder failed for ${row.phone}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }
}

function startAbandonedScheduler() {
  setInterval(() => {
    sendDueAbandoned().catch(e => console.warn('abandoned scheduler tick non-fatal:', e.message));
  }, 5 * 60 * 1000); // every 5 minutes
  console.log('🛒 Abandoned-checkout scheduler started (every 5 min)');
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
  const gateway = (order.payment_gateway || '').toLowerCase();
  // Gateway-based detection — covers all common COD names
  const isCodGateway = gateway.includes('cod') ||
                       gateway.includes('cash') ||
                       gateway.includes('delivery') ||
                       gateway === 'manual';
  // Financial status fallback — paid orders are always 'paid', COD starts as 'pending'
  const isPending = order.financial_status === 'pending';
  return isCodGateway || isPending;
}

// ================================================================
// HEALTH CHECK
// ================================================================
app.get('/', (req, res) => {
  res.json({ status: 'running', time: new Date().toISOString(), pendingOrdersInMemory: Object.keys(pendingOrders).length });
});

// ================================================================
// ADMIN — list pending orders
// ================================================================
app.get('/admin/pending', requireAdminAuth, (req, res) => {
  res.json(pendingOrders);
});

// ================================================================
// ADMIN — BULK SEND
// POST /admin/bulk-send
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
        o.firstName || 'عميلنا', String(o.name), 'الدفع عند الاستلام', String(o.total), String(o.items)
      ]);
      await savePendingOrder(o.phone, {
        orderNo: o.name, shopifyId: String(o.shopifyId || ''), name: o.firstName || 'عميلنا',
        total: o.total, isCOD: o.isCOD !== false, gateway: 'cash_on_delivery',
        sentAt: Date.now(), retried: false, confirmed: false, cancelled: false
      });
      setTimeout(() => retryIfNoReply(o.phone), 60 * 60 * 1000);
      console.log(`✅ Bulk sent + registered: ${o.name} → ${o.phone}`);
      sent++;
    } catch(e) {
      failed++;
      errors.push(`${o.name}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 350));
  }

  console.log(`📤 Bulk send done: ${sent} sent, ${failed} failed`);
  res.json({ sent, failed, errors });
});

// ================================================================
// ADMIN — TEST ABANDONED CHECKOUT REMINDER
// ================================================================
app.get('/admin/test-abandoned', requireAdminAuth, async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.json({ error: 'phone param required' });
  await sendCartReminder({ phone, cust_name: 'عميلنا', items: 'Alkaline Clay Water Bottle ×1', total: '784', checkout_url: 'https://mymayz.com' });
  console.log(`🧪 Test abandoned template sent to ${phone}`);
  res.json({ sent: true, to: phone });
});

// ================================================================
// SUBMIT ORDER TEMPLATES TO META
// ================================================================
app.get('/submit-order-templates', requireAdminAuth, async (req, res) => {
  const url     = `https://graph.facebook.com/v19.0/${WABA_ID}/message_templates`;
  const headers = { 'Authorization': `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };

  const templates = [
    { name:'order_confirmation', body:'مرحباً {{1}}! 👋\n\nشكراً لطلبك من myMayz 🎉\n\n📦 رقم الطلب: #{{2}}\n{{3}} — {{4}} EGP\n🛍️ {{5}}\n\nيرجى تأكيد طلبك الآن:\n✅ اكتب *1* للتأكيد\n❌ اكتب *2* للإلغاء\n\n— فريق myMayz 🌿', example:[['أحمد','53760','الدفع عند الاستلام','299','Alkaline Clay Water Bottle ×1']] },
    { name:'order_received_paid', body:'مرحباً {{1}}! 👋\n\nوصلنا طلبك رقم #{{2}} بنجاح ✅\nسيتم تجهيزه وإرساله في أقرب وقت 📦\n\nشكراً لثقتك في myMayz 🙏\n\n— فريق myMayz 🌿', example:[['أحمد','53760']] },
    { name:'order_reminder',     body:'مرحباً {{1}}! ⏰\n\nلاحظنا أنك لم تؤكد طلبك #{{2}} بعد\n\n✅ رد *1* للتأكيد\n❌ رد *2* للإلغاء\n\nإذا لم نتلقَ ردًا، سيتم تأكيد الطلب تلقائياً خلال 3 ساعات.\n\n— فريق myMayz 🌿', example:[['أحمد','53760']] },
    { name:'order_autoconfirmed',body:'مرحباً {{1}}! ✅\n\nتم تأكيد طلبك #{{2}} تلقائياً\n\nسيتم التجهيز والشحن قريباً 🚚\n\nشكراً لثقتك في myMayz 🙏\n\n— فريق myMayz 🌿', example:[['أحمد','53760']] },
    { name:'order_confirmed',    body:'مرحباً {{1}}! 🎉\n\nتم تأكيد طلبك #{{2}} بنجاح ✅\n\nسيتم التجهيز والشحن قريباً\n\nشكراً لثقتك في myMayz 🙏\n\n— فريق myMayz 🌿', example:[['أحمد','53760']] },
    { name:'order_cancelled_cod',body:'مرحباً {{1}}!\n\nتم استلام طلب الإلغاء لطلبك #{{2}} ✅\n\nلا توجد مبالغ محصلة (الدفع عند الاستلام).\nسيتم إلغاء الطلب خلال 24 ساعة 🙏\n\nيمكنك الطلب مرة أخرى في أي وقت ❤️\n\n— فريق myMayz 🌿', example:[['أحمد','53760']] },
    { name:'order_cancelled_card',body:'مرحباً {{1}}!\n\nتم إلغاء طلبك #{{2}} ✅\n\n{{3}}\n\n— فريق myMayz 🌿', example:[['أحمد','53760','سيتم استرداد 299 EGP تلقائياً خلال 3-7 أيام عمل حسب بنكك 🙏']] }
  ];

  const results = [];
  for (const tpl of templates) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({ name: tpl.name, language: 'ar', category: 'UTILITY',
          components: [{ type: 'BODY', text: tpl.body, example: { body_text: tpl.example } }] })
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
// META WEBHOOK — verify (GET)
// ================================================================
app.get('/webhook/meta', (req, res) => {
  const mode = req.query['hub.mode'], token = req.query['hub.verify_token'], challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) { console.log('✅ Meta webhook verified'); return res.status(200).send(challenge); }
  res.status(403).send('Forbidden');
});

// ================================================================
// META WEBHOOK — inbound messages + delivery status (POST)
// All inbound customer messages are saved to mm_wa_inbox in Supabase
// ================================================================
app.post('/webhook/meta', async (req, res) => {
  res.status(200).send('ok');
  const body = req.body;
  try {
    const changes  = body?.entry?.[0]?.changes?.[0]?.value;
    const statuses = changes?.statuses;
    if (statuses) {
      for (const s of statuses) {
        console.log(`📬 Meta delivery: id=${s.id} status=${s.status} to=${s.recipient_id}${s.errors ? ' errors='+JSON.stringify(s.errors) : ''}`);
        if (!s.id) continue;
        // Capture EVERY receipt so the daily report reflects what actually reached customers
        // (orders + returns alike). Insert if this wamid isn't tracked yet; else no-downgrade update
        // (never let a late 'delivered' overwrite 'read', etc.). Best-effort.
        try {
          const { data: existing } = await supabase
            .from('mm_wa_delivery').select('status').eq('wamid', s.id).maybeSingle();
          if (!existing) {
            await supabase.from('mm_wa_delivery').insert({
              wamid: s.id, phone: s.recipient_id || null, trigger: 'outbound',
              status: s.status, error: s.errors || null
            });
          } else {
            const prevAllowed = {
              delivered: ['sent'],
              read:      ['sent', 'delivered'],
              failed:    ['sent', 'delivered']
            }[s.status];
            if (prevAllowed && prevAllowed.includes(existing.status)) {
              await supabase.from('mm_wa_delivery')
                .update({ status: s.status, error: s.errors || null, updated_at: new Date().toISOString() })
                .eq('wamid', s.id);
            }
          }
        } catch (e) {
          console.warn('mm_wa_delivery upsert non-fatal:', e.message);
        }
        // Instant alert on a SYSTEMIC failure (account lock / auth / throughput) — throttled 1/hour.
        if (s.status === 'failed') {
          const code = s.errors?.[0]?.code;
          if ([131031, 190, 131056, 133010, 133004, 131045].includes(code)) {
            maybeAlertOwner(`⚠️ مشكلة في إرسال واتساب (خطأ ${code}: ${s.errors?.[0]?.title || ''}). العملاء قد لا يستلمون الرسائل — راجع حساب واتساب.`);
          }
        }
      }
    }
    const messages = changes?.messages;
    if (messages) {
      for (const m of messages) {
        const fromRaw     = m.from;
        const fromNorm    = normalisePhone(fromRaw);
        const text        = m.text?.body || '';
        const msgType     = m.type || 'text';
        const waTsRaw     = m.timestamp ? parseInt(m.timestamp) : null;
        const contact     = changes.contacts?.find(c => c.wa_id === fromRaw);
        const contactName = contact?.profile?.name || null;

        console.log(`📨 Meta inbound: from=${fromNorm} type=${msgType} text=${text}`);

        // ── Save to Supabase mm_wa_inbox ──────────────────────
        try {
          const { error: dbErr } = await supabase
            .from('mm_wa_inbox')
            .insert({
              from_phone:   fromNorm,
              message_id:   m.id || null,
              message_type: msgType,
              message_text: text,
              wa_timestamp: waTsRaw,
              contact_name: contactName,
              read: false
            });
          if (dbErr) console.error('❌ mm_wa_inbox insert error:', dbErr.message);
          else       console.log(`💾 Saved inbound msg from ${fromNorm} to mm_wa_inbox`);
        } catch(dbEx) {
          console.error('❌ mm_wa_inbox insert exception:', dbEx.message);
        }

        // ── Order confirmation reply (1 = confirm, 2 = cancel) ──
        const reply = (text || '').trim();
        if (reply === '1' || reply === '2') {
          const order = pendingOrders[fromNorm];
          if (order && !order.confirmed && !order.cancelled) {
            console.log(`🔔 Order reply "${reply}" from ${fromNorm} — order #${order.orderNo}`);
            if (reply === '1') {
              await sendWATemplate(fromNorm, ORDER_TEMPLATES.confirmed, 'ar', [order.name, String(order.orderNo)]);
              const shopifyTag = order.isCOD ? 'COD-Confirmed' : 'Card-Confirmed';
              await tagShopifyOrder(order.shopifyId, shopifyTag);
              await deletePendingOrder(fromNorm);
              console.log(`✅ Tagged order #${order.orderNo} as ${shopifyTag}`);
            } else {
              if (order.isCOD) {
                await sendWATemplate(fromNorm, ORDER_TEMPLATES.cancelled_cod, 'ar', [order.name, String(order.orderNo)]);
                await tagShopifyOrder(order.shopifyId, 'COD-Cancelled');
              } else {
                const refund = await shopifyRefund(order.shopifyId);
                const refundInfo = refund.success
                  ? `سيتم استرداد ${refund.amount} EGP تلقائياً خلال 3-7 أيام عمل حسب بنكك 🙏`
                  : 'سيتم معالجة الاسترداد يدوياً خلال 24 ساعة 🙏';
                await sendWATemplate(fromNorm, ORDER_TEMPLATES.cancelled_card, 'ar', [order.name, String(order.orderNo), refundInfo]);
                await tagShopifyOrder(order.shopifyId, 'COD-Cancelled');
              }
              await deletePendingOrder(fromNorm);
              console.log(`❌ Tagged order #${order.orderNo} as COD-Cancelled`);
            }
          }
        }
      }
    }
  } catch(e) {
    console.error('Meta webhook parse error:', e.message);
  }
});

// ================================================================
// ADMIN — GET WhatsApp inbox (all conversations)
// GET /wa/inbox?secret=...&limit=200
// ================================================================
app.get('/wa/inbox', requireAdminAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const { data, error } = await supabase
      .from('mm_wa_inbox')
      .select('*')
      .order('wa_timestamp', { ascending: false, nullsFirst: false })
      .limit(limit);

    if (error) { console.error('wa/inbox fetch error:', error.message); return res.status(500).json({ error: error.message }); }
    res.json(data || []);
  } catch(e) {
    console.error('wa/inbox exception:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// ADMIN — REPLY to a WhatsApp message (free-form text)
// POST /wa/reply   Body: { phone, message }   Header: x-admin-secret
// Only works within Meta's 24-hour customer service window
// ================================================================
app.post('/wa/reply', requireAdminAuth, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message are required' });

  try {
    await sendWAText(phone, message);

    // Save outbound reply as a record in inbox for thread display
    try {
      await supabase.from('mm_wa_inbox').insert({
        from_phone:   phone,
        message_id:   null,
        message_type: 'outbound',
        message_text: message,
        wa_timestamp: Math.floor(Date.now() / 1000),
        contact_name: 'myMayz Team',
        read: true
      });
    } catch(dbEx) {
      console.warn('wa/reply save-outbound non-fatal:', dbEx.message);
    }

    // Mark all unread inbound messages from this phone as read
    await supabase
      .from('mm_wa_inbox')
      .update({ read: true })
      .eq('from_phone', phone)
      .eq('read', false)
      .neq('message_type', 'outbound');

    console.log(`✅ WA reply sent to ${phone}`);
    res.json({ success: true, to: phone });
  } catch(e) {
    console.error('wa/reply error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// ================================================================
// ADMIN — MARK conversation as read
// POST /wa/mark-read   Body: { phone }
// ================================================================
app.post('/wa/mark-read', requireAdminAuth, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    await supabase.from('mm_wa_inbox').update({ read: true }).eq('from_phone', phone).eq('read', false);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// ADMIN — CHECK ALL TEMPLATES
// ================================================================
app.get('/admin/all-templates', requireAdminAuth, async (req, res) => {
  try {
    const r = await fetch(
      `https://graph.facebook.com/v19.0/${WABA_ID}/message_templates?fields=name,status,category,language&limit=50`,
      { headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}` } }
    );
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// SUBMIT CART REMINDER TEMPLATE
// ================================================================
app.get('/submit-abandoned-template', requireAdminAuth, async (req, res) => {
  const headers = { 'Authorization': `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
  const templateName = 'cart_reminder';
  const body = 'مرحباً {{1}}! 🛒\n\nلاحظنا أنك تركت بعض المنتجات في سلة التسوق:\n🛍️ {{2}}\n💰 {{3}} EGP\n\nأكمل طلبك الآن قبل نفاد المخزون 👇\n{{4}}\n\n— فريق myMayz 🌿';
  try {
    const submitR = await fetch(`https://graph.facebook.com/v19.0/${WABA_ID}/message_templates`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: templateName, language: 'ar', category: 'UTILITY',
        components: [{ type: 'BODY', text: body, example: { body_text: [['أحمد','Alkaline Clay Water Bottle ×1','784','https://mymayz.com']] } }] })
    });
    const submitData = await submitR.json();
    console.log(`📋 Submit "${templateName}" as UTILITY: ${submitR.ok ? '✅' : '❌'} — ${JSON.stringify(submitData)}`);
    res.json({ submitResult: submitData, ok: submitR.ok });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// SUBMIT CART REMINDER + DISCOUNT TEMPLATE  (GET /submit-abandoned-discount-template?secret=)
// ================================================================
app.get('/submit-abandoned-discount-template', requireAdminAuth, async (req, res) => {
  const headers = { 'Authorization': `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
  const templateName = 'cart_reminder_discount';
  const body = 'مرحباً {{1}}! 🛒\n\nلاحظنا أنك تركت بعض المنتجات في سلة التسوق:\n🛍️ {{2}}\n💰 {{3}} EGP\n\n🎁 هدية منا: خصم 10% على طلبك بالكود {{4}}\n\nأكمل طلبك الآن والخصم هيتطبق تلقائياً 👇\n{{5}}\n\n— فريق myMayz 🌿';
  try {
    const submitR = await fetch(`https://graph.facebook.com/v19.0/${WABA_ID}/message_templates`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: templateName, language: 'ar', category: 'MARKETING',
        components: [{ type: 'BODY', text: body, example: { body_text: [['أحمد','Alkaline Clay Water Bottle ×1','784','SBYGWOL10','https://mymayz.com']] } }] })
    });
    const submitData = await submitR.json();
    console.log(`📋 Submit "${templateName}" as MARKETING: ${submitR.ok ? '✅' : '❌'} — ${JSON.stringify(submitData)}`);
    res.json({ submitResult: submitData, ok: submitR.ok });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ================================================================
// START
// ================================================================
app.use('/returns', returnsRouter);

// On-demand WhatsApp delivery report (also lets us test the daily report immediately).
// GET /wa/health-report?secret=...   → sends the report to the owner + returns it as JSON
app.get('/wa/health-report', requireAdminAuth, async (req, res) => {
  try {
    const rep = await sendDailyReport('manual');
    res.json({ ok: true, problem: rep.problem, total: rep.total, counts: rep.counts, sentTo: OWNER_PHONE, text: rep.text });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  restoreOrderTimers();
  startWAReportScheduler();
  startAbandonedScheduler();
});

