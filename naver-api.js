'use strict';

/**
 * 네이버 검색광고 API 공용 클라이언트 모듈
 * - CLI(naver-ad.js)와 웹 서버(server.js)가 함께 사용.
 * - 인증/서명/호출 로직과 캠페인 효율 조회를 제공.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── .env 로더 (무의존성) ──────────────────────────────────
function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

const BASE = 'https://api.searchad.naver.com';
const API_KEY = process.env.NAVER_AD_API_KEY;
const SECRET = process.env.NAVER_AD_SECRET_KEY;
const CUSTOMER = process.env.NAVER_AD_CUSTOMER_ID;

function missingEnv() {
  const miss = [];
  if (!API_KEY) miss.push('NAVER_AD_API_KEY');
  if (!SECRET) miss.push('NAVER_AD_SECRET_KEY');
  if (!CUSTOMER) miss.push('NAVER_AD_CUSTOMER_ID');
  return miss;
}

// ── 서명: message = "{ts}.{method}.{uri}" → HMAC-SHA256 → base64 ──
function sign(ts, method, uri) {
  const miss = missingEnv();
  if (miss.length) throw new Error('네이버 환경변수 누락(' + miss.join(', ') + ') — .env 또는 Vercel 환경변수를 설정하세요.');
  return crypto.createHmac('sha256', SECRET).update(`${ts}.${method}.${uri}`).digest('base64');
}

function authHeaders(method, uri) {
  const ts = Date.now().toString();
  return {
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Timestamp': ts,
    'X-API-KEY': API_KEY,
    'X-Customer': String(CUSTOMER),
    'X-Signature': sign(ts, method, uri),
  };
}

async function api(method, uri, { query, body } = {}) {
  let url = BASE + uri;
  if (query) url += '?' + new URLSearchParams(query).toString();
  const opt = { method, headers: authHeaders(method, uri) };
  if (body) opt.body = JSON.stringify(body);
  const res = await fetch(url, opt);
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status} ${method} ${uri}`);
    e.data = data;
    throw e;
  }
  return data;
}

// ── 동시성 제한 맵 (네이버 rate-limit 고려: 기본 5개씩) ──
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const dash = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

const FIELDS = ['impCnt', 'clkCnt', 'ctr', 'cpc', 'salesAmt', 'ccnt', 'convAmt', 'ror'];

async function getCampaigns() {
  return api('GET', '/ncc/campaigns');
}

/**
 * 특정 일자(YYYYMMDD)의 캠페인별 효율을 조회.
 * @returns { date, rows: [...], totals: {...} }
 */
// 동시 호출 dedup: 같은 날짜 요청이 진행 중이면 같은 Promise 공유 (통합표+상세 중복 방지)
const _statsInflight = new Map();
async function getCampaignStats(startStr, endStr) {
  const s = String(startStr).replace(/-/g, ''), e = String(endStr || startStr).replace(/-/g, '');
  const key = s + '_' + e;
  if (_statsInflight.has(key)) return _statsInflight.get(key);
  const p = (s === e) ? _computeCampaignStats(startStr) : _computeCampaignStatsRange(startStr, endStr);
  _statsInflight.set(key, p);
  try { return await p; } finally { _statsInflight.delete(key); }
}

