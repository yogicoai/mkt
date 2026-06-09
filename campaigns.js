'use strict';

/**
 * 캠페인 엑셀 업로드 저장/조회 — 날짜+캠페인 단위로 저장하고 기간으로 집계.
 * 컬럼 자동탐지: 날짜, 캠페인명, 노출, 클릭, 광고비(총비용), CPC, 구매완료수,
 *   장바구니수, 구매완료 전환매출, 장바구니 전환매출. (무의존성 xlsx-lite 사용)
 */
const { parseXlsx } = require('./xlsx-lite');
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

async function parseUpload(buf) {
  const rows = parseXlsx(buf);
  const find = (r, re) => { for (let i = 0; i < r.length; i++) if (re.test(String(r[i] == null ? '' : r[i]))) return i; return -1; };
  let hi = -1, col = {};
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const r = rows[i] || [];
    const d = find(r, /날짜|일자|date/i), c = find(r, /캠페인|광고\s*명|campaign/i);
    if (d >= 0 && c >= 0) {
      hi = i;
      col = {
        date: d, camp: c,
        imp: find(r, /노출/i), clk: find(r, /클릭/i),
        spend: find(r, /광고비|총\s*비용|소진|cost|spend|^비용/i),
        purch: find(r, /구매.*(수|건)|purchase/i),
        cart: find(r, /장바구니.*(담기|수)|장바구니수|cart/i),
        purchVal: find(r, /구매.*(전환)?\s*매출/i),
        cartVal: find(r, /장바구니.*(전환)?\s*매출/i),
      };
      break;
    }
  }
  if (hi < 0) throw new Error('헤더(날짜·캠페인명)를 찾지 못했습니다. 컬럼명을 확인하세요.');
  const data = await read();
  let added = 0; const dates = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const date = normDate(r[col.date]); const camp = String(r[col.camp] == null ? '' : r[col.camp]).trim();
    if (!date || !camp) continue;
    data[date + '\t' + camp] = {
      date, campaign: camp,
      imp: col.imp >= 0 ? num(r[col.imp]) : 0, clk: col.clk >= 0 ? num(r[col.clk]) : 0,
      spend: col.spend >= 0 ? num(r[col.spend]) : 0,
      purch: col.purch >= 0 ? num(r[col.purch]) : 0, cart: col.cart >= 0 ? num(r[col.cart]) : 0,
      purchVal: col.purchVal >= 0 ? num(r[col.purchVal]) : 0, cartVal: col.cartVal >= 0 ? num(r[col.cartVal]) : 0,
    };
    added++; dates.push(date);
  }
  await write(data);
  dates.sort();
  return { added, from: dates[0] || null, to: dates[dates.length - 1] || null, totalRows: Object.keys(data).length };
}

async function query(start, end) {
  const data = await read();
  const s = start || '0000-00-00', e = end || '9999-99-99';
  const agg = {}; let minD = null, maxD = null;
  for (const k of Object.keys(data)) {
    const r = data[k];
    if (r.date) { if (!minD || r.date < minD) minD = r.date; if (!maxD || r.date > maxD) maxD = r.date; }
    if (r.date < s || r.date > e) continue;
    const o = agg[r.campaign] || (agg[r.campaign] = { campaign: r.campaign, imp: 0, clk: 0, spend: 0, purch: 0, cart: 0, purchVal: 0, cartVal: 0 });
    o.imp += r.imp; o.clk += r.clk; o.spend += r.spend; o.purch += r.purch; o.cart += r.cart; o.purchVal += r.purchVal; o.cartVal += r.cartVal;
  }
  const rows = Object.values(agg).map((o) => ({
    ...o,
    ctr: o.imp ? +(o.clk / o.imp * 100).toFixed(2) : 0,
    cpc: o.clk ? Math.round(o.spend / o.clk) : 0,
    purchRoas: o.spend ? Math.round(o.purchVal / o.spend * 100) : 0,
    cartRoas: o.spend ? Math.round(o.cartVal / o.spend * 100) : 0,
    cpa: o.purch ? Math.round(o.spend / o.purch) : 0,
  })).sort((a, b) => b.spend - a.spend);
  const totals = rows.reduce((a, r) => ({ imp: a.imp + r.imp, clk: a.clk + r.clk, spend: a.spend + r.spend, purch: a.purch + r.purch, cart: a.cart + r.cart, purchVal: a.purchVal + r.purchVal, cartVal: a.cartVal + r.cartVal }), { imp: 0, clk: 0, spend: 0, purch: 0, cart: 0, purchVal: 0, cartVal: 0 });
  return { rows, totals, storedFrom: minD, storedTo: maxD, count: rows.length };
}

module.exports = { parseUpload, query };
