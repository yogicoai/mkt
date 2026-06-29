// 무프레임워크 server.js 의 모든 /api/* 라우트를 Next.js(App Router)로 이식한 캐치올 핸들러.
//  - 기존 백엔드 모듈(naver-api, cafe24-analytics, meta-api, providers, analyze, ai-daily, campaigns, gfa)을 그대로 재사용.
//  - 파일 저장(*.json)은 Mongo KV(store.js)로 대체됨.
//  - nodejs 런타임 강제(crypto/zlib/mongodb 사용), 캐시 끔, AI 분석을 위해 maxDuration 확장.
import naver from '@/naver-api';
import providers from '@/providers';
import analyzeMod from '@/analyze';
import store from '@/store';
import cafe24 from '@/cafe24-analytics';
import metaApi from '@/meta-api';
import aiDaily from '@/ai-daily';
import campaigns from '@/campaigns';
import gfa from '@/gfa';
import kakao from '@/providers/kakao';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // AI 기간분석(다중 API 수집 + Claude) 대비

const J = (obj, status = 200) => Response.json(obj, { status });
const pad = (n) => String(n).padStart(2, '0');
const toYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export async function GET(req) {
  const url = new URL(req.url);
  const p = url.pathname;
  const sp = url.searchParams;
  try {
    // ── 전 플랫폼 통합 요약 ──
    if (p === '/api/summary') {
      const date = (sp.get('date') || naver.yesterday()).replace(/-/g, '');
      if (!/^\d{8}$/.test(date)) return J({ ok: false, error: 'date는 YYYYMMDD 형식' }, 400);
      const data = await providers.getAllSummaries(date);
      if (store.configured()) { try { await store.saveDaily(date, data.rows); } catch (_) {} } // 추이 자동 적재(daily_stats)
      return J({ ok: true, ...data });
    }

    // ── 광고 데이터 일일 자동 수집 (Vercel Cron) ──
    //   대시보드를 아무도 안 열어도 매일 채워지게: 최근 N일(기본 3일) 전 매체를 재수집해 daily_stats 멱등 upsert.
    //   최근일은 플랫폼 확정 지연이 있어 매일 재수집해 보정(부분 적재 → 완성). CRON_SECRET 설정 시 Bearer 인증.
    if (p === '/api/cron/backfill') {
      const auth = req.headers.get('authorization') || '';
      if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) return J({ ok: false, error: 'unauthorized' }, 401);
      if (!store.configured()) return J({ ok: false, error: 'MONGODB_URI 미설정' }, 400);
      const days = Math.max(1, Math.min(7, +(sp.get('days') || 3)));
      const base = new Date();
      const collected = [];
      for (let i = 0; i < days; i++) {
        const dt = new Date(base); dt.setDate(base.getDate() - i);
        const date = toYmd(dt).replace(/-/g, '');
        try {
          const data = await providers.getAllSummaries(date);
          await store.saveDaily(date, data.rows);
          collected.push({ date, rows: data.rows.length, spend: data.rows.reduce((s, r) => s + (+r.spend || 0), 0), errors: data.errors, disabled: data.disabled });
        } catch (e) { collected.push({ date, error: e.message }); }
      }
      return J({ ok: true, at: new Date().toISOString(), days, collected });
    }

    // ── 일자별 추이 (MongoDB daily_stats) ──
    if (p === '/api/trend') {
      if (!store.configured()) return J({ ok: false, error: 'MONGODB_URI 미설정' }, 400);
      const since = (sp.get('since') || '').replace(/-/g, '');
      const until = (sp.get('until') || '').replace(/-/g, '');
      const d = await store.getDb();
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
      return J({ ok: true, dates, series, rowCount: docs.length });
    }

    // ── Cafe24 유입/UTM별 매출 ──
    if (p === '/api/utm') {
      if (!cafe24.enabled()) return J({ ok: false, error: 'Cafe24 토큰 소스 미설정 (CAFE24_TOKEN_URI/CAFE24_MALL_ID)' }, 400);
      const now = new Date();
      const end = sp.get('end') || toYmd(now);
      let start = sp.get('start');
      if (!start) { const s = new Date(now); s.setDate(s.getDate() - 29); start = toYmd(s); }
      const [sales, adsales, effect] = await Promise.all([
        cafe24.getUtmSales(start, end),
        cafe24.getAdSales(start, end).catch(() => null),
        cafe24.getAdEffect(start, end).catch(() => null),
      ]);
      return J({ ok: true, start: sales.start, end: sales.end, sales, adsales, effect });
    }

    // ── 캠페인 업로드 데이터 기간 조회 ──
    if (p === '/api/campaigns') {
      const start = (sp.get('start') || '').replace(/-/g, '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
      const end = (sp.get('end') || '').replace(/-/g, '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
      return J({ ok: true, start, end, ...(await campaigns.query(start, end)) });
    }

    // ── 크리테오 (기간 + 광고세트별) ──
    if (p === '/api/criteo') {
      const now = new Date();
      const end = sp.get('end') || toYmd(now);
      const start = sp.get('start') || end;
      const criteo = (providers.providers || []).find((x) => x.id === 'criteo');
      if (!criteo || !criteo.enabled()) return J({ ok: false, error: '크리테오 자격증명이 설정되지 않았습니다' }, 400);
      return J({ ok: true, ...(await criteo.getBreakdown(start, end)) });
    }

    // ── AI 기간 분석 ──
    if (p === '/api/ai-analyze') {
      const now = new Date();
      const end = (sp.get('end') || toYmd(now)).replace(/-/g, '');
      const start = (sp.get('start') || toYmd(now)).replace(/-/g, '');
      if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) return J({ ok: false, error: 'start/end는 YYYYMMDD 형식' }, 400);
      const force = sp.get('force') === '1';
      const focus = (sp.get('focus') || '').slice(0, 500);
      const r = await aiDaily.getAnalysis(start, end, focus, force);
      return J({ ok: true, ...r });
    }

    // ── 일일보고(텍스트) 데이터 — 장바구니매출·광고비·잔액 (선택 날짜 기준) ──
    if (p === '/api/daily-report') {
      const date = (sp.get('date') || naver.yesterday()).replace(/-/g, '');
      if (!/^\d{8}$/.test(date)) return J({ ok: false, error: 'date는 YYYYMMDD 형식' }, 400);
      const dDash = date.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
      const [sum, nvConv, gfaQ] = await Promise.all([
        providers.getAllSummaries(date),
        naver.getConversionBreakdown(date).catch(() => null),
        campaigns.query(dDash, dDash).catch(() => null),
      ]);
      const rows = sum.rows || [];
      const erred = new Set((sum.errors || []).map((e) => e.platform));
      const pick = (re) => rows.filter((r) => re.test(r.platform || ''));
      const sumSp = (rs) => rs.reduce((a, r) => a + (r.spend || 0), 0);
      const nv = pick(/^네이버/), mt = pick(/^META/), cr = pick(/criteo|크리테오/i), kk = pick(/카카오/);
      const gfaT = (gfaQ && gfaQ.totals) || null;
      const spend = {
        naver: sumSp(nv), meta: sumSp(mt),
        criteo: cr.length ? sumSp(cr) : ((erred.has('Criteo') || erred.has('크리테오')) ? null : 0),
        kakao: kk.length ? sumSp(kk) : 0,
        gfa: gfaT ? Math.round(gfaT.spend || 0) : 0,
      };
      spend.total = (spend.naver || 0) + (spend.meta || 0) + (spend.criteo || 0) + (spend.kakao || 0) + (spend.gfa || 0);
      const metaCart = mt.reduce((a, r) => ({ cnt: a.cnt + (r.conversions || 0), val: a.val + (r.convValue || 0) }), { cnt: 0, val: 0 });
      const cart = {
        naver: (nvConv && nvConv.totals) ? { cnt: nvConv.totals.cartCnt || 0, val: nvConv.totals.cartVal || 0 } : null,
        meta: metaCart,
        gfa: gfaT ? { cnt: Math.round(gfaT.cart || 0), val: Math.round(gfaT.cartVal || 0) } : null,
      };
      const balOf = (rs) => { const r = rs.find((x) => x.balance != null); return r ? r.balance : null; };
      const metaY = rows.find((r) => /요기보/.test(r.platform || ''));
      const metaS = rows.find((r) => /샐리필|sally/i.test(r.platform || ''));
      const balance = {
        naver: balOf(nv),
        metaYogibo: metaY ? metaY.balance : null,
        metaSally: metaS ? metaS.balance : null,
        kakao: balOf(kk),
      };
      return J({ ok: true, date, spend, cart, balance, errors: sum.errors, disabled: sum.disabled });
    }

    // ── GFA 수동/엑셀 데이터 조회 ──
    if (p === '/api/gfa') {
      return J({ ok: true, data: await gfa.getData() });
    }

    // ── 매체별 진짜 ROAS (광고비 × Cafe24 실매출) ──
    if (p === '/api/unified-roas') {
      if (!cafe24.enabled()) return J({ ok: false, error: 'Cafe24 토큰 미설정' }, 400);
      const now = new Date();
      const end = sp.get('end') || toYmd(now);
      const start = sp.get('start') || toYmd(now);
      const [nv, meta, utm] = await Promise.all([
        naver.getNaverBucketRange(start, end),
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
      return J({ ok: true, start, end, rows, totals: { ...tot, roas: tot.spend ? Math.round(tot.caRev / tot.spend * 100) : 0 }, taggedRevenue: utm.taggedRevenue, totalRevenue: utm.totalRevenue });
    }

    // ── META 캠페인/소재 브레이크다운 ──
    if (p === '/api/meta' || p === '/api/meta-ads') {
      if (!metaApi.enabled()) return J({ ok: false, error: 'META 미설정 (META_ACCESS_TOKEN)' }, 400);
      const now = new Date();
      const end = sp.get('end') || toYmd(now);
      const start = sp.get('start') || toYmd(now);
      if (p === '/api/meta') {
        const data = await metaApi.getMetaBreakdown(start, end);
        return J({ ok: true, ...data });
      }
      const account = sp.get('account'), campaign = sp.get('campaign');
      if (!account || !campaign) return J({ ok: false, error: 'account, campaign 파라미터 필요' }, 400);
      const data = await metaApi.getMetaAds(account, campaign, start, end);
      return J({ ok: true, ...data });
    }

    // ── 파워링크 키워드 진짜 ROAS ──
    if (p === '/api/keyword-roas') {
      if (!cafe24.enabled()) return J({ ok: false, error: 'Cafe24 토큰 미설정' }, 400);
      const now = new Date();
      const end = sp.get('end') || toYmd(now);
      let start = sp.get('start');
      if (!start) { const s = new Date(now); s.setDate(s.getDate() - 29); start = toYmd(s); }
      const [nv, caMap] = await Promise.all([
        naver.getPowerlinkKeywordsRange(start, end),
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
      return J({ ok: true, start, end, campaignCount: nv.campaignCount, count: rows.length, totals, rows });
    }

    // ── 네이버 광고그룹별 효율 (기간 합산) ──
    if (p === '/api/adgroups') {
      const campaign = sp.get('campaign');
      const start = (sp.get('start') || sp.get('date') || naver.yesterday()).replace(/-/g, '');
      const end = (sp.get('end') || sp.get('date') || start).replace(/-/g, '');
      if (!campaign) return J({ ok: false, error: 'campaign 파라미터 필요' }, 400);
      if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) return J({ ok: false, error: 'start/end는 YYYYMMDD 형식' }, 400);
      return J({ ok: true, ...(await naver.getAdgroupStats(campaign, start, end)) });
    }

    // ── 네이버 키워드 효율 (기간 합산) ──
    if (p === '/api/keywords') {
      const campaign = sp.get('campaign');
      const adgroup = sp.get('adgroup');
      const start = (sp.get('start') || sp.get('date') || naver.yesterday()).replace(/-/g, '');
      const end = (sp.get('end') || sp.get('date') || start).replace(/-/g, '');
      if (!campaign && !adgroup) return J({ ok: false, error: 'campaign 또는 adgroup 파라미터 필요' }, 400);
      if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) return J({ ok: false, error: 'start/end는 YYYYMMDD 형식' }, 400);
      const data = adgroup ? await naver.getKeywordStatsForAdgroup(adgroup, start, end) : await naver.getKeywordStats(campaign, start, end);
      return J({ ok: true, ...data });
    }

    // ── 네이버 쇼핑 상품별 효율 (기간 합산) ──
    if (p === '/api/products') {
      const campaign = sp.get('campaign');
      const adgroup = sp.get('adgroup');
      const start = (sp.get('start') || sp.get('date') || naver.yesterday()).replace(/-/g, '');
      const end = (sp.get('end') || sp.get('date') || start).replace(/-/g, '');
      if (!campaign && !adgroup) return J({ ok: false, error: 'campaign 또는 adgroup 파라미터 필요' }, 400);
      if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) return J({ ok: false, error: 'start/end는 YYYYMMDD 형식' }, 400);
      const data = adgroup ? await naver.getProductStatsForAdgroup(adgroup, start, end) : await naver.getProductStats(campaign, start, end);
      return J({ ok: true, ...data });
    }

    // ── 네이버 캠페인 효율(상세) + 구매/장바구니 분해 (기간 합산) ──
    if (p === '/api/stats') {
      const start = (sp.get('start') || sp.get('date') || naver.yesterday()).replace(/-/g, '');
      const end = (sp.get('end') || sp.get('date') || start).replace(/-/g, '');
      if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) return J({ ok: false, error: 'start/end는 YYYYMMDD 형식' }, 400);
      const [data, biz, conv] = await Promise.all([
        naver.getCampaignStats(start, end),
        naver.getBizmoney().catch(() => null),
        naver.getConversionBreakdownRange(start, end).catch(() => null),
      ]);
      // 캠페인별 구매(purchase)/장바구니(add_to_cart) 병합 → 실구매 ROAS·구매전환율
      if (conv && conv.byCampaign && Array.isArray(data.rows)) {
        for (const r of data.rows) {
          const b = conv.byCampaign[r.id] || { buyCnt: 0, buyVal: 0, cartCnt: 0, cartVal: 0 };
          r.buyCnt = b.buyCnt; r.buyVal = b.buyVal;
          r.buyRoas = r.salesAmt ? Math.round(b.buyVal / r.salesAmt * 100) : 0;
          r.buyCvr = r.clkCnt ? +(b.buyCnt / r.clkCnt * 100).toFixed(2) : 0;
          r.cartCnt = b.cartCnt; r.cartVal = b.cartVal;
        }
      }
      return J({
        ok: true, customerId: naver.CUSTOMER, bizmoney: biz,
        convBuilt: !!(conv && conv.byCampaign && (conv.daysBuilt == null || conv.daysBuilt > 0)),
        convDaysMissing: conv && conv.daysMissing != null ? conv.daysMissing : null,
        ...data,
      });
    }

    // ── 카카오모먼트 (보고서 + 연결상태) ──
    if (p === '/api/kakao') {
      if (!kakao.enabled()) return J({ ok: false, error: '카카오 미설정 (KAKAO_REST_API_KEY / KAKAO_AD_ACCOUNT_ID)' }, 400);
      const connected = await kakao.hasToken();
      if (!connected) return J({ ok: true, connected: false, authUrl: '/api/kakao/authorize' });
      const date = (sp.get('date') || naver.yesterday()).replace(/-/g, '');
      if (!/^\d{8}$/.test(date)) return J({ ok: false, error: 'date는 YYYYMMDD 형식' }, 400);
      const rows = await kakao.getSummary(date);
      return J({ ok: true, connected: true, date, rows });
    }

    return J({ ok: false, error: 'not found: ' + p }, 404);
  } catch (e) {
    return J({ ok: false, error: e.message, detail: e.data || null }, e.code === 400 ? 400 : 500);
  }
}

