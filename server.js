const express = require('express');
const app = express();
app.use(express.json());

// ─── Environment Variables ───────────────────────────────────────────────────
const {
  ULTRAMSG_INSTANCE_ID,
  ULTRAMSG_TOKEN,
  SHOPIFY_STORE_URL,    // e.g. your-store.myshopify.com
  SHOPIFY_ADMIN_TOKEN,  // shpat_...
  ODOO_URL,             // e.g. https://yourstore.odoo.com
  ODOO_DB,
  ODOO_USERNAME,
  ODOO_PASSWORD,
  PORT = 3000,
} = process.env;

// ─── In-memory state: pending confirmations ──────────────────────────────────
// key: customer phone (E.164), value: { orderId, shopifyOrderId, paymentMethod, amount, currency, retried, retryTimer, noReplyTimer }
const pendingOrders = {};

// ─── Arabic message templates ────────────────────────────────────────────────
function msgConfirmation(orderName, paymentMethod, total, currency) {
  const payLabel = paymentMethod === 'cod' ? 'الدفع عند الاستلام' : 'بطاقة ائتمان';
  return (
    `مرحباً! تم استلام طلبك *${orderName}* بنجاح 🎉\n` +
    `طريقة الدفع: ${payLabel}\n` +
    `المبلغ الإجمالي: ${total} ${currency}\n\n` +
    `الرجاء تأكيد طلبك:\n` +
    `*1* - تأكيد الطلب ✅\n` +
    `*2* - إلغاء الطلب ❌`
  );
}

function msgConfirmed(orderName) {
  return `شكراً! تم تأكيد طلبك *${orderName}* وسيتم تجهيزه قريباً 🚀`;
}

function msgCancelledCOD(orderName) {
  return `تم إلغاء طلبك *${orderName}* بنجاح. نأمل خدمتك في المرة القادمة 🙏`;
}

function msgCancelledCard(orderName, amount, currency) {
  return (
    `تم إلغاء طلبك *${orderName}* وسيتم استرداد مبلغ ${amount} ${currency} خلال 5-7 أيام عمل إلى بطاقتك 💳\n` +
    `شكراً لتعاملك معنا 🙏`
  );
}

function msgRetry(orderName) {
  return (
    `تذكير: طلبك *${orderName}* لا يزال ينتظر تأكيدك.\n\n` +
    `*1* - تأكيد الطلب ✅\n` +
    `*2* - إلغاء الطلب ❌\n\n` +
    `إذا لم نتلقَّ ردك سيُوقف الطلب تلقائياً.`
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Send a WhatsApp message via UltraMsg */
async function sendWhatsApp(phone, message) {
  const url = `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat`;
  const body = new URLSearchParams({
    token: ULTRAMSG_TOKEN,
    to: phone,
    body: message,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json();
  console.log('[WA] Sent to', phone, '->', data);
  return data;
}

/** Authenticate with Odoo JSON-RPC and return uid */
async function odooAuth() {
  const res = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: 1,
      params: {
        model: 'res.users',
        method: 'authenticate',
        args: [ODOO_DB, ODOO_USERNAME, ODOO_PASSWORD, {}],
        kwargs: {},
      },
    }),
  });
  const data = await res.json();
  return data.result; // uid
}

/** Generic Odoo JSON-RPC call */
async function odooCall(uid, model, method, args, kwargs = {}) {
  const res = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `session_id=odoo_session`, // session handled below
    },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: 1,
      params: { model, method, args, kwargs },
    }),
  });
  const data = await res.json();
  return data.result;
}

/** Get Odoo session cookie by logging in */
let odooSession = null;
async function getOdooSession() {
  if (odooSession) return odooSession;
  const res = await fetch(`${ODOO_URL}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: 1,
      params: { db: ODOO_DB, login: ODOO_USERNAME, password: ODOO_PASSWORD },
    }),
  });
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/session_id=([^;]+)/);
  if (match) odooSession = match[1];
  const data = await res.json();
  console.log('[Odoo] Authenticated, uid:', data.result?.uid);
  return odooSession;
}

/** Generic Odoo call with session */
async function odoo(model, method, args, kwargs = {}) {
  const session = await getOdooSession();
  const res = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `session_id=${session}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: Date.now(),
      params: { model, method, args, kwargs },
    }),
  });
  const data = await res.json();
  if (data.error) {
    console.error('[Odoo] Error:', JSON.stringify(data.error));
    throw new Error(data.error.message);
  }
  return data.result;
}

