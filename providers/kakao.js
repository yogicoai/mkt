'use strict';

// 카카오모먼트 OpenAPI 어댑터 — 보고서(report) API로 광고비/노출/클릭/전환/전환매출.
// 인증: 비즈니스 토큰(2단계 OAuth). 토큰은 OAuth 동의 후 Mongo KV('kakao-token')에 저장하고 refresh로 갱신.
//   조사(2026-06) 기준:
//   - authorize: GET  https://kauth.kakao.com/oauth/business/authorize
//   - token:     POST https://kauth.kakao.com/oauth/business/token
//   - report:    GET  https://apis.moment.kakao.com/openapi/v4/adAccounts/report
//                헤더 Authorization: Bearer + adAccountId, 파라미터 adAccountId/start/end/metricsGroup
const { dash } = require('../naver-api'); // .env 로드 보장 + dash
const { kvGet, kvSet } = require('../store');

const REST_KEY = process.env.KAKAO_REST_API_KEY;
const SECRET = process.env.KAKAO_CLIENT_SECRET;
const ADACCT = process.env.KAKAO_AD_ACCOUNT_ID;
const SCOPE = process.env.KAKAO_SCOPE || 'moment_management';
const TOKEN_KEY = 'kakao-token';
const AUTH = 'https://kauth.kakao.com/oauth/business';
const API = 'https://apis.moment.kakao.com/openapi/v4';
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _sumCache = new Map(); const SUM_TTL = 5 * 60 * 1000; // 보고서 5분 캐시(호출제한 5초/1회 회피)

// 실제 사용할 광고계정 ID. .env가 틀린 계정이면(403 -402/-813) 토큰이 권한 가진 계정으로 자동 교체.
let _acct = ADACCT;
// 이 토큰이 접근 가능한 광고계정 목록에서 첫 계정 발견(자가치유). GET /adAccounts.
async function discoverAccount(tok) {
  try {
    const r = await fetch(`${API}/adAccounts`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
    if (!r.ok) return null;
    const j = await r.json();
    const id = j && Array.isArray(j.content) && j.content[0] && j.content[0].id;
    return id ? String(id) : null;
  } catch (_) { return null; }
}

function enabled() { return !!REST_KEY && !!ADACCT; }

function authorizeUrl(redirectUri) {
  const u = new URL(`${AUTH}/authorize`);
  u.searchParams.set('client_id', REST_KEY);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', SCOPE);
  return u.toString();
}

async function getStoredToken() { return kvGet(TOKEN_KEY, null); }
async function hasToken() { const t = await getStoredToken(); return !!(t && t.access_token); }

// 인가 코드 → 비즈니스 토큰 교환 (callback에서 호출 후 저장)
async function exchangeCode(code, redirectUri) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: REST_KEY, redirect_uri: redirectUri, code });
  if (SECRET) body.set('client_secret', SECRET);
  const r = await fetch(`${AUTH}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' }, body });
  const j = await r.json();
  if (!j.access_token) throw new Error('카카오 토큰 교환 실패: ' + JSON.stringify(j).slice(0, 200));
  const tok = { access_token: j.access_token, refresh_token: j.refresh_token || null, scope: j.scope || SCOPE, expires_in: j.expires_in || null, obtainedAt: new Date().toISOString() };
  await kvSet(TOKEN_KEY, tok);
  return tok;
}

async function refresh(tok) {
  if (!tok || !tok.refresh_token) return null;
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: REST_KEY, refresh_token: tok.refresh_token });
  if (SECRET) body.set('client_secret', SECRET);
  const r = await fetch(`${AUTH}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' }, body });
  const j = await r.json();
  if (!j.access_token) return null;
  const next = { ...tok, access_token: j.access_token, refresh_token: j.refresh_token || tok.refresh_token, expires_in: j.expires_in || tok.expires_in, obtainedAt: new Date().toISOString() };
  await kvSet(TOKEN_KEY, next);
  return next;
}

