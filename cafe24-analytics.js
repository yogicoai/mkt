'use strict';

/**
 * Cafe24 Analytics API (ca-api.cafe24data.com) — UTM/유입경로별 방문·전환·매출.
 *
 * 토큰 정책: yogiChat(클라우드타입)이 Cafe24 OAuth 토큰의 단일 소유자.
 *   - 토큰은 공유 MongoDB(yogibo DB, tokens 컬렉션)에 저장되고 yogiChat이 매시간 자동 갱신.
 *   - 여기서는 그 토큰을 "읽기 전용"으로만 사용한다(직접 refresh 안 함 → 토큰 회전 충돌/프로덕션 영향 0).
 *   - 401 시: DB에서 최신 토큰을 한 번 다시 읽어 재시도(yogiChat이 이미 회전시켰을 수 있음). 그래도 실패하면 에러.
 *
 * 응답 검증됨: /sales/orderdetails 가 ad/medium/campaign/content = utm_source/medium/campaign/content 로 자동 수집.
 */

const { MongoClient } = require('mongodb');

const CA_BASE = 'https://ca-api.cafe24data.com';
const MALL = process.env.CAFE24_MALL_ID || 'yogibo';
const TOKEN_URI = process.env.CAFE24_TOKEN_URI || process.env.MONGODB_URI;
const TOKEN_DB = process.env.CAFE24_TOKEN_DB || 'yogibo';
const TOKEN_COLL = process.env.CAFE24_TOKEN_COLLECTION || 'tokens';

function enabled() { return !!(TOKEN_URI && MALL); }

// ── 토큰 (읽기 전용, 60초 캐시) ──
let _client = null;
let _cache = { token: null, at: 0 };

async function readToken(force) {
  if (!force && _cache.token && Date.now() - _cache.at < 60000) return _cache.token;
  if (!TOKEN_URI) throw new Error('CAFE24_TOKEN_URI(또는 MONGODB_URI) 미설정');
  if (!_client) { _client = new MongoClient(TOKEN_URI); await _client.connect(); }
  const doc = await _client.db(TOKEN_DB).collection(TOKEN_COLL).findOne({});
  if (!doc || !doc.accessToken) throw new Error('Cafe24 토큰 없음 (yogiChat tokens 컬렉션 확인)');
  _cache = { token: doc.accessToken, at: Date.now() };
  return doc.accessToken;
}

async function caGet(endpoint, params, _retry) {
  const token = await readToken(_retry);
  const u = new URL(CA_BASE + endpoint);
  u.searchParams.set('mall_id', MALL);
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') u.searchParams.set(k, String(v));
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  if (r.status === 401 && !_retry) return caGet(endpoint, params, true); // DB 최신 토큰으로 1회 재시도(yogiChat 갱신분)
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch (_) { throw new Error(`Cafe24 분석 응답 파싱 실패 (HTTP ${r.status}): ${txt.slice(0, 140)}`); }
  if (r.status >= 400) {
    let msg = (j && j.error && (j.error.message || (typeof j.error === 'string' ? j.error : null))) || j.message || JSON.stringify(j).slice(0, 160);
    if (r.status === 401) msg += ' — Cafe24 토큰 만료. yogiChat(토큰 소유자)가 갱신해야 합니다.';
    const err = new Error(`Cafe24 분석 HTTP ${r.status}: ${msg}`); err.code = r.status; throw err;
  }
  return j;
}

// limit/offset 페이지네이션(최대 ~50k행 안전캡)
async function paginate(endpoint, params, key) {
  const limit = 1000; let offset = 0; const out = [];
  for (let i = 0; i < 50; i++) {
    const j = await caGet(endpoint, { ...params, limit, offset });
    const arr = (j && j[key]) || [];
    out.push(...arr);
    if (arr.length < limit) break;
    offset += limit;
  }
  return out;
}

// YYYYMMDD 또는 YYYY-MM-DD → YYYY-MM-DD
function ymd(s) {
  const d = String(s || '').replace(/-/g, '');
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : String(s);
}