export async function POST(req) {
  const url = new URL(req.url);
  const p = url.pathname;
  const sp = url.searchParams;
  try {
    // ── AI 분석 (Claude) — 레거시 단일 데이터 분석 ──
    if (p === '/api/analyze') {
      if (!analyzeMod.enabled()) return J({ ok: false, error: 'ANTHROPIC_API_KEY 미설정' }, 400);
      const data = await req.json().catch(() => ({}));
      const out = await analyzeMod.analyze(data);
      return J({ ok: true, ...out });
    }

    // ── 캠페인 엑셀/CSV 업로드 → 저장 (단일 raw 또는 JSON {files:[base64]} 대량) ──
    if (p === '/api/campaigns-upload') {
      const fallbackDate = sp.get('end') || sp.get('start') || '';
      const ct = req.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        const body = await req.json().catch(() => ({}));
        const list = Array.isArray(body.files) ? body.files : [];
        if (!list.length) return J({ ok: false, error: '업로드할 파일이 없습니다' }, 400);
        const buffers = list.map((b) => Buffer.from(String(b || ''), 'base64'));
        const r = await campaigns.parseUploadMany(buffers, { fallbackDate, names: Array.isArray(body.names) ? body.names : [] });
        return J({ ok: true, ...r });
      }
      const buf = Buffer.from(await req.arrayBuffer());
      const r = await campaigns.parseUpload(buf, { fallbackDate });
      return J({ ok: true, ...r });
    }

    // ── 캠페인 데이터 삭제 (전체 / 기간) ──
    if (p === '/api/campaigns-delete') {
      const d = await req.json().catch(() => ({}));
      const r = d.all ? await campaigns.clearAll() : await campaigns.clearRange(d.start, d.end);
      return J({ ok: true, ...r });
    }

    // ── GFA 수동 입력(월별) ──
    if (p === '/api/gfa') {
      const d = await req.json().catch(() => ({}));
      const data = await gfa.setMonth(d);
      return J({ ok: true, data });
    }

    // ── GFA 엑셀/CSV 업로드 ──
    if (p === '/api/gfa-upload') {
      const buf = Buffer.from(await req.arrayBuffer());
      const r = await gfa.uploadXlsx(buf);
      return J({ ok: true, ...r });
    }

    return J({ ok: false, error: 'not found: ' + p }, 404);
  } catch (e) {
    return J({ ok: false, error: e.message }, e.code === 400 ? 400 : 500);
  }
}