async function _computeCampaignStats(dateStr) {
  const since = dash(dateStr);
  const camps = await getCampaigns();

  const rows = await mapLimit(camps, 5, async (c) => {
    let m = {};
    try {
      const out = await api('GET', '/stats', {
        query: {
          id: c.nccCampaignId,
          fields: JSON.stringify(FIELDS),
          timeRange: JSON.stringify({ since, until: since }),
        },
      });
      const arr = out && out.data ? out.data : Array.isArray(out) ? out : [];
      m = arr[0] || {};
    } catch (_) { /* 실패 캠페인은 0 처리 */ }
    return {
      id: c.nccCampaignId, name: c.name, tp: c.campaignTp, status: c.status,
      impCnt: +m.impCnt || 0, clkCnt: +m.clkCnt || 0, ctr: +m.ctr || 0,
      cpc: +m.cpc || 0, salesAmt: +m.salesAmt || 0, ccnt: +m.ccnt || 0,
      convAmt: +m.convAmt || 0, ror: +m.ror || 0,
    };
  });

  // 합계 (노출 발생분 기준)
  const active = rows.filter((r) => r.impCnt > 0);
  const sum = active.reduce((a, r) => ({
    impCnt: a.impCnt + r.impCnt, clkCnt: a.clkCnt + r.clkCnt, salesAmt: a.salesAmt + r.salesAmt,
    ccnt: a.ccnt + r.ccnt, convAmt: a.convAmt + r.convAmt,
  }), { impCnt: 0, clkCnt: 0, salesAmt: 0, ccnt: 0, convAmt: 0 });
  const totals = {
    ...sum,
    ctr: sum.impCnt ? +(sum.clkCnt / sum.impCnt * 100).toFixed(2) : 0,
    cpc: sum.clkCnt ? Math.round(sum.salesAmt / sum.clkCnt) : 0,
    ror: sum.salesAmt ? Math.round(sum.convAmt / sum.salesAmt * 100) : 0,
    activeCount: active.length,
    totalCount: rows.length,
  };

  return { date: dateStr, rows, totals };
}

// 기간(시작≠끝) 캠페인 합산 — 캠페인 /stats는 timeRange만으론 합산이 안 돼 timeIncrement='1'(일별) 후 합산(검증됨).
async function _computeCampaignStatsRange(startStr, endStr) {
  const since = dash(startStr), until = dash(endStr);
  const camps = await getCampaigns();
  const rows = await mapLimit(camps, 5, async (c) => {
    const a = { impCnt: 0, clkCnt: 0, salesAmt: 0, ccnt: 0, convAmt: 0 };
    try {
      const out = await api('GET', '/stats', {
        query: { id: c.nccCampaignId, fields: JSON.stringify(FIELDS), timeRange: JSON.stringify({ since, until }), timeIncrement: '1' },
      });
      const arr = (out && out.data) ? out.data : (Array.isArray(out) ? out : []);
      for (const m of arr) { a.impCnt += +m.impCnt || 0; a.clkCnt += +m.clkCnt || 0; a.salesAmt += +m.salesAmt || 0; a.ccnt += +m.ccnt || 0; a.convAmt += +m.convAmt || 0; }
    } catch (_) { /* 실패 캠페인은 0 처리 */ }
    return {
      id: c.nccCampaignId, name: c.name, tp: c.campaignTp, status: c.status,
      impCnt: a.impCnt, clkCnt: a.clkCnt,
      ctr: a.impCnt ? +(a.clkCnt / a.impCnt * 100).toFixed(4) : 0,
      cpc: a.clkCnt ? Math.round(a.salesAmt / a.clkCnt) : 0,
      salesAmt: a.salesAmt, ccnt: a.ccnt, convAmt: a.convAmt,
      ror: a.salesAmt ? Math.round(a.convAmt / a.salesAmt * 100) : 0,
    };
  });
  const active = rows.filter((r) => r.impCnt > 0);
  const sum = active.reduce((acc, r) => ({
    impCnt: acc.impCnt + r.impCnt, clkCnt: acc.clkCnt + r.clkCnt, salesAmt: acc.salesAmt + r.salesAmt,
    ccnt: acc.ccnt + r.ccnt, convAmt: acc.convAmt + r.convAmt,
  }), { impCnt: 0, clkCnt: 0, salesAmt: 0, ccnt: 0, convAmt: 0 });
  const totals = {
    ...sum,
    ctr: sum.impCnt ? +(sum.clkCnt / sum.impCnt * 100).toFixed(2) : 0,
    cpc: sum.clkCnt ? Math.round(sum.salesAmt / sum.clkCnt) : 0,
    ror: sum.salesAmt ? Math.round(sum.convAmt / sum.salesAmt * 100) : 0,
    activeCount: active.length, totalCount: rows.length,
  };
  return { date: startStr, start: startStr, end: endStr, rows, totals };
}

// 비즈머니(광고비 잔액) 조회
async function getBizmoney() {
  const d = await api('GET', '/billing/bizmoney');
  return { bizmoney: Math.floor(+d.bizmoney || 0), budgetLock: !!d.budgetLock, refundLock: !!d.refundLock };
}