/** Find Odoo sale.order by Shopify order name (e.g. #1001) */
async function findOdooOrder(shopifyOrderName) {
  const results = await odoo('sale.order', 'search_read',
    [[['client_order_ref', '=', shopifyOrderName]]],
    { fields: ['id', 'name', 'state', 'tag_ids'], limit: 1 }
  );
  return results && results[0];
}

/** Get or create a tag ID in Odoo */
async function getTagId(tagName) {
  let results = await odoo('crm.tag', 'search_read',
    [[['name', '=', tagName]]],
    { fields: ['id'], limit: 1 }
  );
  if (results && results[0]) return results[0].id;
  const id = await odoo('crm.tag', 'create', [{ name: tagName }]);
  return id;
}

/** Add a tag to an Odoo sale order */
async function addTagToOrder(odooOrderId, tagName) {
  const tagId = await getTagId(tagName);
  await odoo('sale.order', 'write',
    [[odooOrderId], { tag_ids: [[4, tagId]] }]
  );
  console.log(`[Odoo] Tagged order ${odooOrderId} with ${tagName}`);
}

/** Cancel an Odoo sale order */
async function cancelOdooOrder(odooOrderId) {
  await odoo('sale.order', 'action_cancel', [[odooOrderId]]);
  console.log(`[Odoo] Cancelled order ${odooOrderId}`);
}

/** Issue a Shopify refund for a card payment */
async function shopifyRefund(shopifyOrderId, amount, currency) {
  // First get transactions to find the payment gateway transaction
  const txRes = await fetch(
    `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${shopifyOrderId}/transactions.json`,
    { headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN } }
  );
  const txData = await txRes.json();
  const saleTx = (txData.transactions || []).find(t => t.kind === 'sale' || t.kind === 'capture');

  const refundPayload = {
    refund: {
      currency,
      notify: true,
      transactions: saleTx ? [{
        parent_id: saleTx.id,
        amount,
        kind: 'refund',
        gateway: saleTx.gateway,
      }] : [],
    },
  };

  const res = await fetch(
    `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${shopifyOrderId}/refunds.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify(refundPayload),
    }
  );
  const data = await res.json();
  console.log('[Shopify] Refund response:', JSON.stringify(data));
  return data;
}

/** Cancel a Shopify order (for COD) */
async function shopifyCancel(shopifyOrderId) {
  const res = await fetch(
    `https://${SHOPIFY_STORE_URL}/admin/api/2024-01/orders/${shopifyOrderId}/cancel.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({ reason: 'customer', email: false }),
    }
  );
  const data = await res.json();
  console.log('[Shopify] Cancel response:', JSON.stringify(data));
  return data;
}

/** Normalise a phone number to E.164 (add country code if missing) */
function normalisePhone(raw) {
  if (!raw) return null;
  let phone = raw.replace(/\D/g, '');
  if (phone.startsWith('0')) phone = '20' + phone.slice(1); // Egypt default
  if (!phone.startsWith('+')) phone = '+' + phone;
  return phone;
}

