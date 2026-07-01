'use strict';

/**
 * Meta(Facebook/Instagram) Marketing API — 캠페인·소재(광고)별 드릴다운 (기간 기반).
 * providers/meta.js(통합표용 계정 단일일자 요약)와 별개. 여기는 META 탭 상세용.
 * 전환 기준: 장바구니(add_to_cart) + 구매(purchase) 둘 다 수집, ROAS는 구매매출 기준(실결제).
 */

const crypto = require('crypto');
require('./naver-api'); // require 시 .env 로드 보장

const V = process.env.META_API_VERSION || 'v24.0';
const TOKEN = process.env.META_ACCESS_TOKEN;
const SECRET = process.env.META_APP_SECRET;
const ACCOUNTS = [
  { platform: 'META 요기보', id: process.env.META_AD_ACCOUNT_YOGIBO },
  { platform: 'META 샐리필', id: process.env.META_AD_ACCOUNT_SALLYFILL },
].filter((a) => a.id);
const stripAct = (s) => String(s).replace(/^act_/, '');

function enabled() { return !!TOKEN && ACCOUNTS.length > 0; }
function proof() { return SECRET ? crypto.createHmac('sha256', SECRET).update(TOKEN).digest('hex') : null; }

async function mget(pathQuery) {
  const u = new URL(`https://graph.facebook.com/${V}/${pathQuery}`);
  u.searchParams.set('access_token', TOKEN);
  const p = proof(); if (p) u.searchParams.set('appsecret_proof', p);
  const res = await fetch(u);
  const j = await res.json();
  if (j.error) throw new Error(`Meta ${j.error.code}: ${j.error.message}`);
  return j;
}
async function mgetAll(pathQuery) {
  let j = await mget(pathQuery);
  let out = (j.data || []).slice();
  let guard = 0;
  while (j.paging && j.paging.next && guard < 20) {
    const r = await fetch(j.paging.next); j = await r.json();
    if (j.error) break;
    out = out.concat(j.data || []); guard++;
  }
  return out;
}