// 전환 분해 — StatReport AD_CONVERSION 보고서. 캠페인별로 구매(purchase)/장바구니(add_to_cart) 분리.
// 컬럼(헤더없는 TSV): [2]캠페인ID [3]광고그룹ID [4]키워드ID [10]전환유형 [11]전환수 [12]전환매출
const CONV_TTL = 10 * 60 * 1000; // 전환데이터는 자주 안 변하므로 10분 캐시
const _convCache = new Map();
const _convInflight = new Map();

async function _computeConv(date) {
  const job = await api('POST', '/stat-reports', { body: { reportTp: 'AD_CONVERSION', statDt: date } });
  let info = job, status = job.status, tries = 0;
  while (['REGIST', 'RUNNING', 'WAITING', 'AGGREGATING'].includes(status) && tries < 40) {
    await new Promise((r) => setTimeout(r, 2000));
    info = await api('GET', `/stat-reports/${job.reportJobId}`);
    status = info.status; tries++;
  }
  if (status !== 'BUILT') return { status, byCampaign: null, totals: null };
  const res = await fetch(info.downloadUrl, { headers: authHeaders('GET', new URL(info.downloadUrl).pathname) });
  const tsv = await res.text();
  const byCampaign = {}, byAdgroup = {}, byKeyword = {}; // 컬럼: [2]캠페인ID [3]광고그룹ID [4]키워드ID
  const totals = { buyCnt: 0, buyVal: 0, cartCnt: 0, cartVal: 0 };
  const add = (obj, key, type, cnt, val) => {
    if (!key) return;
    const o = obj[key] || (obj[key] = { buyCnt: 0, buyVal: 0, cartCnt: 0, cartVal: 0 });
    if (type === 'purchase') { o.buyCnt += cnt; o.buyVal += val; }
    else if (type === 'add_to_cart') { o.cartCnt += cnt; o.cartVal += val; }
  };
  for (const line of tsv.split(/\r?\n/)) {
    if (!line) continue;
    const a = line.split('\t');
    const type = a[10], cnt = +a[11] || 0, val = +a[12] || 0;
    add(byCampaign, a[2], type, cnt, val);
    add(byAdgroup, a[3], type, cnt, val);
    add(byKeyword, a[4], type, cnt, val);
    if (type === 'purchase') { totals.buyCnt += cnt; totals.buyVal += val; }
    else if (type === 'add_to_cart') { totals.cartCnt += cnt; totals.cartVal += val; }
  }
  return { status: 'BUILT', byCampaign, byAdgroup, byKeyword, totals };
}

// 캠페인별 구매/장바구니 분해 (10분 캐시). 미완료(BUILT 전)는 캐시 안 함.
async function getConversionBreakdown(date) {
  const hit = _convCache.get(date);
  if (hit && Date.now() - hit.at < CONV_TTL) return hit.data;
  if (_convInflight.has(date)) return _convInflight.get(date);
  const p = _computeConv(date);
  _convInflight.set(date, p);
  try {
    const d = await p;
    if (d.byCampaign) _convCache.set(date, { at: Date.now(), data: d });
    return d;
  } finally { _convInflight.delete(date); }
}

