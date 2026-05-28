/**
 * myMayz Returns Portal — WhatsApp Notifications
 * Add to your Railway server (shopify-whatsapp-server)
 *
 * SETUP:
 *  1. Copy this file into your repo root as returns-routes.js
 *  2. In your index.js add:
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

// ── CORS — allow requests from the returns portal ────────────────────
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-returns-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// ── Config ────────────────────────────────────────────────────────────
const PHONE_ID = process.env.META_PHONE_NUMBER_ID || '1091672370692388';
const SECRET   = process.env.RETURNS_SECRET       || 'mymayz-returns-2024';

// WhatsApp Business Account ID (used for template-status endpoint)
const WABA_ID = process.env.WABA_ID || '900960922811775';

// Template names — must match exactly what you submit to Meta
// Status starts as PENDING; replace names once approved if you use different ones
const TEMPLATES = {
  request_received:   'return_request_received',   // params: name, ordName, reqId
  request_approved:   'return_request_approved',    // params: name, ordName
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
    console.warn('[Returns WA] Bad phone:', phone, '→', p);
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
        parameters: params.map(v => ({ type: 'text', text: String(v || '—') }))
      }]
    }
  };

  try {
    const r = await fetch(
      `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
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
//   trigger: 'request_received' | 'request_approved' | 'warehouse_received' | 'awb_created' | 'refund_processed'
//   phone:   customer phone (any format — will be normalised)
//   name:    customer name (for greeting)
//   ordName: Shopify order name e.g. "#53760"
//   reqId:   request ID (trigger: request_received only)
//   awb:     airway bill number (trigger: awb_created only)
//   amount:  refund/credit amount e.g. "1200 EGP" (trigger: refund_processed only)
router.post('/notify', async (req, res) => {
  // Auth
  const secret = req.headers['x-returns-secret'];
  if (secret !== SECRET) {
    console.warn('[Returns WA] Unauthorized request from', req.ip);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { trigger, phone, name, ordName, reqId, awb, amount } = req.body || {};

  if (!trigger) return res.status(400).json({ error: 'Missing trigger' });
  if (!phone)   return res.status(400).json({ error: 'Missing phone' });

  const safeName    = name    || 'عزيزي العميل';
  const safeOrdName = ordName || '—';

  let result;
  try {
    switch (trigger) {

      case 'request_received':
        result = await sendTemplate(phone, TEMPLATES.request_received, [
          safeName,
          safeOrdName,
          reqId || '—'
        ]);
        break;

      case 'request_approved':
        result = await sendTemplate(phone, TEMPLATES.request_approved, [
          safeName,
          safeOrdName
        ]);
        break;

      case 'warehouse_received':
        result = await sendTemplate(phone, TEMPLATES.warehouse_received, [
          safeName,
          safeOrdName
        ]);
        break;

      case 'awb_created':
        result = await sendTemplate(phone, TEMPLATES.awb_created, [
          safeName,
          safeOrdName,
          awb || '—'
        ]);
        break;

      case 'refund_processed': {
        const amtStr = amount
          ? (typeof amount === 'number'
              ? amount.toLocaleString('en-EG', { maximumFractionDigits: 0 }) + ' EGP'
              : String(amount))
          : '—';
        result = await sendTemplate(phone, TEMPLATES.refund_processed, [
          safeName,
          safeOrdName,
          amtStr
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

// ── GET /returns/template-status ─────────────────────────────────────
router.get('/template-status', async (req, res) => {
  if (req.headers['x-returns-secret'] !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const r = await fetch(
      `https://graph.facebook.com/v19.0/${WABA_ID}/message_templates?fields=name,status,language,category&limit=20`,
      { headers: { 'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}` } }
    );
    const d = await r.json();
    const ourNames = Object.values(TEMPLATES);
    const filtered = (d.data || []).filter(t => ourNames.includes(t.name));
    return res.json({ templates: filtered, total: (d.data || []).length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;

// ════════════════════════════════════════════════════════════════════
//  📋  META TEMPLATE SUBMISSIONS
//  Go to: Meta Business Manager → WhatsApp → Message Templates → Create
//  Category: UTILITY  |  Language: Arabic (ar)
//  Account: WABA 900960922811775
// ════════════════════════════════════════════════════════════════════

/*
──────────────────────────────────────────────────
TEMPLATE 1: return_request_received
──────────────────────────────────────────────────
Name:     return_request_received
Category: UTILITY
Language: ar

Body (Arabic):
مرحباً {{1}} 👋

تم استلام طلب الإر٫bًع/ب�لاستبدب�ل الخاص بك بنجاح ✅

📦 رقم الطلب: {{2}}
🔖 رقم المر٫bً: {{3}}

سنراجه طلبك ونتواصل معك قريباً fي حال احتجنا أي ميعلومات اضافيمي.

— friq myMayz 🌿

Example values: {{1}}=سارةٌ {{2}}=#53760ٌ {{3}}=REQ-ABC123

──────────────────────────────────────────────────
TEMPLATE 2: return_request_approved
──────────────────────────────────────────────────
Name:     return_request_approved
Category: UTILITY
Language: ar

Body (Arabic):
مرحباً {{1}} 👋

تمت الموافقة عممي طلب الإر٫bً-الاستبدب�ل الخاص بك ✅

📦 رقم الطلب: {{2}}
	يرجو تتجهيس المنتb٠ للش٭bن,و سيتواصل معك فريفن ال٩تتديد مىاbً الاستلام.



— فريق myMayz 🌿

Example values: {{1}}=سارة، {{2}}=#53760

──────────────────────────────────────────────────
TEMPLATE 4: return_warehouse_received
──────────────────────────────────────────────────
Name:     return_warehouse_received
Category: UTILITY
Language: ar

Body (Arabic):
مرحباً {{1}} 👋

وصل منتثك إلى محذن myMayz بنتجاح 📓✅

📦 رقم الطلب: {{2}}
	٫اري مرا٫عني حاله المنتج. سيتم معهلٙه طلبك خلال 1–2يوم عمل.

— فريق myMayz 🌿

Example values: {{1}}=سارة، {{2}}=#53760

──────────────────────────────────────────────────
TEMPLATE 5: return_awb_created
──────────────────────────────────────────────────
Name:     return_awb_created
Category: UTILITY
Language: ar

Body (Arabic):
مرحباً {{1}} 👋

تم إنثاء بوليصة الاستلام منتجك 🚙

📦 رقم الطلب: {{2}}
📉 رقم البوليصة: {{3}}

المندوب سيتواصل مصك قريباً لتحديد موعوء الاستلام. يرجو تتحديد موظ�bً لتسليم.

— فريق myMayz 🌿

Example values: {{1}}=سارة، {{2}}=#53760، {{3}}=7891234

──────────────────────────────────────────────────
TEMPLATE 4: return_refund_processed
──────────────────────────────────────────────────
Name:     return_refund_processed
Category: UTILITY
Language: ar

Body (Arabic):
مرحباً {{1}} 👋

تمت معالجة استرداد مبلغك بنجاح 💰✅

📦 رقم الطلب: {{2}}
💵 المبلغ: {{3}}

يرتين التحقق من حساتbك. في حال عدم الاستلام خلال 24 ساعة تواصل معمن.

— friq myMayz 🌿

Example values: {{1}}=سارةٌ {{2}}=#53760ٌ {{3}}=1200 EGP
──────────────────────────────────────────────────
*/
