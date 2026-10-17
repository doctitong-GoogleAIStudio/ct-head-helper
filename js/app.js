import { WINDOWS, loadFiles, renderSlice, sliceStats, buildMontages, sliceToDataUrl } from './imaging.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- storage (best effort; the app works without it) ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

// The SDK loads lazily so the viewer works offline and before a key is set.
let aiModule = null;
async function ai() {
  if (!aiModule) aiModule = await import('./ai.js');
  return aiModule;
}
const MODEL_OPTIONS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (most accurate)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster, cheaper)' },
];

const state = {
  study: null,
  seriesIndex: 0,
  sliceIndex: 0,
  windowKey: 'brain',
  messages: null,
  report: null,
  abort: null,
  busy: false,
};

const settings = {
  get apiKey() { return store.get('ct.apiKey', ''); },
  get model() { return store.get('ct.model', MODEL_OPTIONS[0].id); },
  get maxSlices() { return store.get('ct.maxSlices', 192); },
};

// ---------- loading ----------
async function handleFiles(fileList) {
  const files = [...fileList].filter((f) => !/^(DICOMDIR|\.DS_Store|thumbs\.db)$/i.test(f.name));
  if (!files.length) return;
  $('loadStatus').textContent = `Reading ${files.length} file(s)…`;
  const study = await loadFiles(files, (done, total) => {
    if (done % 10 === 0 || done === total) $('loadStatus').textContent = `Reading files… ${done}/${total}`;
  });

  const skipped = $('skippedList');
  skipped.innerHTML = study.skipped.slice(0, 50).map((s) => `<li>${esc(s.name)}: ${esc(s.reason)}</li>`).join('');
  if (study.skipped.length > 50) skipped.innerHTML += `<li>…and ${study.skipped.length - 50} more</li>`;
  skipped.hidden = !study.skipped.length;

  if (!study.series.length) {
    $('loadStatus').textContent = 'No readable images found.';
    return;
  }
  const sliceCount = study.series.reduce((n, s) => n + s.slices.length, 0);
  $('loadStatus').textContent = `Loaded ${sliceCount} slice(s) in ${study.series.length} series.` +
    (study.skipped.length ? ` ${study.skipped.length} file(s) skipped.` : '');

  state.study = study;
  state.seriesIndex = 0;
  state.sliceIndex = Math.floor(study.series[0].slices.length / 2);
  state.windowKey = 'brain';
  state.messages = null;
  state.report = null;
  $('reportCard').hidden = true;
  $('errorBox').hidden = true;
  $('viewerCard').hidden = false;
  $('analyzeCard').hidden = false;
  renderTabs();
  renderViewer();
  updateSendSummary();
}

// Recursively collects files from dropped folders.
async function filesFromDrop(dt) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

// ---------- viewer ----------
function currentSeries() { return state.study?.series[state.seriesIndex]; }

function renderTabs() {
  $('seriesTabs').innerHTML = state.study.series.map((s, i) =>
    `<button class="tab" role="tab" aria-selected="${i === state.seriesIndex}" data-i="${i}">${esc(s.description)}<span class="count">${s.slices.length}</span></button>`
  ).join('');
}

function renderViewer() {
  const s = currentSeries();
  if (!s) return;
  const slice = s.slices[state.sliceIndex];
  renderSlice(slice, state.windowKey, $('viewCanvas'));
  const slider = $('sliceSlider');
  slider.max = s.slices.length;
  slider.value = state.sliceIndex + 1;
  slider.hidden = s.slices.length < 2;
  $('sliceLabel').textContent = `#${state.sliceIndex + 1} / ${s.slices.length}` +
    (s.kind === 'dicom' ? ` · ${WINDOWS[state.windowKey].label} W${WINDOWS[state.windowKey].width}/L${WINDOWS[state.windowKey].center}` : '');

  const isImage = s.kind === 'image';
  $('windowButtons').innerHTML = Object.entries(WINDOWS).map(([k, w]) =>
    `<button data-w="${k}" aria-pressed="${k === state.windowKey}" ${isImage ? 'disabled title="Windowing needs DICOM data"' : ''}>${w.label}</button>`
  ).join('');
  renderPrepLog(s, slice);
}

