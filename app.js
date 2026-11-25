import {
  expandReceiptItems,
  fileToBase64,
  normalizeParsedReceiptJson,
  normalizeThaiText,
  parseReceiptWithTesseract,
  RECEIPT_OCR_PROMPT
} from './ocr.js';

// Feature-detected polyfill for <input type="checkbox" switch> (modern-web-guidance: switch)
if (!('switch' in HTMLInputElement.prototype)) {
  import('https://esm.sh/input-switch-polyfill').catch(() => {
    // Graceful fallback: standard checkbox still works cleanly if offline
  });
}

// Feature-detected light-dismiss fallback for <dialog closedby="any"> (modern-web-guidance: dialog / light-dismiss-a-dialog)
if (!('closedBy' in HTMLDialogElement.prototype)) {
  const isOutside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = isOutside(e, dialog);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && isOutside(e, dialog)) {
        dialog.close();
      }
      pressedOutside = false;
    });
  }
}

const PERSON_COLORS = [
  '#2563eb', // Blue
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#ec4899', // Pink
  '#8b5cf6', // Violet
  '#06b6d4', // Cyan
  '#f97316', // Orange
  '#84cc16', // Lime
  '#ef4444', // Red
  '#14b8a6'  // Teal
];

// Clear any previously saved API keys from localStorage
localStorage.removeItem('slipshare_gemini_api_key');
localStorage.removeItem('slipshare_gemini_model');
localStorage.removeItem('slipshare_ocr_engine');

const STORAGE_KEYS = {
  currency: 'slipshare_currency'
};

// Application State
const state = {
  items: [],
  people: [],
  shareParticipants: new Set(),
  charges: {
    scEnabled: false,
    scRate: 10,
    scAuto: false,
    vatEnabled: false,
    vatRate: 7,
    vatAuto: false,
    vatOnSc: true
  },
  reportedTotals: {
    subtotal: null,
    total: null
  },
  meta: null,
  sourceLabel: '',
  receiptImageUrl: null,
  receiptImageFile: null,
  filter: 'all',
  searchQuery: '',
  draggedItemId: null,
  inspectingBasketId: null,
  settings: {
    currency: localStorage.getItem(STORAGE_KEYS.currency) || '฿'
  }
};

// DOM References
const els = {
  uploadDropzone: document.getElementById('uploadDropzone'),
  receiptFileInput: document.getElementById('receiptFileInput'),
  btnOpenPasteAi: document.getElementById('btnOpenPasteAi'),
  btnHeroPasteAi: document.getElementById('btnHeroPasteAi'),
  btnPreviewReceipt: document.getElementById('btnPreviewReceipt'),
  btnFooterSummary: document.getElementById('btnFooterSummary'),

  ocrProgress: document.getElementById('ocrProgress'),
  ocrProgressTitle: document.getElementById('ocrProgressTitle'),
  ocrProgressDetail: document.getElementById('ocrProgressDetail'),
  ocrProgressBar: document.getElementById('ocrProgressBar'),

  metaSourceBadge: document.getElementById('metaSourceBadge'),
  verifyStatusBadge: document.getElementById('verifyStatusBadge'),
  metaDetailsText: document.getElementById('metaDetailsText'),
  toggleServiceCharge: document.getElementById('toggleServiceCharge'),
  inputServiceChargeRate: document.getElementById('inputServiceChargeRate'),
  badgeScAuto: document.getElementById('badgeScAuto'),
  toggleVat: document.getElementById('toggleVat'),
  inputVatRate: document.getElementById('inputVatRate'),
  badgeVatAuto: document.getElementById('badgeVatAuto'),
  toggleVatOnSc: document.getElementById('toggleVatOnSc'),

  statSubtotal: document.getElementById('statSubtotal'),
  statScWrap: document.getElementById('statScWrap'),
  statScPct: document.getElementById('statScPct'),
  statSc: document.getElementById('statSc'),
  statVatWrap: document.getElementById('statVatWrap'),
  statVatPct: document.getElementById('statVatPct'),
  statVat: document.getElementById('statVat'),
  statGrandTotal: document.getElementById('statGrandTotal'),
  progressLabel: document.getElementById('progressLabel'),
  progressPercent: document.getElementById('progressPercent'),
  progressFill: document.getElementById('progressFill'),

  countAll: document.getElementById('countAll'),
  countUnassigned: document.getElementById('countUnassigned'),
  countAssigned: document.getElementById('countAssigned'),
  searchItems: document.getElementById('searchItems'),
  btnAddItem: document.getElementById('btnAddItem'),
  btnResetAssignments: document.getElementById('btnResetAssignments'),
  itemsDropArea: document.getElementById('itemsDropArea'),
  itemsGrid: document.getElementById('itemsGrid'),
  emptyItemsHint: document.getElementById('emptyItemsHint'),

  shareBasket: document.getElementById('shareBasket'),
  shareItemCount: document.getElementById('shareItemCount'),
  shareTotalAmount: document.getElementById('shareTotalAmount'),
  shareDropCue: document.getElementById('shareDropCue'),
  shareDropPreview: document.getElementById('shareDropPreview'),
  shareParticipantsBar: document.getElementById('shareParticipantsBar'),
  sharePerPersonNote: document.getElementById('sharePerPersonNote'),

  btnRemovePerson: document.getElementById('btnRemovePerson'),
  btnAddPerson: document.getElementById('btnAddPerson'),
  peopleCountDisplay: document.getElementById('peopleCountDisplay'),
  individualBasketsList: document.getElementById('individualBasketsList'),
  footerAllocatedTotal: document.getElementById('footerAllocatedTotal'),

  // Dialogs
  verifyDialog: document.getElementById('verifyDialog'),
  verifyMessage: document.getElementById('verifyMessage'),
  verifyTable: document.getElementById('verifyTable'),
  btnVerifyViewReceipt: document.getElementById('btnVerifyViewReceipt'),
  btnVerifyAddItem: document.getElementById('btnVerifyAddItem'),

  basketDetailDialog: document.getElementById('basketDetailDialog'),
  basketDetailTitle: document.getElementById('basketDetailTitle'),
  basketDetailSummary: document.getElementById('basketDetailSummary'),
  basketDetailList: document.getElementById('basketDetailList'),

  pasteAiDialog: document.getElementById('pasteAiDialog'),
  pasteAiNotice: document.getElementById('pasteAiNotice'),
  btnCopyAiPrompt: document.getElementById('btnCopyAiPrompt'),
  copyPromptStatus: document.getElementById('copyPromptStatus'),
  pasteAiTextarea: document.getElementById('pasteAiTextarea'),
  pasteAiError: document.getElementById('pasteAiError'),
  btnImportAiJson: document.getElementById('btnImportAiJson'),

  previewDialog: document.getElementById('previewDialog'),
  receiptPreviewImg: document.getElementById('receiptPreviewImg'),
  btnRescanReceipt: document.getElementById('btnRescanReceipt'),

  summaryDialog: document.getElementById('summaryDialog'),
  chkSummaryDetails: document.getElementById('chkSummaryDetails'),
  summaryTextarea: document.getElementById('summaryTextarea'),
  btnCopySummary: document.getElementById('btnCopySummary'),
  copyConfirmMsg: document.getElementById('copyConfirmMsg'),

  itemDialog: document.getElementById('itemDialog'),
  itemDialogTitle: document.getElementById('itemDialogTitle'),
  itemForm: document.getElementById('itemForm'),
  editItemId: document.getElementById('editItemId'),
  editItemName: document.getElementById('editItemName'),
  editItemPrice: document.getElementById('editItemPrice'),
  editItemQty: document.getElementById('editItemQty'),
  editItemQtyWrap: document.getElementById('editItemQtyWrap'),
  btnDeleteItem: document.getElementById('btnDeleteItem'),
  btnCancelItem: document.getElementById('btnCancelItem'),

  assignDialog: document.getElementById('assignDialog'),
  assignItemPreview: document.getElementById('assignItemPreview'),
  assignTargetsList: document.getElementById('assignTargetsList'),

  toast: document.getElementById('toast')
};

