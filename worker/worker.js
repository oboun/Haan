// Haan OCR Proxy — Hardened Cloudflare Worker for Gemini 2.5 Flash-Lite / Flash
// - Strict server-side Origin enforcement (403 on unauthorized origins)
// - Per-IP sliding-window rate limit + Content-Length & MIME allowlist
// - API key sent via x-goog-api-key header (never in URL)
// - Tries gemini-2.5-flash-lite first (~฿0.01/receipt), auto-escalates to gemini-2.5-flash if totals mismatch

const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif'
]);

const MAX_BODY_BYTES = 9_000_000;
const MAX_BASE64_CHARS = 8_000_000;
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const ipHits = new Map();

const RECEIPT_OCR_PROMPT = `You are an expert receipt OCR parser specializing in Thai and English restaurant receipts.
Read EVERY SINGLE LINE of this receipt image carefully from top to bottom. Do not skip any item.

Rules:
0. First evaluate the image quality:
   - Set imageStatus to:
     - "ok" if it is a readable receipt.
     - "not_a_receipt" if the photo is not a receipt/bill/slip.
     - "blurry" if text/prices are too blurry or out of focus to read reliably.
     - "cutoff" if part of the items list or the bottom totals are cut off/missing from the frame.
     - "dark_or_glare" if heavy shadow, darkness, or glare makes prices unreadable.
   - If imageStatus is not "ok", set imageIssue to a short, helpful 1-sentence reason.
1. Merge modifier/variant sub-lines with their parent item:
   - If a parent line has price 0.00 and the next line specifies size/variant with the actual price (e.g. "1 Tap 9 : Limburgse Witte 0.00" followed by "Tap 9 : Pint 280.00", or "1 ปีกไก่ทอดบริววิงส์ 0.00" followed by "Size L (2kg.) 444.00"), combine them into ONE item with the parent's quantity and the priced sub-line's total.
   - If a sub-line is a 0.00 free accompaniment (e.g. "1x โซดา (Soda) 0.00"), append it to the parent item name in parentheses rather than making a separate 0.00 item.
2. Preserve original Thai and English item names accurately with NO extra spaces inside Thai words.
3. For each item, provide qty (integer >= 1) and lineTotal (total price printed for that line, NOT unit price).
4. SELF-CHECK before outputting: Sum all your extracted items' lineTotal values and verify they equal the printed Subtotal on the receipt. If they do not match, re-read the receipt image carefully to find the missing or misread line!
5. Detect whether Service Charge and VAT are present on the receipt:
   - Set serviceCharge.enabled = true if a Service Charge line exists with amount > 0, else false. Extract its rate (e.g. 10) and amount.
   - Set vat.enabled = true if a VAT/Tax line exists with amount > 0, else false. Extract its rate (e.g. 7) and amount.
   - Set vat.appliesToServiceCharge = true if VAT is calculated on (Subtotal + Service Charge), e.g., when "Before VAT" equals Subtotal + Service Charge.
6. Extract reportedTotals: the exact Subtotal and final Total printed at the bottom of the receipt (null if not printed).

Return ONLY valid JSON matching this exact structure:
{
  "imageStatus": "ok | not_a_receipt | blurry | cutoff | dark_or_glare",
  "imageIssue": "string or null",
  "meta": {
    "receiptNo": "string or null",
    "table": "string or null",
    "guests": number or null,
    "date": "string or null",
    "time": "string or null",
    "currency": "฿"
  },
  "serviceCharge": {
    "enabled": boolean,
    "rate": number,
    "amount": number
  },
  "vat": {
    "enabled": boolean,
    "rate": number,
    "amount": number,
    "appliesToServiceCharge": boolean
  },
  "reportedTotals": {
    "subtotal": number or null,
    "total": number or null
  },
  "items": [
    { "name": "string", "qty": number, "lineTotal": number }
  ]
}`;

function isOriginAllowed(origin, allowedRaw) {
  if (!allowedRaw || allowedRaw.trim() === '*') return true;
  if (!origin) return false;
  const list = allowedRaw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin);
}

