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
const { createClient } = require('@supabase/supabase-js');

// Supabase client for delivery tracking (mm_wa_delivery). Optional — if the env
// vars or table are missing, tracking is skipped and sends still work.
const _sb = (process.env.SUPABASE_URL && process.env.SUPABASE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
  : null;

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

// ── Phone normalizer ─────────────────────────────────────────────────
// Returns { ok, phone, reason }. NEVER blind-prefixes a country code.
//
// The previous version assumed every customer was Egyptian: it stripped a
// leading 0 and stapled '20' onto the front of ANYTHING. That silently
// corrupted every non-Egyptian number — a Jordanian customer whose number is
// 0796244441 (or 00962796244441) became 20796244441 / 200962796244441, numbers
// that do not exist. Meta ACCEPTS such a send and only later returns delivery
// error 131026 "Message undeliverable", so it looked like a working send while
// the customer got nothing. 64 return-lifecycle notifications were lost this way
// in the first 8 days of Aug 2026 (order #59209 was the reported case).
//
// Rules, in order:
//   • '00' is the international access code → strip it, then re-test.
//   • Anything that looks like an Egyptian mobile (1[0125] + 8 digits, with or
//     without the 20 / leading 0) → normalise to 20XXXXXXXXXX.
//   • An explicitly international number (+cc… / 00cc…) → trust it as-is.
//   • Everything else (a foreign LOCAL number like 079…, an Egyptian landline
//     like 02…, or junk) → reject. The country cannot be inferred from the
//     digits alone, and guessing is what caused this bug. Skipping is reported
//     back so CS can fix the number, instead of burning a send nobody receives.
const EG_MOBILE = /^1[0125]\d{8}$/;   // Egyptian mobile, no leading 0

function normalizePhone(raw) {
  const s = String(raw || '').trim();
  const hadPlus = s.startsWith('+');
  let p = s.replace(/\D/g, '');
  if (!p) return { ok: false, reason: 'empty', phone: '' };

  let hadIntlPrefix = hadPlus;
  if (p.startsWith('00')) { p = p.slice(2); hadIntlPrefix = true; }

  // Egyptian, already carrying the country code
  if (p.startsWith('20') && EG_MOBILE.test(p.slice(2))) return okPhone(p);
  // Egyptian, bare local form (with or without the trunk 0)
  if (EG_MOBILE.test(p))                                 return okPhone('20' + p);
  if (p.startsWith('0') && EG_MOBILE.test(p.slice(1)))   return okPhone('20' + p.slice(1));
  // Trunk 0 typed in front of the country code: 0 20 1XXXXXXXXX
  if (p.startsWith('020') && EG_MOBILE.test(p.slice(3))) return okPhone(p.slice(1));
  // Explicitly international and not Egyptian — trust the country code it came with
  if (hadIntlPrefix)                                     return okPhone(p);

  return { ok: false, reason: 'unrecognised_number', phone: p };
}

function okPhone(p) {
  // E.164 allows 8–15 digits; outside that it cannot be a real subscriber number
  return (p.length >= 8 && p.length <= 15)
    ? { ok: true, phone: p }
    : { ok: false, reason: 'bad_length', phone: p };
}

// ── Core send function ────────────────────────────────────────────────
async function sendTemplate(phone, templateName, params) {
  const n = normalizePhone(phone);
  if (!n.ok) {
    console.warn('[Returns WA] Skipped — unusable phone:', JSON.stringify(phone), '→', n.phone, '(' + n.reason + ')');
    return { ok: false, skipped: true, reason: n.reason, phone: n.phone };
  }
  const p = n.phone;

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

    // ── Record this send for delivery tracking (best-effort) ──────────
    if (_sb) {
      const wamid = result?.data?.messages?.[0]?.id || null;
      try {
        // Record the number we ACTUALLY used; on a skip keep the raw digits so CS
        // can see what the customer typed. 'skipped' is a distinct status from
        // 'failed' — nothing was sent to Meta, the number itself is unusable.
        const _n = normalizePhone(phone);
        await _sb.from('mm_wa_delivery').insert({
          wamid,
          phone:    _n.phone || String(phone || '').replace(/\D/g, ''),
          trigger,
          template: TEMPLATES[trigger] || null,
          ord_name: ordName || null,
          req_id:   reqId ? String(reqId) : null,
          status:   result?.ok ? 'sent' : (result?.skipped ? 'skipped' : 'failed'),
          error:    result?.ok ? null : (result?.data?.error || {
                      reason:  result?.reason || 'send_failed',
                      message: result?.skipped
                        ? 'Phone number is not a usable WhatsApp number — nothing was sent. Fix the number on the order and resend.'
                        : undefined
                    })
        });
      } catch (e) {
        console.warn('[Returns WA] delivery insert non-fatal:', e.message);
      }
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

// ── GET /returns/delivery?ordName=#53760 ─────────────────────────────
// Returns the notification delivery rows for an order, newest first, so the
// returns portal can show ✓✓ Delivered / Read / ✗ Failed per notification.
router.get('/delivery', async (req, res) => {
  if (req.headers['x-returns-secret'] !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!_sb) return res.json([]);
  const { ordName, phone } = req.query;
  try {
    let q = _sb.from('mm_wa_delivery')
      .select('wamid, trigger, template, ord_name, req_id, status, error, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(50);
    if (ordName)      q = q.eq('ord_name', ordName);
    else if (phone)   q = q.eq('phone', normalizePhone(phone));
    else return res.status(400).json({ error: 'ordName or phone required' });
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data || []);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
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

// ── GET /returns/template-components ─────────────────────────────────
// Returns full template bodies + components from Meta (for debugging)
router.get('/template-components', async (req, res) => {
  if (req.headers['x-returns-secret'] !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const r = await fetch(
      `https://graph.facebook.com/v19.0/${WABA_ID}/message_templates?fields=name,status,language,category,components&limit=50`,
      { headers: { 'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}` } }
    );
    const d = await r.json();
    const ourNames = Object.values(TEMPLATES);
    const filtered = (d.data || []).filter(t => ourNames.includes(t.name));
    return res.json({ templates: filtered });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── POST /returns/submit-template ────────────────────────────────────
// Proxies a template submission to Meta. Send the full templateBody in req.body.
// Body: { templateBody: { name, language, category, components: [...] } }
router.post('/submit-template', async (req, res) => {
  if (req.headers['x-returns-secret'] !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { templateBody } = req.body || {};
  if (!templateBody) {
    return res.status(400).json({ error: 'Missing templateBody in request body' });
  }
  try {
    const r = await fetch(
      `https://graph.facebook.com/v19.0/${WABA_ID}/message_templates`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(templateBody)
      }
    );
    const d = await r.json();
    return res.json({ ok: r.ok, data: d });
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

تم استلام طلب الإرجاع/الاستبدال الخاص بك بنجاح ✅

📦 رقم الطلب: {{2}}
🔖 رقم المرجع: {{3}}

سنراجع طلبك ونتواصل معك قريباً في حال احتجنا أي معلومات إضافية.

— فريق myMayz 🌿

Example values: {{1}}=سارة، {{2}}=#53760، {{3}}=REQ-ABC123

──────────────────────────────────────────────────
TEMPLATE 2: return_request_approved
──────────────────────────────────────────────────
Name:     return_request_approved
Category: UTILITY
Language: ar

Body (Arabic):
مرحباً {{1}} 👋

تمت الموافقة على طلب الإرجاع/الاستبدال الخاص بك ✅

📦 رقم الطلب: {{2}}

يرجى تجهيز المنتج للشحن، وسيتواصل معك فريقنا قريباً لتحديد موعد الاستلام.

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

وصل منتجك إلى مخزن myMayz بنجاح 📦✅

📦 رقم الطلب: {{2}}

جاري مراجعة حالة المنتج. سيتم معالجة طلبك خلال 1–2 يوم عمل.

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

تم إنشاء بوليصة الشحن لاستلام منتجك 🚚

📦 رقم الطلب: {{2}}
📋 رقم البوليصة: {{3}}

المندوب سيتواصل معك قريباً لتحديد موعد الاستلام. يرجى تجهيز المنتج للتسليم.

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

يرجى التحقق من حسابك. في حال عدم الاستلام خلال 24 ساعة تواصل معنا.

— فريق myMayz 🌿

Example values: {{1}}}سارة، {{2}}=#53760، {{3}}=1200 EGP
──────────────────────────────────────────────────
*/
