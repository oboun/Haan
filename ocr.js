// Haan OCR & Receipt Parsing Module
// Supports: Paste-from-AI JSON (Gemini Web / ChatGPT / Claude) + Offline Tesseract.js with Canvas Preprocessing

export const RECEIPT_OCR_PROMPT = `You are an expert receipt OCR parser specializing in Thai and English restaurant receipts.
Read EVERY SINGLE LINE of this receipt image carefully from top to bottom. Do not skip any item.

Rules:
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

/**
 * Fix Thai OCR spacing artifacts (e.g. Tesseract inserting spaces between Thai consonants
 * and combining vowels/tone marks like "ข้ า ว เกร ี ย บ" -> "ข้าวเกรียบ").
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
 * Normalize structured JSON object returned by any AI (Gemini, OpenAI-compatible, or Paste-from-AI).
 */
export function normalizeParsedReceiptJson(rawText, sourceLabel = 'AI Paste') {
  if (!rawText || !String(rawText).trim()) {
    throw new Error('Empty response. Please paste valid JSON.');
  }

  let cleaned = String(rawText).trim();
  // Strip markdown code fences if present
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  } else {
    // Extract outermost JSON object if surrounded by explanatory prose
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Invalid JSON format (${err.message})`);
  }

  if (!Array.isArray(parsed.items)) {
    throw new Error('JSON is missing an "items" array.');
  }

  return {
    source: sourceLabel,
    meta: parsed.meta || {},
    serviceCharge: {
      enabled: Boolean(parsed.serviceCharge?.enabled),
      rate: Number(parsed.serviceCharge?.rate) || 10,
      amount: Number(parsed.serviceCharge?.amount) || 0
    },
    vat: {
      enabled: Boolean(parsed.vat?.enabled),
      rate: Number(parsed.vat?.rate) || 7,
      amount: Number(parsed.vat?.amount) || 0,
      appliesToServiceCharge: parsed.vat?.appliesToServiceCharge !== false
    },
    reportedTotals: {
      subtotal: parsed.reportedTotals?.subtotal != null ? Number(parsed.reportedTotals.subtotal) : null,
      total: parsed.reportedTotals?.total != null ? Number(parsed.reportedTotals.total) : null
    },
    items: parsed.items
  };
}

/**
 * Auto-expand multi-quantity receipt lines into individual 1x draggable items.
 * Preserves rounding remainder on the last unit so totals match exactly.
 */
export function expandReceiptItems(rawItems, idPrefix = 'item') {
  const expanded = [];
  let seq = 1;

  for (const raw of rawItems) {
    const qty = Math.max(1, Math.round(Number(raw.qty) || 1));
    const lineTotal = Number(raw.lineTotal ?? (Number(raw.unitPrice || 0) * qty)) || 0;
    const baseUnit = Math.floor((lineTotal / qty) * 100) / 100;
    const remainder = Math.round((lineTotal - baseUnit * qty) * 100) / 100;
    const groupId = `${idPrefix}_g${seq}`;
    const cleanName = normalizeThaiText(raw.name || 'Unnamed Item');

    for (let i = 0; i < qty; i++) {
      const price = i === qty - 1
        ? Math.round((baseUnit + remainder) * 100) / 100
        : baseUnit;

      expanded.push({
        id: `${idPrefix}_${Date.now()}_${seq++}`,
        name: cleanName,
        price,
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
 * Convert File/Blob to { base64, mimeType, dataUrl }
 */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const commaIdx = dataUrl.indexOf(',');
      const base64 = dataUrl.slice(commaIdx + 1);
      const mimeType = file.type || 'image/jpeg';
      resolve({ base64, mimeType, dataUrl });
    };
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Canvas Image Preprocessor for Offline Tesseract.js:
 * - Normalizes size (~1600px width)
 * - Converts to grayscale (weighted to reduce green/blue thermal tint)
 * - Applies percentile contrast stretching so text becomes crisp dark on clean white
 */
function preprocessReceiptImage(imageSource) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const targetMaxW = 1800;
        const scale = img.naturalWidth > targetMaxW ? targetMaxW / img.naturalWidth : 1;
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);

        const imageData = ctx.getImageData(0, 0, w, h);
        const d = imageData.data;
        const hist = new Uint32Array(256);

        // 1. Grayscale conversion + histogram
        const gray = new Uint8Array(w * h);
        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
          const v = Math.round(0.35 * d[i] + 0.50 * d[i + 1] + 0.15 * d[i + 2]);
          gray[p] = v;
          hist[v]++;
        }

        // 2. Find 3rd and 88th percentile for robust contrast stretching
        const totalPx = w * h;
        let cum = 0;
        let low = 0;
        let high = 255;
        for (let i = 0; i < 256; i++) {
          cum += hist[i];
          if (cum >= totalPx * 0.03) { low = i; break; }
        }
        cum = 0;
        for (let i = 0; i < 256; i++) {
          cum += hist[i];
          if (cum >= totalPx * 0.88) { high = i; break; }
        }
        const range = Math.max(20, high - low);

        // 3. Apply stretched contrast + soft S-curve for crisp receipt text
        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
          let norm = (gray[p] - low) / range;
          norm = Math.max(0, Math.min(1, norm));
          // Push light background closer to pure white while keeping dark ink crisp
          const enhanced = norm > 0.72 ? 255 : Math.round(Math.pow(norm / 0.72, 1.35) * 235);
          d[i] = d[i + 1] = d[i + 2] = enhanced;
        }

        ctx.putImageData(imageData, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve(imageSource);
      }
    };
    img.onerror = () => resolve(imageSource);
    img.src = imageSource;
  });
}