function corsHeaders(origin, allowedRaw) {
  const allow = !allowedRaw || allowedRaw.trim() === '*' ? (origin || '*') : origin;
  return {
    'Access-Control-Allow-Origin': allow || '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

function checkRateLimit(ip) {
  const now = Date.now();
  const timestamps = (ipHits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    ipHits.set(ip, timestamps);
    return false;
  }
  timestamps.push(now);
  ipHits.set(ip, timestamps);
  // Keep map bounded
  if (ipHits.size > 2000) {
    const oldestKey = ipHits.keys().next().value;
    ipHits.delete(oldestKey);
  }
  return true;
}

function totalsMatch(parsed) {
  if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) return false;
  const sub = parsed.items.reduce((s, i) => s + (Number(i?.lineTotal) || 0), 0);
  const repSub = parsed.reportedTotals?.subtotal;
  const repTot = parsed.reportedTotals?.total;
  if (repSub != null && Number.isFinite(Number(repSub)) && Math.abs(sub - Number(repSub)) > 0.05) {
    return false;
  }

  if (repTot != null && Number.isFinite(Number(repTot))) {
    const scRate = parsed.serviceCharge?.enabled ? (Number(parsed.serviceCharge?.rate) || 0) : 0;
    const vatRate = parsed.vat?.enabled ? (Number(parsed.vat?.rate) || 0) : 0;
    const vatOnSc = parsed.vat?.appliesToServiceCharge !== false;
    const sc = sub * (scRate / 100);
    const vat = (vatOnSc ? sub + sc : sub) * (vatRate / 100);
    if (Math.abs(sub + sc + vat - Number(repTot)) > 0.05) return false;
  }
  return true;
}

async function callGemini(apiKey, model, imageBase64, mimeType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: RECEIPT_OCR_PROMPT },
            { inline_data: { mime_type: mimeType, data: imageBase64 } }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    console.error(`Gemini error ${resp.status} (${model}):`, errText.slice(0, 500));
    throw new Error(`UPSTREAM_${resp.status}`);
  }

  const data = await resp.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error('EMPTY_RESPONSE');

  const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedRaw = env.ALLOWED_ORIGINS || '';

    if (!isOriginAllowed(origin, allowedRaw)) {
      return jsonResponse({ error: 'Forbidden origin' }, 403, { Vary: 'Origin' });
    }

    const headers = corsHeaders(origin, allowedRaw);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, headers);
    }

    if (!env.GEMINI_API_KEY) {
      console.error('Missing GEMINI_API_KEY secret');
      return jsonResponse({ error: 'OCR service is not configured.' }, 503, headers);
    }

    // Per-IP rate limit
    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRateLimit(clientIp)) {
      return jsonResponse({ error: 'Too many scans. Please wait a few minutes and try again.' }, 429, headers);
    }

    // Check Content-Length before reading body into memory
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return jsonResponse({ error: 'Image too large (max ~6MB).' }, 413, headers);
    }

    let rawBody;
    try {
      rawBody = await request.text();
    } catch {
      return jsonResponse({ error: 'Could not read request body.' }, 400, headers);
    }

    if (rawBody.length > MAX_BODY_BYTES) {
      return jsonResponse({ error: 'Image too large (max ~6MB).' }, 413, headers);
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: 'Invalid JSON body.' }, 400, headers);
    }

    const { imageBase64, mimeType = 'image/jpeg' } = payload || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return jsonResponse({ error: 'Missing image data.' }, 400, headers);
    }
    if (typeof mimeType !== 'string' || !ALLOWED_MIMES.has(mimeType.toLowerCase())) {
      return jsonResponse({ error: 'Unsupported image format.' }, 400, headers);
    }
    if (imageBase64.length > MAX_BASE64_CHARS) {
      return jsonResponse({ error: 'Image too large (max ~6MB).' }, 413, headers);
    }

    const primaryModel = env.PRIMARY_MODEL || 'gemini-2.5-flash-lite';
    const fallbackModel = env.FALLBACK_MODEL || 'gemini-2.5-flash';

    try {
      let usedModel = primaryModel;
      let parsed = await callGemini(env.GEMINI_API_KEY, primaryModel, imageBase64, mimeType.toLowerCase());

      if (
        (!parsed.imageStatus || parsed.imageStatus === 'ok') &&
        !totalsMatch(parsed) &&
        fallbackModel &&
        fallbackModel !== primaryModel
      ) {
        try {
          const retryParsed = await callGemini(env.GEMINI_API_KEY, fallbackModel, imageBase64, mimeType.toLowerCase());
          parsed = retryParsed;
          usedModel = fallbackModel;
        } catch (err) {
          console.error('Fallback model failed:', err?.message);
        }
      }

      return jsonResponse({ ...parsed, usedModel }, 200, headers);
    } catch (err) {
      const code = String(err?.message || '');
      const status = code === 'UPSTREAM_429' ? 429 : 502;
      const clientMsg = status === 429
        ? 'AI scanner is busy right now. Please retry in a moment.'
        : 'OCR service temporarily unavailable. Please try again.';
      return jsonResponse({ error: clientMsg }, status, headers);
    }
  }
};
