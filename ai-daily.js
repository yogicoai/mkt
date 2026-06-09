'use strict';

/**
 * AI 기간 분석 — 사용자가 지정한 기간(start~end)의 광고 데이터를 모아 Claude로
 * 결과 피드백·방향성 생성. 같은 기간은 한 번만 생성하도록 파일 캐시(ai-daily.json).
 * 토큰 사용량·예상 비용도 함께 반환.
 */
const { analyze, enabled } = require('./analyze');
const naver = require('./naver-api');
const metaApi = require('./meta-api');
const cafe24 = require('./cafe24-analytics');
const { kvGet, kvSet } = require('./store');

const KEY = 'ai-daily';
const read = () => kvGet(KEY, {});   // async (Mongo KV) — 기간별 분석 캐시
const write = (d) => kvSet(KEY, d);  // async (Mongo KV)
const ymd = (s) => { const d = String(s).replace(/-/g, ''); return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`; };

// 예상 단가(요금표 기준, env로 조정 가능). 실제 청구와 다를 수 있어 '예상'.
const PIN = +process.env.ANTHROPIC_PRICE_IN || 5;     // USD / 1M input tokens
const POUT = +process.env.ANTHROPIC_PRICE_OUT || 25;  // USD / 1M output tokens
const USD_KRW = +process.env.USD_KRW || 1380;
function costOf(usage) {
  if (!usage) return null;
  const i = usage.input_tokens || 0, o = usage.output_tokens || 0;
  const usd = i / 1e6 * PIN + o / 1e6 * POUT;
  return { inputTokens: i, outputTokens: o, usd: +usd.toFixed(4), krw: Math.round(usd * USD_KRW) };
}

// 기간 전체 광고 데이터 수집 (실패 소스는 건너뜀)
async function gather(start, end) {
  const s = ymd(start), e = ymd(end);
  const [nv, meta, utm, kw] = await Promise.all([
    naver.getNaverBucketRange(s, e).catch(() => null),
    metaApi.enabled() ? metaApi.getMetaBreakdown(s, e).catch(() => null) : Promise.resolve(null),
    cafe24.enabled() ? cafe24.getUtmSales(s, e).catch(() => null) : Promise.resolve(null),
    naver.getPowerlinkKeywordsRange(s, e).catch(() => null),
  ]);
  const biz = await naver.getBizmoney().catch(() => null);

  const med = {}; if (utm) utm.byMedium.forEach((m) => { med[m.medium] = m.revenue; });
  const metaSpend = meta ? meta.accounts.reduce((a, x) => a + x.totals.spend, 0) : 0;
  const metaPurch = meta ? meta.accounts.reduce((a, x) => a + x.totals.purchVal, 0) : 0;
  const unified = [
    { 매체: '네이버 검색', 광고비: nv ? nv.검색.spend : 0, 네이버보고전환매출: nv ? nv.검색.convAmt : 0, Cafe24실매출: med['Naver'] || 0 },
    { 매체: '네이버 쇼핑', 광고비: nv ? nv.쇼핑.spend : 0, 네이버보고전환매출: nv ? nv.쇼핑.convAmt : 0, Cafe24실매출: med['shopping'] || 0 },
    { 매체: '메타', 광고비: metaSpend, 메타보고구매매출: metaPurch, Cafe24실매출: med['meta'] || 0 },
    { 매체: '카카오·플친', 광고비: 0, Cafe24실매출: (med['kakao'] || 0) + (med['Plusfriendmessage'] || 0) + (med['kakaodm'] || 0) },
  ].map((r) => ({ ...r, 진짜ROAS_퍼센트: r.광고비 ? Math.round((r.Cafe24실매출 || 0) / r.광고비 * 100) : null }));

  const kwTop = kw ? kw.rows.slice(0, 15).map((k) => ({ 키워드: k.keyword, 광고비: k.salesAmt, 클릭: k.clkCnt, 전환수: k.ccnt, 네이버전환매출: k.convAmt, ROAS_퍼센트: Math.round(k.ror) })) : [];
  const metaCamps = meta ? meta.accounts.flatMap((a) => (a.campaigns || []).filter((c) => c.spend > 0).map((c) => ({ 계정: a.platform, 캠페인: c.name, 광고비: c.spend, 구매: c.purch, 구매매출: c.purchVal, ROAS_퍼센트: c.roas }))) : [];
  const cafeTop = utm ? utm.byCampaign.slice(0, 12).map((c) => ({ 매체: c.medium, 캠페인: c.campaign, 주문: c.orders, 실매출: c.revenue })) : [];

  return {
    기간: s + ' ~ ' + e,
    매체별_광고비_실매출_진짜ROAS: unified,
    네이버_파워링크_키워드_top: kwTop,
    메타_캠페인: metaCamps,
    Cafe24_유입_캠페인_top: cafeTop,
    Cafe24_요약: utm ? { 전체주문: utm.totalOrders, 전체매출: utm.totalRevenue, UTM태그매출: utm.taggedRevenue } : null,
    현재_네이버_비즈머니잔액: biz ? biz.bizmoney : null,
  };
}

async function getAnalysis(start, end, focus, force) {
  const s = ymd(start), e = ymd(end), key = s + '_' + e + (focus ? '|' + focus : '');
  const cache = await read();
  if (!force && cache[key]) return { ...cache[key], cached: true };
  if (!enabled()) throw new Error('ANTHROPIC_API_KEY 미설정 (.env)');
  const data = await gather(start, end);
  const out = await analyze(data, focus);
  const rec = { start: s, end: e, focus: focus || '', text: out.text, model: out.model, usage: out.usage, cost: costOf(out.usage), generatedAt: new Date().toISOString() };
  cache[key] = rec; await write(cache);
  return { ...rec, cached: false };
}

module.exports = { getAnalysis, enabled };
