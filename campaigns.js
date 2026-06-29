'use strict';

/**
 * 캠페인 엑셀/CSV 업로드 저장/조회 — 날짜+캠페인 단위로 저장하고 기간으로 집계.
 * 컬럼 자동탐지: 날짜, 캠페인명, 노출, 클릭, 광고비(총비용), CPC, 구매완료수,
 *   장바구니수, 구매완료 전환매출, 장바구니 전환매출. (무의존성 xlsx-lite/CSV 사용)
 */
const { parseRows } = require('./xlsx-lite');
const { kvGet, kvSet } = require('./store');

const KEY = 'uploaded-campaigns';
const read = () => kvGet(KEY, {});       // async (Mongo KV)
const write = (d) => kvSet(KEY, d);      // async (Mongo KV)
const num = (s) => { const n = parseFloat(String(s == null ? '' : s).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; };

function normDate(s) {
  s = String(s == null ? '' : s).trim(); let m;
  if ((m = /(\d{4})\D(\d{1,2})\D(\d{1,2})/.exec(s))) return m[1] + '-' + String(+m[2]).padStart(2, '0') + '-' + String(+m[3]).padStart(2, '0');
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return m[1] + '-' + m[2] + '-' + m[3];
  if (/^\d{4,6}(\.\d+)?$/.test(s)) { const n = Math.floor(+s); if (n > 20000 && n < 60000) { const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000); return d.toISOString().slice(0, 10); } }
  return '';
}

// 단일 버퍼 파싱 → 행 배열([{date,campaign,source,imp,clk,spend,purch,cart,purchVal,cartVal}]). DB 미접근.
function parseOne(buf, opts = {}) {
  const rows = parseRows(buf);
  const find = (r, re, reject) => {
    for (let i = 0; i < r.length; i++) {
      const raw = String(r[i] == null ? '' : r[i]).trim();
      const compact = raw.replace(/\s+/g, '');
      if ((re.test(raw) || re.test(compact)) && !(reject && (reject.test(raw) || reject.test(compact)))) return i;
    }
    return -1;
  };
  let hi = -1, col = {};
  const uploadDate = normDate(opts.fallbackDate || '');
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const r = rows[i] || [];
    const d = find(r, /날짜|일자|^date$/i);
    const period = find(r, /기간|period|date\s*range/i, /목적|예산|상태|유형|구분/i); // 'GFA 기간' 컬럼 = 그 데이터의 보고기간
    const end = find(r, /종료일|종료날짜|end\s*date/i);
    const start = find(r, /시작일|시작날짜|start\s*date/i);
    const c = find(r, /캠페인(명|이름)?|광고명|campaign(name)?/i, /id|번호|유형|상태/i);
    if ((d >= 0 || period >= 0 || end >= 0 || start >= 0 || uploadDate) && c >= 0) {
      hi = i;
      col = {
        date: d, period, endDate: end, startDate: start, camp: c,
        imp: find(r, /노출|impression/i), clk: find(r, /클릭|click/i),
        spend: find(r, /광고비|총비용|총\s*비용|소진|cost|spend|^비용/i),
        purch: find(r, /구매.*(완료)?(수|건)|전환수|purchase/i, /매출|금액|value|revenue|총|앱/i), // '총 전환수'·'앱 내 구매완료 수' 제외 → 순수 '구매완료 수'
        cart: find(r, /장바구니.*(담기|수|건)|장바구니수|cart/i, /매출|금액|value|revenue/i),
        purchVal: find(r, /구매.*(전환)?\s*매출|구매.*금액|purchase.*(value|revenue)/i),
        cartVal: find(r, /장바구니.*(전환)?\s*매출|장바구니.*금액|cart.*(value|revenue)/i),
      };
      break;
    }
  }
  if (hi < 0) throw new Error('헤더(날짜/시작일/종료일·캠페인 이름)를 찾지 못했습니다. 컬럼명을 확인하세요.');
  const out = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    // 날짜→기간→종료일→시작일을 우선, 없을 때만 조회기간 종료일(uploadDate)로 폴백
    const date = (col.date >= 0 ? normDate(r[col.date]) : '') || (col.period >= 0 ? normDate(r[col.period]) : '') || normDate(r[col.endDate]) || normDate(r[col.startDate]) || uploadDate;
    const camp = String(r[col.camp] == null ? '' : r[col.camp]).trim();
    if (!date || !camp) continue;
    out.push({
      date, campaign: camp, source: opts.source || '',
      imp: col.imp >= 0 ? num(r[col.imp]) : 0, clk: col.clk >= 0 ? num(r[col.clk]) : 0,
      spend: col.spend >= 0 ? num(r[col.spend]) : 0,
      purch: col.purch >= 0 ? num(r[col.purch]) : 0, cart: col.cart >= 0 ? num(r[col.cart]) : 0,
      purchVal: col.purchVal >= 0 ? num(r[col.purchVal]) : 0, cartVal: col.cartVal >= 0 ? num(r[col.cartVal]) : 0,
    });
  }
  if (!out.length) {
    throw new Error('저장할 데이터가 없습니다 — 날짜(또는 시작일/종료일)와 캠페인 이름이 채워진 행을 찾지 못했어요. 날짜 컬럼이 없으면 상단에서 조회 기간을 먼저 선택해주세요.');
  }
  return out;
}