// 기간 구매/장바구니 분해 — 일별 리포트를 합산. 오늘·미래는 네이버가 당일 리포트를 안 줘서 제외(검증: 당일 POST 400).
async function getConversionBreakdownRange(startStr, endStr) {
  const start = String(startStr).replace(/-/g, ''), end = String(endStr || startStr).replace(/-/g, '');
  if (start === end) return getConversionBreakdown(start);
  const now = new Date();
  const today = '' + now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
  const mk = (s) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  let days = [];
  for (let d = mk(start); d <= mk(end); d.setDate(d.getDate() + 1)) {
    const ds = '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    if (ds < today) days.push(ds); // 오늘·미래 제외(리포트 미제공)
  }
  // 일별 리포트는 하루당 1회 빌드라 기간이 길면 무한로딩 → 최근 MAX_DAYS일로 상한(나머지는 분해 생략, 총전환·광고비는 기간 전체 정상)
  const MAX_DAYS = 62;
  let daysSkipped = 0;
  if (days.length > MAX_DAYS) { daysSkipped = days.length - MAX_DAYS; days = days.slice(-MAX_DAYS); }
  const results = await mapLimit(days, 6, (ds) => getConversionBreakdown(ds).catch(() => null));
  const byCampaign = {}, byAdgroup = {}, byKeyword = {}; const totals = { buyCnt: 0, buyVal: 0, cartCnt: 0, cartVal: 0 };
  const merge = (dst, src) => { if (!src) return; for (const k of Object.keys(src)) { const o = src[k]; const t = dst[k] || (dst[k] = { buyCnt: 0, buyVal: 0, cartCnt: 0, cartVal: 0 }); t.buyCnt += o.buyCnt; t.buyVal += o.buyVal; t.cartCnt += o.cartCnt; t.cartVal += o.cartVal; } };
  let daysBuilt = 0, daysMissing = 0;
  for (const r of results) {
    if (!r || !r.byCampaign) { daysMissing++; continue; }
    daysBuilt++;
    merge(byCampaign, r.byCampaign); merge(byAdgroup, r.byAdgroup); merge(byKeyword, r.byKeyword);
    totals.buyCnt += r.totals.buyCnt; totals.buyVal += r.totals.buyVal;
    totals.cartCnt += r.totals.cartCnt; totals.cartVal += r.totals.cartVal;
  }
  return { status: daysBuilt ? 'BUILT' : 'NONE', byCampaign, byAdgroup, byKeyword, totals, daysBuilt, daysMissing, daysSkipped };
}

// 장바구니 전환(통합표용) — 위 분해에서 파생 (기존 시그니처 유지: conversions=장바구니수, convValue=장바구니매출)
async function getCartConversions(date) {
  const d = await getConversionBreakdown(date);
  if (!d.totals) return { conversions: null, convValue: null, status: d.status };
  return { conversions: d.totals.cartCnt, convValue: d.totals.cartVal, status: 'BUILT' };
}

// 캠페인의 키워드별 효율 (adgroups→keywords→/stats). ids는 콤마구분.
async function getKeywordStats(campaignId, startStr, endStr) {
  const since = dash(startStr), until = dash(endStr || startStr);
  const CAP = 3000; // 초대형 캠페인(세부키워드 등) 안전 상한
  const ags = await api('GET', '/ncc/adgroups', { query: { nccCampaignId: campaignId } });
  const lists = await mapLimit(ags, 5, (ag) =>
    api('GET', '/ncc/keywords', { query: { nccAdgroupId: ag.nccAdgroupId } }).catch(() => []));
  let kws = [], truncated = false;
  for (const list of lists) {
    for (const k of list) {
      if (kws.length >= CAP) { truncated = true; break; }
      kws.push(k);
    }
    if (truncated) break;
  }

  const F = ['impCnt', 'clkCnt', 'ctr', 'cpc', 'salesAmt', 'ccnt', 'convAmt', 'ror', 'avgRnk'];
  const batches = [];
  for (let i = 0; i < kws.length; i += 100) batches.push(kws.slice(i, i + 100));
  const stat = {};
  await mapLimit(batches, 5, async (batch) => {
    const ids = batch.map((k) => k.nccKeywordId).join(',');
    try {
      const out = await api('GET', '/stats', {
        query: { ids, fields: JSON.stringify(F), timeRange: JSON.stringify({ since, until }) },
      });
      (out.data || []).forEach((r) => { if (r.id) stat[r.id] = r; });
    } catch (_) { /* 배치 실패 무시 */ }
  });

  const rows = kws.map((k) => {
    const s = stat[k.nccKeywordId] || {};
    const imp = +s.impCnt || 0, clk = +s.clkCnt || 0, spend = +s.salesAmt || 0, conv = +s.convAmt || 0;
    return {
      keyword: k.keyword,
      impCnt: imp, clkCnt: clk, ctr: imp ? +(clk / imp * 100).toFixed(2) : 0, cpc: clk ? Math.round(spend / clk) : 0,
      salesAmt: spend, ccnt: +s.ccnt || 0, convAmt: conv,
      ror: spend ? Math.round(conv / spend * 100) : 0, avgRnk: +s.avgRnk || 0,
    };
  }).filter((r) => r.impCnt > 0).sort((a, b) => b.salesAmt - a.salesAmt);

  return { campaignId, date: startStr, start: startStr, end: endStr || startStr, keywordCount: kws.length, activeCount: rows.length, truncated, rows };
}

