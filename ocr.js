// Haan OCR & Receipt Parsing Module
// Supports: Gemini Vision via Cloudflare Worker Proxy with low-memory client compression

// Paste your deployed Cloudflare Worker URL here (see worker/README.md):
// e.g. 'https://haan-ocr.your-subdomain.workers.dev'
export const OCR_WORKER_URL = 'https://haan-ocr.kamonwat-t.workers.dev';

const MAX_ITEM_QTY = 100;

/**
 * Fix Thai spacing artifacts & normalize Unicode NFC.
 */
export function normalizeThaiText(text) {
  if (!text) return '';
  let s = String(text).normalize('NFC');
  s = s.replace(/\s+([\u0E31\u0E34-\u0E3A\u0E47-\u0E4E])/g, '$1');
  let prev;
  do {
    prev = s;
    s = s.replace(/([\u0E00-\u0E7F])\s+([\u0E00-\u0E7F])/g, '$1$2');
  } while (s !== prev);
  return s.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Sanitize currency symbol (prevents XSS / junk values).
 */
export function sanitizeCurrency(raw, fallback = '฿') {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(/[<>"'`&;\\\/]/g, '').trim().slice(0, 4);
  return cleaned || fallback;
}

function parseFiniteNonNegative(val, fallback = null) {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function clampRate(val, fallback) {
  const n = parseFiniteNonNegative(val, null);
  if (n === null) return fallback;
  return Math.min(100, n);
}

/**
 * Normalize structured JSON object returned by the Gemini Vision Worker.
 */
export function normalizeParsedReceiptJson(rawInput, sourceLabel = 'Gemini Vision') {
  if (!rawInput || typeof rawInput !== 'object') {
    throw new Error('Invalid receipt response.');
  }

  const parsed = rawInput;
  const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
  const cleanItems = [];

  for (const entry of rawItems) {
    if (!entry || typeof entry !== 'object') continue;
    const qtyRaw = Number(entry.qty);
    const qty = Number.isFinite(qtyRaw) ? Math.max(1, Math.min(MAX_ITEM_QTY, Math.round(qtyRaw))) : 1;
    const lineTotal = parseFiniteNonNegative(entry.lineTotal, null);
    const unitPrice = parseFiniteNonNegative(entry.unitPrice, null);
    const safeTotal = lineTotal !== null ? lineTotal : (unitPrice !== null ? unitPrice * qty : 0);
    cleanItems.push({
      name: normalizeThaiText(entry.name || 'Unnamed Item'),
      qty,
      lineTotal: Math.round(safeTotal * 100) / 100
    });
  }

  const rawMeta = parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
  const guestsRaw = Number(rawMeta.guests);
  const guests = Number.isFinite(guestsRaw) && guestsRaw >= 1 && guestsRaw <= 20
    ? Math.round(guestsRaw)
    : null;

  return {
    source: sourceLabel,
    imageStatus: typeof parsed.imageStatus === 'string' ? parsed.imageStatus : 'ok',
    imageIssue: typeof parsed.imageIssue === 'string' ? parsed.imageIssue : null,
    meta: {
      receiptNo: rawMeta.receiptNo ? String(rawMeta.receiptNo).slice(0, 64) : null,
      table: rawMeta.table ? String(rawMeta.table).slice(0, 32) : null,
      guests,
      date: rawMeta.date ? String(rawMeta.date).slice(0, 32) : null,
      time: rawMeta.time ? String(rawMeta.time).slice(0, 32) : null,
      currency: sanitizeCurrency(rawMeta.currency, '฿')
    },
    serviceCharge: {
      enabled: Boolean(parsed.serviceCharge?.enabled),
      rate: clampRate(parsed.serviceCharge?.rate, 10),
      amount: parseFiniteNonNegative(parsed.serviceCharge?.amount, 0)
    },
    vat: {
      enabled: Boolean(parsed.vat?.enabled),
      rate: clampRate(parsed.vat?.rate, 7),
      amount: parseFiniteNonNegative(parsed.vat?.amount, 0),
      appliesToServiceCharge: parsed.vat?.appliesToServiceCharge !== false
    },
    reportedTotals: {
      subtotal: parseFiniteNonNegative(parsed.reportedTotals?.subtotal, null),
      total: parseFiniteNonNegative(parsed.reportedTotals?.total, null)
    },
    items: cleanItems
  };
}

/**
 * Auto-expand multi-quantity receipt lines into individual 1x draggable items.
 * Preserves rounding remainder on the last unit so totals match exactly in integer cents.
 */
export function expandReceiptItems(rawItems, idPrefix = 'item') {
  const expanded = [];
  let seq = 1;

  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const qty = Math.max(1, Math.min(MAX_ITEM_QTY, Math.round(Number(raw.qty) || 1)));
    const totalCents = Math.max(0, Math.round((Number(raw.lineTotal ?? (Number(raw.unitPrice || 0) * qty)) || 0) * 100));
    const baseCents = Math.floor(totalCents / qty);
    const remainderCents = totalCents - baseCents * qty;
    const groupId = `${idPrefix}_g${seq}`;
    const cleanName = normalizeThaiText(raw.name || 'Unnamed Item');

    for (let i = 0; i < qty; i++) {
      const unitCents = i === qty - 1 ? baseCents + remainderCents : baseCents;
      expanded.push({
        id: `${idPrefix}_${Date.now()}_${seq++}`,
        name: cleanName,
        price: unitCents / 100,
        assignedTo: null,
        groupId: qty > 1 ? groupId : null,
        unitIndex: qty > 1 ? i + 1 : null,
        groupTotal: qty > 1 ? qty : null
      });
    }
  }

  return expanded;
}

/**
 * Low-memory resize & compress for 12MP-48MP phone photos before sending to Gemini Worker.
 * Uses createImageBitmap / ObjectURL instead of FileReader.readAsDataURL to avoid iOS OOM spikes.
 */
export async function compressReceiptImage(file, maxDim = 1500, quality = 0.85) {
  let bitmap = null;
  let objectUrl = null;

  try {
    let srcW;
    let srcH;
    let drawable;

    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(file);
      srcW = bitmap.width;
      srcH = bitmap.height;
      drawable = bitmap;
    } else {
      objectUrl = URL.createObjectURL(file);
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('Could not decode image'));
        el.src = objectUrl;
      });
      srcW = img.naturalWidth;
      srcH = img.naturalHeight;
      drawable = img;
    }

    const largest = Math.max(srcW, srcH);
    const scale = largest > maxDim ? maxDim / largest : 1;
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(drawable, 0, 0, w, h);

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Compression failed'))), 'image/jpeg', quality);
    });

    // Release canvas backing store immediately
    canvas.width = 0;
    canvas.height = 0;

    const previewUrl = URL.createObjectURL(blob);
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const base64 = btoa(binary);

    return { base64, mimeType: 'image/jpeg', previewUrl };
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Send compressed receipt image to the Cloudflare Worker Gemini Vision proxy.
 */
export async function parseReceiptWithWorker(base64, mimeType, onProgress) {
  const endpoint = OCR_WORKER_URL.trim();
  if (!endpoint) {
    throw new Error('OCR_WORKER_URL_NOT_SET');
  }

  onProgress?.('Scanning receipt with AI…', 35);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64: base64, mimeType })
  });

  onProgress?.('Verifying items & totals…', 85);

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `OCR service error (${response.status})`);
  }

  onProgress?.('Done!', 100);
  const label = data.usedModel ? `Gemini (${data.usedModel})` : 'Gemini Vision';
  return normalizeParsedReceiptJson(data, label);
}