// Utilities
function fmt(amount) {
  const num = Number(amount) || 0;
  return `${state.settings.currency}${num.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function fmtSignedDiff(diff) {
  const sign = diff > 0 ? '+' : diff < 0 ? '−' : '';
  return `${sign}${fmt(Math.abs(diff))}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = null;
function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2800);
}

// Initialize People
function initPeople(count = 4) {
  const current = state.people;
  const target = Math.max(1, Math.min(16, count));

  while (current.length < target) {
    const idx = current.length;
    const id = `p_${Date.now()}_${idx + 1}`;
    current.push({
      id,
      name: `Person ${idx + 1}`,
      color: PERSON_COLORS[idx % PERSON_COLORS.length]
    });
    state.shareParticipants.add(id);
  }

  while (current.length > target) {
    const removed = current.pop();
    state.shareParticipants.delete(removed.id);
    for (const item of state.items) {
      if (item.assignedTo === removed.id) {
        item.assignedTo = null;
      }
    }
  }
}

// Tax & Total Calculations
function computeTotals() {
  const subtotal = state.items.reduce((sum, item) => sum + item.price, 0);
  const scRate = state.charges.scEnabled ? state.charges.scRate : 0;
  const vatRate = state.charges.vatEnabled ? state.charges.vatRate : 0;
  const vatOnSc = state.charges.vatOnSc;

  const calcCharges = (base) => {
    const sc = base * (scRate / 100);
    const vatBase = vatOnSc ? (base + sc) : base;
    const vat = vatBase * (vatRate / 100);
    return { base, sc, vat, total: base + sc + vat };
  };

  const receipt = calcCharges(subtotal);

  // Shared basket
  const sharedItems = state.items.filter((i) => i.assignedTo === 'shared');
  const sharedSubtotal = sharedItems.reduce((sum, i) => sum + i.price, 0);
  const activeShareIds = state.people
    .map((p) => p.id)
    .filter((id) => state.shareParticipants.has(id));
  const shareDivisor = activeShareIds.length || 1;
  const sharePerPersonBase = activeShareIds.length > 0 ? sharedSubtotal / shareDivisor : 0;
  const sharedTotals = calcCharges(sharedSubtotal);

  // Individual baskets
  const perPerson = new Map();
  let allocatedTotal = 0;

  for (const person of state.people) {
    const ownItems = state.items.filter((i) => i.assignedTo === person.id);
    const ownSubtotal = ownItems.reduce((sum, i) => sum + i.price, 0);
    const sharePart = state.shareParticipants.has(person.id) ? sharePerPersonBase : 0;
    const combinedBase = ownSubtotal + sharePart;
    const breakdown = calcCharges(combinedBase);
    allocatedTotal += breakdown.total;

    perPerson.set(person.id, {
      ownItems,
      ownSubtotal,
      sharePart,
      ...breakdown
    });
  }

  if (sharedItems.length > 0 && activeShareIds.length === 0) {
    allocatedTotal += sharedTotals.total;
  }

  return {
    receipt,
    sharedItems,
    sharedSubtotal,
    sharedTotals,
    activeShareIds,
    sharePerPersonBase,
    perPerson,
    allocatedTotal
  };
}

// Total Price Verification against Receipt Printed Totals
function getVerificationStatus(totals) {
  const { subtotal: repSub, total: repTot } = state.reportedTotals;
  const hasReported = repSub != null || repTot != null;

  if (!hasReported) {
    return {
      hasReported: false,
      mismatch: state.items.length > 0, // warn if receipt was scanned but total couldn't be read
      subtotalDiff: null,
      totalDiff: null
    };
  }

  const subtotalDiff = repSub != null ? Math.round((totals.receipt.base - repSub) * 100) / 100 : null;
  const totalDiff = repTot != null ? Math.round((totals.receipt.total - repTot) * 100) / 100 : null;
  const tolerance = 0.05;

  const subBad = subtotalDiff != null && Math.abs(subtotalDiff) > tolerance;
  const totBad = totalDiff != null && Math.abs(totalDiff) > tolerance;

  return {
    hasReported: true,
    mismatch: subBad || totBad,
    subtotalDiff,
    totalDiff,
    repSub,
    repTot
  };
}

function openVerifyDialog() {
  const totals = computeTotals();
  const v = getVerificationStatus(totals);

  if (!v.hasReported) {
    els.verifyMessage.textContent =
      'OCR could not detect the printed Total on this receipt. Please double-check the extracted items and prices against your receipt image.';
    els.verifyTable.innerHTML = `
      <div class="verify-row verify-row-head">
        <span>Field</span><span>Receipt</span><span>Extracted</span><span>Diff</span>
      </div>
      <div class="verify-row">
        <span>Subtotal</span><span>Not detected</span><span>${fmt(totals.receipt.base)}</span><span>—</span>
      </div>
      <div class="verify-row">
        <span>Grand Total</span><span>Not detected</span><span>${fmt(totals.receipt.total)}</span><span>—</span>
      </div>
    `;
  } else {
    const primaryDiff = v.totalDiff != null ? v.totalDiff : v.subtotalDiff;
    const absDiff = Math.abs(primaryDiff || 0);
    if (v.mismatch) {
      els.verifyMessage.textContent =
        `The extracted items do not match the printed receipt total (difference of ${fmt(absDiff)}). Please review and fix any missed or misread items before splitting.`;
    } else {
      els.verifyMessage.textContent =
        'All extracted items, Service Charge, and VAT match the printed receipt total!';
    }

    const subRow = v.repSub != null ? `
      <div class="verify-row">
        <span>Subtotal</span>
        <span>${fmt(v.repSub)}</span>
        <span>${fmt(totals.receipt.base)}</span>
        <span class="${Math.abs(v.subtotalDiff) > 0.05 ? 'verify-diff-bad' : 'verify-diff-ok'}">
          ${Math.abs(v.subtotalDiff) <= 0.05 ? '✓ Match' : fmtSignedDiff(v.subtotalDiff)}
        </span>
      </div>
    ` : '';

    const totRow = v.repTot != null ? `
      <div class="verify-row">
        <span><strong>Grand Total</strong></span>
        <span><strong>${fmt(v.repTot)}</strong></span>
        <span><strong>${fmt(totals.receipt.total)}</strong></span>
        <span class="${Math.abs(v.totalDiff) > 0.05 ? 'verify-diff-bad' : 'verify-diff-ok'}">
          ${Math.abs(v.totalDiff) <= 0.05 ? '✓ Match' : fmtSignedDiff(v.totalDiff)}
        </span>
      </div>
    ` : '';

    els.verifyTable.innerHTML = `
      <div class="verify-row verify-row-head">
        <span>Field</span><span>Receipt</span><span>Extracted</span><span>Diff</span>
      </div>
      ${subRow}
      ${totRow}
    `;
  }

  els.btnVerifyViewReceipt.hidden = !state.receiptImageUrl;
  els.verifyDialog.showModal();
}

