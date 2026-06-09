'use strict';

/**
 * 로컬 대시보드 서버 (무의존성, node:http)
 *   브라우저 → /api/stats → (서명) → 네이버 검색광고 API
 *
 * 실행: node server.js  →  http://localhost:5173
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { getCampaignStats, getBizmoney, getKeywordStats, getPowerlinkKeywordsRange, getNaverBucketRange, getProductStats, getProductStatsForAdgroup, getAdgroupStats, getKeywordStatsForAdgroup, missingEnv, CUSTOMER, yesterday } = require('./naver-api');
const { getAllSummaries } = require('./providers');
const { analyze, enabled: analyzeEnabled, model: analyzeModel } = require('./analyze');
const { db: getDb, configured: dbConfigured } = require('./db');
const cafe24 = require('./cafe24-analytics');
const metaApi = require('./meta-api');
const { parseXlsx } = require('./xlsx-lite');
const aiDaily = require('./ai-daily');
const campaigns = require('./campaigns');

const PORT = process.env.PORT || 5173;
const PUBLIC = path.join(__dirname, 'public');

// 시작 시 .env 검증
const miss = missingEnv();
if (miss.length) {
  console.error('\n❌ .env 누락:', miss.join(', '), '\n   .env 를 채운 뒤 다시 실행하세요.\n');
  process.exit(1);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // ── API: AI 분석 (Claude) ──
  if (url.pathname === '/api/analyze' && req.method === 'POST') {
    if (!analyzeEnabled()) return sendJson(res, 400, { ok: false, error: 'ANTHROPIC_API_KEY 미설정 (.env)' });
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        console.log(`[${new Date().toISOString()}] /api/analyze date=${data.date} model=${analyzeModel()}`);
        const out = await analyze(data);
        sendJson(res, 200, { ok: true, ...out });
      } catch (e) {
        console.error('  AI 분석 실패:', e.message);
        sendJson(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  // ── API: 전 플랫폼 통합 요약 (NAVER/META/Criteo/GFA) ──
  if (url.pathname === '/api/summary') {
    const date = (url.searchParams.get('date') || yesterday()).replace(/-/g, '');
    if (!/^\d{8}$/.test(date)) return sendJson(res, 400, { ok: false, error: 'date는 YYYYMMDD 형식' });
    console.log(`[${new Date().toISOString()}] /api/summary date=${date}`);
    try {
      const data = await getAllSummaries(date);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      console.error('  통합요약 실패:', e.message);
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // ── API: 일자별 추이 (MongoDB daily_stats) ──
  if (url.pathname === '/api/trend') {
    if (!dbConfigured()) return sendJson(res, 400, { ok: false, error: 'MONGODB_URI 미설정' });
    const since = (url.searchParams.get('since') || '').replace(/-/g, '');
    const until = (url.searchParams.get('until') || '').replace(/-/g, '');
    try {
      const d = await getDb();
      const q = {};
      if (/^\d{8}$/.test(since) || /^\d{8}$/.test(until)) {
        q.date = {};
        if (/^\d{8}$/.test(since)) q.date.$gte = since;
        if (/^\d{8}$/.test(until)) q.date.$lte = until;
      }
      const docs = await d.collection('daily_stats').find(q).sort({ date: 1 }).toArray();
      const byDate = {};
      for (const r of docs) {
        const a = byDate[r.date] || (byDate[r.date] = { spend: 0, convValue: 0, conv: 0, imp: 0, clk: 0 });
        a.spend += r.spend || 0; a.convValue += r.convValue || 0; a.conv += r.conv || 0;
        a.imp += r.imp || 0; a.clk += r.clk || 0;
      }
      const dates = Object.keys(byDate).sort();
      const series = { spend: [], convValue: [], roas: [], conv: [], clk: [], imp: [] };
      for (const dt of dates) {
        const a = byDate[dt];
        series.spend.push(a.spend); series.convValue.push(a.convValue); series.conv.push(a.conv);
        series.clk.push(a.clk); series.imp.push(a.imp);
        series.roas.push(a.spend ? Math.round(a.convValue / a.spend * 100) : 0);
      }
      return sendJson(res, 200, { ok: true, dates, series, rowCount: docs.length });
    } catch (e) {
      console.error('  트렌드 조회 실패:', e.message);
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // ── API: Cafe24 유입/UTM별 매출 (ca-api.cafe24data.com, yogiChat 토큰 재사용) ──
  if (url.pathname === '/api/utm') {
    if (!cafe24.enabled()) return sendJson(res, 400, { ok: false, error: 'Cafe24 토큰 소스 미설정 (.env CAFE24_TOKEN_URI/CAFE24_MALL_ID)' });
    const pad = (n) => String(n).padStart(2, '0');
    const toYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const now = new Date();
    const end = url.searchParams.get('end') || toYmd(now);
    let start = url.searchParams.get('start');
    if (!start) { const s = new Date(now); s.setDate(s.getDate() - 29); start = toYmd(s); }
    console.log(`[${new Date().toISOString()}] /api/utm ${start}~${end}`);
    try {
      const [sales, adsales, effect] = await Promise.all([
        cafe24.getUtmSales(start, end),
        cafe24.getAdSales(start, end).catch(() => null),
        cafe24.getAdEffect(start, end).catch(() => null),
      ]);
      return sendJson(res, 200, { ok: true, start: sales.start, end: sales.end, sales, adsales, effect });
    } catch (e) {
      console.error('  UTM 조회 실패:', e.message);
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // ── API: 캠페인 엑셀 업로드(날짜+지표) → 저장 ──
  if (url.pathname === '/api/campaigns-upload' && req.method === 'POST') {
    const chunks = []; let size = 0;
    req.on('data', (c) => { chunks.push(c); size += c.length; if (size > 20e6) req.destroy(); });
    req.on('end', () => {
      try {
        const r = campaigns.parseUpload(Buffer.concat(chunks));
        console.log(`[${new Date().toISOString()}] /api/campaigns-upload +${r.added}행 (${r.from}~${r.to})`);
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        console.error('  캠페인 업로드 실패:', e.message);
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }
  // ── API: 캠페인 업로드 데이터 기간 조회(캠페인별 집계) ──
  if (url.pathname === '/api/campaigns') {
    const start = (url.searchParams.get('start') || '').replace(/-/g, '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    const end = (url.searchParams.get('end') || '').replace(/-/g, '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
    try {
      return sendJson(res, 200, { ok: true, start, end, ...campaigns.query(start, end) });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // ── API: AI 기간 분석 (기간 광고데이터 → Claude 피드백/방향성, 기간별 캐시 + 비용) ──
  if (url.pathname === '/api/ai-analyze') {
    const pad = (n) => String(n).padStart(2, '0');
    const toYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const now = new Date();
    const end = (url.searchParams.get('end') || toYmd(now)).replace(/-/g, '');
    const start = (url.searchParams.get('start') || toYmd(now)).replace(/-/g, '');
    if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) return sendJson(res, 400, { ok: false, error: 'start/end는 YYYYMMDD 형식' });
    const force = url.searchParams.get('force') === '1';
    const focus = (url.searchParams.get('focus') || '').slice(0, 500);
    console.log(`[${new Date().toISOString()}] /api/ai-analyze ${start}~${end} force=${force} focus=${focus ? 'Y' : 'N'}`);
    try {
      const r = await aiDaily.getAnalysis(start, end, focus, force);
      return sendJson(res, 200, { ok: true, ...r });
    } catch (e) {
      console.error('  AI 기간분석 실패:', e.message);
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // ── API: GFA 수동 입력(월별 광고비·전환매출) — 파트너 API 미승인 대체 ──
  if (url.pathname === '/api/gfa') {
    const FILE = path.join(__dirname, 'gfa-manual.json');
    const readData = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return {}; } };
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, data: readData() });
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        try {
          const d = JSON.parse(body || '{}');
          const month = String(d.month || '').trim();
          if (!/^\d{4}-\d{2}$/.test(month)) return sendJson(res, 400, { ok: false, error: 'month는 YYYY-MM 형식' });
          const data = readData();
          if (d.delete) delete data[month];
          else data[month] = { spend: Math.round(+d.spend || 0), convValue: Math.round(+d.convValue || 0), conv: Math.round(+d.conv || 0) };
          fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
          return sendJson(res, 200, { ok: true, data });
        } catch (e) { return sendJson(res, 500, { ok: false, error: e.message }); }
      });
      return;
    }
    return sendJson(res, 405, { ok: false, error: 'GET 또는 POST' });
  }

  // ── API: GFA 엑셀(.xlsx) 업로드 → 월별 광고비/전환매출 합산 저장 ──
  if (url.pathname === '/api/gfa-upload' && req.method === 'POST') {
    const FILE = path.join(__dirname, 'gfa-manual.json');
    const readData = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return {}; } };
    const chunks = []; let size = 0;
    req.on('data', (c) => { chunks.push(c); size += c.length; if (size > 12e6) req.destroy(); });
    req.on('end', () => {
      try {
        const rows = parseXlsx(Buffer.concat(chunks));
        const num = (s) => { const n = parseFloat(String(s == null ? '' : s).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; };
        const normMonth = (s) => {
          s = String(s == null ? '' : s).trim(); let m;
          if ((m = /(\d{4})\s*[.\-/년]\s*(\d{1,2})/.exec(s))) return m[1] + '-' + String(+m[2]).padStart(2, '0');
          if ((m = /^(\d{4})(\d{2})$/.exec(s))) return m[1] + '-' + m[2];
          if (/^\d{4,6}(\.\d+)?$/.test(s)) { const n = Math.floor(+s); if (n > 20000 && n < 60000) { const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); } }
          return '';
        };
        // 헤더행 + 컬럼 매핑 (앞 8행 스캔)
        let hi = -1, mC = -1, sC = -1, vC = -1;
        for (let i = 0; i < Math.min(rows.length, 8); i++) {
          const r = rows[i] || []; let a = -1, b = -1, c = -1;
          r.forEach((cell, idx) => {
            const t = String(cell == null ? '' : cell);
            if (a < 0 && /월|기간|날짜|일자|date|month/i.test(t)) a = idx;
            if (b < 0 && /광고비|비용|지출|소진|cost|spend/i.test(t)) b = idx;
            if (c < 0 && /전환매출|매출|전환금액|revenue/i.test(t)) c = idx;
          });
          if (a >= 0 && (b >= 0 || c >= 0)) { hi = i; mC = a; sC = b; vC = c; break; }
        }
        if (hi < 0) return sendJson(res, 400, { ok: false, error: '헤더(월/광고비/전환매출)를 못 찾았습니다. 컬럼명을 확인하세요.' });
        const agg = {};
        for (let i = hi + 1; i < rows.length; i++) {
          const r = rows[i] || []; const month = normMonth(r[mC]); if (!month) continue;
          const o = agg[month] || (agg[month] = { spend: 0, convValue: 0 });
          if (sC >= 0) o.spend += num(r[sC]);
          if (vC >= 0) o.convValue += num(r[vC]);
        }
        const data = readData();
        const months = Object.keys(agg).sort();
        for (const month of months) data[month] = { spend: Math.round(agg[month].spend), convValue: Math.round(agg[month].convValue), conv: (data[month] && data[month].conv) || 0 };
        fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
        console.log(`[${new Date().toISOString()}] /api/gfa-upload ${months.length}개월 (${months.join(',')})`);
        return sendJson(res, 200, { ok: true, added: months.length, months, data });
      } catch (e) {
        console.error('  GFA 업로드 실패:', e.message);
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  // ── API: 매체별 진짜 ROAS (광고비 × Cafe24 실매출) ──
  if (url.pathname === '/api/unified-roas') {
    if (!cafe24.enabled()) return sendJson(res, 400, { ok: false, error: 'Cafe24 토큰 미설정' });
    const pad = (n) => String(n).padStart(2, '0');
    const toYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const now = new Date();
    const end = url.searchParams.get('end') || toYmd(now);
    const start = url.searchParams.get('start') || toYmd(now);
    console.log(`[${new Date().toISOString()}] /api/unified-roas ${start}~${end}`);
    try {
      const [nv, meta, utm] = await Promise.all([
        getNaverBucketRange(start, end),
        metaApi.enabled() ? metaApi.getMetaBreakdown(start, end) : Promise.resolve({ accounts: [] }),
        cafe24.getUtmSales(start, end),
      ]);
      const med = {}; (utm.byMedium || []).forEach((m) => { med[m.medium] = m; });
      const caRev = (k) => (med[k] && med[k].revenue) || 0;
      const metaSpend = meta.accounts.reduce((a, x) => a + x.totals.spend, 0);
      const metaConvVal = meta.accounts.reduce((a, x) => a + x.totals.purchVal, 0);
      const rows = [
        { ch: '네이버 검색(파워링크·브랜드)', spend: nv.검색.spend, adConv: nv.검색.convAmt, caRev: caRev('Naver') },
        { ch: '네이버 쇼핑', spend: nv.쇼핑.spend, adConv: nv.쇼핑.convAmt, caRev: caRev('shopping') },
        { ch: '메타', spend: metaSpend, adConv: metaConvVal, caRev: caRev('meta') },
        { ch: '카카오·플친', spend: 0, adConv: 0, caRev: caRev('kakao') + caRev('Plusfriendmessage') + caRev('kakaodm') },
      ].map((r) => ({ ...r, roas: r.spend ? Math.round(r.caRev / r.spend * 100) : 0, adRoas: r.spend ? Math.round(r.adConv / r.spend * 100) : 0 }));
      const tot = rows.reduce((a, r) => ({ spend: a.spend + r.spend, adConv: a.adConv + r.adConv, caRev: a.caRev + r.caRev }), { spend: 0, adConv: 0, caRev: 0 });
      return sendJson(res, 200, { ok: true, start, end, rows, totals: { ...tot, roas: tot.spend ? Math.round(tot.caRev / tot.spend * 100) : 0 }, taggedRevenue: utm.taggedRevenue, totalRevenue: utm.totalRevenue });
    } catch (e) {
      console.error('  통합 ROAS 실패:', e.message);
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // ── API: META 캠페인/소재 브레이크다운 ──
  if (url.pathname === '/api/meta' || url.pathname === '/api/meta-ads') {
    if (!metaApi.enabled()) return sendJson(res, 400, { ok: false, error: 'META 미설정 (.env META_ACCESS_TOKEN)' });
    const pad = (n) => String(n).padStart(2, '0');
    const toYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const now = new Date();
    const end = url.searchParams.get('end') || toYmd(now);
    const start = url.searchParams.get('start') || toYmd(now);
    try {
      if (url.pathname === '/api/meta') {
        console.log(`[${new Date().toISOString()}] /api/meta ${start}~${end}`);
        const data = await metaApi.getMetaBreakdown(start, end);
        return sendJson(res, 200, { ok: true, ...data });
      }
      const account = url.searchParams.get('account'), campaign = url.searchParams.get('campaign');
      if (!account || !campaign) return sendJson(res, 400, { ok: false, error: 'account, campaign 파라미터 필요' });
      console.log(`[${new Date().toISOString()}] /api/meta-ads acct=${account} camp=${campaign} ${start}~${end}`);
      const data = await metaApi.getMetaAds(account, campaign, start, end);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      console.error('  META 조회 실패:', e.message);
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // ── API: 파워링크 키워드 진짜 ROAS (네이버 광고비 × Cafe24 SA 실매출) ──
  if (url.pathname === '/api/keyword-roas') {
    if (!cafe24.enabled()) return sendJson(res, 400, { ok: false, error: 'Cafe24 토큰 미설정' });
    const pad = (n) => String(n).padStart(2, '0');
    const toYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const now = new Date();
    const end = url.searchParams.get('end') || toYmd(now);
    let start = url.searchParams.get('start');
    if (!start) { const s = new Date(now); s.setDate(s.getDate() - 29); start = toYmd(s); }
    console.log(`[${new Date().toISOString()}] /api/keyword-roas ${start}~${end}`);
    try {
      const [nv, caMap] = await Promise.all([
        getPowerlinkKeywordsRange(start, end),
        cafe24.getSaKeywordRevenue(start, end),
      ]);
      const rows = nv.rows.map((r) => {
        const c = caMap[r.norm] || null;
        return {
          keyword: r.keyword, cost: r.salesAmt, clk: r.clkCnt, imp: r.impCnt,
          nvConv: r.ccnt, nvConvAmt: r.convAmt, nvRoas: r.salesAmt ? Math.round(r.convAmt / r.salesAmt * 100) : 0,
          caRev: c ? c.revenue : 0, caPurch: c ? c.purchases : 0,
          caRoas: (c && r.salesAmt) ? Math.round(c.revenue / r.salesAmt * 100) : 0,
        };
      });
      const totals = rows.reduce((a, r) => ({ cost: a.cost + r.cost, nvConvAmt: a.nvConvAmt + r.nvConvAmt, caRev: a.caRev + r.caRev }), { cost: 0, nvConvAmt: 0, caRev: 0 });
      return sendJson(res, 200, { ok: true, start, end, campaignCount: nv.campaignCount, count: rows.length, totals, rows });
    } catch (e) {
      console.error('  키워드 ROAS 실패:', e.message);
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // ── API: 네이버 광고그룹별 효율(계층형 1단계) ──
  if (url.pathname === '/api/adgroups') {
    const campaign = url.searchParams.get('campaign');
    const date = (url.searchParams.get('date') || yesterday()).replace(/-/g, '');
    if (!campaign) return sendJson(res, 400, { ok: false, error: 'campaign 파라미터 필요' });
    if (!/^\d{8}$/.test(date)) return sendJson(res, 400, { ok: false, error: 'date는 YYYYMMDD 형식' });
    console.log(`[${new Date().toISOString()}] /api/adgroups campaign=${campaign} date=${date}`);
    try {
      const data = await getAdgroupStats(campaign, date);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      console.error('  광고그룹 조회 실패:', e.message);
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // ── API: 네이버 키워드 효율(캠페인 또는 광고그룹 단위) ──
  if (url.pathname === '/api/keywords') {
    const campaign = url.searchParams.get('campaign');
    const adgroup = url.searchParams.get('adgroup');
    const date = (url.searchParams.get('date') || yesterday()).replace(/-/g, '');
    if (!campaign && !adgroup) return sendJson(res, 400, { ok: false, error: 'campaign 또는 adgroup 파라미터 필요' });
    if (!/^\d{8}$/.test(date)) return sendJson(res, 400, { ok: false, error: 'date는 YYYYMMDD 형식' });
    console.log(`[${new Date().toISOString()}] /api/keywords ${adgroup ? 'adgroup=' + adgroup : 'campaign=' + campaign} date=${date}`);
    try {
      const data = adgroup ? await getKeywordStatsForAdgroup(adgroup, date) : await getKeywordStats(campaign, date);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      console.error('  키워드 조회 실패:', e.message);
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // ── API: 네이버 쇼핑 상품별 효율(캠페인 드릴다운) ──
  if (url.pathname === '/api/products') {
    const campaign = url.searchParams.get('campaign');
    const adgroup = url.searchParams.get('adgroup');
    const date = (url.searchParams.get('date') || yesterday()).replace(/-/g, '');
    if (!campaign && !adgroup) return sendJson(res, 400, { ok: false, error: 'campaign 또는 adgroup 파라미터 필요' });
    if (!/^\d{8}$/.test(date)) return sendJson(res, 400, { ok: false, error: 'date는 YYYYMMDD 형식' });
    console.log(`[${new Date().toISOString()}] /api/products ${adgroup ? 'adgroup=' + adgroup : 'campaign=' + campaign} date=${date}`);
    try {
      const data = adgroup ? await getProductStatsForAdgroup(adgroup, date) : await getProductStats(campaign, date);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      console.error('  상품 조회 실패:', e.message);
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // ── API: 네이버 캠페인 효율(상세) ──
  if (url.pathname === '/api/stats') {
    const date = (url.searchParams.get('date') || yesterday()).replace(/-/g, '');
    if (!/^\d{8}$/.test(date)) return sendJson(res, 400, { ok: false, error: 'date는 YYYYMMDD 형식' });
    console.log(`[${new Date().toISOString()}] /api/stats date=${date}`);
    try {
      const [data, biz] = await Promise.all([
        getCampaignStats(date),
        getBizmoney().catch(() => null),
      ]);
      return sendJson(res, 200, { ok: true, customerId: CUSTOMER, bizmoney: biz, ...data });
    } catch (e) {
      console.error('  조회 실패:', e.message, e.data || '');
      return sendJson(res, 500, { ok: false, error: e.message, detail: e.data || null });
    }
  }

  // ── 정적 파일 (public/) ──
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const fp = path.join(PUBLIC, path.normalize(rel));
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(fp, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`\n▶ 대시보드:  http://localhost:${PORT}`);
  console.log(`  광고계정 CUSTOMER_ID = ${CUSTOMER}`);
  console.log('  (Ctrl+C 로 종료)\n');
});