// 단일 업로드(레거시) — 날짜+캠페인 키, 같은 날짜 기존 데이터 삭제 후 교체.
async function parseUpload(buf, opts = {}) {
  const rows = parseOne(buf, opts);
  const incoming = {}; const dateSet = new Set();
  for (const r of rows) { incoming[r.date + '\t' + r.campaign] = r; dateSet.add(r.date); }
  const data = await read();
  let replaced = 0;
  for (const k of Object.keys(data)) { const rr = data[k]; const kd = (rr && rr.date) || k.split('\t')[0]; if (dateSet.has(kd)) { delete data[k]; replaced++; } }
  Object.assign(data, incoming);
  await write(data);
  const ds = [...dateSet].sort();
  return { added: Object.keys(incoming).length, replaced, from: ds[0] || null, to: ds[ds.length - 1] || null, totalRows: Object.keys(data).length };
}

// 여러 파일 일괄 업로드 — 파일(source)별로 저장.
//  · 캠페인은 파일 간 합산(query에서 캠페인명 기준 합) → 파일마다 다른 기간이어도 누락 없이 더해짐
//  · 같은 파일(파일명)을 다시 올리면 그 파일 행만 삭제 후 교체 → 같은 데이터가 쌓이지 않음
//  · 키 = 파일명 + 날짜 + 캠페인명 (일자별 행 보존 — 같은 캠페인의 여러 날짜가 안 합쳐짐)
async function parseUploadMany(buffers, opts = {}) {
  const list = Array.isArray(buffers) ? buffers : [buffers];
  const names = opts.names || [];
  const data = await read();
  const incoming = {}; const newSources = new Set(); const perFile = []; let okFiles = 0;
  for (let i = 0; i < list.length; i++) {
    const name = names[i] || ('파일' + (i + 1));
    try {
      const rows = parseOne(list[i], { ...opts, source: name });
      newSources.add(name);
      for (const r of rows) {
        const key = name + '\t' + r.date + '\t' + r.campaign;
        const ex = incoming[key];
        if (ex) { ex.imp += r.imp; ex.clk += r.clk; ex.spend += r.spend; ex.purch += r.purch; ex.cart += r.cart; ex.purchVal += r.purchVal; ex.cartVal += r.cartVal; }
        else incoming[key] = { ...r };
      }
      okFiles++;
      perFile.push({ name, rows: rows.length, ok: true });
    } catch (e) {
      perFile.push({ name, ok: false, error: e.message });
    }
  }
  if (!Object.keys(incoming).length) {
    const errs = perFile.filter((f) => !f.ok).map((f) => f.name + ': ' + f.error).join(' / ');
    throw new Error('업로드된 파일에서 저장할 데이터를 찾지 못했어요.' + (errs ? ' (' + errs + ')' : ''));
  }
  // 같은 파일(source) 재업로드 → 기존 그 파일 행 삭제(중복 누적 방지)
  let replaced = 0;
  for (const k of Object.keys(data)) { const r = data[k]; if (r && r.source && newSources.has(r.source)) { delete data[k]; replaced++; } }
  Object.assign(data, incoming);
  await write(data);
  const sources = new Set(Object.values(data).map((r) => r && r.source).filter(Boolean));
  return { files: list.length, okFiles, replaced, added: Object.keys(incoming).length, totalRows: Object.keys(data).length, fileCount: sources.size, perFile };
}