/**
 * Dynamically load Tesseract.js from CDN only when offline OCR is used.
 */
let tesseractLoadPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!tesseractLoadPromise) {
    tesseractLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      script.async = true;
      script.onload = () => resolve(window.Tesseract);
      script.onerror = () => reject(new Error('Failed to load Tesseract.js from CDN'));
      document.head.appendChild(script);
    });
  }
  return tesseractLoadPromise;
}

/**
 * Parse a receipt image locally in the browser using Tesseract.js (eng+tha) with Canvas preprocessing.
 */
export async function parseReceiptWithTesseract(imageSource, onProgress) {
  onProgress?.('Enhancing receipt contrast & clarity…', 8);
  const processedSource = await preprocessReceiptImage(imageSource);

  onProgress?.('Loading offline OCR engine (Tesseract.js)…', 15);
  const Tesseract = await loadTesseract();

  const worker = await Tesseract.createWorker('eng+tha', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') {
        const pct = Math.round(25 + (m.progress || 0) * 65);
        onProgress?.(`Recognizing text (${Math.round((m.progress || 0) * 100)}%)…`, pct);
      } else if (m.status) {
        onProgress?.(`OCR: ${m.status}…`, 20);
      }
    }
  });

  try {
    const { data: { text } } = await worker.recognize(processedSource);
    onProgress?.('Extracting items, VAT & Service Charge…', 95);
    const parsed = parseReceiptTextHeuristic(text);
    onProgress?.('Done!', 100);
    return {
      source: 'Tesseract.js (Offline)',
      ...parsed
    };
  } finally {
    await worker.terminate();
  }
}

/**
 * Forgiving price extractor for noisy offline OCR lines (e.g. "280.00", "280,00", "280.0O", "444.00 .")
 */
function extractTrailingPrice(line) {
  // Normalize common OCR digit confusions near the end of the line
  const cleaned = line
    .replace(/[|\]})_,.;:]+$/, '')
    .trim();

  const match = cleaned.match(/([\d,]+[.,]\s*[\dOo]{2})\s*$/);
  if (!match) return null;

  const rawNum = match[1]
    .replace(/\s+/g, '')
    .replace(/[Oo]/g, '0');

  // If formatted like "280,00" (comma as decimal), convert last comma to dot
  const normalizedNum = /,\d{2}$/.test(rawNum)
    ? rawNum.replace(/,(\d{2})$/, '.$1').replace(/,/g, '')
    : rawNum.replace(/,/g, '');

  const value = parseFloat(normalizedNum);
  if (!Number.isFinite(value)) return null;

  return {
    value,
    index: match.index,
    leftPart: cleaned.slice(0, match.index).trim()
  };
}

/**
 * Heuristic parser for raw OCR text from restaurant receipts.
 */