function renderPrepLog(series, slice) {
  const items = [];
  if (series.kind === 'dicom') {
    const m = slice.meta;
    const st = sliceStats(slice);
    items.push(`<b>Decode</b>: ${series.slices.length} slice(s), ${slice.cols}×${slice.rows} px, transfer syntax ${esc(m.transferSyntax)}${series.thickness ? `, ${series.thickness} mm` : ''}.`);
    items.push(`<b>Order</b>: sorted along the slice normal (ImagePositionPatient), falling back to InstanceNumber.`);
    if (st) {
      items.push(`<b>HU rescale</b> (slope/intercept): this slice ranges ${Math.round(st.min)} to ${Math.round(st.max)} HU.`);
      items.push(`<b>Normalization stats</b> (tissue &gt; −200 HU): mean ${st.mean.toFixed(1)} HU, SD ${st.sd.toFixed(1)} HU.`);
    }
    items.push(`<b>Windowing</b>: brain W80/L40${$('extraWindows').checked ? ', subdural W215/L75 and bone W2800/L600 (primary series)' : ''}, clipped to 0–255.`);
  } else {
    items.push(`<b>Decode</b>: ${series.slices.length} image(s); this one ${slice.cols}×${slice.rows} px. Windowing is fixed by the source image.`);
  }
  items.push(`<b>Resize</b>: each slice fitted to a 256×256 tile, aspect ratio kept.`);
  items.push(`<b>Montage</b>: 4×4 tiles per image, each labelled #N so findings can cite slices.`);
  items.push(`<b>Inference</b>: Claude vision reviews every montage and returns a structured report.`);
  $('prepLog').innerHTML = items.map((t) => `<li>${t}</li>`).join('');
}

// ---------- payload ----------
const BYTES_LIMIT = 24 * 1024 * 1024;
const IMAGE_LIMIT = 90;

function primarySeriesIndex(series) {
  let best = -1, most = 0;
  series.forEach((s, i) => { if (s.kind === 'dicom' && s.slices.length > most) { most = s.slices.length; best = i; } });
  return best;
}

function buildPayload() {
  const series = state.study.series;
  const extra = $('extraWindows').checked;
  const maxImages = Math.max(1, Math.ceil(settings.maxSlices / 16));
  const primary = primarySeriesIndex(series);
  const out = { series: [], images: [] };

  series.forEach((s, i) => {
    const info = { description: s.description, kind: s.kind, modality: s.modality, thickness: s.thickness, total: s.slices.length, windows: [] };
    if (s.kind === 'image' && s.slices.length <= 12) {
      s.slices.forEach((slice, k) => out.images.push({
        caption: `Uploaded image ${k + 1} of ${s.slices.length} ("${slice.name}"):`,
        dataUrl: sliceToDataUrl(slice, 'brain'),
      }));
      Object.assign(info, { covered: s.slices.length, sampled: false, windows: ['as uploaded'] });
    } else {
      const windows = s.kind === 'image' ? ['brain'] : (extra && i === primary ? ['brain', 'subdural', 'bone'] : ['brain']);
      for (const w of windows) {
        const r = buildMontages(s, w, { maxImages });
        r.montages.forEach((m) => out.images.push({
          caption: `Series "${s.description}" · ${s.kind === 'image' ? 'uploaded images' : `${WINDOWS[w].label} window (W${WINDOWS[w].width}/L${WINDOWS[w].center})`} · slices #${m.from}–#${m.to} of ${s.slices.length}:`,
          dataUrl: m.dataUrl,
        }));
        Object.assign(info, { covered: r.covered, sampled: r.sampled });
      }
      info.windows = s.kind === 'image' ? ['as uploaded'] : windows.map((w) => WINDOWS[w].label.toLowerCase());
    }
    out.series.push(info);
  });

  out.bytes = out.images.reduce((n, img) => n + img.dataUrl.length, 0);
  return out;
}

