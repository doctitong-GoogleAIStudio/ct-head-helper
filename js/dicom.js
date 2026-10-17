// Minimal DICOM Part 10 reader for uncompressed CT slices.
// Supports Implicit VR Little Endian, Explicit VR Little Endian and multi-frame
// files. Compressed transfer syntaxes are detected and reported, not decoded.

const TS_IMPLICIT_LE = '1.2.840.10008.1.2';
const TS_EXPLICIT_LE = '1.2.840.10008.1.2.1';
const TS_DEFLATE = '1.2.840.10008.1.2.1.99';
const TS_EXPLICIT_BE = '1.2.840.10008.1.2.2';

const LONG_VRS = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV']);
const UNDEFINED = 0xffffffff;

// Tags we keep (group<<16 | element). Patient identifiers are deliberately not read.
const TAGS = {
  0x00020010: 'transferSyntax',
  0x00080060: 'modality',
  0x0008103e: 'seriesDescription',
  0x00180050: 'sliceThickness',
  0x0020000e: 'seriesUID',
  0x00200011: 'seriesNumber',
  0x00200013: 'instanceNumber',
  0x00200032: 'imagePosition',
  0x00200037: 'imageOrientation',
  0x00280002: 'samplesPerPixel',
  0x00280004: 'photometric',
  0x00280008: 'numberOfFrames',
  0x00280010: 'rows',
  0x00280011: 'columns',
  0x00280100: 'bitsAllocated',
  0x00280101: 'bitsStored',
  0x00280103: 'pixelRepresentation',
  0x00281050: 'windowCenter',
  0x00281051: 'windowWidth',
  0x00281052: 'rescaleIntercept',
  0x00281053: 'rescaleSlope',
};
const US_TAGS = new Set([0x00280002, 0x00280010, 0x00280011, 0x00280100, 0x00280101, 0x00280103]);
const PIXEL_DATA = 0x7fe00010;

export class DicomError extends Error {}

export function looksLikeDicom(buffer) {
  if (buffer.byteLength < 132) return false;
  const b = new Uint8Array(buffer, 128, 4);
  if (b[0] === 0x44 && b[1] === 0x49 && b[2] === 0x43 && b[3] === 0x4d) return true;
  // Some files omit the preamble and start straight at group 0002 or 0008.
  const v = new DataView(buffer);
  const g = v.getUint16(0, true);
  return g === 0x0002 || g === 0x0008;
}

