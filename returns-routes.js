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
// ── CORS — allow requests from the returns portal ─────────────────────
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

// ── POST /returns/submit-templates (one-time admin) ───────────────────
const WABA_ID = '900960922811775';
router.post('/submit-templates', async (req, res) => {
  if (req.headers['x-returns-secret'] !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const TOKEN = process.env.META_ACCESS_TOKEN;
  const defs = [
    {
      name: 'return_request_received',
      text: 'مرحباً {{1}} 👋\n\nتم استلام طلب الإرجاع/الاستبدال الخاص بك بنجاح ✅\n\n📦 رقم الطلب: {{2}}\n🔖 رقم المرجع: {{3}}\n\nسنراجع طلبك ونتواصل معك قريباً في حال احتجنا أي معلومات إضافية.\n\n— فريق myMayz 🌿',
      example: [['سارة', '#53760', 'REQ-ABC123']]
    },
    {
      name: 'return_warehouse_received',
      text: 'مرحباً {{1}} 👋\n\nوصل منتجك إلى مخزن myMayz بنجاح 📦✅\n\n📦 رقم الطلب: {{2}}\n\nجاري مراجعة حالة المنتج. سيتم معالجة طلبك خلال 1-2 يوم عمل.\n\n— فريق myMayz 🌿',
      example: [['سارة', '#53760']]
    },
    {
      name: 'return_awb_created',
      text: 'مرحباً {{1}} 👋\n\nتم إنشاء بوليصة الشحن لاستلام منتجك 🚚\n\n📦 رقم الطلب: {{2}}\n📋 رقم البوليصة: {{3}}\n\nالمندوب سيتواصل معك قريباً لتحديد موعد الاستلام. يرجى تجهيز المنتج للتسليم.\n\n— فريق myMayz 🌿',
      example: [['سارة', '#53760', '7891234']]
    },
    {
      name: 'return_refund_processed',
      text: 'مرحباً {{1}} 👋\n\nتمت معالجة استرداد مبلغك بنجاح 💰✅\n\n📦 رقم الطلب: {{2}}\n💵 المبلغ: {{3}}\n\nيرجى التحقق من حسابك. في حال عدم الاستلام خلال 24 ساعة تواصل معنا.\n\n— فريق myMayz 🌿',
      example: [['سارة', '#53760', '1200 EGP']]
    }
  ];
  const results = [];
  for (const t of defs) {
    try {
      const r = await fetch('https://graph.facebook.com/v19.0/' + WABA_ID + '/message_templates', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: t.name,
          language: 'ar',
          category: 'UTILITY',
          components: [{ type: 'BODY', text: t.text, example: { body_text: t.example } }]
        })
      });
      const d = await r.json();
      results.push({ name: t.name, ok: r.ok, data: d });
    } catch (e) {
      results.push({ name: t.name, ok: false, error: e.message });
    }
  }
  return res.json({ submitted: results.length, results });
});

// ── GET /returns/template-status ─────────────────────────────────────
router.get('/template-status', async (req, res) => {
  if (req.headers['x-returns-secret'] !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const r = await fetch(
      'https://graph.facebook.com/v19.0/' + WABA_ID + '/message_templates?fields=name,status,language,category&limit=20',
      { headers: { 'Authorization': 'Bearer ' + process.env.META_ACCESS_TOKEN } }
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
