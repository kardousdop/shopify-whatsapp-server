/**
 * myMayz Returns Portal — WhatsApp Notifications
 * Add to your Railway server (shopify-whatsapp-server)
 *
 * SETUP:
 *  1. Copy this file into your repo root as returns-routes.js
 *  2. In your server.js add:
 *       const returnsRouter = require('./returns-routes');
 *       app.use('/returns', returnsRouter);
 *  3. Add env variable in Railway:
 *       RETURNS_SECRET=mymayz-returns-2024
 *  4. Submit the 4 WhatsApp templates in Meta Business Manager
 *     (template content is at the bottom of this file)
 *  5. Once templates are APPROVED, fill in their names below
 */

const express = require('express');
const router  = express.Router();

// ── Config ────────────────────────────────────────────────────────────
const PHONE_ID = process.env.META_PHONE_NUMBER_ID || '1091672370692388';
const SECRET   = process.env.RETURNS_SECRET       || 'mymayz-returns-2024';

// Template names — must match exactly what you submit to Meta
const TEMPLATES = {
  request_received:   'return_request_received',   // params: name, ordName, reqId
  warehouse_received: 'return_warehouse_received',  // params: name, ordName
  awb_created:        'return_awb_created',          // params: name, ordName, awbNum
  refund_processed:   'return_refund_processed',     // params: name, ordName, amount
};

// ── Phone normalizer (Egyptian numbers) ──────────────────────────────
function normalizePhone(p) {
  p = (p || '').replace(/\D/g, '');
  if (p.startsWith('0'))              p = '20' + p.slice(1);
  if (!p.startsWith('20') && p.length >= 10) p = '20' + p;
  return p;
}

// ── Core send function ────────────────────────────────────────────────
async function sendTemplate(phone, templateName, params) {
  const p = normalizePhone(phone);
  if (!p || p.length < 11) {
    console.warn('[Returns WA] Bad phone:', phone, '->', p);
    return { ok: false, reason: 'bad_phone' };
  }

  const body = {
    messaging_product: 'whatsapp',
    to: p,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'ar' },
      components: [{
        type: 'body',
        parameters: params.map(v => ({ type: 'text', text: String(v || '-') }))
      }]
    }
  };

  try {
    const r = await fetch(
      'https://graph.facebook.com/v19.0/' + PHONE_ID + '/messages',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + process.env.META_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );
    const data = await r.json();
    if (!r.ok) {
      console.error('[Returns WA] Error sending', templateName, 'to', p, JSON.stringify(data));
    } else {
      console.log('[Returns WA] Sent', templateName, 'to', p);
    }
    return { ok: r.ok, data };
  } catch (e) {
    console.error('[Returns WA] Fetch error:', e.message);
    return { ok: false, reason: e.message };
  }
}