export function parseDicom(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let pos = 0;
  if (buffer.byteLength >= 132 && String.fromCharCode(...bytes.subarray(128, 132)) === 'DICM') pos = 132;

  const out = {};
  let pixel = null;
  let explicit = true;
  let syntaxSwitched = false;

  const readStr = (off, len) => {
    let s = '';
    for (let i = 0; i < len; i++) {
      const c = bytes[off + i];
      if (c !== 0) s += String.fromCharCode(c);
    }
    return s.trim();
  };

  // Reads one element header at p; returns {tag, vr, len, valueStart}.
  const header = (p, isExplicit) => {
    const group = view.getUint16(p, true);
    const elem = view.getUint16(p + 2, true);
    const tag = ((group << 16) | elem) >>> 0;
    // Item / delimiter tags never carry a VR.
    if (group === 0xfffe) return { tag, vr: null, len: view.getUint32(p + 4, true), valueStart: p + 8 };
    if (isExplicit) {
      const vr = String.fromCharCode(bytes[p + 4], bytes[p + 5]);
      if (LONG_VRS.has(vr)) return { tag, vr, len: view.getUint32(p + 8, true), valueStart: p + 12 };
      return { tag, vr, len: view.getUint16(p + 6, true), valueStart: p + 8 };
    }
    return { tag, vr: null, len: view.getUint32(p + 4, true), valueStart: p + 8 };
  };

  // Skips a sequence or encapsulated value of undefined length; returns end offset.
  const skipUndefined = (p, isExplicit) => {
    while (p < buffer.byteLength - 8) {
      const h = header(p, isExplicit);
      if (h.tag === 0xfffee0dd) return h.valueStart; // sequence delimiter
      if (h.tag === 0xfffee000) {
        if (h.len === UNDEFINED) p = skipItem(h.valueStart, isExplicit);
        else p = h.valueStart + h.len;
        continue;
      }
      // Stray element inside a sequence (malformed); step over it.
      p = h.len === UNDEFINED ? skipUndefined(h.valueStart, isExplicit) : h.valueStart + h.len;
    }
    return buffer.byteLength;
  };
  const skipItem = (p, isExplicit) => {
    while (p < buffer.byteLength - 8) {
      const h = header(p, isExplicit);
      if (h.tag === 0xfffee00d) return h.valueStart; // item delimiter
      p = h.len === UNDEFINED ? skipUndefined(h.valueStart, isExplicit) : h.valueStart + h.len;
    }
    return buffer.byteLength;
  };

  while (pos < buffer.byteLength - 8) {
    const group = view.getUint16(pos, true);
    if (group !== 0x0002 && !syntaxSwitched) {
      syntaxSwitched = true;
      const ts = out.transferSyntax || TS_EXPLICIT_LE;
      if (ts === TS_EXPLICIT_BE || ts === TS_DEFLATE) {
        throw new DicomError(`Unsupported transfer syntax ${ts} (big-endian or deflated).`);
      }
      explicit = ts !== TS_IMPLICIT_LE;
      // Files with no meta header: sniff whether the next element looks explicit.
      if (!out.transferSyntax) {
        const vr = String.fromCharCode(bytes[pos + 4], bytes[pos + 5]);
        explicit = /^[A-Z]{2}$/.test(vr);
      }
    }
    const h = header(pos, group === 0x0002 ? true : explicit);

    if (h.tag === PIXEL_DATA) {
      if (h.len === UNDEFINED) {
        pixel = { encapsulated: true, offset: h.valueStart };
      } else {
        pixel = { encapsulated: false, offset: h.valueStart, length: h.len };
      }
      break;
    }

    if (h.len === UNDEFINED) {
      pos = skipUndefined(h.valueStart, group === 0x0002 ? true : explicit);
      continue;
    }

    const key = TAGS[h.tag];
    if (key) {
      if (US_TAGS.has(h.tag)) out[key] = view.getUint16(h.valueStart, true);
      else out[key] = readStr(h.valueStart, h.len);
    }
    pos = h.valueStart + h.len;
  }

  if (!pixel) throw new DicomError('No pixel data (may be a DICOMDIR, report or structured file).');

  const ts = out.transferSyntax || (explicit ? TS_EXPLICIT_LE : TS_IMPLICIT_LE);
  if (pixel.encapsulated) {
    throw new DicomError(
      `Compressed DICOM (transfer syntax ${ts}) is not supported in the browser. ` +
        'Export the series as uncompressed DICOM, or upload PNG/JPG slices.'
    );
  }

  const rows = out.rows, cols = out.columns;
  if (!rows || !cols) throw new DicomError('Missing image dimensions.');
  const bits = out.bitsAllocated || 16;
  const spp = out.samplesPerPixel || 1;
  const frames = parseInt(out.numberOfFrames || '1', 10) || 1;
  const signed = out.pixelRepresentation === 1;
  const slope = parseFloat(out.rescaleSlope || '1') || 1;
  const intercept = parseFloat(out.rescaleIntercept || '0') || 0;
  const frameSize = rows * cols * spp * (bits / 8);

  const result = [];
  for (let f = 0; f < frames; f++) {
    const start = pixel.offset + f * frameSize;
    if (start + frameSize > buffer.byteLength) break;
    let values;
    if (spp === 1) {
      values = new Float32Array(rows * cols);
      if (bits === 16) {
        const src = signed ? new Int16Array(buffer.slice(start, start + frameSize)) : new Uint16Array(buffer.slice(start, start + frameSize));
        for (let i = 0; i < values.length; i++) values[i] = src[i] * slope + intercept;
      } else if (bits === 8) {
        for (let i = 0; i < values.length; i++) values[i] = bytes[start + i] * slope + intercept;
      } else if (bits === 32) {
        const src = signed ? new Int32Array(buffer.slice(start, start + frameSize)) : new Uint32Array(buffer.slice(start, start + frameSize));
        for (let i = 0; i < values.length; i++) values[i] = src[i] * slope + intercept;
      } else {
        throw new DicomError(`Unsupported bits allocated: ${bits}.`);
      }
      if (out.photometric === 'MONOCHROME1') {
        let max = -Infinity;
        for (const v of values) if (v > max) max = v;
        for (let i = 0; i < values.length; i++) values[i] = max - values[i];
      }
    } else {
      values = new Uint8ClampedArray(bytes.slice(start, start + frameSize)); // RGB
    }
    result.push({
      rows,
      cols,
      rgb: spp === 3,
      values,
      frame: f,
      meta: {
        modality: out.modality || '',
        seriesUID: out.seriesUID || 'unknown-series',
        seriesNumber: parseInt(out.seriesNumber || '0', 10) || 0,
        seriesDescription: out.seriesDescription || '',
        instanceNumber: parseInt(out.instanceNumber || '0', 10) || 0,
        sliceThickness: parseFloat(out.sliceThickness || '0') || 0,
        imagePosition: parseNums(out.imagePosition),
        imageOrientation: parseNums(out.imageOrientation),
        windowCenter: parseNums(out.windowCenter)[0],
        windowWidth: parseNums(out.windowWidth)[0],
        transferSyntax: ts,
      },
    });
  }
  return result;
}

function parseNums(s) {
  if (!s) return [];
  return s.split('\\').map(Number).filter((n) => !Number.isNaN(n));
}