// Apply Parsed Receipt Data to State
function applyReceiptData(data, imageUrl = null, imageFile = null) {
  state.items = expandReceiptItems(data.items || []);
  state.meta = data.meta || {};
  state.sourceLabel = data.source || 'OCR';
  state.reportedTotals = {
    subtotal: data.reportedTotals?.subtotal ?? null,
    total: data.reportedTotals?.total ?? null
  };

  if (imageUrl) {
    state.receiptImageUrl = imageUrl;
    state.receiptImageFile = imageFile;
    els.receiptPreviewImg.src = imageUrl;
    els.btnPreviewReceipt.hidden = false;
  } else {
    state.receiptImageUrl = null;
    state.receiptImageFile = null;
    els.receiptPreviewImg.removeAttribute('src');
    els.btnPreviewReceipt.hidden = true;
  }

  if (data.meta?.currency) {
    state.settings.currency = data.meta.currency;
  }

  // Automatically set VAT / Service Charge ON or OFF based on receipt data
  state.charges.scEnabled = Boolean(data.serviceCharge?.enabled);
  state.charges.scRate = Number(data.serviceCharge?.rate) || 10;
  state.charges.scAuto = true;

  state.charges.vatEnabled = Boolean(data.vat?.enabled);
  state.charges.vatRate = Number(data.vat?.rate) || 7;
  state.charges.vatAuto = true;
  state.charges.vatOnSc = data.vat?.appliesToServiceCharge !== false;

  // Auto-adjust number of individual baskets if receipt lists guest count
  if (data.meta?.guests && data.meta.guests >= 1 && data.meta.guests <= 16) {
    initPeople(data.meta.guests);
  }

  syncChargeControlsUI();
  renderAll();

  // Verify total price right after import and show popup warning if mismatched
  const totals = computeTotals();
  const verification = getVerificationStatus(totals);
  if (verification.mismatch) {
    openVerifyDialog();
  } else if (verification.hasReported) {
    showToast(`✓ Verified! ${state.items.length} items match receipt total (${fmt(totals.receipt.total)})`);
  }
}

function syncChargeControlsUI() {
  els.toggleServiceCharge.checked = state.charges.scEnabled;
  els.inputServiceChargeRate.value = state.charges.scRate;
  els.inputServiceChargeRate.disabled = !state.charges.scEnabled;
  els.badgeScAuto.hidden = !state.charges.scAuto;

  els.toggleVat.checked = state.charges.vatEnabled;
  els.inputVatRate.value = state.charges.vatRate;
  els.inputVatRate.disabled = !state.charges.vatEnabled;
  els.badgeVatAuto.hidden = !state.charges.vatAuto;

  els.toggleVatOnSc.checked = state.charges.vatOnSc;
}

// Rendering
function renderAll() {
  const totals = computeTotals();
  renderHeaderAndMeta(totals);
  renderItemsGrid();
  renderShareBasket(totals);
  renderIndividualBaskets(totals);
  renderRightFooter(totals);
  if (els.basketDetailDialog.open && state.inspectingBasketId) {
    renderBasketDetailDialog(state.inspectingBasketId, totals);
  }
}

function renderHeaderAndMeta(totals) {
  const hasItems = state.items.length > 0;
  els.uploadDropzone.classList.toggle('compact', hasItems);

  if (hasItems) {
    els.metaSourceBadge.textContent = state.sourceLabel || 'Loaded';
    els.metaSourceBadge.classList.add('loaded');

    const v = getVerificationStatus(totals);
    els.verifyStatusBadge.hidden = false;
    if (v.hasReported && !v.mismatch) {
      els.verifyStatusBadge.className = 'verify-badge ok';
      els.verifyStatusBadge.textContent = '✓ Total Verified';
    } else if (v.hasReported && v.mismatch) {
      const diff = v.totalDiff != null ? v.totalDiff : v.subtotalDiff;
      els.verifyStatusBadge.className = 'verify-badge warn';
      els.verifyStatusBadge.textContent = `⚠ Diff ${fmtSignedDiff(diff)}`;
    } else {
      els.verifyStatusBadge.className = 'verify-badge warn';
      els.verifyStatusBadge.textContent = '⚠ Unverified Total';
    }

    const parts = [];
    if (state.meta?.table) parts.push(`Table ${state.meta.table}`);
    if (state.meta?.guests) parts.push(`${state.meta.guests} guests`);
    if (state.meta?.date) parts.push(state.meta.date);
    if (state.meta?.time) parts.push(state.meta.time);
    els.metaDetailsText.textContent = parts.length
      ? `${parts.join(' • ')} (${state.items.length} items)`
      : `${state.items.length} items on receipt`;
  } else {
    els.metaSourceBadge.textContent = 'No receipt loaded';
    els.metaSourceBadge.classList.remove('loaded');
    els.verifyStatusBadge.hidden = true;
    els.metaDetailsText.textContent = 'Upload a slip to begin';
  }

  // Totals strip
  els.statSubtotal.textContent = fmt(totals.receipt.base);
  els.statScPct.textContent = state.charges.scRate;
  els.statSc.textContent = fmt(totals.receipt.sc);
  els.statScWrap.classList.toggle('disabled', !state.charges.scEnabled);

  els.statVatPct.textContent = state.charges.vatRate;
  els.statVat.textContent = fmt(totals.receipt.vat);
  els.statVatWrap.classList.toggle('disabled', !state.charges.vatEnabled);

  els.statGrandTotal.textContent = fmt(totals.receipt.total);

  // Assignment progress
  const totalCount = state.items.length;
  const assignedCount = state.items.filter((i) => i.assignedTo !== null).length;
  const unassignedCount = totalCount - assignedCount;
  const pct = totalCount > 0 ? Math.round((assignedCount / totalCount) * 100) : 0;

  els.progressLabel.textContent = `${assignedCount} / ${totalCount} items assigned`;
  els.progressPercent.textContent = `${pct}%`;
  els.progressFill.style.width = `${pct}%`;

  els.countAll.textContent = totalCount;
  els.countUnassigned.textContent = unassignedCount;
  els.countAssigned.textContent = assignedCount;
}