// ── 주문상세(UTM별 매출) ──
async function getUtmSales(start, end) {
  const s = ymd(start), e = ymd(end);
  const rows = await paginate('/sales/orderdetails', { start_date: s, end_date: e, device_type: 'total' }, 'orderdetails');
  const seen = new Set();
  const byMedium = {}, byCampaign = {}, byUtm = {};
  let totalOrders = 0, totalRevenue = 0, taggedOrders = 0, taggedRevenue = 0;
  for (const r of rows) {
    const oid = r.order_id;
    if (oid && seen.has(oid)) continue; if (oid) seen.add(oid);
    const amt = +r.order_amount || 0;
    const ad = (r.ad || '').trim(), medium = (r.medium || '').trim(), campaign = (r.campaign || '').trim(), content = (r.content || '').trim();
    const tagged = !!(medium || campaign || ad);
    totalOrders++; totalRevenue += amt;
    if (tagged) { taggedOrders++; taggedRevenue += amt; }
    const M = medium || '(직접/기타)';
    (byMedium[M] = byMedium[M] || { medium: M, orders: 0, revenue: 0 }); byMedium[M].orders++; byMedium[M].revenue += amt;
    if (tagged) {
      const ck = M + '\t' + (campaign || '(미지정)');
      (byCampaign[ck] = byCampaign[ck] || { medium: M, campaign: campaign || '(미지정)', orders: 0, revenue: 0 }); byCampaign[ck].orders++; byCampaign[ck].revenue += amt;
      const uk = [ad, M, campaign, content].join('\t');
      (byUtm[uk] = byUtm[uk] || { ad: ad || '(없음)', medium: M, campaign: campaign || '(미지정)', content: content || '', orders: 0, revenue: 0 }); byUtm[uk].orders++; byUtm[uk].revenue += amt;
    }
  }
  const byRev = (a, b) => b.revenue - a.revenue;
  return {
    start: s, end: e, totalOrders, totalRevenue, taggedOrders, taggedRevenue,
    byMedium: Object.values(byMedium).sort(byRev),
    byCampaign: Object.values(byCampaign).sort(byRev),
    byUtm: Object.values(byUtm).sort(byRev),
  };
}

// ── 광고매체별 방문·주문·매출 (직접/none 포함) ──
async function getAdSales(start, end) {
  const s = ymd(start), e = ymd(end);
  const rows = await paginate('/visitpaths/adsales', { start_date: s, end_date: e, device_type: 'total' }, 'adsales');
  const norm = rows.map((r) => ({ ad: (r.ad || '(없음)'), visits: +r.join_count || 0, orders: +r.order_count || 0, revenue: +r.order_amount || 0 }))
    .sort((a, b) => b.revenue - a.revenue);
  return { start: s, end: e, rows: norm };
}

// ── 광고효과 상세(키워드별 방문·전환율·매출) ──
async function getAdEffect(start, end) {
  const s = ymd(start), e = ymd(end);
  const rows = await paginate('/adeffect/addetails', { start_date: s, end_date: e, device_type: 'total' }, 'addetails');
  const norm = rows.map((r) => {
    const visit = +r.visit_count || 0, purchase = +r.purchase_count || 0, revenue = +r.order_amount || 0;
    return { ad: (r.ad || ''), keyword: (r.keyword || ''), visit, purchase, revenue, cvr: visit ? purchase / visit * 100 : 0, perBuyer: +r.order_amount_per_buyer || 0 };
  }).filter((r) => r.visit > 0 || r.revenue > 0).sort((a, b) => b.revenue - a.revenue);
  return { start: s, end: e, count: norm.length, rows: norm };
}

// 파워링크(검색광고, ad=SA) 키워드별 실매출 — 키워드 진짜 ROAS 조인용.
// ad='SA'(파워링크 직접전환)만 집계. 키워드 정규화(소문자+공백제거)로 네이버와 매칭.
const NK = (s) => String(s || '').toLowerCase().replace(/\s+/g, '').trim();
async function getSaKeywordRevenue(start, end) {
  const s = ymd(start), e = ymd(end);
  const rows = await paginate('/adeffect/addetails', { start_date: s, end_date: e, device_type: 'total' }, 'addetails');
  const map = {};
  for (const r of rows) {
    if ((r.ad || '') !== 'SA') continue; // 파워링크(검색광고) 직접전환만
    const kw = (r.keyword || '').trim(); if (!kw) continue;
    const n = NK(kw);
    const o = map[n] || (map[n] = { keyword: kw, revenue: 0, purchases: 0, visits: 0 });
    o.revenue += +r.order_amount || 0; o.purchases += +r.purchase_count || 0; o.visits += +r.visit_count || 0;
  }
  return map; // { normalizedKeyword: {keyword, revenue, purchases, visits} }
}

async function close() { if (_client) { try { await _client.close(); } catch (_) {} _client = null; } }

module.exports = { enabled, getUtmSales, getAdSales, getAdEffect, getSaKeywordRevenue, NK, readToken, close, MALL };
