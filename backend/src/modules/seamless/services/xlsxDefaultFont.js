// Minimal dependency-free XLSX post-processor that sets the workbook's default (font[0])
// cell font. ExcelJS hardcodes font[0] = Calibri 11 inside its styles serializer with no
// public API to override it (see node_modules/exceljs/lib/xlsx/xform/style/styles-xform.js),
// but OOXML column widths are measured against the Normal cell style's font — which is
// font[0]. So every column width we store is interpreted in Calibri-11 character units even
// though every cell renders in Angsana New 14, and the narrower date columns overflow to
// #############. This rewriter swaps font[0] in xl/styles.xml to the rendering font so the
// stored widths are measured against the same font that actually draws.
//
// XLSX is a ZIP archive. We read the central directory, copy every entry verbatim except
// xl/styles.xml (which we replace with an edited copy, re-deflated), and emit a fresh ZIP.
// CRC32 and deflate come from node:zlib; no external zip dependency.
//
// This is intentionally narrow: it only edits font[0] (the default font) and leaves every
// other style, cell, and worksheet byte untouched. If the default font is already correct,
// the buffer is returned unchanged.

const { crc32, deflateRawSync, inflateRawSync } = require('node:zlib');

const DEFAULT_FONT = { name: 'Angsana New', size: 14 };

// Build the <font> XML for the default font. Keep it minimal — ExcelJS writes a plain
// <font><sz/><name/></font> for explicit fonts; match that shape so consumers don't choke.
function buildDefaultFontXml(font) {
  return `<font><sz val="${font.size}"/><name val="${font.name}"/></font>`;
}

// Replace the first <font>...</font> block inside <fonts>...</fonts> with the default font.
// The fonts collection is always at the top of styles.xml; font[0] is the default referenced
// by the Normal cell style (cellStyleXfs[0]) and by numFmt-only column styles.
function replaceDefaultFont(stylesXml, font) {
  const desiredXml = buildDefaultFontXml(font);
  const fontsBlockMatch = stylesXml.match(/(<fonts[^>]*>)([\s\S]*?)(<\/fonts>)/);
  if (!fontsBlockMatch) {
    return stylesXml; // malformed; leave untouched rather than corrupt
  }
  const inner = fontsBlockMatch[2];
  const fontRegex = /<font>[\s\S]*?<\/font>/;
  if (!fontRegex.test(inner)) {
    // No font elements at all (ExcelJS hadn't seeded any) — prepend the default.
    return stylesXml.replace(
      /(<fonts[^>]*>)([\s\S]*?)(<\/fonts>)/,
      (_, open, _inner, close) => `${open}${desiredXml}${_inner}${close}`,
    );
  }
  // Replace only the first <font> block, in place.
  let replacedFirst = false;
  const newInner = inner.replace(/<font>[\s\S]*?<\/font>/g, (match) => {
    if (replacedFirst) return match;
    replacedFirst = true;
    return match === desiredXml ? match : desiredXml;
  });
  return stylesXml.replace(
    /(<fonts[^>]*>)([\s\S]*?)(<\/fonts>)/,
    (_, open, _inner, close) => `${open}${newInner}${close}`,
  );
}

function readUInt16LE(buf, offset) {
  return buf.readUInt16LE(offset);
}
function readUInt32LE(buf, offset) {
  return buf.readUInt32LE(offset);
}