function getOwnerInfo(assignedTo) {
  if (!assignedTo) return null;
  if (assignedTo === 'shared') {
    return { name: 'Share', color: '#6366f1' };
  }
  const person = state.people.find((p) => p.id === assignedTo);
  return person ? { name: person.name, color: person.color } : null;
}

function renderItemsGrid() {
  const q = state.searchQuery.trim().toLowerCase();
  const filtered = state.items
    .filter((item) => {
      if (state.filter === 'unassigned' && item.assignedTo !== null) return false;
      if (state.filter === 'assigned' && item.assignedTo === null) return false;
      if (q && !item.name.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => {
      const aAssigned = a.assignedTo !== null ? 1 : 0;
      const bAssigned = b.assignedTo !== null ? 1 : 0;
      return aAssigned - bAssigned;
    });

  els.emptyItemsHint.hidden = !(state.items.length > 0 && filtered.length === 0);

  if (filtered.length === 0) {
    els.itemsGrid.innerHTML = '';
    return;
  }

  els.itemsGrid.innerHTML = filtered.map((item) => {
    const owner = getOwnerInfo(item.assignedTo);
    const assignedClass = owner ? 'is-assigned' : '';
    const styleAttr = owner ? `style="--owner-color: ${owner.color}"` : '';
    const unitBadge = item.groupTotal > 1
      ? `<span class="item-unit-badge">Unit ${item.unitIndex} of ${item.groupTotal}</span>`
      : '';

    const bottomLeft = owner
      ? `<span class="item-owner-pill"><span class="item-owner-dot"></span>${escapeHtml(owner.name)}</span>`
      : `<span class="item-unassigned-hint">Unassigned</span>`;

    return `
      <article class="item-card ${assignedClass}" ${styleAttr} draggable="true" data-item-id="${item.id}" tabindex="0">
        <div class="item-card-top">
          <span class="item-grip" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="5.5" cy="3.5" r="1.2"/><circle cx="10.5" cy="3.5" r="1.2"/>
              <circle cx="5.5" cy="8" r="1.2"/><circle cx="10.5" cy="8" r="1.2"/>
              <circle cx="5.5" cy="12.5" r="1.2"/><circle cx="10.5" cy="12.5" r="1.2"/>
            </svg>
          </span>
          <div class="item-name-wrap">
            <span class="item-name">${escapeHtml(item.name)}</span>
            ${unitBadge}
          </div>
          <span class="item-price">${fmt(item.price)}</span>
        </div>
        <div class="item-card-bottom">
          ${bottomLeft}
          <div class="item-actions">
            <button type="button" class="item-icon-btn" data-action="assign" data-item-id="${item.id}" title="Assign to basket" aria-label="Assign ${escapeHtml(item.name)}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
            </button>
            <button type="button" class="item-icon-btn" data-action="edit" data-item-id="${item.id}" title="Edit item" aria-label="Edit ${escapeHtml(item.name)}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
            </button>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

function renderShareBasket(totals) {
  const sharedCount = totals.sharedItems.length;
  els.shareItemCount.textContent = sharedCount;
  els.shareTotalAmount.textContent = fmt(totals.sharedTotals.total);
  els.shareBasket.classList.toggle('has-items', sharedCount > 0);

  if (els.shareDropPreview && els.shareDropCue) {
    if (sharedCount > 0) {
      const previewItems = totals.sharedItems.slice(0, 2);
      const extra = sharedCount - previewItems.length;
      const chipsHtml = previewItems
        .map((item) => `<span class="share-preview-chip">${escapeHtml(item.name)}</span>`)
        .join('');
      const moreHtml = extra > 0
        ? `<button type="button" class="share-preview-more" data-inspect-basket="shared">+${extra} more</button>`
        : '';
      els.shareDropPreview.innerHTML = chipsHtml + moreHtml;
      els.shareDropPreview.hidden = false;
      els.shareDropCue.hidden = true;
    } else {
      els.shareDropPreview.innerHTML = '';
      els.shareDropPreview.hidden = true;
      els.shareDropCue.hidden = false;
    }
  }

  els.shareParticipantsBar.innerHTML = state.people.map((person) => {
    const active = state.shareParticipants.has(person.id);
    return `
      <button type="button" class="share-chip ${active ? 'active' : ''}" data-share-person="${person.id}" style="--chip-color: ${person.color}" aria-pressed="${active}">
        <span class="share-chip-dot"></span>
        <span>${escapeHtml(person.name)}</span>
      </button>
    `;
  }).join('');

  const count = totals.activeShareIds.length;
  const perPersonWithTax = count > 0 ? totals.sharedTotals.total / count : 0;
  els.sharePerPersonNote.textContent = count > 0
    ? `${fmt(perPersonWithTax)} / person · ${count} splitting`
    : 'Select at least 1 person below to split';
}

function renderIndividualBaskets(totals) {
  const n = state.people.length;
  els.peopleCountDisplay.textContent = n;
  els.individualBasketsList.dataset.cols = n <= 3 ? '1' : '2';
  els.individualBasketsList.dataset.density = n >= 7 ? 'compact' : 'normal';

  els.individualBasketsList.innerHTML = state.people.map((person) => {
    const data = totals.perPerson.get(person.id);
    const miniParts = [];
    if (data.ownSubtotal > 0) miniParts.push(`Own ${fmt(data.ownSubtotal)}`);
    if (data.sharePart > 0) miniParts.push(`Share ${fmt(data.sharePart)}`);
    const miniLine = miniParts.length > 0 ? miniParts.join(' · ') : 'Drop items here';

    return `
      <section class="basket-card person-basket" data-basket-id="${person.id}" style="--basket-color: ${person.color}" aria-label="${escapeHtml(person.name)} basket">
        <div class="person-top-row">
          <label class="person-color-picker" title="Change color for ${escapeHtml(person.name)}">
            <input type="color" value="${person.color}" data-person-color="${person.id}" aria-label="Color for ${escapeHtml(person.name)}">
          </label>
          <input type="text" class="person-name-input" value="${escapeHtml(person.name)}" data-person-name="${person.id}" aria-label="Person name">
          <button type="button" class="basket-count-pill clickable-pill" data-inspect-basket="${person.id}" title="View items in ${escapeHtml(person.name)}'s basket">${data.ownItems.length}</button>
        </div>
        <div class="person-bottom-row">
          <div class="person-total-line">
            <strong class="person-total-amount">${fmt(data.total)}</strong>
          </div>
          <span class="person-mini-breakdown">${miniLine}</span>
        </div>
      </section>
    `;
  }).join('');
}

function renderRightFooter(totals) {
  const diff = Math.abs(totals.allocatedTotal - totals.receipt.total);
  const complete = state.items.length > 0 && diff < 0.02;
  els.footerAllocatedTotal.textContent = `${fmt(totals.allocatedTotal)} / ${fmt(totals.receipt.total)}`;
  els.footerAllocatedTotal.classList.toggle('complete', complete);
}

// Basket Detail Inspector Dialog
function renderBasketDetailDialog(basketId, totals = computeTotals()) {
  state.inspectingBasketId = basketId;
  const isShared = basketId === 'shared';
  const person = isShared ? null : state.people.find((p) => p.id === basketId);
  if (!isShared && !person) {
    els.basketDetailDialog.close();
    return;
  }

  const items = isShared ? totals.sharedItems : totals.perPerson.get(person.id).ownItems;
  const totalAmt = isShared ? totals.sharedTotals.total : totals.perPerson.get(person.id).total;

  els.basketDetailTitle.textContent = isShared ? 'Share' : person.name;
  els.basketDetailSummary.innerHTML = `<span>${items.length} ${items.length === 1 ? 'item' : 'items'}</span><span>Total (incl. tax): ${fmt(totalAmt)}</span>`;

  if (items.length === 0) {
    els.basketDetailList.innerHTML = `<p style="margin: 8px 0; color: var(--text-muted); text-align: center;">No items assigned yet. Drag items from the left pane onto this card.</p>`;
  } else {
    els.basketDetailList.innerHTML = items.map((item) => `
      <div class="basket-detail-row">
        <span class="basket-detail-name">${escapeHtml(item.name)}</span>
        <span class="basket-detail-price">${fmt(item.price)}</span>
        <button type="button" class="basket-item-remove" data-unassign-id="${item.id}" aria-label="Remove ${escapeHtml(item.name)}">&times;</button>
      </div>
    `).join('');
  }
}

function openBasketDetailDialog(basketId) {
  renderBasketDetailDialog(basketId);
  els.basketDetailDialog.showModal();
}

// Assignment Actions
function assignItem(itemId, targetBasketId) {
  const item = state.items.find((i) => i.id === itemId);
  if (!item) return;
  item.assignedTo = targetBasketId;
  renderAll();
}

// OCR Orchestration
function setOcrLoading(loading, title = '', detail = '', pct = 0) {
  els.ocrProgress.hidden = !loading;
  if (loading) {
    els.ocrProgressTitle.textContent = title;
    els.ocrProgressDetail.textContent = detail;
    els.ocrProgressBar.style.width = `${Math.max(5, Math.min(100, pct))}%`;
  }
}

function openPasteAiDialog(noticeText = '') {
  els.copyPromptStatus.textContent = '';
  els.pasteAiError.textContent = '';
  if (noticeText) {
    els.pasteAiNotice.textContent = noticeText;
    els.pasteAiNotice.hidden = false;
  } else {
    els.pasteAiNotice.textContent = '';
    els.pasteAiNotice.hidden = true;
  }
  els.pasteAiDialog.showModal();
  if (!window.matchMedia('(pointer: coarse)').matches) {
    els.pasteAiTextarea.focus();
  }
}

function clearReceiptData() {
  state.items = [];
  state.meta = null;
  state.sourceLabel = '';
  state.reportedTotals = { subtotal: null, total: null };
  state.receiptImageUrl = null;
  state.receiptImageFile = null;
  els.receiptPreviewImg.removeAttribute('src');
  els.btnPreviewReceipt.hidden = true;
  state.charges.scEnabled = false;
  state.charges.scAuto = false;
  state.charges.vatEnabled = false;
  state.charges.vatAuto = false;
  syncChargeControlsUI();
  renderAll();
}

function validateOcrResult(result) {
  const expanded = expandReceiptItems(result.items || []);
  if (expanded.length === 0) {
    return { ok: false, reason: 'Offline OCR could not detect any items from this receipt.' };
  }

  const repSub = result.reportedTotals?.subtotal ?? null;
  const repTot = result.reportedTotals?.total ?? null;
  if (repSub == null && repTot == null) {
    return { ok: false, reason: 'Offline OCR could not read the receipt total to verify all items.' };
  }

  const sub = expanded.reduce((s, i) => s + i.price, 0);
  const scRate = result.serviceCharge?.enabled ? (Number(result.serviceCharge?.rate) || 10) : 0;
  const vatRate = result.vat?.enabled ? (Number(result.vat?.rate) || 7) : 0;
  const vatOnSc = result.vat?.appliesToServiceCharge !== false;
  const sc = sub * (scRate / 100);
  const vat = (vatOnSc ? sub + sc : sub) * (vatRate / 100);
  const calcTot = sub + sc + vat;

  const tolerance = 0.05;
  if (repSub != null && Math.abs(sub - repSub) > tolerance) {
    return {
      ok: false,
      reason: `Offline OCR missed items (Extracted Subtotal ${fmt(sub)} vs Receipt ${fmt(repSub)}). Cleared incomplete data — use Paste AI below for 100% accuracy.`
    };
  }
  if (repTot != null && Math.abs(calcTot - repTot) > tolerance) {
    return {
      ok: false,
      reason: `Offline OCR total mismatch (Extracted ${fmt(calcTot)} vs Receipt ${fmt(repTot)}). Cleared incomplete data — use Paste AI below for 100% accuracy.`
    };
  }

  return { ok: true };
}

async function handleReceiptFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    showToast('Please select a valid image file.');
    return;
  }

  const { dataUrl } = await fileToBase64(file);
  state.receiptImageUrl = dataUrl;
  state.receiptImageFile = file;
  els.receiptPreviewImg.src = dataUrl;
  els.btnPreviewReceipt.hidden = false;

  try {
    setOcrLoading(true, 'Scanning with Tesseract.js (Offline)…', 'Enhancing image contrast', 10);
    const result = await parseReceiptWithTesseract(dataUrl, (msg, pct) => {
      setOcrLoading(true, 'Scanning with Tesseract.js (Offline)…', msg, pct);
    });

    setOcrLoading(false);

    // Strict check: never load incomplete/mismatched OCR data; clean & open Paste AI instead
    const check = validateOcrResult(result);
    if (!check.ok) {
      clearReceiptData();
      openPasteAiDialog(check.reason);
      return;
    }

    applyReceiptData(result, dataUrl, file);
  } catch (err) {
    setOcrLoading(false);
    clearReceiptData();
    openPasteAiDialog(`Offline OCR failed (${err.message}). Use Paste AI below for 100% accuracy.`);
  }
}

async function rescanCurrentReceipt() {
  els.previewDialog.close();
  if (state.receiptImageFile) {
    await handleReceiptFile(state.receiptImageFile);
  }
}

// Summary Text Generator (LINE / WhatsApp friendly — Share listed first)
function generateSummaryText(includeDetails = true) {
  const totals = computeTotals();
  const lines = [];

  lines.push('🧾 Haan Bill Summary');
  const metaBits = [];
  if (state.meta?.table) metaBits.push(`Table ${state.meta.table}`);
  if (state.meta?.date) metaBits.push(state.meta.date);
  if (metaBits.length) lines.push(metaBits.join(' • '));
  lines.push('────────────────────');

  // Share section first
  if (totals.sharedItems.length > 0) {
    const shareCount = totals.activeShareIds.length;
    const perPersonShare = shareCount > 0 ? totals.sharedTotals.total / shareCount : 0;
    lines.push(`🤝 Share (${totals.sharedItems.length} items): ${fmt(totals.sharedTotals.total)} (${fmt(perPersonShare)} / person × ${shareCount})`);
    if (includeDetails) {
      for (const item of totals.sharedItems) {
        lines.push(`   - ${item.name} (${fmt(item.price)})`);
      }
      const taxBits = [];
      if (state.charges.scEnabled) taxBits.push(`SC ${state.charges.scRate}%: ${fmt(totals.sharedTotals.sc)}`);
      if (state.charges.vatEnabled) taxBits.push(`VAT ${state.charges.vatRate}%: ${fmt(totals.sharedTotals.vat)}`);
      if (taxBits.length) lines.push(`   - ${taxBits.join(' + ')}`);
    }
    lines.push('────────────────────');
  }

  // Individual section
  for (const person of state.people) {
    const p = totals.perPerson.get(person.id);
    lines.push(`• ${person.name}: ${fmt(p.total)}`);
    if (includeDetails && (p.ownItems.length > 0 || p.sharePart > 0)) {
      for (const item of p.ownItems) {
        lines.push(`   - ${item.name} (${fmt(item.price)})`);
      }
      if (p.sharePart > 0) {
        lines.push(`   - Share portion (${fmt(p.sharePart)})`);
      }
      const taxBits = [];
      if (state.charges.scEnabled) taxBits.push(`SC ${state.charges.scRate}%: ${fmt(p.sc)}`);
      if (state.charges.vatEnabled) taxBits.push(`VAT ${state.charges.vatRate}%: ${fmt(p.vat)}`);
      if (taxBits.length) lines.push(`   - ${taxBits.join(' + ')}`);
    }
  }

  const unassigned = state.items.filter((i) => i.assignedTo === null);
  if (unassigned.length > 0) {
    const unassignedSub = unassigned.reduce((s, i) => s + i.price, 0);
    lines.push('');
    lines.push(`⚠️ Unassigned (${unassigned.length} items): ${fmt(unassignedSub)} before tax`);
  }

  lines.push('────────────────────');
  lines.push(`Subtotal: ${fmt(totals.receipt.base)}`);
  if (state.charges.scEnabled) {
    lines.push(`Service Charge (${state.charges.scRate}%): ${fmt(totals.receipt.sc)}`);
  }
  if (state.charges.vatEnabled) {
    lines.push(`VAT (${state.charges.vatRate}%): ${fmt(totals.receipt.vat)}`);
  }
  lines.push(`Grand Total: ${fmt(totals.receipt.total)}`);

  return lines.join('\n');
}

// Dialog Helpers
function openSummaryDialog() {
  els.copyConfirmMsg.textContent = '';
  els.summaryTextarea.value = generateSummaryText(els.chkSummaryDetails.checked);
  els.summaryDialog.showModal();
}

function openItemDialog(itemId = null) {
  if (itemId) {
    const item = state.items.find((i) => i.id === itemId);
    if (!item) return;
    els.itemDialogTitle.textContent = 'Edit Item';
    els.editItemId.value = item.id;
    els.editItemName.value = item.name;
    els.editItemPrice.value = item.price.toFixed(2);
    els.editItemQtyWrap.hidden = true;
    els.btnDeleteItem.hidden = false;
  } else {
    els.itemDialogTitle.textContent = 'Add Item';
    els.editItemId.value = '';
    els.editItemName.value = '';
    els.editItemPrice.value = '';
    els.editItemQty.value = '1';
    els.editItemQtyWrap.hidden = false;
    els.btnDeleteItem.hidden = true;
  }
  els.itemDialog.showModal();
  els.editItemName.focus();
}

function openAssignDialog(itemId) {
  const item = state.items.find((i) => i.id === itemId);
  if (!item) return;

  els.assignItemPreview.innerHTML = `<span>${escapeHtml(item.name)}</span><span>${fmt(item.price)}</span>`;

  const targets = [
    { id: 'shared', label: 'Share (Split evenly)', color: '#6366f1' },
    ...state.people.map((p) => ({ id: p.id, label: p.name, color: p.color })),
    ...(item.assignedTo !== null ? [{ id: '__unassign__', label: 'Move back to Unassigned', color: '#94a3b8' }] : [])
  ];

  els.assignTargetsList.innerHTML = targets.map((t) => {
    const isCurrent = item.assignedTo === t.id;
    return `
      <button type="button" class="assign-target-btn ${isCurrent ? 'is-current' : ''}" data-assign-target="${t.id}" data-assign-item="${item.id}">
        <span class="assign-target-left">
          <span class="assign-dot" style="background: ${t.color}"></span>
          <span>${escapeHtml(t.label)}</span>
        </span>
        <span>${isCurrent ? 'Selected' : 'Assign'}</span>
      </button>
    `;
  }).join('');

  els.assignDialog.showModal();
}

// Event Listeners
function bindEvents() {
  // File upload & dropzone
  els.receiptFileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleReceiptFile(file);
    e.target.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    els.uploadDropzone.addEventListener(evt, (e) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        els.uploadDropzone.classList.add('file-drag-over');
      }
    });
  });

  ['dragleave', 'drop'].forEach((evt) => {
    els.uploadDropzone.addEventListener(evt, () => {
      els.uploadDropzone.classList.remove('file-drag-over');
    });
  });

  els.uploadDropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      e.preventDefault();
      handleReceiptFile(file);
    }
  });

  // Header & hero buttons
  els.btnOpenPasteAi.addEventListener('click', () => openPasteAiDialog());
  els.btnHeroPasteAi.addEventListener('click', () => openPasteAiDialog());

  els.btnCopyAiPrompt.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(RECEIPT_OCR_PROMPT);
      els.copyPromptStatus.textContent = 'Prompt copied! Paste it with your receipt photo in Gemini web.';
    } catch {
      els.copyPromptStatus.textContent = 'Could not copy automatically — please allow clipboard access.';
    }
  });

  els.btnImportAiJson.addEventListener('click', () => {
    els.pasteAiError.textContent = '';
    try {
      const parsed = normalizeParsedReceiptJson(els.pasteAiTextarea.value, 'Gemini Web JSON');
      els.pasteAiDialog.close();
      els.pasteAiTextarea.value = '';
      applyReceiptData(parsed);
    } catch (err) {
      els.pasteAiError.textContent = err.message;
    }
  });

  els.btnPreviewReceipt.addEventListener('click', () => els.previewDialog.showModal());
  els.btnRescanReceipt.addEventListener('click', rescanCurrentReceipt);
  els.btnFooterSummary.addEventListener('click', openSummaryDialog);

  // Verification badge & dialog buttons
  els.verifyStatusBadge.addEventListener('click', openVerifyDialog);
  els.btnVerifyViewReceipt.addEventListener('click', () => {
    els.verifyDialog.close();
    els.previewDialog.showModal();
  });
  els.btnVerifyAddItem.addEventListener('click', () => {
    els.verifyDialog.close();
    openItemDialog(null);
  });

  // Tax & Service Charge controls
  els.toggleServiceCharge.addEventListener('change', () => {
    state.charges.scEnabled = els.toggleServiceCharge.checked;
    state.charges.scAuto = false;
    syncChargeControlsUI();
    renderAll();
  });

  els.inputServiceChargeRate.addEventListener('input', () => {
    state.charges.scRate = Math.max(0, parseFloat(els.inputServiceChargeRate.value) || 0);
    state.charges.scAuto = false;
    els.badgeScAuto.hidden = true;
    renderAll();
  });

  els.toggleVat.addEventListener('change', () => {
    state.charges.vatEnabled = els.toggleVat.checked;
    state.charges.vatAuto = false;
    syncChargeControlsUI();
    renderAll();
  });

  els.inputVatRate.addEventListener('input', () => {
    state.charges.vatRate = Math.max(0, parseFloat(els.inputVatRate.value) || 0);
    state.charges.vatAuto = false;
    els.badgeVatAuto.hidden = true;
    renderAll();
  });

  els.toggleVatOnSc.addEventListener('change', () => {
    state.charges.vatOnSc = els.toggleVatOnSc.checked;
    renderAll();
  });

  // Filters & search
  document.querySelectorAll('.filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.filter = tab.dataset.filter;
      document.querySelectorAll('.filter-tab').forEach((t) => {
        const active = t === tab;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', String(active));
      });
      renderItemsGrid();
    });
  });

  els.searchItems.addEventListener('input', () => {
    state.searchQuery = els.searchItems.value;
    renderItemsGrid();
  });

  els.btnAddItem.addEventListener('click', () => openItemDialog(null));
  els.btnResetAssignments.addEventListener('click', () => {
    if (state.items.every((i) => i.assignedTo === null)) return;
    for (const item of state.items) item.assignedTo = null;
    renderAll();
    showToast('All items moved back to unassigned');
  });

  // Left items grid click (assign / edit / tap-to-assign)
  els.itemsGrid.addEventListener('click', (e) => {
    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
      e.stopPropagation();
      const { action, itemId } = actionBtn.dataset;
      if (action === 'edit') openItemDialog(itemId);
      if (action === 'assign') openAssignDialog(itemId);
      return;
    }

    const card = e.target.closest('.item-card');
    if (card) {
      if (Date.now() < suppressClickUntil) return;
      openAssignDialog(card.dataset.itemId);
    }
  });

  els.itemsGrid.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const card = e.target.closest('.item-card');
      if (card && e.target === card) {
        e.preventDefault();
        openAssignDialog(card.dataset.itemId);
      }
    }
  });

  // Drag & Drop (Desktop HTML5)
  let suppressClickUntil = 0;

  document.addEventListener('dragstart', (e) => {
    const draggable = e.target.closest('[draggable="true"][data-item-id]');
    if (!draggable) return;
    state.draggedItemId = draggable.dataset.itemId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', state.draggedItemId);
    draggable.classList.add('dragging');
    document.body.classList.add('is-dragging-item');
  });

  document.addEventListener('dragend', (e) => {
    const draggable = e.target.closest('[draggable="true"][data-item-id]');
    if (draggable) draggable.classList.remove('dragging');
    state.draggedItemId = null;
    document.body.classList.remove('is-dragging-item');
    document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    els.itemsDropArea.classList.remove('drag-over-unassign');
  });

  // Drop onto any Basket (Share or Individual)
  document.querySelector('.pane-right').addEventListener('dragover', (e) => {
    const basket = e.target.closest('.basket-card[data-basket-id]');
    if (!basket || !state.draggedItemId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.basket-card.drag-over').forEach((b) => {
      if (b !== basket) b.classList.remove('drag-over');
    });
    basket.classList.add('drag-over');
  });

  document.querySelector('.pane-right').addEventListener('dragleave', (e) => {
    const basket = e.target.closest('.basket-card[data-basket-id]');
    if (basket && !basket.contains(e.relatedTarget)) {
      basket.classList.remove('drag-over');
    }
  });

  document.querySelector('.pane-right').addEventListener('drop', (e) => {
    const basket = e.target.closest('.basket-card[data-basket-id]');
    if (!basket) return;
    e.preventDefault();
    basket.classList.remove('drag-over');
    document.body.classList.remove('is-dragging-item');
    const itemId = state.draggedItemId || e.dataTransfer.getData('text/plain');
    state.draggedItemId = null;
    if (itemId) {
      assignItem(itemId, basket.dataset.basketId);
    }
  });

  // Drop back onto Left Items Area to unassign
  els.itemsDropArea.addEventListener('dragover', (e) => {
    if (!state.draggedItemId) return;
    const item = state.items.find((i) => i.id === state.draggedItemId);
    if (item && item.assignedTo !== null) {
      e.preventDefault();
      els.itemsDropArea.classList.add('drag-over-unassign');
    }
  });

  els.itemsDropArea.addEventListener('dragleave', (e) => {
    if (!els.itemsDropArea.contains(e.relatedTarget)) {
      els.itemsDropArea.classList.remove('drag-over-unassign');
    }
  });

  els.itemsDropArea.addEventListener('drop', (e) => {
    if (!state.draggedItemId) return;
    e.preventDefault();
    els.itemsDropArea.classList.remove('drag-over-unassign');
    document.body.classList.remove('is-dragging-item');
    const itemId = state.draggedItemId;
    state.draggedItemId = null;
    assignItem(itemId, null);
  });

  // Mobile Touch Drag & Drop (instant via 6-dot grip, or 180ms hold anywhere on card)
  let touchDrag = null;

  const cleanupTouchDrag = () => {
    if (!touchDrag) return;
    clearTimeout(touchDrag.holdTimer);
    if (touchDrag.ghost) touchDrag.ghost.remove();
    if (touchDrag.card) touchDrag.card.classList.remove('dragging');
    document.querySelectorAll('.basket-card.drag-over').forEach((b) => b.classList.remove('drag-over'));
    document.body.classList.remove('is-dragging-item');
    touchDrag = null;
  };

  const activateTouchDrag = (td, x, y) => {
    if (td.active) return;
    const item = state.items.find((i) => i.id === td.itemId);
    if (!item) return;
    td.active = true;
    td.card.classList.add('dragging');
    document.body.classList.add('is-dragging-item');
    navigator.vibrate?.(12);

    const ghost = document.createElement('div');
    ghost.className = 'touch-drag-ghost';
    ghost.innerHTML = `<span class="touch-drag-ghost-name">${escapeHtml(item.name)}</span><span class="touch-drag-ghost-price">${fmt(item.price)}</span>`;
    ghost.style.left = `${x}px`;
    ghost.style.top = `${y}px`;
    document.body.appendChild(ghost);
    td.ghost = ghost;
  };

  els.itemsGrid.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    if (e.target.closest('button')) return;
    const card = e.target.closest('.item-card[data-item-id]');
    if (!card) return;

    const touch = e.touches[0];
    const fromGrip = Boolean(e.target.closest('.item-grip'));
    const td = {
      itemId: card.dataset.itemId,
      card,
      startX: touch.clientX,
      startY: touch.clientY,
      fromGrip,
      active: false,
      ghost: null,
      hoveredBasket: null,
      holdTimer: null
    };
    touchDrag = td;

    if (fromGrip) {
      activateTouchDrag(td, touch.clientX, touch.clientY);
    } else {
      td.holdTimer = setTimeout(() => {
        if (touchDrag === td) {
          activateTouchDrag(td, td.startX, td.startY);
        }
      }, 180);
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!touchDrag || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchDrag.startX;
    const dy = touch.clientY - touchDrag.startY;

    if (!touchDrag.active) {
      if (Math.hypot(dx, dy) > 10) {
        // User is scrolling the page — cancel hold timer
        clearTimeout(touchDrag.holdTimer);
        touchDrag = null;
      }
      return;
    }

    e.preventDefault();
    touchDrag.ghost.style.left = `${touch.clientX}px`;
    touchDrag.ghost.style.top = `${touch.clientY}px`;

    const elUnder = document.elementFromPoint(touch.clientX, touch.clientY);
    const basket = elUnder ? elUnder.closest('.basket-card[data-basket-id]') : null;

    if (touchDrag.hoveredBasket && touchDrag.hoveredBasket !== basket) {
      touchDrag.hoveredBasket.classList.remove('drag-over');
    }
    if (basket) {
      basket.classList.add('drag-over');
    }
    touchDrag.hoveredBasket = basket;
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (!touchDrag) return;
    const td = touchDrag;
    if (td.active) {
      suppressClickUntil = Date.now() + 350;
      const targetBasketId = td.hoveredBasket?.dataset.basketId || null;
      cleanupTouchDrag();
      if (targetBasketId) {
        assignItem(td.itemId, targetBasketId);
      }
    } else {
      cleanupTouchDrag();
    }
  });

  document.addEventListener('touchcancel', cleanupTouchDrag);

  // Right pane interactions (inspect basket items, toggle share participant, edit name/color)
  document.querySelector('.pane-right').addEventListener('click', (e) => {
    const inspectBtn = e.target.closest('[data-inspect-basket]');
    if (inspectBtn) {
      openBasketDetailDialog(inspectBtn.dataset.inspectBasket);
      return;
    }

    const shareChip = e.target.closest('[data-share-person]');
    if (shareChip) {
      const pid = shareChip.dataset.sharePerson;
      if (state.shareParticipants.has(pid)) {
        state.shareParticipants.delete(pid);
      } else {
        state.shareParticipants.add(pid);
      }
      renderAll();
      return;
    }

    // Clicking anywhere else on a Share or Individual card opens its assigned items list
    if (e.target.closest('input, label, button')) return;
    const basketCard = e.target.closest('.basket-card[data-basket-id]');
    if (basketCard) {
      openBasketDetailDialog(basketCard.dataset.basketId);
    }
  });

  // Basket Detail Dialog remove item
  els.basketDetailList.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-unassign-id]');
    if (removeBtn) {
      assignItem(removeBtn.dataset.unassignId, null);
    }
  });

  els.basketDetailDialog.addEventListener('close', () => {
    state.inspectingBasketId = null;
  });

  // Auto-select all text when clicking/focusing a person's name input for 1-click rename
  document.querySelector('.pane-right').addEventListener('focusin', (e) => {
    const nameInput = e.target.closest('[data-person-name]');
    if (nameInput) {
      nameInput.select();
    }
  });

  document.querySelector('.pane-right').addEventListener('mouseup', (e) => {
    const nameInput = e.target.closest('[data-person-name]');
    if (nameInput && document.activeElement === nameInput) {
      // Keep full selection intact on the initial mouseup after focus
      if (nameInput.selectionStart === 0 && nameInput.selectionEnd === nameInput.value.length) {
        e.preventDefault();
      }
    }
  });

  document.querySelector('.pane-right').addEventListener('keydown', (e) => {
    const nameInput = e.target.closest('[data-person-name]');
    if (nameInput && e.key === 'Enter') {
      nameInput.blur();
    }
  });

  document.querySelector('.pane-right').addEventListener('input', (e) => {
    const nameInput = e.target.closest('[data-person-name]');
    if (nameInput) {
      const person = state.people.find((p) => p.id === nameInput.dataset.personName);
      if (person) {
        person.name = nameInput.value || 'Unnamed';
        const totals = computeTotals();
        renderShareBasket(totals);
        renderItemsGrid();
      }
      return;
    }

    const colorInput = e.target.closest('[data-person-color]');
    if (colorInput) {
      const person = state.people.find((p) => p.id === colorInput.dataset.personColor);
      if (person) {
        person.color = colorInput.value;
        const basket = colorInput.closest('.person-basket');
        if (basket) basket.style.setProperty('--basket-color', person.color);
        const totals = computeTotals();
        renderShareBasket(totals);
        renderItemsGrid();
      }
    }
  });

  // People count stepper
  els.btnAddPerson.addEventListener('click', () => {
    initPeople(state.people.length + 1);
    renderAll();
  });

  els.btnRemovePerson.addEventListener('click', () => {
    if (state.people.length <= 1) return;
    initPeople(state.people.length - 1);
    renderAll();
  });

  // Summary Dialog
  els.chkSummaryDetails.addEventListener('change', () => {
    els.summaryTextarea.value = generateSummaryText(els.chkSummaryDetails.checked);
  });

  els.btnCopySummary.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(els.summaryTextarea.value);
      els.copyConfirmMsg.textContent = 'Copied to clipboard!';
      showToast('Summary copied — ready to paste!');
    } catch {
      els.summaryTextarea.select();
      document.execCommand('copy');
      els.copyConfirmMsg.textContent = 'Copied!';
    }
  });

  // Add / Edit Item Dialog
  els.btnCancelItem.addEventListener('click', () => els.itemDialog.close());

  els.btnDeleteItem.addEventListener('click', () => {
    const id = els.editItemId.value;
    if (!id) return;
    state.items = state.items.filter((i) => i.id !== id);
    els.itemDialog.close();
    renderAll();
    showToast('Item deleted');
  });

  els.itemForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = els.editItemId.value;
    const name = normalizeThaiText(els.editItemName.value.trim());
    const price = Math.max(0, parseFloat(els.editItemPrice.value) || 0);

    if (!name) return;

    if (id) {
      const item = state.items.find((i) => i.id === id);
      if (item) {
        item.name = name;
        item.price = price;
      }
      showToast('Item updated');
    } else {
      const qty = Math.max(1, parseInt(els.editItemQty.value, 10) || 1);
      const added = expandReceiptItems([{ name, qty, lineTotal: price * qty }], 'manual');
      state.items.push(...added);
      showToast(qty > 1 ? `Added ${qty} individual items` : 'Item added');
    }

    els.itemDialog.close();
    renderAll();
  });

  // Quick Assign Dialog
  els.assignTargetsList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-assign-target]');
    if (!btn) return;
    const itemId = btn.dataset.assignItem;
    const target = btn.dataset.assignTarget === '__unassign__' ? null : btn.dataset.assignTarget;
    assignItem(itemId, target);
    els.assignDialog.close();
  });
}

// Boot
initPeople(4);
syncChargeControlsUI();
bindEvents();
renderAll();