// 파워링크(요기보 검색광고) 키워드 기간합산 — 여러 WEB_SITE 캠페인(샐리필 제외) 통합.
// /stats timeRange(시작≠끝, timeIncrement 없음)로 기간 합산값을 키워드당 1행 반환(검증됨).
// 캠페인 간 동일 키워드는 정규화 텍스트로 합산. since/until: YYYY-MM-DD 또는 YYYYMMDD.
const normKw = (s) => String(s || '').toLowerCase().replace(/\s+/g, '').trim();
async function getPowerlinkKeywordsRange(sinceStr, untilStr) {
  const since = dash(String(sinceStr).replace(/-/g, '')), until = dash(String(untilStr).replace(/-/g, ''));
  const camps = await getCampaigns();
  const targets = camps.filter((c) => c.campaignTp === 'WEB_SITE' && !/샐리필/.test(c.name || ''));
  const F = ['impCnt', 'clkCnt', 'salesAmt', 'ccnt', 'convAmt', 'avgRnk'];
  const agg = {};
  await mapLimit(targets, 3, async (c) => {
    const ags = await api('GET', '/ncc/adgroups', { query: { nccCampaignId: c.nccCampaignId } }).catch(() => []);
    const lists = await mapLimit(ags, 5, (ag) =>
      api('GET', '/ncc/keywords', { query: { nccAdgroupId: ag.nccAdgroupId } }).catch(() => []));
    const kws = lists.flat();
    const idToKw = {};
    kws.forEach((k) => { idToKw[k.nccKeywordId] = k.keyword; });
    const batches = [];
    for (let i = 0; i < kws.length; i += 100) batches.push(kws.slice(i, i + 100));
    await mapLimit(batches, 5, async (batch) => {
      const ids = batch.map((k) => k.nccKeywordId).join(',');
      if (!ids) return;
      try {
        const out = await api('GET', '/stats', { query: { ids, fields: JSON.stringify(F), timeRange: JSON.stringify({ since, until }) } });
        (out.data || []).forEach((s) => {
          const kw = idToKw[s.id]; if (kw == null) return;
          const n = normKw(kw);
          const o = agg[n] || (agg[n] = { keyword: kw, norm: n, impCnt: 0, clkCnt: 0, salesAmt: 0, ccnt: 0, convAmt: 0 });
          o.impCnt += +s.impCnt || 0; o.clkCnt += +s.clkCnt || 0; o.salesAmt += +s.salesAmt || 0;
          o.ccnt += +s.ccnt || 0; o.convAmt += +s.convAmt || 0;
        });
      } catch (_) { /* 배치 실패 무시 */ }
    });
  });
  const rows = Object.values(agg)
    .filter((r) => r.impCnt > 0 || r.salesAmt > 0)
    .map((r) => ({ ...r, ctr: r.impCnt ? +(r.clkCnt / r.impCnt * 100).toFixed(2) : 0, cpc: r.clkCnt ? Math.round(r.salesAmt / r.clkCnt) : 0, ror: r.salesAmt ? Math.round(r.convAmt / r.salesAmt * 100) : 0 }))
    .sort((a, b) => b.salesAmt - a.salesAmt);
  return { since: since, until: until, campaignCount: targets.length, rows };
}

