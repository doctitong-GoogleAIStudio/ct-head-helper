// Study loading, series grouping, HU windowing and montage building.
import { looksLikeDicom, parseDicom } from './dicom.js';

export const WINDOWS = {
  brain: { label: 'Brain', center: 40, width: 80 },
  subdural: { label: 'Subdural', center: 75, width: 215 },
  stroke: { label: 'Stroke', center: 32, width: 8 },
  bone: { label: 'Bone', center: 600, width: 2800 },
};

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif)$/i;
const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// Reads a list of Files into { series: [...], skipped: [{name, reason}] }.
export async function loadFiles(files, onProgress) {
  const dicomSlices = [];
  const imageSlices = [];
  const skipped = [];
  let done = 0;

  for (const file of files) {
    try {
      if (file.type.startsWith('image/') || IMAGE_EXT.test(file.name)) {
        imageSlices.push(await loadImageSlice(file));
      } else {
        const buffer = await file.arrayBuffer();
        if (!looksLikeDicom(buffer)) {
          skipped.push({ name: file.name, reason: 'Not an image or DICOM file' });
        } else {
          for (const frame of parseDicom(buffer)) {
            dicomSlices.push({ kind: 'dicom', name: file.name, ...frame });
          }
        }
      }
    } catch (err) {
      skipped.push({ name: file.name, reason: err.message || String(err) });
    }
    done++;
    onProgress?.(done, files.length);
  }

  const series = [];
  const byUID = new Map();
  for (const s of dicomSlices) {
    const key = s.meta.seriesUID;
    if (!byUID.has(key)) byUID.set(key, []);
    byUID.get(key).push(s);
  }
  for (const [uid, slices] of byUID) {
    sortSlices(slices);
    const m = slices[0].meta;
    series.push({
      id: uid,
      kind: 'dicom',
      number: m.seriesNumber,
      description: m.seriesDescription || `Series ${m.seriesNumber || series.length + 1}`,
      modality: m.modality,
      thickness: m.sliceThickness,
      slices,
    });
  }
  series.sort((a, b) => a.number - b.number);

  if (imageSlices.length) {
    imageSlices.sort((a, b) => naturalCompare(a.name, b.name));
    series.push({
      id: 'uploaded-images',
      kind: 'image',
      number: 0,
      description: 'Uploaded images',
      modality: 'IMG',
      thickness: 0,
      slices: imageSlices,
    });
  }
  return { series, skipped };
}

function sortSlices(slices) {
  const o = slices[0].meta.imageOrientation;
  if (o.length === 6 && slices.every((s) => s.meta.imagePosition.length === 3)) {
    // Slice normal = row direction × column direction.
    const n = [o[1] * o[5] - o[2] * o[4], o[2] * o[3] - o[0] * o[5], o[0] * o[4] - o[1] * o[3]];
    const d = (s) => s.meta.imagePosition[0] * n[0] + s.meta.imagePosition[1] * n[1] + s.meta.imagePosition[2] * n[2];
    slices.sort((a, b) => d(a) - d(b));
  } else {
    slices.sort((a, b) => a.meta.instanceNumber - b.meta.instanceNumber || a.frame - b.frame);
  }
}

async function loadImageSlice(file) {
  const bitmap = await createImageBitmap(file);
  return { kind: 'image', name: file.name, rows: bitmap.height, cols: bitmap.width, bitmap };
}

// Draws one slice into a canvas at its native size using the given window.
export function renderSlice(slice, windowKey, canvas) {
  canvas = canvas || document.createElement('canvas');
  canvas.width = slice.cols;
  canvas.height = slice.rows;
  const ctx = canvas.getContext('2d');
  if (slice.kind === 'image') {
    ctx.drawImage(slice.bitmap, 0, 0);
    return canvas;
  }
  const img = ctx.createImageData(slice.cols, slice.rows);
  const px = img.data;
  if (slice.rgb) {
    for (let i = 0, j = 0; i < slice.values.length; i += 3, j += 4) {
      px[j] = slice.values[i]; px[j + 1] = slice.values[i + 1]; px[j + 2] = slice.values[i + 2]; px[j + 3] = 255;
    }
  } else {
    const isCT = (slice.meta.modality || 'CT') === 'CT';
    let { center, width } = WINDOWS[windowKey] || WINDOWS.brain;
    if (!isCT && slice.meta.windowWidth) {
      center = slice.meta.windowCenter;
      width = slice.meta.windowWidth;
    }
    const lo = center - width / 2;
    const scale = 255 / width;
    const v = slice.values;
    for (let i = 0, j = 0; i < v.length; i++, j += 4) {
      const g = (v[i] - lo) * scale;
      const c = g < 0 ? 0 : g > 255 ? 255 : g;
      px[j] = px[j + 1] = px[j + 2] = c;
      px[j + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Real preprocessing statistics shown to the user (what a CNN pipeline would compute).
export function sliceStats(slice) {
  if (slice.kind !== 'dicom' || slice.rgb) return null;
  const v = slice.values;
  let min = Infinity, max = -Infinity, sum = 0, sumSq = 0, n = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x < min) min = x;
    if (x > max) max = x;
    // Mean/SD over tissue only (exclude air), as CNN pipelines usually do.
    if (x > -200) { sum += x; sumSq += x * x; n++; }
  }
  const mean = n ? sum / n : 0;
  const sd = n ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0;
  return { min, max, mean, sd };
}

// Builds grid montages covering slices of a series. Returns [{ dataUrl, from, to, window }].
export function buildMontages(series, windowKey, { tile = 256, cols = 4, rows = 4, maxImages = 12 } = {}) {
  const perMontage = cols * rows;
  let slices = series.slices.map((s, i) => ({ s, index: i + 1 }));
  const capacity = perMontage * maxImages;
  let sampled = false;
  if (slices.length > capacity) {
    // Evenly spaced sample so the full craniocaudal extent is still covered.
    const step = slices.length / capacity;
    slices = Array.from({ length: capacity }, (_, k) => slices[Math.floor(k * step)]);
    sampled = true;
  }

  const montages = [];
  for (let start = 0; start < slices.length; start += perMontage) {
    const chunk = slices.slice(start, start + perMontage);
    const usedRows = Math.ceil(chunk.length / cols);
    const canvas = document.createElement('canvas');
    canvas.width = cols * tile;
    canvas.height = usedRows * tile;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    chunk.forEach(({ s, index }, k) => {
      const src = renderSlice(s, windowKey);
      const x = (k % cols) * tile, y = Math.floor(k / cols) * tile;
      const scale = Math.min(tile / src.width, tile / src.height);
      const w = src.width * scale, h = src.height * scale;
      ctx.drawImage(src, x + (tile - w) / 2, y + (tile - h) / 2, w, h);
      ctx.font = 'bold 15px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,.65)';
      ctx.fillRect(x + 3, y + 3, 44, 20);
      ctx.fillStyle = '#ffd34d';
      ctx.fillText(`#${index}`, x + 7, y + 18);
    });
    montages.push({
      dataUrl: canvas.toDataURL('image/jpeg', 0.9),
      from: chunk[0].index,
      to: chunk[chunk.length - 1].index,
      window: windowKey,
    });
  }
  return { montages, sampled, covered: slices.length, total: series.slices.length };
}

// Single image (for small PNG/JPG uploads), long edge capped.
export function sliceToDataUrl(slice, windowKey, maxEdge = 1024) {
  const src = renderSlice(slice, windowKey);
  const scale = Math.min(1, maxEdge / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.92);
}