// Parse the ZIP central directory and return the entry list. Each entry: { name, compressedSize,
// uncompressedSize, crc32, localHeaderOffset, compressionMethod }.
function parseZipEntries(buf) {
  // Find the End Of Central Directory record (signature 0x06054b50).
  let eocd = -1;
  const minEocd = buf.length - 22;
  for (let i = buf.length - 22; i >= Math.max(0, minEocd - 65535) && i >= 0; i -= 1) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('xlsxDefaultFont: End Of Central Directory record not found');
  }
  const cdCount = readUInt16LE(buf, eocd + 10);
  const cdOffset = readUInt32LE(buf, eocd + 16);

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < cdCount; i += 1) {
    if (readUInt32LE(buf, p) !== 0x02014b50) {
      throw new Error(`xlsxDefaultFont: central directory entry ${i} signature mismatch`);
    }
    const compressionMethod = readUInt16LE(buf, p + 10);
    const crc = readUInt32LE(buf, p + 16);
    const compressedSize = readUInt32LE(buf, p + 20);
    const uncompressedSize = readUInt32LE(buf, p + 24);
    const nameLen = readUInt16LE(buf, p + 28);
    const extraLen = readUInt16LE(buf, p + 30);
    const commentLen = readUInt16LE(buf, p + 32);
    const localHeaderOffset = readUInt32LE(buf, p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({
      name,
      compressionMethod,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      cdExtra: buf.slice(p + 46 + nameLen, p + 46 + nameLen + extraLen),
      cdComment: buf.slice(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + commentLen),
      cdRecord: buf.slice(p, p + 46 + nameLen + extraLen + commentLen),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, eocd };
}

// Extract a raw (still-compressed) entry's payload by reading its local file header.
function readRawEntryPayload(buf, entry) {
  const lh = entry.localHeaderOffset;
  if (readUInt32LE(buf, lh) !== 0x04034b50) {
    throw new Error(`xlsxDefaultFont: local header signature mismatch for ${entry.name}`);
  }
  const nameLen = readUInt16LE(buf, lh + 26);
  const extraLen = readUInt16LE(buf, lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  return buf.slice(dataStart, dataStart + entry.compressedSize);
}

function inflateEntry(buf, entry) {
  const raw = readRawEntryPayload(buf, entry);
  if (entry.compressionMethod === 0) {
    return raw; // stored
  }
  if (entry.compressionMethod !== 8) {
    throw new Error(`xlsxDefaultFont: unsupported compression method ${entry.compressionMethod} for ${entry.name}`);
  }
  // ZIP stores raw DEFLATE streams (no zlib wrapper). Use inflateRawSync (the dedicated raw
  // function) — node's inflateSync does not honor a { raw: true } option the way deflate does.
  return inflateRawSync(raw);
}

// Rewrite an XLSX buffer so that xl/styles.xml's default font (font[0]) is the given font.
// If the default font is already correct, returns the original buffer unchanged.
function applyDefaultFont(buffer, font = DEFAULT_FONT) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  let entries;
  try {
    ({ entries } = parseZipEntries(buf));
  } catch (error) {
    // Not a recognizable ZIP — return untouched rather than corrupt. Caller decides whether
    // to treat this as an error.
    return buf;
  }

  const stylesEntry = entries.find((entry) => entry.name === 'xl/styles.xml');
  if (!stylesEntry) {
    return buf; // nothing to fix
  }

  const originalXml = inflateEntry(buf, stylesEntry).toString('utf8');
  const desiredFontXml = buildDefaultFontXml(font);
  const alreadyCorrect = new RegExp(
    `^<fonts[^>]*>\\s*${desiredFontXml.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  ).test(originalXml.replace(/\s+/g, '')) || false;
  // Simpler/robust: replace and compare.
  const editedXml = replaceDefaultFont(originalXml, font);
  if (editedXml === originalXml) {
    return buf; // font[0] was already the desired default
  }

  // Rebuild the ZIP: copy every entry's local-header+payload verbatim except styles.xml,
  // which we re-deflate. Then write a fresh central directory + EOCD.
  // Produce a raw DEFLATE stream (no zlib wrapper) to match ZIP's method-8 storage. Use the
  // dedicated deflateRawSync rather than a { raw: true } option, which inflate side proved
  // unreliable across zlib bindings.
  const stylesCompressed = deflateRawSync(Buffer.from(editedXml, 'utf8'), { level: 9 });
  const stylesCrc = crc32(Buffer.from(editedXml, 'utf8')) >>> 0;

  const outParts = [];
  const newEntries = [];
  let outOffset = 0;

  for (const entry of entries) {
    const isStyles = entry.name === 'xl/styles.xml';
    const payload = isStyles ? stylesCompressed : readRawEntryPayload(buf, entry);
    const crc = isStyles ? stylesCrc : entry.crc;
    const compSize = isStyles ? stylesCompressed.length : entry.compressedSize;
    const uncompSize = isStyles ? Buffer.byteLength(editedXml, 'utf8') : entry.uncompressedSize;
    const compMethod = isStyles ? 8 : entry.compressionMethod;

    // Local file header (30 bytes + name + extra)
    const nameBuf = Buffer.from(entry.name, 'utf8');
    // Re-read the local extra field length to preserve it.
    const lh = entry.localHeaderOffset;
    const localExtraLen = readUInt16LE(buf, lh + 28);
    const localExtra = buf.slice(lh + 30 + readUInt16LE(buf, lh + 26), lh + 30 + readUInt16LE(buf, lh + 26) + localExtraLen);

    const lhBuf = Buffer.alloc(30);
    lhBuf.writeUInt32LE(0x04034b50, 0);
    lhBuf.writeUInt16LE(20, 4); // version needed
    lhBuf.writeUInt16LE(0, 6); // flags
    lhBuf.writeUInt16LE(compMethod, 8);
    lhBuf.writeUInt16LE(0, 10); // mod time
    lhBuf.writeUInt16LE(0, 12); // mod date
    lhBuf.writeUInt32LE(crc >>> 0, 14);
    lhBuf.writeUInt32LE(compSize, 18);
    lhBuf.writeUInt32LE(uncompSize, 22);
    lhBuf.writeUInt16LE(nameBuf.length, 26);
    lhBuf.writeUInt16LE(localExtra.length, 28);

    outParts.push(lhBuf, nameBuf, localExtra, payload);
    newEntries.push({
      name: entry.name,
      crc,
      compSize,
      uncompSize,
      compMethod,
      localHeaderOffset: outOffset,
      nameBuf,
      localExtra,
      cdExtra: entry.cdExtra,
      cdComment: entry.cdComment,
    });
    outOffset += lhBuf.length + nameBuf.length + localExtra.length + payload.length;
  }

  const cdStart = outOffset;
  for (const entry of newEntries) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(entry.compMethod, 10);
    cd.writeUInt16LE(0, 12); // mod time
    cd.writeUInt16LE(0, 14); // mod date
    cd.writeUInt32LE(entry.crc >>> 0, 16);
    cd.writeUInt32LE(entry.compSize, 20);
    cd.writeUInt32LE(entry.uncompSize, 24);
    cd.writeUInt16LE(entry.nameBuf.length, 28);
    cd.writeUInt16LE(entry.cdExtra.length, 30);
    cd.writeUInt16LE(entry.cdComment.length, 32);
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(entry.localHeaderOffset, 42);
    outParts.push(cd, entry.nameBuf, entry.cdExtra, entry.cdComment);
    outOffset += cd.length + entry.nameBuf.length + entry.cdExtra.length + entry.cdComment.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk with cd
  eocd.writeUInt16LE(newEntries.length, 8);
  eocd.writeUInt16LE(newEntries.length, 10);
  eocd.writeUInt32LE(outOffset - cdStart, 12); // cd size
  eocd.writeUInt32LE(cdStart, 16); // cd offset
  eocd.writeUInt16LE(0, 20); // comment len
  outParts.push(eocd);

  return Buffer.concat(outParts);
}

module.exports = { applyDefaultFont, DEFAULT_FONT, replaceDefaultFont, parseZipEntries, inflateEntry };