// ─── Shopify Webhook: Order Created ──────────────────────────────────────────
app.post('/webhook/order-created', async (req, res) => {
  res.sendStatus(200); // always ack immediately

  try {
    const order = req.body;
    const shopifyOrderId = String(order.id);
    const orderName = order.name; // e.g. #1001
    const total = order.total_price;
    const currency = order.currency;
    const phone = normalisePhone(
      order.billing_address?.phone || order.shipping_address?.phone || order.phone
    );
    const paymentGateway = (order.payment_gateway_names || [])[0] || '';
    const isCOD = paymentGateway.toLowerCase().includes('cod') ||
                  paymentGateway.toLowerCase().includes('cash') ||
                  order.payment_terms?.payment_terms_name?.toLowerCase().includes('cod');

    console.log(`[Order] ${orderName} | ${phone} | gateway: ${paymentGateway} | COD: ${isCOD}`);

    if (!phone) {
      console.warn('[Order] No phone number found, skipping WhatsApp.');
      return;
    }

    await sendWhatsApp(phone, msgConfirmation(orderName, isCOD ? 'cod' : 'card', total, currency));

    // Save pending state
    const noReplyTimer = setTimeout(async () => {
      // After 2 hours of initial message — send retry
      if (!pendingOrders[phone]) return;
      await sendWhatsApp(phone, msgRetry(orderName));
      pendingOrders[phone].retried = true;

      // After another 2 hours — tag as no-response
      pendingOrders[phone].noReplyTimer2 = setTimeout(async () => {
        if (!pendingOrders[phone]) return;
        const entry = pendingOrders[phone];
        try {
          const odooOrder = await findOdooOrder(orderName);
          if (odooOrder) await addTagToOrder(odooOrder.id, 'wa-no-response');
        } catch (e) { console.error('[NoReply] Odoo error:', e.message); }
        delete pendingOrders[phone];
        console.log(`[NoReply] Order ${orderName} tagged wa-no-response`);
      }, 2 * 60 * 60 * 1000);

    }, 2 * 60 * 60 * 1000);

    pendingOrders[phone] = {
      shopifyOrderId,
      orderName,
      isCOD,
      total,
      currency,
      retried: false,
      noReplyTimer,
    };

  } catch (err) {
    console.error('[Order Webhook] Error:', err.message);
  }
});

// ─── UltraMsg Webhook: Customer Reply ────────────────────────────────────────
app.post('/webhook/wa-reply', async (req, res) => {
  res.sendStatus(200);

  try {
    const { data } = req.body;
    if (!data || data.from_me) return; // ignore outgoing messages

    const from = '+' + String(data.from || '').replace(/\D/g, '');
    const text = (data.body || '').trim();

    console.log(`[WA Reply] from: ${from}, text: "${text}"`);

    const entry = pendingOrders[from];
    if (!entry) {
      console.log('[WA Reply] No pending order for', from);
      return;
    }

    // Clear timers
    clearTimeout(entry.noReplyTimer);
    clearTimeout(entry.noReplyTimer2);

    if (text === '1') {
      // ── CONFIRMED ──────────────────────────────────────────────────────────
      try {
        const odooOrder = await findOdooOrder(entry.orderName);
        if (odooOrder) await addTagToOrder(odooOrder.id, 'wa-confirmed');
      } catch (e) { console.error('[Confirm] Odoo error:', e.message); }
      await sendWhatsApp(from, msgConfirmed(entry.orderName));
      delete pendingOrders[from];

    } else if (text === '2') {
      // ── CANCELLED ──────────────────────────────────────────────────────────
      try {
        const odooOrder = await findOdooOrder(entry.orderName);
        if (odooOrder) {
          await cancelOdooOrder(odooOrder.id);
          await addTagToOrder(odooOrder.id, 'wa-cancelled');
        }
      } catch (e) { console.error('[Cancel] Odoo error:', e.message); }

      if (entry.isCOD) {
        // COD: cancel Shopify order (Odoo connector will sync too)
        try { await shopifyCancel(entry.shopifyOrderId); } catch (e) { console.error('[Cancel COD] Shopify error:', e.message); }
        await sendWhatsApp(from, msgCancelledCOD(entry.orderName));
      } else {
        // Card: refund via Shopify
        try { await shopifyRefund(entry.shopifyOrderId, entry.total, entry.currency); } catch (e) { console.error('[Cancel Card] Refund error:', e.message); }
        await sendWhatsApp(from, msgCancelledCard(entry.orderName, entry.total, entry.currency));
      }
      delete pendingOrders[from];

    } else {
      console.log('[WA Reply] Unrecognised reply, ignoring.');
    }

  } catch (err) {
    console.error('[WA Reply Webhook] Error:', err.message);
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'running', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