function estimateSend() {
  const series = state.study.series;
  const extra = $('extraWindows').checked;
  const maxImages = Math.max(1, Math.ceil(settings.maxSlices / 16));
  const primary = primarySeriesIndex(series);
  let images = 0, slices = 0, total = 0;
  series.forEach((s, i) => {
    total += s.slices.length;
    if (s.kind === 'image' && s.slices.length <= 12) { images += s.slices.length; slices += s.slices.length; return; }
    const covered = Math.min(s.slices.length, maxImages * 16);
    const per = Math.ceil(covered / 16);
    const windows = s.kind === 'dicom' && extra && i === primary ? 3 : 1;
    images += per * windows;
    slices += covered;
  });
  return { images, slices, total };
}

function updateSendSummary() {
  if (!state.study) return;
  const e = estimateSend();
  const tokens = e.images * 1400;
  $('sendSummary').textContent =
    `Will send ${e.images} image(s) covering ${e.slices} of ${e.total} slice(s) across ${state.study.series.length} series ` +
    `(≈${Math.round(tokens / 1000)}k input tokens).` + (e.slices < e.total ? ' Long series are evenly sampled; raise the limit in Settings to send more.' : '');
}

// ---------- interpretation ----------
function setBusy(busy, text) {
  state.busy = busy;
  $('analyzeBtn').disabled = busy;
  $('cancelBtn').hidden = !busy;
  $('progress').hidden = !busy;
  if (text) $('progressText').textContent = text;
  $('chatForm').querySelector('button').disabled = busy;
}

function showError(err) {
  const box = $('errorBox');
  let msg = err?.message || String(err);
  if (err?.name === 'AbortError' || /abort/i.test(msg)) msg = 'Cancelled.';
  else if (err?.status === 401) msg = 'The API key was rejected (401). Check it in Settings.';
  else if (err?.status === 429) msg = 'Rate limited by the API (429). Wait a moment and try again.';
  else if (err?.status === 413) msg = 'Request too large. Lower "Max slices sent per series" in Settings.';
  else if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) msg = 'Network error: you need to be online to interpret, and the API must be reachable.';
  box.textContent = msg;
  box.hidden = false;
}

function progressText(p) {
  if (p.phase === 'thinking') return 'Reviewing all slices…';
  if (p.phase === 'writing') return `Writing report… (${p.chars} chars)`;
  return 'Working…';
}

async function analyze() {
  if (state.busy || !state.study) return;
  if (!settings.apiKey) { openSettings(); return; }
  $('errorBox').hidden = true;
  setBusy(true, 'Preparing images…');
  await new Promise((r) => setTimeout(r, 20)); // let the spinner paint

  try {
    const payload = buildPayload();
    if (payload.images.length > IMAGE_LIMIT || payload.bytes > BYTES_LIMIT) {
      throw new Error(`Too much image data (${payload.images.length} images, ${(payload.bytes / 1048576).toFixed(1)} MB). Lower "Max slices sent per series" in Settings or untick extra windows.`);
    }
    setBusy(true, `Sending ${payload.images.length} image(s)…`);
    const { buildStudyContent, interpret } = await ai();
    const content = buildStudyContent(payload, { history: $('history').value, cnnCompare: $('cnnCompare').checked });
    state.abort = new AbortController();
    const { report, messages, usage } = await interpret({
      apiKey: settings.apiKey,
      model: settings.model,
      content,
      signal: state.abort.signal,
      onProgress: (p) => { $('progressText').textContent = progressText(p); },
    });
    state.report = report;
    state.messages = messages;
    $('chatLog').innerHTML = '';
    renderReport(report, usage, payload);
    saveHistory(report);
  } catch (err) {
    console.error(err);
    showError(err);
  } finally {
    state.abort = null;
    setBusy(false);
  }
}

const POSITIVE = new Set(['Detected', 'Acute', 'Chronic', 'Present', 'Suggestive', 'Hydrocephalus']);
const NEGATIVE = new Set(['Not Detected', 'Absent', 'Normal']);
const chipClass = (status) => POSITIVE.has(status) ? 'pos' : NEGATIVE.has(status) ? 'neg' : 'ind';