// 네이버 매체버킷(검색/쇼핑/기타)별 기간합산 광고비·전환매출 — 통합 진짜 ROAS용.
// 검색=WEB_SITE(파워링크)+BRAND_SEARCH(브랜드검색) → Cafe24 medium=Naver 와 매칭. 쇼핑=SHOPPING → medium=shopping.
async function getNaverBucketRange(sinceStr, untilStr) {
  const since = dash(String(sinceStr).replace(/-/g, '')), until = dash(String(untilStr).replace(/-/g, ''));
  const camps = await getCampaigns();
  const bucketOf = (tp) => tp === 'SHOPPING' ? '쇼핑' : (tp === 'WEB_SITE' || tp === 'BRAND_SEARCH') ? '검색' : '기타';
  const agg = { 검색: { spend: 0, convAmt: 0, ccnt: 0 }, 쇼핑: { spend: 0, convAmt: 0, ccnt: 0 }, 기타: { spend: 0, convAmt: 0, ccnt: 0 } };
  await mapLimit(camps, 5, async (c) => {
    try {
      // 캠페인 /stats는 timeRange만으로는 합산이 안 됨 → timeIncrement='1'(일별) 후 합산 (backfill 검증 방식)
      const out = await api('GET', '/stats', { query: { id: c.nccCampaignId, fields: JSON.stringify(['salesAmt', 'convAmt', 'ccnt']), timeRange: JSON.stringify({ since, until }), timeIncrement: '1' } });
      const arr = (out && out.data) || [];
      const b = agg[bucketOf(c.campaignTp)];
      for (const m of arr) { b.spend += +m.salesAmt || 0; b.convAmt += +m.convAmt || 0; b.ccnt += +m.ccnt || 0; }
    } catch (_) { /* 캠페인 실패 무시 */ }
  });
  return agg;
}

// 쇼핑검색광고: 캠페인의 상품(소재)별 효율. adgroups→ads(소재)→/stats(ids=콤마구분)
// 소재 referenceData.productTitle = 상품명, imageUrl = 썸네일. 상품 단위로 합산.
async function getProductStats(campaignId, startStr, endStr) {
  const since = dash(startStr), until = dash(endStr || startStr);
  const CAP = 3000;
  const ags = await api('GET', '/ncc/adgroups', { query: { nccCampaignId: campaignId } });
  const adLists = await mapLimit(ags, 5, (ag) =>
    api('GET', '/ncc/ads', { query: { nccAdgroupId: ag.nccAdgroupId } }).catch(() => []));

  const meta = {}; // nccAdId → {key,title,image,price,url}
  let adIds = [], truncated = false;
  for (const list of adLists) {
    for (const a of list) {
      if (adIds.length >= CAP) { truncated = true; break; }
      const rd = a.referenceData || {};
      meta[a.nccAdId] = {
        key: rd.id || rd.mallProductId || a.nccAdId,
        title: rd.productTitle || '(상품명 없음)',
        image: rd.imageUrl || '',
        price: +rd.lowPrice || 0,
        url: rd.mallProductUrl || '',
      };
      adIds.push(a.nccAdId);
    }
    if (truncated) break;
  }

  const F = ['impCnt', 'clkCnt', 'salesAmt', 'ccnt', 'convAmt'];
  const batches = [];
  for (let i = 0; i < adIds.length; i += 100) batches.push(adIds.slice(i, i + 100));
  const stat = {};
  await mapLimit(batches, 5, async (batch) => {
    try {
      const out = await api('GET', '/stats', {
        query: { ids: batch.join(','), fields: JSON.stringify(F), timeRange: JSON.stringify({ since, until }) },
      });
      (out.data || []).forEach((r) => { if (r.id) stat[r.id] = r; });
    } catch (_) { /* 배치 실패 무시 */ }
  });

  // 상품(referenceKey) 단위 합산
  const prod = {};
  for (const adId of adIds) {
    const s = stat[adId]; if (!s) continue;
    const m = meta[adId];
    const p = prod[m.key] || (prod[m.key] = { product: m.title, image: m.image, price: m.price, url: m.url, impCnt: 0, clkCnt: 0, salesAmt: 0, ccnt: 0, convAmt: 0 });
    p.impCnt += +s.impCnt || 0; p.clkCnt += +s.clkCnt || 0; p.salesAmt += +s.salesAmt || 0;
    p.ccnt += +s.ccnt || 0; p.convAmt += +s.convAmt || 0;
  }
  const rows = Object.values(prod)
    .map((p) => ({ ...p, ror: p.salesAmt > 0 ? p.convAmt / p.salesAmt * 100 : 0 }))
    .filter((r) => r.impCnt > 0)
    .sort((a, b) => b.salesAmt - a.salesAmt);

  return { campaignId, date: startStr, start: startStr, end: endStr || startStr, productCount: adIds.length, activeCount: rows.length, truncated, rows };
}