export function parseReceiptTextHeuristic(rawText) {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const meta = {
    receiptNo: null,
    table: null,
    guests: null,
    date: null,
    time: null,
    currency: '฿'
  };

  let scEnabled = false;
  let scRate = 10;
  let scAmount = 0;
  let vatEnabled = false;
  let vatRate = 7;
  let vatAmount = 0;
  let hasBeforeVat = false;
  let reportedSubtotal = null;
  let reportedTotal = null;

  const rawItems = [];
  let pendingParent = null;

  const skipLineRe = /^(receipt|tax invoice|before vat|items?:|change|cash|card|promptpay|thank you|staff|id:|กรุณาตรวจสอบ)/i;

  for (const rawLine of lines) {
    const line = normalizeThaiText(rawLine);

    const tableMatch = line.match(/table\s*[:#]?\s*([A-Z0-9-]+)/i);
    if (tableMatch) { meta.table = tableMatch[1]; continue; }

    const guestsMatch = line.match(/guests?\s*[:#]?\s*(\d+)/i);
    if (guestsMatch) { meta.guests = parseInt(guestsMatch[1], 10); continue; }

    const dateMatch = line.match(/date\s*[:#]?\s*([\d/-]+)/i);
    if (dateMatch) { meta.date = dateMatch[1]; continue; }

    const noMatch = line.match(/no\.?\s*[:#]?\s*([A-Z0-9/-]+)/i);
    if (noMatch) { meta.receiptNo = noMatch[1]; continue; }

    const priceInfo = extractTrailingPrice(line);

    // Printed Subtotal
    if (/^(sub\s*total|ยอดรวม|รวมเงิน)\b/i.test(line)) {
      if (priceInfo) reportedSubtotal = priceInfo.value;
      pendingParent = null;
      continue;
    }

    // Service charge detection
    if (/service\s*charge/i.test(line)) {
      const rateMatch = line.match(/(\d+(?:\.\d+)?)\s*%/);
      if (rateMatch) scRate = parseFloat(rateMatch[1]);
      if (priceInfo) {
        scAmount = priceInfo.value;
        if (scAmount > 0) scEnabled = true;
      }
      pendingParent = null;
      continue;
    }

    if (/before\s*vat/i.test(line)) {
      hasBeforeVat = true;
      pendingParent = null;
      continue;
    }

    // VAT detection
    if (/\bvat\b|ภาษีมูลค่าเพิ่ม/i.test(line)) {
      const rateMatch = line.match(/(\d+(?:\.\d+)?)\s*%/);
      if (rateMatch) vatRate = parseFloat(rateMatch[1]);
      if (priceInfo) {
        vatAmount = priceInfo.value;
        if (vatAmount > 0) vatEnabled = true;
      }
      pendingParent = null;
      continue;
    }

    // Printed Grand Total
    if (/^(grand\s*total|total|ยอดสุทธิ|รวมสุทธิ)\b/i.test(line)) {
      if (priceInfo) reportedTotal = priceInfo.value;
      pendingParent = null;
      continue;
    }

    if (skipLineRe.test(line)) {
      pendingParent = null;
      continue;
    }

    if (!priceInfo || !priceInfo.leftPart) continue;

    const price = priceInfo.value;
    const leftPart = priceInfo.leftPart;

    const qtyMatch = leftPart.match(/^(\d{1,2})\s+(.+)$/);
    const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;
    const name = normalizeThaiText(qtyMatch ? qtyMatch[2] : leftPart);

    if (price === 0) {
      if (/^1x\s/i.test(name) && rawItems.length > 0) {
        rawItems[rawItems.length - 1].name += ` (${name})`;
      } else {
        pendingParent = { name, qty };
      }
      continue;
    }

    if (pendingParent && !qtyMatch) {
      rawItems.push({
        name: `${pendingParent.name} (${name})`,
        qty: pendingParent.qty,
        lineTotal: price
      });
      pendingParent = null;
    } else {
      pendingParent = null;
      rawItems.push({ name, qty, lineTotal: price });
    }
  }

  return {
    meta,
    serviceCharge: {
      enabled: scEnabled,
      rate: scRate,
      amount: scAmount
    },
    vat: {
      enabled: vatEnabled,
      rate: vatRate,
      amount: vatAmount,
      appliesToServiceCharge: hasBeforeVat || scEnabled
    },
    reportedTotals: {
      subtotal: reportedSubtotal,
      total: reportedTotal
    },
    items: rawItems
  };
}