const FINDINGS = [
  ['hemorrhage', 'Hemorrhage'],
  ['infarct', 'Infarct'],
  ['edema_midline_shift', 'Edema / Midline Shift'],
  ['mass_lesion', 'Mass Lesion'],
  ['ventricular_system', 'Ventricular System'],
];

function renderReport(r, usage, payload) {
  const urgencyText = { critical: 'Critical finding: communicate immediately', urgent: 'Urgent: prompt clinical review', routine: 'No critical finding flagged' }[r.urgency] || r.urgency;
  const sent = payload ? `${payload.images.length} image(s), ${payload.series.reduce((n, s) => n + s.covered, 0)} slice(s)` : '';
  let html = `
    <div class="urgency ${esc(r.urgency)}">${esc(urgencyText)}</div>
    <p class="muted small-text">${esc(r.study_assessment)}</p>
    <p class="section-title">🧠 AI Interpretation</p>
    <ul class="findings">
      ${FINDINGS.map(([k, label]) => `
        <li class="finding">
          <span class="name">${label}</span>
          <span class="chip ${chipClass(r[k].status)}">${esc(r[k].status)}</span>
          ${r[k].details ? `<span class="detail">${esc(r[k].details)}</span>` : ''}
        </li>`).join('')}
    </ul>`;
  if (r.other_findings?.length) {
    html += `<p class="section-title">Other findings</p><ul class="other">${r.other_findings.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`;
  }
  html += `
    <p class="section-title">🩺 Impression</p>
    <div class="impression">
      <p>${esc(r.impression)}</p>
      ${r.clinical_advice ? `<p><strong>Advice:</strong> ${esc(r.clinical_advice)}</p>` : ''}
    </div>`;
  if (r.cnn_emulation?.length) {
    html += `<p class="section-title">Simulated CNN comparison</p>
      <p class="sim-note">Illustrative only: generated by Claude to show how these architectures typically behave. No CNN was run.</p>
      <div class="cnn">${r.cnn_emulation.map((m) => `
        <div class="cnn-card">
          <h4>${esc(m.architecture)}</h4>
          <div>Top: <strong>${esc(m.top_prediction)}</strong></div>
          ${(m.scores || []).map((s) => {
            const p = Math.max(0, Math.min(1, Number(s.probability) || 0));
            return `<div class="bar"><span>${esc(s.label)}</span><span class="track"><span class="fill" style="width:${(p * 100).toFixed(0)}%"></span></span><span class="val">${p.toFixed(2)}</span></div>`;
          }).join('')}
          <div class="muted">${esc(m.behaviour_note)}</div>
        </div>`).join('')}</div>`;
  }
  html += `<p class="meta-line">Confidence: ${esc(r.confidence)} · ${esc(settings.model)}${sent ? ` · ${sent}` : ''}${usage ? ` · ${usage.input_tokens + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)} in / ${usage.output_tokens} out tokens` : ''}</p>`;
  $('reportBody').innerHTML = html;
  $('reportCard').hidden = false;
  $('chatForm').hidden = !state.messages;
  $('reportCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function reportToText(r) {
  const lines = ['🧠 AI Interpretation:'];
  for (const [k, label] of FINDINGS) {
    lines.push(`- ${label}: ${r[k].status}${r[k].details ? ` (${r[k].details})` : ''}`);
  }
  if (r.other_findings?.length) {
    lines.push('', 'Other findings:', ...r.other_findings.map((f) => `- ${f}`));
  }
  lines.push('', '🩺 Impression:', r.impression);
  if (r.clinical_advice) lines.push(`Advice: ${r.clinical_advice}`);
  if (r.cnn_emulation?.length) {
    lines.push('', 'Simulated CNN comparison (illustrative, no CNN was run):');
    for (const m of r.cnn_emulation) lines.push(`- ${m.architecture}: ${m.top_prediction}. ${m.behaviour_note}`);
  }
  lines.push('', `Confidence: ${r.confidence}. AI decision support only; verify against the images and a radiologist's report.`);
  return lines.join('\n');
}