// 단일 광고그룹의 상품(소재)별 효율 (쇼핑 계층 2단계)
async function getProductStatsForAdgroup(adgroupId, startStr, endStr) {
  const since = dash(startStr), until = dash(endStr || startStr);
  const ads = await api('GET', '/ncc/ads', { query: { nccAdgroupId: adgroupId } });
  const meta = {}; const adIds = [];
  for (const a of ads) {
    const rd = a.referenceData || {};
    meta[a.nccAdId] = { key: rd.id || rd.mallProductId || a.nccAdId, title: rd.productTitle || '(상품명 없음)', image: rd.imageUrl || '', price: +rd.lowPrice || 0, url: rd.mallProductUrl || '' };
    adIds.push(a.nccAdId);
  }
  const F = ['impCnt', 'clkCnt', 'salesAmt', 'ccnt', 'convAmt'];
  const batches = [];
  for (let i = 0; i < adIds.length; i += 100) batches.push(adIds.slice(i, i + 100));
  const stat = {};
  await mapLimit(batches, 5, async (batch) => {
    try {
      const out = await api('GET', '/stats', { query: { ids: batch.join(','), fields: JSON.stringify(F), timeRange: JSON.stringify({ since, until }) } });
      (out.data || []).forEach((r) => { if (r.id) stat[r.id] = r; });
    } catch (_) { /* 무시 */ }
  });
  const prod = {};
  for (const adId of adIds) {
    const s = stat[adId]; if (!s) continue;
    const m = meta[adId];
    const p = prod[m.key] || (prod[m.key] = { product: m.title, image: m.image, price: m.price, url: m.url, impCnt: 0, clkCnt: 0, salesAmt: 0, ccnt: 0, convAmt: 0 });
    p.impCnt += +s.impCnt || 0; p.clkCnt += +s.clkCnt || 0; p.salesAmt += +s.salesAmt || 0; p.ccnt += +s.ccnt || 0; p.convAmt += +s.convAmt || 0;
  }
  const rows = Object.values(prod).map((p) => ({ ...p, ror: p.salesAmt > 0 ? p.convAmt / p.salesAmt * 100 : 0 }))
    .filter((r) => r.impCnt > 0).sort((a, b) => b.salesAmt - a.salesAmt);
  return { adgroupId, date: startStr, start: startStr, end: endStr || startStr, productCount: adIds.length, activeCount: rows.length, rows };
}

// 캠페인의 광고그룹별 효율 (계층형 드릴다운 1단계). 입찰가·연결채널(URL) 포함.
async function getAdgroupStats(campaignId, startStr, endStr) {
  const since = dash(startStr), until = dash(endStr || startStr);
  const [ags, channels, cvB] = await Promise.all([
    api('GET', '/ncc/adgroups', { query: { nccCampaignId: campaignId } }),
    api('GET', '/ncc/channels').catch(() => []),
    getConversionBreakdownRange(startStr, endStr).catch(() => null), // 광고그룹별 구매/장바구니 분해
  ]);
  const chMap = {};
  for (const c of (channels || [])) chMap[c.nccBusinessChannelId] = c.channelKey || (c.businessInfo && c.businessInfo.site) || c.name || '';
  const byAdg = (cvB && cvB.byAdgroup) || {};

  const F = ['impCnt', 'clkCnt', 'ctr', 'cpc', 'salesAmt', 'ccnt', 'convAmt', 'ror'];
  const ids = ags.map((a) => a.nccAdgroupId);
  const batches = [];
  for (let i = 0; i < ids.length; i += 100) batches.push(ids.slice(i, i + 100));
  const stat = {};
  await mapLimit(batches, 5, async (batch) => {
    try {
      const out = await api('GET', '/stats', { query: { ids: batch.join(','), fields: JSON.stringify(F), timeRange: JSON.stringify({ since, until }) } });
      (out.data || []).forEach((r) => { if (r.id) stat[r.id] = r; });
    } catch (_) { /* 무시 */ }
  });

  const rows = ags.map((a) => {
    const s = stat[a.nccAdgroupId] || {};
    const b = byAdg[a.nccAdgroupId] || { buyCnt: 0, buyVal: 0, cartCnt: 0, cartVal: 0 };
    const imp = +s.impCnt || 0, clk = +s.clkCnt || 0, spend = +s.salesAmt || 0, conv = +s.convAmt || 0;
    return {
      adgroupId: a.nccAdgroupId, name: a.name, status: a.status, bidAmt: +a.bidAmt || 0,
      channel: chMap[a.pcChannelId] || chMap[a.mobileChannelId] || '',
      impCnt: imp, clkCnt: clk, ctr: imp ? +(clk / imp * 100).toFixed(2) : 0, cpc: clk ? Math.round(spend / clk) : 0,
      salesAmt: spend, ccnt: +s.ccnt || 0, convAmt: conv, ror: spend ? Math.round(conv / spend * 100) : 0,
      buyCnt: b.buyCnt, buyVal: b.buyVal, cartCnt: b.cartCnt, cartVal: b.cartVal,
      buyRoas: spend ? Math.round(b.buyVal / spend * 100) : 0,
    };
  }).sort((a, b) => b.salesAmt - a.salesAmt);

  return { campaignId, date: startStr, start: startStr, end: endStr || startStr, count: rows.length, rows };
}

