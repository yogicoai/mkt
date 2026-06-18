'use strict';

/**
 * 무의존성 최소 .xlsx 리더 — ZIP(중앙디렉터리) 해제 + 워크시트 XML 파싱 → 2차원 행 배열.
 * 내장 zlib만 사용. 단순 표(첫 시트) 읽기 용도. 수식/스타일/병합은 값만 추출.
 */
const zlib = require('zlib');

function readZipEntries(buf) {
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx 형식이 아닙니다 (ZIP EOCD 없음)');
  const cdCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries[name] = { method, compSize, lho };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entry) {
  const lho = entry.lho;
  if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('ZIP local header 손상');
  const nameLen = buf.readUInt16LE(lho + 26);
  const extraLen = buf.readUInt16LE(lho + 28);
  const start = lho + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error('지원하지 않는 압축 방식 ' + entry.method);
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g; let m;
  while ((m = siRe.exec(xml))) {
    let text = ''; const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g; let t;
    while ((t = tRe.exec(m[1]))) text += t[1];
    out.push(decodeXml(text));
  }
  return out;
}

function colToIdx(ref) {
  const m = /^([A-Z]+)/.exec(ref || ''); if (!m) return 0;
  let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g; let r;
  while ((r = rowRe.exec(xml))) {
    const cells = []; let auto = 0;
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let c;
    while ((c = cRe.exec(r[1]))) {
      const attrs = c[1], body = c[2] || '';
      const ref = (/r="([^"]+)"/.exec(attrs) || [])[1];
      const idx = ref ? colToIdx(ref) : auto;
      const type = (/t="([^"]+)"/.exec(attrs) || [])[1] || 'n';
      let val = '';
      if (type === 'inlineStr') { const it = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body); val = it ? decodeXml(it[1]) : ''; }
      else { const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(body); const raw = v ? v[1] : ''; val = type === 's' ? (shared[+raw] || '') : decodeXml(raw); }
      cells[idx] = val; auto = idx + 1;
    }
    rows.push(cells);
  }
  return rows;
}

function parseXlsx(buf) {
  const entries = readZipEntries(buf);
  const ss = entries['xl/sharedStrings.xml'] ? parseSharedStrings(readEntry(buf, entries['xl/sharedStrings.xml']).toString('utf8')) : [];
  const sheetName = entries['xl/worksheets/sheet1.xml'] ? 'xl/worksheets/sheet1.xml'
    : Object.keys(entries).find((n) => /^xl\/worksheets\/.*\.xml$/.test(n));
  if (!sheetName) throw new Error('워크시트를 찾을 수 없습니다');
  return parseSheet(readEntry(buf, entries[sheetName]).toString('utf8'), ss);
}

function isXlsx(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}

function decodeCsv(buf) {
  const decoders = ['utf-8', 'euc-kr'].map((enc) => {
    try { return new TextDecoder(enc, { fatal: false }).decode(buf); } catch (_) { return ''; }
  });
  return decoders
    .map((text) => ({ text: text.replace(/^\uFEFF/, ''), score: (text.match(/[가-힣]/g) || []).length - (text.match(/\uFFFD/g) || []).length * 5 }))
    .sort((a, b) => b.score - a.score)[0].text;
}

function guessDelimiter(text) {
  const line = (text.split(/\r?\n/).find((x) => x.trim()) || '');
  const counts = [',', '\t', ';'].map((d) => ({ d, n: (line.match(new RegExp(d === '\t' ? '\\t' : '\\' + d, 'g')) || []).length }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ',';
}

function parseCsv(buf) {
  const text = decodeCsv(buf);
  const delimiter = guessDelimiter(text);
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true; // 따옴표는 필드 시작에서만 (RFC 4180) — 필드 중간 따옴표는 리터럴
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function parseRows(buf) {
  return isXlsx(buf) ? parseXlsx(buf) : parseCsv(buf);
}

module.exports = { parseXlsx, parseCsv, parseRows };