// ── POST /returns/notify ──────────────────────────────────────────────
// Body:
//   trigger: 'request_received' | 'warehouse_received' | 'awb_created' | 'refund_processed'
//   phone:   customer phone (any format — will be normalised)
//   name:    customer name (for greeting)
//   ordName: Shopify order name e.g. "#53760"
//   reqId:   request ID (trigger: request_received only)
//   awb:     airway bill number (trigger: awb_created only)
//   amount:  refund/credit amount e.g. "1200 EGP" (trigger: refund_processed only)
router.post('/notify', async (req, res) => {
  const secret = req.headers['x-returns-secret'];
  if (secret !== SECRET) {
    console.warn('[Returns WA] Unauthorized request from', req.ip);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { trigger, phone, name, ordName, reqId, awb, amount } = req.body || {};

  if (!trigger) return res.status(400).json({ error: 'Missing trigger' });
  if (!phone)   return res.status(400).json({ error: 'Missing phone' });

  const safeName    = name    || 'عزيزي العميل';
  const safeOrdName = ordName || '-';

  let result;
  try {
    switch (trigger) {

      case 'request_received':
        result = await sendTemplate(phone, TEMPLATES.request_received, [
          safeName, safeOrdName, reqId || '-'
        ]);
        break;

      case 'warehouse_received':
        result = await sendTemplate(phone, TEMPLATES.warehouse_received, [
          safeName, safeOrdName
        ]);
        break;

      case 'awb_created':
        result = await sendTemplate(phone, TEMPLATES.awb_created, [
          safeName, safeOrdName, awb || '-'
        ]);
        break;

      case 'refund_processed': {
        const amtStr = amount
          ? (typeof amount === 'number'
              ? amount.toLocaleString('en-EG', { maximumFractionDigits: 0 }) + ' EGP'
              : String(amount))
          : '-';
        result = await sendTemplate(phone, TEMPLATES.refund_processed, [
          safeName, safeOrdName, amtStr
        ]);
        break;
      }

      default:
        return res.status(400).json({ error: 'Unknown trigger: ' + trigger });
    }

    return res.json(result);
  } catch (e) {
    console.error('[Returns WA] Unhandled error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// ── GET /returns/health ───────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    templates: TEMPLATES,
    phoneId: PHONE_ID,
    hasToken: !!process.env.META_ACCESS_TOKEN
  });
});

module.exports = router;

// ════════════════════════════════════════════════════════════════════
//  META TEMPLATE SUBMISSIONS
//  Go to: Meta Business Manager -> WhatsApp -> Message Templates -> Create
//  Category: UTILITY  |  Language: Arabic (ar)
//  Account: WABA 900960922811775
// ════════════════════════════════════════════════════════════════════

/*
--------------------------------------------------
TEMPLATE 1: return_request_received
--------------------------------------------------
Name:     return_request_received
Category: UTILITY
Language: ar

Body (Arabic):
مرحباً {{1}} 👋

تم استلام طلب الإرجاع/الاستبدال الخاص بك بنجاح ✅

📦 رقم الطلب: {{2}}
🔖 رقم المرجع: {{3}}

سنراجع طلبك ونتواصل معك قريباً في حال احتجنا أي معلومات إضافية.

— فريق myMayz 🌿

Example values: {{1}}=سارة، {{2}}=#53760، {{3}}=REQ-ABC123

--------------------------------------------------
TEMPLATE 2: return_warehouse_received
--------------------------------------------------
Name:     return_warehouse_received
Category: UTILITY
Language: ar

Body (Arabic):
مرحباً {{1}} 👋

وصل منتجك إلى مخزن myMayz بنجاح 📦✅

📦 رقم الطلب: {{2}}

جاري مراجعة حالة المنتج. سيتم معالجة طلبك خلال 1-2 يوم عمل.

— فريق myMayz 🌿

Example values: {{1}}=سارة، {{2}}=#53760

--------------------------------------------------
TEMPLATE 3: return_awb_created
--------------------------------------------------
Name:     return_awb_created
Category: UTILITY
Language: ar

Body (Arabic):
مرحباً {{1}} 👋

تم إنشاء بوليصة الشحن لاستلام منتجك 🚚

📦 رقم الطلب: {{2}}
📋 رقم البوليصة: {{3}}

المندوب سيتواصل معك قريباً لتحديد موعد الاستلام. يرجى تجهيز المنتج للتسليم.

— فريق myMayz 🌿

Example values: {{1}}=سارة، {{2}}=#53760، {{3}}=7891234

--------------------------------------------------
TEMPLATE 4: return_refund_processed
--------------------------------------------------
Name:     return_refund_processed
Category: UTILITY
Language: ar

Body (Arabic):
مرحباً {{1}} 👋

تمت معالجة استرداد مبلغك بنجاح 💰✅

📦 رقم الطلب: {{2}}
💵 المبلغ: {{3}}

يرجى التحقق من حسابك. في حال عدم الاستلام خلال 24 ساعة تواصل معنا.

— فريق myMayz 🌿

Example values: {{1}}=سارة، {{2}}=#53760، {{3}}=1200 EGP
--------------------------------------------------
*/