async function query(start, end) {
  const data = await read();
  const s = start || '0000-00-00', e = end || '9999-99-99';
  const agg = {}; const fileAgg = {}; const monthAgg = {}; const daily = []; let minD = null, maxD = null;
  const blank = () => ({ imp: 0, clk: 0, spend: 0, purch: 0, cart: 0, purchVal: 0, cartVal: 0 });
  const addInto = (o, r) => { o.imp += r.imp; o.clk += r.clk; o.spend += r.spend; o.purch += r.purch; o.cart += r.cart; o.purchVal += r.purchVal; o.cartVal += r.cartVal; };
  for (const k of Object.keys(data)) {
    const r = data[k];
    if (r.date) { if (!minD || r.date < minD) minD = r.date; if (!maxD || r.date > maxD) maxD = r.date; }
    if (r.date < s || r.date > e) continue;
    daily.push(r); // 날짜+캠페인 원행(일자별 표용)
    addInto(agg[r.campaign] || (agg[r.campaign] = Object.assign({ campaign: r.campaign }, blank())), r);
    if (r.source) addInto(fileAgg[r.source] || (fileAgg[r.source] = Object.assign({ file: r.source }, blank())), r);
    const mon = (r.date || '').slice(0, 7);
    if (mon) addInto(monthAgg[mon] || (monthAgg[mon] = Object.assign({ month: mon }, blank())), r);
  }
  const withRoas = (o) => ({ ...o, ctr: o.imp ? +(o.clk / o.imp * 100).toFixed(2) : 0, cpc: o.clk ? Math.round(o.spend / o.clk) : 0, purchRoas: o.spend ? Math.round(o.purchVal / o.spend * 100) : 0, cartRoas: o.spend ? Math.round(o.cartVal / o.spend * 100) : 0, cpa: o.purch ? Math.round(o.spend / o.purch) : 0 });
  const rows = Object.values(agg).map(withRoas).sort((a, b) => b.spend - a.spend);
  const dailyRows = daily.map(withRoas).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.spend - a.spend)); // 날짜 내림차순
  const byFile = Object.values(fileAgg).map(withRoas).sort((a, b) => b.spend - a.spend);
  const byMonth = Object.values(monthAgg).map(withRoas).sort((a, b) => a.month < b.month ? -1 : 1);
  const totals = rows.reduce((a, r) => ({ imp: a.imp + r.imp, clk: a.clk + r.clk, spend: a.spend + r.spend, purch: a.purch + r.purch, cart: a.cart + r.cart, purchVal: a.purchVal + r.purchVal, cartVal: a.cartVal + r.cartVal }), blank());
  return { rows, daily: dailyRows, byFile, byMonth, totals, storedFrom: minD, storedTo: maxD, count: rows.length, dailyCount: dailyRows.length };
}

async function clearAll() { await write({}); return { cleared: true, totalRows: 0 }; }
async function clearRange(start, end) {
  const data = await read();
  const s = start || '0000-00-00', e = end || '9999-99-99';
  let removed = 0;
  for (const k of Object.keys(data)) { const d = data[k].date; if (d >= s && d <= e) { delete data[k]; removed++; } }
  await write(data);
  return { removed, totalRows: Object.keys(data).length };
}

module.exports = { parseUpload, parseUploadMany, query, clearAll, clearRange };