// 단일 광고그룹의 키워드별 효율 (계층형 드릴다운 2단계)
async function getKeywordStatsForAdgroup(adgroupId, startStr, endStr) {
  const since = dash(startStr), until = dash(endStr || startStr);
  const [kws, cvB] = await Promise.all([
    api('GET', '/ncc/keywords', { query: { nccAdgroupId: adgroupId } }),
    getConversionBreakdownRange(startStr, endStr).catch(() => null), // 키워드별 구매/장바구니 분해
  ]);
  const byKw = (cvB && cvB.byKeyword) || {};
  const F = ['impCnt', 'clkCnt', 'ctr', 'cpc', 'salesAmt', 'ccnt', 'convAmt', 'ror', 'avgRnk'];
  const batches = [];
  for (let i = 0; i < kws.length; i += 100) batches.push(kws.slice(i, i + 100));
  const stat = {};
  await mapLimit(batches, 5, async (batch) => {
    const ids = batch.map((k) => k.nccKeywordId).join(',');
    try {
      const out = await api('GET', '/stats', { query: { ids, fields: JSON.stringify(F), timeRange: JSON.stringify({ since, until }) } });
      (out.data || []).forEach((r) => { if (r.id) stat[r.id] = r; });
    } catch (_) { /* 무시 */ }
  });
  const rows = kws.map((k) => {
    const s = stat[k.nccKeywordId] || {};
    const b = byKw[k.nccKeywordId] || { buyCnt: 0, buyVal: 0, cartCnt: 0, cartVal: 0 };
    const imp = +s.impCnt || 0, clk = +s.clkCnt || 0, spend = +s.salesAmt || 0, conv = +s.convAmt || 0;
    return {
      keyword: k.keyword, impCnt: imp, clkCnt: clk, ctr: imp ? +(clk / imp * 100).toFixed(2) : 0, cpc: clk ? Math.round(spend / clk) : 0,
      salesAmt: spend, ccnt: +s.ccnt || 0, convAmt: conv, ror: spend ? Math.round(conv / spend * 100) : 0, avgRnk: +s.avgRnk || 0,
      buyCnt: b.buyCnt, buyVal: b.buyVal, cartCnt: b.cartCnt, cartVal: b.cartVal, buyRoas: spend ? Math.round(b.buyVal / spend * 100) : 0,
    };
  }).filter((r) => r.impCnt > 0).sort((a, b) => b.salesAmt - a.salesAmt);
  return { adgroupId, date: startStr, start: startStr, end: endStr || startStr, keywordCount: kws.length, activeCount: rows.length, rows };
}

// 어제 (로컬=KST 기준) YYYYMMDD
function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

module.exports = {
  BASE, CUSTOMER, FIELDS,
  missingEnv, authHeaders, api, getCampaigns, getCampaignStats, getBizmoney, getCartConversions, getConversionBreakdown, getConversionBreakdownRange, getKeywordStats, getPowerlinkKeywordsRange, getNaverBucketRange, normKw, getProductStats, getProductStatsForAdgroup, getAdgroupStats, getKeywordStatsForAdgroup, yesterday, dash,
};
