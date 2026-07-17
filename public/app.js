// SKU Compositor — main app logic
(function () {
  'use strict';

  const DEFAULT_PROMPT = `Combine the two input product images into a single clean e-commerce image with a pure white background. Preserve the original proportions, aspect ratio, and appearance of both products. Do not stretch, squash, warp, or distort either product. Maximize the displayed size of both products while keeping them fully visible. Treat the bottom of the image as a flat shelf, with the lowest visible point of each product resting on the same horizontal line. This shared baseline is the highest-priority layout constraint and must not be broken for centering or spacing. Arrange the products to make the best use of the available space. When necessary, intelligently overlap the products in the most natural and visually balanced way, prioritizing larger product size while keeping the primary branding and product identity of both products clearly visible. Choose the amount and direction of overlap based on the shapes of the products rather than using a fixed amount. Center the overall composition horizontally. Maintain comfortable whitespace around the left, right, and top edges so the composition does not appear cramped. Do not crop either product and do not add any extra elements.`;

  const MOCK = new URLSearchParams(location.search).has('mock');

  // ---- Elements ----
  const $ = (id) => document.getElementById(id);
  const els = {
    templateCanvas: $('templateCanvas'),
    tplTitle: $('tplTitle'), tplOffer: $('tplOffer'),
    tplOfferVisible: $('tplOfferVisible'),
    tplReset: $('tplReset'), layersList: $('layersList'), inspector: $('inspector'),
    dropZone: $('dropZone'), csvInput: $('csvInput'), dropLabel: $('dropLabel'),
    settingsBlock: $('settingsBlock'), autoSummary: $('autoSummary'),
    colChecks: $('colChecks'), titleCol: $('titleCol'), offerCol: $('offerCol'),
    queueBlock: $('queueBlock'), queueList: $('queueList'), queueCount: $('queueCount'),
    prompt: $('prompt'),
    azureEndpoint: $('azureEndpoint'), azureKey: $('azureKey'), tinyKey: $('tinyKey'),
    generateBtn: $('generateBtn'),
    progressWrap: $('progressWrap'), progressBar: $('progressBar'), progressText: $('progressText'),
    tileGrid: $('tileGrid'), compressBtn: $('compressBtn'), downloadBtn: $('downloadBtn'),
    compressSummary: $('compressSummary'),
  };

  // ---- State ----
  const state = {
    headers: [],
    records: [],
    imageCols: [],
    titleCol: '',
    offerCol: '',
    items: [],          // queue items: { id, record, urls, title, offer, status, sourceImages, resultImage, canvas, compressed }
    running: false,
    template: loadTemplate(),
    selectedLayer: 'frame',
  };

  // ---- Template state ----
  function deepMerge(base, saved) {
    const out = Array.isArray(base) ? [...base] : { ...base };
    if (!saved || typeof saved !== 'object') return out;
    if (Array.isArray(base)) return Array.isArray(saved) ? [...saved] : out;
    for (const k of Object.keys(base)) {
      if (k in saved) {
        out[k] = typeof base[k] === 'object' && base[k] !== null ? deepMerge(base[k], saved[k]) : saved[k];
      }
    }
    return out;
  }

  function loadTemplate() {
    try {
      const saved = JSON.parse(localStorage.getItem('skuc_template'));
      return deepMerge(DEFAULT_TEMPLATE, saved);
    } catch { return deepMerge(DEFAULT_TEMPLATE, null); }
  }

  function saveTemplate() {
    localStorage.setItem('skuc_template', JSON.stringify(state.template));
  }

  // ---- Persistence for keys / prompt ----
  const KEYS = ['azureEndpoint', 'azureKey', 'tinyKey', 'prompt'];
  KEYS.forEach((k) => {
    const saved = localStorage.getItem('skuc_' + k);
    if (saved !== null) els[k].value = saved;
    els[k].addEventListener('input', () => localStorage.setItem('skuc_' + k, els[k].value));
  });
  if (!els.prompt.value) { els.prompt.value = DEFAULT_PROMPT; localStorage.setItem('skuc_prompt', DEFAULT_PROMPT); }
  const DEFAULT_ENDPOINT = 'https://kernel-krew-east-us-resource.services.ai.azure.com/openai/v1/images/edits';
  if (!els.azureEndpoint.value) { els.azureEndpoint.value = DEFAULT_ENDPOINT; localStorage.setItem('skuc_azureEndpoint', DEFAULT_ENDPOINT); }

  // ---- Template editor ----
  const LAYER_LABELS = { frame: 'Frame', title: 'Title', image: 'Image', offer: 'Offer bar' };

  // Property control definitions per layer: [key, label, type, extra]
  const LAYER_PROPS = {
    frame: [
      ['width', 'Width', 'number', { min: 20, max: 400 }],
      ['height', 'Height', 'number', { min: 20, max: 400 }],
      ['radius', 'Corner radius', 'number', { min: 0, max: 100 }],
      ['bg', 'Background', 'color'],
    ],
    title: [
      ['size', 'Font size', 'number', { min: 4, max: 60 }],
      ['lineHeight', 'Line height', 'number', { min: 4, max: 80 }],
      ['weight', 'Weight', 'select', { options: [['400', 'Regular'], ['500', 'Medium'], ['600', 'DemiBold'], ['700', 'Bold'], ['800', 'ExtraBold']] }],
      ['color', 'Color', 'color'],
      ['y', 'Y position', 'number', { min: -100, max: 400 }],
      ['xOffset', 'X offset', 'number', { min: -200, max: 200 }],
      ['width', 'Text width', 'number', { min: 10, max: 400 }],
      ['maxLines', 'Max lines', 'number', { min: 1, max: 6 }],
      ['align', 'Align', 'select', { options: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']] }],
    ],
    image: [
      ['width', 'Width', 'number', { min: 10, max: 400 }],
      ['height', 'Height', 'number', { min: 10, max: 400 }],
      ['xOffset', 'X offset', 'number', { min: -200, max: 200 }],
      ['bottom', 'Bottom offset', 'number', { min: -400, max: 400 }],
      ['fit', 'Fit', 'select', { options: [['cover', 'Cover (fill)'], ['contain', 'Contain (fit)']] }],
    ],
    offer: [
      ['width', 'Width', 'number', { min: 10, max: 400 }],
      ['height', 'Height', 'number', { min: 6, max: 200 }],
      ['xOffset', 'X offset', 'number', { min: -200, max: 200 }],
      ['bottom', 'Bottom offset', 'number', { min: -400, max: 400 }],
      ['radius', 'Corner radius', 'number', { min: 0, max: 100 }],
      ['pad', 'Padding', 'number', { min: 0, max: 40 }],
      ['bg', 'Background', 'color'],
      ['color', 'Text color', 'color'],
      ['size', 'Font size', 'number', { min: 4, max: 60 }],
      ['weight', 'Weight', 'select', { options: [['400', 'Regular'], ['500', 'Medium'], ['600', 'DemiBold'], ['700', 'Bold'], ['800', 'ExtraBold']] }],
    ],
  };

  function renderTemplate() {
    const tpl = state.template;
    renderTile(els.templateCanvas, {
      title: els.tplTitle.value,
      offerText: els.tplOffer.value,
      offerVisible: els.tplOfferVisible.checked,
      image: null,
    }, tpl);
    // Selection outline on the preview (never on exported tiles)
    if (state.selectedLayer) {
      const ctx = els.templateCanvas.getContext('2d');
      const S = els.templateCanvas.width / tpl.frame.width;
      const r = tileLayerRect(tpl, state.selectedLayer);
      ctx.save();
      ctx.strokeStyle = '#ef4372';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(r.x * S, r.y * S, r.w * S, r.h * S);
      ctx.restore();
    }
    // Keep the on-screen preview proportional to the frame
    els.templateCanvas.style.height = Math.round(150 * tpl.frame.height / tpl.frame.width) + 'px';
    // Re-render generated tiles live; edits invalidate compression.
    state.items.forEach((it) => { if (it.canvas) { it.compressed = null; placeResult(it); } });
    if (state.items.length) { els.compressSummary.textContent = ''; renderSizeLabels(); }
  }

  function renderLayersList() {
    const tpl = state.template;
    els.layersList.innerHTML = '';
    // Topmost layer first, like Figma; frame always at the bottom of the list.
    const rows = [...tpl.layerOrder].reverse().concat('frame');
    rows.forEach((name) => {
      const row = document.createElement('div');
      row.className = 'layer-row' + (state.selectedLayer === name ? ' selected' : '');
      const isFrame = name === 'frame';
      if (!isFrame && !tpl[name].visible) row.classList.add('hidden-layer');

      if (!isFrame) {
        const eye = document.createElement('button');
        eye.textContent = tpl[name].visible ? '👁' : '－';
        eye.title = tpl[name].visible ? 'Hide layer' : 'Show layer';
        eye.addEventListener('click', (e) => {
          e.stopPropagation();
          tpl[name].visible = !tpl[name].visible;
          templateChanged();
        });
        row.appendChild(eye);
      }

      const label = document.createElement('span');
      label.className = 'layer-name';
      label.textContent = LAYER_LABELS[name];
      row.appendChild(label);

      if (!isFrame) {
        const idx = tpl.layerOrder.indexOf(name);
        const up = document.createElement('button');
        up.textContent = '▲';
        up.title = 'Bring forward';
        up.disabled = idx === tpl.layerOrder.length - 1;
        up.addEventListener('click', (e) => {
          e.stopPropagation();
          tpl.layerOrder.splice(idx, 1);
          tpl.layerOrder.splice(idx + 1, 0, name);
          templateChanged();
        });
        const down = document.createElement('button');
        down.textContent = '▼';
        down.title = 'Send backward';
        down.disabled = idx === 0;
        down.addEventListener('click', (e) => {
          e.stopPropagation();
          tpl.layerOrder.splice(idx, 1);
          tpl.layerOrder.splice(idx - 1, 0, name);
          templateChanged();
        });
        row.append(up, down);
      }

      row.addEventListener('click', () => selectLayer(name));
      els.layersList.appendChild(row);
    });
  }

  function renderInspector() {
    const name = state.selectedLayer;
    els.inspector.innerHTML = '';
    if (!name) return;
    const layer = state.template[name];

    const title = document.createElement('div');
    title.className = 'inspector-title';
    title.textContent = LAYER_LABELS[name];
    els.inspector.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'inspector-grid';
    for (const [key, label, type, extra = {}] of LAYER_PROPS[name]) {
      const wrap = document.createElement('label');
      wrap.className = 'prop';
      wrap.textContent = label;
      let input;
      if (type === 'select') {
        input = document.createElement('select');
        for (const [val, text] of extra.options) {
          const opt = document.createElement('option');
          opt.value = val; opt.textContent = text;
          input.appendChild(opt);
        }
        input.value = String(layer[key]);
        input.addEventListener('change', () => {
          layer[key] = /^\d+$/.test(input.value) ? Number(input.value) : input.value;
          templateChanged();
        });
      } else if (type === 'color') {
        input = document.createElement('input');
        input.type = 'color';
        input.value = layer[key];
        input.addEventListener('input', () => { layer[key] = input.value; templateChanged(); });
      } else {
        input = document.createElement('input');
        input.type = 'number';
        if (extra.min !== undefined) input.min = extra.min;
        if (extra.max !== undefined) input.max = extra.max;
        input.value = layer[key];
        input.addEventListener('input', () => {
          const v = Number(input.value);
          if (!Number.isFinite(v)) return;
          layer[key] = Math.min(extra.max ?? Infinity, Math.max(extra.min ?? -Infinity, v));
          templateChanged();
        });
      }
      wrap.appendChild(input);
      grid.appendChild(wrap);
    }
    els.inspector.appendChild(grid);
  }

  function selectLayer(name) {
    state.selectedLayer = name;
    renderLayersList();
    renderInspector();
    renderTemplate();
  }

  // Re-render everything after a template edit (list rebuilds only when structure changed).
  function templateChanged() {
    saveTemplate();
    renderLayersList();
    renderTemplate();
  }

  // Click-to-select on the preview canvas
  els.templateCanvas.addEventListener('click', (e) => {
    const rect = els.templateCanvas.getBoundingClientRect();
    const tpl = state.template;
    const x = (e.clientX - rect.left) / rect.width * tpl.frame.width;
    const y = (e.clientY - rect.top) / rect.height * tpl.frame.height;
    selectLayer(hitTestTile(tpl, x, y));
  });

  els.tplReset.addEventListener('click', () => {
    if (!confirm('Reset the template to the default design? Your edits will be lost.')) return;
    state.template = deepMerge(DEFAULT_TEMPLATE, null);
    localStorage.removeItem('skuc_template');
    selectLayer(state.selectedLayer);
  });

  ['tplTitle', 'tplOffer', 'tplOfferVisible'].forEach((k) =>
    els[k].addEventListener('input', renderTemplate));
  selectLayer('frame');

  // ---- CSV upload ----
  els.dropZone.addEventListener('click', () => els.csvInput.click());
  els.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropZone.classList.add('drag'); });
  els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('drag'));
  els.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    els.dropZone.classList.remove('drag');
    const f = e.dataTransfer.files?.[0];
    if (f) loadCSVFile(f);
  });
  els.csvInput.addEventListener('change', () => {
    const f = els.csvInput.files?.[0];
    if (f) loadCSVFile(f);
  });

  function loadCSVFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const { headers, records } = parseCSV(String(reader.result));
      if (!headers.length || !records.length) { alert('CSV appears empty.'); return; }
      state.headers = headers;
      state.records = records;
      state.imageCols = detectImageColumns(headers, records);
      state.titleCol = detectTitleColumn(headers, state.imageCols);
      state.offerCol = detectOfferColumn(headers, state.imageCols);
      els.dropLabel.innerHTML = `<strong>${file.name}</strong> — ${records.length} row${records.length > 1 ? 's' : ''}`;
      buildSettingsUI();
      buildQueue();
    };
    reader.readAsText(file);
  }

  // ---- Settings (Auto / Custom tabs) ----
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $('tab-auto').hidden = tab.dataset.tab !== 'auto';
      $('tab-custom').hidden = tab.dataset.tab !== 'custom';
    });
  });

  function buildSettingsUI() {
    els.settingsBlock.hidden = false;
    els.autoSummary.innerHTML =
      `Image columns: <strong>${state.imageCols.join(', ') || 'none detected'}</strong><br>` +
      `Title column: <strong>${state.titleCol || 'none'}</strong> · Offer column: <strong>${state.offerCol || 'none'}</strong>`;

    // Custom tab
    els.colChecks.innerHTML = '';
    state.headers.forEach((h) => {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = h;
      cb.checked = state.imageCols.includes(h);
      cb.addEventListener('change', () => {
        state.imageCols = [...els.colChecks.querySelectorAll('input:checked')].map((c) => c.value);
        buildQueue();
      });
      label.append(cb, document.createTextNode(' ' + h));
      els.colChecks.appendChild(label);
    });

    for (const sel of [els.titleCol, els.offerCol]) {
      sel.innerHTML = '<option value="">(none)</option>';
      state.headers.forEach((h) => {
        const o = document.createElement('option');
        o.value = o.textContent = h;
        sel.appendChild(o);
      });
    }
    els.titleCol.value = state.titleCol;
    els.offerCol.value = state.offerCol;
    els.titleCol.addEventListener('change', () => { state.titleCol = els.titleCol.value; buildQueue(); });
    els.offerCol.addEventListener('change', () => { state.offerCol = els.offerCol.value; buildQueue(); });
  }

  // ---- Queue ----
  function buildQueue() {
    state.items = state.records.map((record, i) => {
      const urls = state.imageCols.map((c) => record[c]).filter((u) => /^https?:\/\//i.test(u || ''));
      return {
        id: i,
        record,
        urls,
        title: state.titleCol ? record[state.titleCol] : '',
        offer: state.offerCol ? record[state.offerCol] : '',
        status: urls.length ? 'ready' : 'no-images',
        sourceImages: null,
        resultImage: null,
        canvas: null,
        compressed: null,
      };
    });
    renderQueue();
    renderGrid();
    els.queueBlock.hidden = false;
    els.generateBtn.disabled = !state.items.some((it) => it.urls.length);
  }

  const BADGE = {
    'ready': ['', 'ready'],
    'no-images': ['error', 'no image URLs'],
    'fetching': ['processing', 'fetching…'],
    'generating': ['processing', 'generating…'],
    'done': ['done', '✓ done'],
    'error': ['error', 'error'],
  };

  function renderQueue() {
    els.queueList.innerHTML = '';
    els.queueCount.textContent = `(${state.items.length})`;
    state.items.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'queue-item';
      row.dataset.id = item.id;

      const thumbs = document.createElement('div');
      thumbs.className = 'thumbs';
      item.urls.slice(0, 3).forEach((u) => {
        const img = document.createElement('img');
        img.src = '/api/fetch-image?url=' + encodeURIComponent(u);
        img.loading = 'lazy';
        thumbs.appendChild(img);
      });

      const meta = document.createElement('div');
      meta.className = 'meta';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.title || `Row ${item.id + 1}`;
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = `${item.urls.length} image${item.urls.length === 1 ? '' : 's'}` + (item.offer ? ` · ${item.offer}` : '');
      meta.append(name, sub);

      const badge = document.createElement('span');
      const [cls, text] = BADGE[item.status] || ['', item.status];
      badge.className = 'badge ' + cls;
      badge.textContent = item.status === 'error' && item.errorMsg ? `error` : text;
      if (item.errorMsg) badge.title = item.errorMsg;

      const reloadBtn = document.createElement('button');
      reloadBtn.textContent = '↻';
      reloadBtn.title = 'Regenerate this item';
      reloadBtn.disabled = state.running || !item.urls.length;
      reloadBtn.addEventListener('click', () => regenerateItem(item));

      const removeBtn = document.createElement('button');
      removeBtn.textContent = '✕';
      removeBtn.title = 'Remove';
      removeBtn.disabled = state.running;
      removeBtn.addEventListener('click', () => {
        state.items = state.items.filter((it) => it !== item);
        renderQueue();
        renderGrid();
        els.generateBtn.disabled = !state.items.some((it) => it.urls.length);
      });

      row.append(thumbs, meta, badge, reloadBtn, removeBtn);
      els.queueList.appendChild(row);
    });
  }

  // ---- Image pipeline ----
  async function loadImageFromUrl(url) {
    const res = await fetch('/api/fetch-image?url=' + encodeURIComponent(url));
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed to fetch ${url}`);
    }
    const blob = await res.blob();
    const img = await blobToImage(blob);
    return img;
  }

  function blobToImage(blob) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(img.src); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('Image decode failed')); };
      img.src = URL.createObjectURL(blob);
    });
  }

  // Downscale to max 1024px on longest side, convert to PNG data URL.
  function preprocess(img) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const scale = Math.min(1, 1024 / Math.max(iw, ih));
    const w = Math.round(iw * scale), h = Math.round(ih * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/png');
  }

  function b64ToImage(b64) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Result image decode failed'));
      img.src = 'data:image/png;base64,' + b64;
    });
  }

  // Mock composite: draw source images side by side on white (for testing without Azure).
  function mockComposite(images) {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 1024;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 1024, 1024);
    const n = images.length;
    const cell = 1024 / n;
    images.forEach((img, i) => {
      const s = Math.min((cell * 0.9) / img.naturalWidth, 900 / img.naturalHeight);
      const w = img.naturalWidth * s, h = img.naturalHeight * s;
      ctx.drawImage(img, i * cell + (cell - w) / 2, 1000 - h, w, h); // shared baseline
    });
    return new Promise((resolve) => {
      const out = new Image();
      out.onload = () => resolve(out);
      out.src = c.toDataURL('image/png');
    });
  }

  async function generateItem(item) {
    item.errorMsg = null;
    item.status = 'fetching';
    renderQueue();
    const images = [];
    for (const u of item.urls) images.push(await loadImageFromUrl(u));
    item.sourceImages = images;

    item.status = 'generating';
    renderQueue();

    let resultImg;
    if (MOCK) {
      await new Promise((r) => setTimeout(r, 600));
      resultImg = await mockComposite(images);
    } else if (images.length === 1) {
      // single image: no compositing needed unless prompt demands it — still send to Azure for clean bg
      resultImg = await callAzure(images);
    } else {
      resultImg = await callAzure(images);
    }
    item.resultImage = resultImg;
    item.compressed = null;
    item.status = 'done';
    renderQueue();
    placeResult(item);
  }

  async function callAzure(images) {
    const payload = {
      endpoint: els.azureEndpoint.value.trim(),
      apiKey: els.azureKey.value.trim(),
      prompt: els.prompt.value.trim(),
      images: images.map(preprocess),
      background: 'auto',
      quality: 'low',
    };
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Generate failed (${res.status})`);
    return b64ToImage(json.b64);
  }

  // ---- Output grid ----
  function renderGrid() {
    els.tileGrid.innerHTML = '';
    state.items.forEach((item) => {
      const cell = document.createElement('div');
      cell.className = 'tile-cell';
      cell.dataset.id = item.id;

      const canvas = document.createElement('canvas');
      item.canvas = canvas;
      renderTile(canvas, {
        title: item.title || els.tplTitle.value,
        offerText: item.offer || els.tplOffer.value,
        offerVisible: els.tplOfferVisible.checked && (!!(item.offer || '').trim() || !state.offerCol),
        image: item.resultImage,
      }, state.template);

      const label = document.createElement('div');
      label.className = 'tile-label';
      label.textContent = item.title || `Row ${item.id + 1}`;
      const sizeInfo = document.createElement('div');
      sizeInfo.className = 'tile-size';
      if (item.compressed) {
        sizeInfo.textContent = `${fmtKB(item.compressed.inputSize)} → ${fmtKB(item.compressed.data.length)}`;
      }
      cell.append(canvas, label, sizeInfo);
      els.tileGrid.appendChild(cell);
    });
    updateOutputButtons();
  }

  function placeResult(item) {
    if (!item.canvas) return renderGrid();
    renderTile(item.canvas, {
      title: item.title || els.tplTitle.value,
      offerText: item.offer || els.tplOffer.value,
      offerVisible: els.tplOfferVisible.checked && (!!(item.offer || '').trim() || !state.offerCol),
      image: item.resultImage,
    }, state.template);
    updateOutputButtons();
  }

  function updateOutputButtons() {
    const done = state.items.filter((it) => it.status === 'done');
    els.compressBtn.disabled = state.running || !done.length;
    els.downloadBtn.disabled = state.running || !done.length;
  }

  function fmtKB(n) { return (n / 1024).toFixed(1) + ' KB'; }

  function renderSizeLabels() {
    els.tileGrid.querySelectorAll('.tile-cell').forEach((cell) => {
      const item = state.items.find((it) => String(it.id) === cell.dataset.id);
      const sizeEl = cell.querySelector('.tile-size');
      if (!item || !sizeEl) return;
      sizeEl.textContent = item.compressed
        ? `${fmtKB(item.compressed.inputSize)} → ${fmtKB(item.compressed.data.length)}`
        : '';
    });
  }

  // ---- Generate & Populate (sequential) ----
  els.generateBtn.addEventListener('click', async () => {
    if (state.running) return;
    if (!MOCK && (!els.azureEndpoint.value.trim() || !els.azureKey.value.trim())) {
      alert('Enter your Azure endpoint and API key (or use ?mock=1 for testing).');
      return;
    }
    const todo = state.items.filter((it) => it.urls.length);
    if (!todo.length) return;

    state.running = true;
    els.generateBtn.disabled = true;
    els.progressWrap.hidden = false;

    let n = 0;
    for (const item of todo) {
      n++;
      els.progressText.textContent = `Tile ${n} of ${todo.length} generating with ${MOCK ? 'mock' : 'azure'}…`;
      els.progressBar.style.width = `${((n - 1) / todo.length) * 100}%`;
      try {
        await generateItem(item);
      } catch (e) {
        item.status = 'error';
        item.errorMsg = e.message;
        renderQueue();
      }
      els.progressBar.style.width = `${(n / todo.length) * 100}%`;
    }

    els.progressText.textContent = `Done — ${state.items.filter((i) => i.status === 'done').length} of ${todo.length} tiles generated.`;
    state.running = false;
    els.generateBtn.disabled = false;
    renderQueue();
    updateOutputButtons();
  });

  async function regenerateItem(item) {
    if (state.running) return;
    state.running = true;
    els.generateBtn.disabled = true;
    els.progressWrap.hidden = false;
    els.progressText.textContent = `Regenerating row ${item.id + 1}…`;
    try {
      await generateItem(item);
      els.progressText.textContent = `Row ${item.id + 1} regenerated.`;
    } catch (e) {
      item.status = 'error';
      item.errorMsg = e.message;
      renderQueue();
      els.progressText.textContent = `Row ${item.id + 1} failed: ${e.message}`;
    }
    state.running = false;
    els.generateBtn.disabled = false;
    updateOutputButtons();
  }

  // ---- TinyPNG compression ----
  els.compressBtn.addEventListener('click', async () => {
    const key = els.tinyKey.value.trim();
    if (!key) { alert('Enter your TinyPNG API key.'); return; }
    const done = state.items.filter((it) => it.status === 'done' && it.canvas);
    if (!done.length) return;

    state.running = true;
    els.compressBtn.disabled = true;
    els.downloadBtn.disabled = true;
    els.progressWrap.hidden = false;

    let n = 0, inTotal = 0, outTotal = 0, failed = 0;
    for (const item of done) {
      n++;
      els.progressText.textContent = `Compressing tile ${n} of ${done.length} with TinyPNG…`;
      els.progressBar.style.width = `${((n - 1) / done.length) * 100}%`;
      try {
        const blob = await tileToPngBlob(item.canvas);
        const buf = new Uint8Array(await blob.arrayBuffer());
        const res = await fetch('/api/compress', {
          method: 'POST',
          headers: { 'x-tinify-key': key, 'Content-Type': 'application/octet-stream' },
          body: buf,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Compression failed (${res.status})`);
        }
        const out = new Uint8Array(await res.arrayBuffer());
        item.compressed = { data: out, inputSize: buf.length };
        inTotal += buf.length;
        outTotal += out.length;
      } catch (e) {
        failed++;
        console.error('Compress failed for row', item.id + 1, e);
      }
      els.progressBar.style.width = `${(n / done.length) * 100}%`;
    }

    state.running = false;
    els.progressText.textContent = failed
      ? `Compression finished with ${failed} failure${failed > 1 ? 's' : ''}.`
      : `Compression complete.`;
    els.compressSummary.textContent = outTotal
      ? `TinyPNG: ${fmtKB(inTotal)} → ${fmtKB(outTotal)} (saved ${Math.round((1 - outTotal / inTotal) * 100)}%)`
      : '';
    renderSizeLabels();
    els.compressBtn.disabled = false;
    els.downloadBtn.disabled = false;
  });

  // ---- ZIP download ----
  els.downloadBtn.addEventListener('click', async () => {
    const done = state.items.filter((it) => it.status === 'done' && it.canvas);
    if (!done.length) return;

    const files = [];
    for (const item of done) {
      let data;
      if (item.compressed) {
        data = item.compressed.data;
      } else {
        const blob = await tileToPngBlob(item.canvas);
        data = new Uint8Array(await blob.arrayBuffer());
      }
      const base = (item.title || `tile-${item.id + 1}`).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || `tile-${item.id + 1}`;
      files.push({ name: `${String(item.id + 1).padStart(2, '0')}-${base}.png`, data });
    }

    const zip = buildZip(files);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zip);
    a.download = 'sku-tiles.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
})();