const pick = (arr, t) => { if (!Array.isArray(arr)) return 0; const h = arr.find((a) => a.action_type === t); return h ? +h.value || 0 : 0; };
const ymd = (s) => { const d = String(s).replace(/-/g, ''); return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`; };

function metricRow(r) {
  const spend = Math.round(+r.spend || 0), imp = +r.impressions || 0, clk = +r.clicks || 0;
  return {
    spend, imp, clk,
    ctr: imp ? +(clk / imp * 100).toFixed(2) : 0,
    cpc: clk ? Math.round(spend / clk) : 0,
    cart: Math.round(pick(r.actions, 'add_to_cart')), cartVal: Math.round(pick(r.action_values, 'add_to_cart')),
    purch: Math.round(pick(r.actions, 'purchase')), purchVal: Math.round(pick(r.action_values, 'purchase')),
    roas: spend ? Math.round(Math.round(pick(r.action_values, 'purchase')) / spend * 100) : 0,
  };
}

// 계정별 캠페인 브레이크다운
async function getMetaBreakdown(start, end) {
  const tr = encodeURIComponent(JSON.stringify({ since: ymd(start), until: ymd(end) }));
  const accounts = [];
  for (const acc of ACCOUNTS) {
    const id = stripAct(acc.id);
    let campaigns = [];
    try {
      const rows = await mgetAll(`act_${id}/insights?level=campaign&time_range=${tr}&fields=campaign_id,campaign_name,spend,impressions,clicks,actions,action_values&limit=200`);
      campaigns = rows.map((r) => ({ id: r.campaign_id, name: r.campaign_name, ...metricRow(r) })).sort((a, b) => b.spend - a.spend);
    } catch (e) { /* 계정 단위 실패는 빈 배열 */ }
    const t = campaigns.reduce((a, c) => ({
      spend: a.spend + c.spend, imp: a.imp + c.imp, clk: a.clk + c.clk,
      cart: a.cart + c.cart, cartVal: a.cartVal + c.cartVal, purch: a.purch + c.purch, purchVal: a.purchVal + c.purchVal,
    }), { spend: 0, imp: 0, clk: 0, cart: 0, cartVal: 0, purch: 0, purchVal: 0 });
    accounts.push({ platform: acc.platform, id, totals: { ...t, roas: t.spend ? Math.round(t.purchVal / t.spend * 100) : 0 }, campaigns });
  }
  return { start: ymd(start), end: ymd(end), accounts };
}

// 캠페인의 소재(광고)별 + 썸네일
async function getMetaAds(account, campaign, start, end) {
  const id = stripAct(account);
  const tr = encodeURIComponent(JSON.stringify({ since: ymd(start), until: ymd(end) }));
  const flt = encodeURIComponent(JSON.stringify([{ field: 'campaign.id', operator: 'EQUAL', value: String(campaign) }]));
  const rows = await mgetAll(`act_${id}/insights?level=ad&time_range=${tr}&filtering=${flt}&fields=ad_id,ad_name,spend,impressions,clicks,actions,action_values&limit=200`);
  let ads = rows.map((r) => ({ id: r.ad_id, name: r.ad_name, ...metricRow(r) })).sort((a, b) => b.spend - a.spend);
  const ids = ads.map((a) => a.id).filter(Boolean);
  if (ids.length) {
    try {
      const thumbs = {};
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        const j = await mget(`?ids=${batch.join(',')}&fields=creative{thumbnail_url,image_url}`);
        for (const k of Object.keys(j)) { const c = j[k] && j[k].creative; if (c && (c.thumbnail_url || c.image_url)) thumbs[k] = { thumb: c.thumbnail_url || c.image_url, image: c.image_url || c.thumbnail_url }; }
      }
      ads = ads.map((a) => ({ ...a, thumb: (thumbs[a.id] || {}).thumb || '', image: (thumbs[a.id] || {}).image || '' }));
    } catch (_) { /* 썸네일 실패 무시 */ }
  }
  return { account: id, campaign: String(campaign), start: ymd(start), end: ymd(end), count: ads.length, ads };
}

// 계정 통합 소재(광고) 베스트 N — level=ad 계정단위 insights + 썸네일. 전체 탭 '매체별 베스트 소재'용.
async function getMetaBestAds(start, end, limit = 5) {
  const tr = encodeURIComponent(JSON.stringify({ since: ymd(start), until: ymd(end) }));
  const all = [];
  for (const acc of ACCOUNTS) {
    const id = stripAct(acc.id);
    try {
      const rows = await mgetAll(`act_${id}/insights?level=ad&time_range=${tr}&fields=ad_id,ad_name,campaign_name,spend,impressions,clicks,actions,action_values&limit=500`);
      rows.forEach((r) => all.push({ id: r.ad_id, name: r.ad_name, campaign: r.campaign_name, account: acc.platform, ...metricRow(r) }));
    } catch (_) { /* 계정 실패 무시 */ }
  }
  let top = all.filter((a) => a.imp > 0)
    .sort((a, b) => (b.purch - a.purch) || (b.clk - a.clk) || (b.imp - a.imp))
    .slice(0, limit);
  const ids = top.map((a) => a.id).filter(Boolean);
  if (ids.length) {
    try {
      const thumbs = {};
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        const j = await mget(`?ids=${batch.join(',')}&fields=creative{thumbnail_url,image_url}`);
        for (const k of Object.keys(j)) { const c = j[k] && j[k].creative; if (c) thumbs[k] = c.thumbnail_url || c.image_url || ''; }
      }
      top = top.map((a) => ({ ...a, thumb: thumbs[a.id] || '' }));
    } catch (_) { /* 썸네일 실패 무시 */ }
  }
  return top;
}

module.exports = { enabled, getMetaBreakdown, getMetaAds, getMetaBestAds, ACCOUNTS };
