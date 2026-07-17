// Tile renderer — data-driven template. Defaults replicate the Figma "SKU tile" frame (75×96).
// Layers (from Figma):
//   - Frame: 75×96, white bg, 12px corner radius, clips content
//   - "Title": text, centered, y 8, width 59, 11px DemiBold, #424957, line-height 12
//   - "Image container": 75×75, bottom edge 12px above frame bottom
//   - "Offer": 104×20 bar centered horizontally, flush to bottom, bg #ef4372, padding 4
// Horizontal position = centered + xOffset. Vertical: title hangs from the top (y),
// image and offer are anchored to the frame bottom (bottom = offset of the layer's
// bottom edge relative to the frame bottom; negative = above it).
window.DEFAULT_TEMPLATE = {
  frame: { width: 75, height: 96, radius: 12, bg: '#ffffff' },
  layerOrder: ['image', 'title', 'offer'], // draw order; last = topmost
  title: {
    visible: true, xOffset: 0, y: 8, width: 59,
    size: 11, lineHeight: 12, weight: 600, color: '#424957', maxLines: 2, align: 'center',
  },
  image: { visible: true, xOffset: 0, bottom: -12, width: 75, height: 75, fit: 'cover' },
  offer: {
    visible: true, xOffset: 0, bottom: 0, width: 104, height: 20, radius: 0, pad: 4,
    bg: '#ef4372', color: '#ffffff', size: 10, weight: 700,
  },
};

const FONT_STACK = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const EXPORT_WIDTH = 600; // output PNG width in px regardless of tile width

function roundedRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Bounding rect of a layer in tile units — shared by the renderer and hit testing.
window.tileLayerRect = function tileLayerRect(tpl, name) {
  const W = tpl.frame.width, H = tpl.frame.height;
  if (name === 'frame') return { x: 0, y: 0, w: W, h: H };
  const l = tpl[name];
  const x = (W - l.width) / 2 + l.xOffset;
  if (name === 'title') return { x, y: l.y, w: l.width, h: l.lineHeight * l.maxLines };
  return { x, y: H + l.bottom - l.height, w: l.width, h: l.height };
};

// Topmost visible layer at a point (tile units); frame is the fallback.
window.hitTestTile = function hitTestTile(tpl, x, y) {
  for (let i = tpl.layerOrder.length - 1; i >= 0; i--) {
    const name = tpl.layerOrder[i];
    if (!tpl[name].visible) continue;
    const r = tileLayerRect(tpl, name);
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return name;
  }
  return 'frame';
};

// Wrap text into at most maxLines, ellipsizing the last line.
function wrapText(ctx, text, maxWidth, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width <= maxWidth || !line) {
      line = test;
    } else {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length > maxLines) lines.length = maxLines;
  // Ellipsize last line if content overflows
  const joined = lines.join(' ');
  if (joined.replace(/\s+/g, ' ') !== String(text).trim().replace(/\s+/g, ' ')) {
    let last = lines[lines.length - 1] || '';
    while (last && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = last + '…';
  }
  return lines;
}

// Draw an image into a rect with cover/contain fit.
function drawImageFit(ctx, img, x, y, w, h, fit) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const scale = fit === 'contain' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
  const dw = iw * scale, dh = ih * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

function drawImageLayer(ctx, tpl, opts) {
  const r = tileLayerRect(tpl, 'image');
  if (opts.image) {
    drawImageFit(ctx, opts.image, r.x, r.y, r.w, r.h, tpl.image.fit);
  } else {
    ctx.fillStyle = '#f2f3f6';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = '#c3c8d2';
    ctx.font = `500 6px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('image', r.x + r.w / 2, r.y + r.h / 2);
  }
}

function drawTitleLayer(ctx, tpl, opts) {
  const t = tpl.title;
  const r = tileLayerRect(tpl, 'title');
  ctx.fillStyle = t.color;
  ctx.font = `${t.weight} ${t.size}px ${FONT_STACK}`;
  ctx.textBaseline = 'alphabetic';
  const lines = wrapText(ctx, opts.title || '', t.width, t.maxLines);
  const tx = t.align === 'left' ? r.x : t.align === 'right' ? r.x + r.w : r.x + r.w / 2;
  ctx.textAlign = t.align;
  lines.forEach((line, i) => {
    ctx.fillText(line, tx, t.y + t.size * 0.8 + i * t.lineHeight);
  });
}

function drawOfferLayer(ctx, tpl, opts) {
  if (!(opts.offerText || '').trim()) return;
  const o = tpl.offer;
  const r = tileLayerRect(tpl, 'offer');
  ctx.fillStyle = o.bg;
  roundedRectPath(ctx, r.x, r.y, r.w, r.h, o.radius);
  ctx.fill();
  ctx.fillStyle = o.color;
  ctx.font = `${o.weight} ${o.size}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // single line, ellipsized to visible width minus padding (bar may be wider than the tile)
  let text = String(opts.offerText);
  const maxW = Math.min(r.w, tpl.frame.width) - o.pad * 2;
  while (text && ctx.measureText(text).width > maxW) text = text.slice(0, -1);
  if (text !== String(opts.offerText)) text = text.slice(0, -1) + '…';
  ctx.fillText(text, r.x + r.w / 2, r.y + r.h / 2 + 0.5);
}

// Render one tile. opts: { title, offerText, offerVisible, image (HTMLImageElement|null) }
window.renderTile = function renderTile(canvas, opts, tpl) {
  tpl = tpl || window.DEFAULT_TEMPLATE;
  const W = tpl.frame.width, H = tpl.frame.height;
  const S = EXPORT_WIDTH / W;
  canvas.width = Math.round(W * S);
  canvas.height = Math.round(H * S);
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(S, S);

  // Frame: bg, rounded, clips all layers
  roundedRectPath(ctx, 0, 0, W, H, tpl.frame.radius);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = tpl.frame.bg;
  ctx.fillRect(0, 0, W, H);

  for (const name of tpl.layerOrder) {
    if (!tpl[name].visible) continue;
    if (name === 'image') drawImageLayer(ctx, tpl, opts);
    else if (name === 'title') drawTitleLayer(ctx, tpl, opts);
    else if (name === 'offer' && opts.offerVisible) drawOfferLayer(ctx, tpl, opts);
  }

  ctx.restore(); // clip
  ctx.restore(); // scale
};

// Export canvas → PNG bytes
window.tileToPngBlob = function tileToPngBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
};
