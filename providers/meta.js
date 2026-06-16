'use strict';

// Meta(Facebook/Instagram) Marketing API 어댑터
// 광고비/전환/전환매출 = act_<id>/insights, 잔액 = act_<id> balance/spend_cap
const crypto = require('crypto');
const { dash } = require('../naver-api'); // require 시 .env 로드 보장 + dash 유틸

const V = process.env.META_API_VERSION || 'v24.0';
const TOKEN = process.env.META_ACCESS_TOKEN;
const SECRET = process.env.META_APP_SECRET;
const PURCHASE = process.env.META_PURCHASE_ACTION || 'omni_purchase';
const ACCOUNTS = [
  { platform: 'META 요기보', id: process.env.META_AD_ACCOUNT_YOGIBO },
  { platform: 'META 샐리필', id: process.env.META_AD_ACCOUNT_SALLYFILL },
].filter((a) => a.id);

const ZERO_DEC = ['KRW', 'JPY', 'VND', 'CLP']; // 소수 없는 통화
const minor = (v, cur) => (ZERO_DEC.includes(cur) ? Math.round(+v || 0) : Math.round((+v || 0) / 100));
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

// actions/action_values 배열에서 구매 전환값 추출
function pick(arr, type) {
  if (!Array.isArray(arr)) return 0;
  const hit = arr.find((a) => a.action_type === type)
    || arr.find((a) => a.action_type === 'purchase')
    || arr.find((a) => a.action_type === 'offsite_conversion.fc_purchase');
  return hit ? +hit.value || 0 : 0;
}

async function one(acc, date) {
  const since = dash(date);
  const tr = encodeURIComponent(JSON.stringify({ since, until: since }));
  const ins = await mget(`act_${stripAct(acc.id)}/insights?level=account&time_range=${tr}&fields=spend,impressions,clicks,actions,action_values`);
  const row = (ins.data && ins.data[0]) || {};
  const spend = Math.round(+row.spend || 0); // insights spend = 통화 실제단위
  const imp = Math.round(+row.impressions || 0), clk = Math.round(+row.clicks || 0);
  const conv = Math.round(pick(row.actions, PURCHASE));
  const rev = Math.round(pick(row.action_values, PURCHASE));

  let balance = null, note = '';
  try {
    const a = await mget(`act_${stripAct(acc.id)}?fields=balance,spend_cap,amount_spent,currency`);
    const cur = a.currency || 'KRW';
    if (a.spend_cap && +a.spend_cap > 0) balance = minor(a.spend_cap, cur) - minor(a.amount_spent, cur); // 한도잔여 (리포트 잔액과 일치 검증됨)
    else if (a.balance != null) { balance = minor(a.balance, cur); note = '잔액=미청구액(한도 미설정)'; }
  } catch (_) { /* 잔액 실패는 무시 */ }

  return { platform: acc.platform, spend, conversions: conv, convValue: rev, imp, clk, balance, currency: 'KRW', note };
}

module.exports = {
  id: 'meta',
  label: 'META',
  enabled,
  async getSummary(date) {
    return Promise.all(ACCOUNTS.map((a) => one(a, date)));
  },
};