// ---------- follow-up chat ----------
function miniMarkdown(text) {
  const blocks = esc(text).split(/\n{2,}/);
  return blocks.map((b) => {
    const fmt = (s) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const lines = b.split('\n');
    if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
      return `<ul>${lines.map((l) => `<li>${fmt(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''))}</li>`).join('')}</ul>`;
    }
    if (/^#{1,4}\s/.test(b)) return `<p><strong>${fmt(b.replace(/^#{1,4}\s/, ''))}</strong></p>`;
    return `<p>${fmt(b).replace(/\n/g, '<br>')}</p>`;
  }).join('');
}

async function ask(question) {
  if (state.busy || !state.messages) return;
  const log = $('chatLog');
  log.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(question)}</div>`);
  setBusy(true, 'Thinking about your question…');
  $('errorBox').hidden = true;
  try {
    const { followUp } = await ai();
    state.abort = new AbortController();
    const { answer, messages } = await followUp({
      apiKey: settings.apiKey,
      model: settings.model,
      messages: state.messages,
      question,
      signal: state.abort.signal,
      onProgress: (p) => { $('progressText').textContent = progressText(p); },
    });
    state.messages = messages;
    log.insertAdjacentHTML('beforeend', `<div class="msg ai">${miniMarkdown(answer)}</div>`);
  } catch (err) {
    console.error(err);
    log.lastElementChild?.remove();
    showError(err);
    $('analyzeCard').scrollIntoView({ behavior: 'smooth' });
  } finally {
    state.abort = null;
    setBusy(false);
  }
}

// ---------- history ----------
function saveHistory(report) {
  const list = store.get('ct.history', []);
  list.unshift({ at: new Date().toISOString(), history: $('history').value.trim(), report });
  store.set('ct.history', list.slice(0, 25));
}

function renderHistory() {
  const list = store.get('ct.history', []);
  $('historyList').innerHTML = list.length ? list.map((h, i) => `
    <li>
      <div class="row"><strong>${esc(new Date(h.at).toLocaleString())}</strong><span class="chip ${h.report.urgency === 'critical' ? 'pos' : h.report.urgency === 'urgent' ? 'ind' : 'neg'}">${esc(h.report.urgency)}</span></div>
      <div>${esc(h.report.impression)}</div>
      ${h.history ? `<div class="muted small-text">${esc(h.history)}</div>` : ''}
      <div class="row tight"><button class="btn ghost small" data-open-h="${i}">Open</button><button class="btn ghost small" data-del-h="${i}">Delete</button></div>
    </li>`).join('') : '<li class="muted">No saved reports yet.</li>';
}

// ---------- settings ----------
function openSettings() {
  $('modelSelect').innerHTML = MODEL_OPTIONS.map((m) => `<option value="${m.id}" ${m.id === settings.model ? 'selected' : ''}>${m.label}</option>`).join('');
  $('apiKey').value = settings.apiKey;
  $('maxSlices').value = String(settings.maxSlices);
  $('keyTest').textContent = '';
  $('settingsDialog').showModal();
}

function refreshKeyBanner() { $('keyBanner').hidden = !!settings.apiKey; }

// ---------- wiring ----------
function init() {
  for (const id of ['fileInput', 'folderInput', 'cameraInput']) {
    $(id).addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
  }
  const dz = $('dropZone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', async (e) => {
    e.preventDefault();
    dz.classList.remove('over');
    handleFiles(await filesFromDrop(e.dataTransfer));
  });
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } });

  $('seriesTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    state.seriesIndex = Number(b.dataset.i);
    state.sliceIndex = Math.floor(currentSeries().slices.length / 2);
    if (currentSeries().kind === 'image') state.windowKey = 'brain';
    renderTabs();
    renderViewer();
  });
  $('windowButtons').addEventListener('click', (e) => {
    const b = e.target.closest('[data-w]');
    if (!b || b.disabled) return;
    state.windowKey = b.dataset.w;
    renderViewer();
  });
  $('sliceSlider').addEventListener('input', (e) => { state.sliceIndex = Number(e.target.value) - 1; renderViewer(); });
  const step = (d) => {
    const s = currentSeries();
    if (!s) return;
    state.sliceIndex = Math.max(0, Math.min(s.slices.length - 1, state.sliceIndex + d));
    renderViewer();
  };
  document.querySelector('.canvas-wrap').addEventListener('wheel', (e) => { e.preventDefault(); step(e.deltaY > 0 ? 1 : -1); }, { passive: false });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select') || $('viewerCard').hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') step(-1);
  });

  $('clearBtn').addEventListener('click', () => {
    state.study = null; state.messages = null; state.report = null;
    for (const id of ['viewerCard', 'analyzeCard', 'reportCard', 'skippedList']) $(id).hidden = true;
    $('loadStatus').textContent = '';
  });

  $('extraWindows').addEventListener('change', () => { updateSendSummary(); renderViewer(); });
  $('analyzeBtn').addEventListener('click', analyze);
  $('cancelBtn').addEventListener('click', () => state.abort?.abort());

  $('copyBtn').addEventListener('click', async () => {
    if (!state.report) return;
    try {
      await navigator.clipboard.writeText(reportToText(state.report));
      $('copyBtn').textContent = 'Copied';
    } catch {
      $('copyBtn').textContent = 'Copy failed';
    }
    setTimeout(() => { $('copyBtn').textContent = 'Copy'; }, 1500);
  });
  $('printBtn').addEventListener('click', () => window.print());

  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('chatInput').value.trim();
    if (!q) return;
    $('chatInput').value = '';
    ask(q);
  });

  $('settingsBtn').addEventListener('click', openSettings);
  document.addEventListener('click', (e) => { if (e.target.closest('[data-open="settings"]')) openSettings(); });
  $('settingsForm').addEventListener('submit', () => {
    store.set('ct.apiKey', $('apiKey').value.trim());
    store.set('ct.model', $('modelSelect').value);
    store.set('ct.maxSlices', Number($('maxSlices').value));
    refreshKeyBanner();
    updateSendSummary();
  });
  $('testKeyBtn').addEventListener('click', async () => {
    const key = $('apiKey').value.trim();
    $('keyTest').textContent = 'Testing…';
    try {
      const { testKey } = await ai();
      await testKey(key);
      $('keyTest').textContent = 'Key works.';
    } catch (err) {
      $('keyTest').textContent = err?.status === 401 ? 'Key rejected (401).' : `Test failed: ${err.message}`;
    }
  });
  $('forgetKeyBtn').addEventListener('click', () => {
    store.remove('ct.apiKey');
    $('apiKey').value = '';
    $('keyTest').textContent = 'Key removed from this device.';
    refreshKeyBanner();
  });

  $('historyBtn').addEventListener('click', () => { renderHistory(); $('historyDialog').showModal(); });
  $('closeHistory').addEventListener('click', () => $('historyDialog').close());
  $('historyList').addEventListener('click', (e) => {
    const list = store.get('ct.history', []);
    const open = e.target.closest('[data-open-h]');
    const del = e.target.closest('[data-del-h]');
    if (open) {
      const h = list[Number(open.dataset.openH)];
      state.report = h.report;
      state.messages = null; // images are not stored, so no follow-ups on past reports
      $('chatLog').innerHTML = '<p class="muted small-text">Follow-up questions are available only for the study loaded in this session.</p>';
      renderReport(h.report, null, null);
      $('historyDialog').close();
    } else if (del) {
      list.splice(Number(del.dataset.delH), 1);
      store.set('ct.history', list);
      renderHistory();
    }
  });

  // Install prompt (Chromium) and service worker.
  let deferred = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('installBtn').hidden = false; });
  $('installBtn').addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    $('installBtn').hidden = true;
  });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
  }

  refreshKeyBanner();
}

init();