// 보고서 호출 (401 → refresh 재시도, 429 → 호출제한 대기 후 재시도)
async function report(start, end, opts) {
  opts = opts || {};
  const tok = await getStoredToken();
  if (!tok || !tok.access_token) throw new Error('카카오 비즈니스 토큰 없음 — 대시보드 카카오 탭에서 "연결하기"로 1회 동의가 필요합니다.');
  const sd = dash(start).replace(/-/g, ''), ed = dash(end || start).replace(/-/g, ''); // yyyyMMdd (기간이면 일별 반환 → 합산)
  const u = new URL(`${API}/adAccounts/report`);
  u.searchParams.set('adAccountId', String(_acct));
  u.searchParams.set('start', sd); u.searchParams.set('end', ed);
  u.searchParams.set('metricsGroup', 'BASIC,MESSAGE,PIXEL_SDK_CONVERSION'); // MESSAGE 포함 — 메시지 캠페인 발송/클릭
  const r = await fetch(u, { headers: { Authorization: `Bearer ${tok.access_token}`, adAccountId: String(_acct) } });
  if (r.status === 401 && !opts.refreshed) { const n = await refresh(tok); if (n) return report(start, end, { ...opts, refreshed: true }); }
  if (r.status === 429 && !opts.rateRetried) { await _sleep(5500); return report(start, end, { ...opts, rateRetried: true }); } // 호출제한 5초/1회
  // 403(-402 미동의 / -813 권한없음): 설정된 계정이 틀렸을 수 있음 → 접근 가능한 계정으로 1회 자동 교체 후 재시도
  if (r.status === 403 && !opts.acctRetried) {
    const found = await discoverAccount(tok);
    if (found && found !== String(_acct)) { _acct = found; return report(start, end, { ...opts, acctRetried: true }); }
  }
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch (_) { throw new Error(`카카오모먼트 응답 파싱 실패 (HTTP ${r.status}): ${txt.slice(0, 140)}`); }
  if (!r.ok) {
    let msg = (j && (j.message || j.msg || (j.error && (j.error.message || j.error)))) || JSON.stringify(j).slice(0, 160);
    if (r.status === 401) msg += ' — 토큰 만료/무효. 카카오 탭에서 다시 연결하세요.';
    if (r.status === 429) msg += ' — 호출 제한(5초에 1회). 잠시 후 다시 조회하세요.';
    const e = new Error(`카카오모먼트 HTTP ${r.status}: ${msg}`); e.code = r.status; throw e;
  }
  return j;
}

// 광고계정 캐시 잔액 — GET /adAccounts/balance (헤더 adAccountId). 응답 cash(유상)+freeCash(무상). 5분 캐시.
let _balCache = { at: 0, val: null };
async function balance() {
  if (_balCache.val != null && Date.now() - _balCache.at < SUM_TTL) return _balCache.val;
  const tok = await getStoredToken();
  if (!tok || !tok.access_token) return null;
  try {
    const r = await fetch(`${API}/adAccounts/balance`, { headers: { Authorization: `Bearer ${tok.access_token}`, adAccountId: String(_acct) } });
    if (!r.ok) return null;
    const j = await r.json();
    const val = (+j.cash || 0) + (+j.freeCash || 0); // 유상+무상 캐시 합 = 보유 잔액(원)
    _balCache = { at: Date.now(), val };
    return val;
  } catch (_) { return null; }
}

module.exports = {
  id: 'kakao', label: '카카오모먼트', enabled, authorizeUrl, exchangeCode, hasToken,
  async getSummary(start, end) {
    const key = String(start) + '_' + String(end || start);
    const hit = _sumCache.get(key);
    if (hit && Date.now() - hit.at < SUM_TTL) return hit.data;
    const bal = await balance(); // 잔액은 날짜 무관 — 데이터 0/오류여도 항상 표시
    let j;
    try { j = await report(start, end); }
    catch (e) {
      if (e && e.code === 401) throw e;          // 토큰 만료/무효는 노출(재연결 필요)
      if (hit) return hit.data;                  // 429 등 일시 오류는 조용히 — 캐시 있으면 그걸
      return [{ platform: '카카오모먼트', spend: 0, conversions: 0, convValue: 0, buyCnt: 0, buyVal: 0, cartCnt: 0, cartVal: 0, imp: 0, clk: 0, balance: bal, currency: 'KRW', note: '집계 대기' }]; // 0행이어도 잔액은 표시
    }
    let spend = 0, imp = 0, click = 0, conv = 0, rev = 0, cart = 0;
    for (const row of (j.data || [])) {
      const m = row.metrics || row || {};
      spend += +m.cost || 0;
      imp += (+m.imp || 0) + (+m.msg_send || 0);    // 메시지 캠페인은 노출 대신 발송수
      click += (+m.click || 0) + (+m.msg_click || 0); // 메시지 클릭 포함
      conv += +m.conv_purchase_1d || 0; rev += +m.conv_purchase_p_1d || 0;
      cart += +m.conv_add_to_cart_1d || 0;          // 장바구니 담기(1일) — 카카오는 담기 매출값은 미제공
    }
    const rows = [{ platform: '카카오모먼트', spend: Math.round(spend), conversions: Math.round(conv), convValue: Math.round(rev), buyCnt: Math.round(conv), buyVal: Math.round(rev), cartCnt: Math.round(cart), cartVal: 0, imp, clk: click, balance: bal, currency: 'KRW' }];
    _sumCache.set(key, { at: Date.now(), data: rows });
    return rows;
  },
};
