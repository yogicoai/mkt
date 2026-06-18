'use strict';

/**
 * GFA(성과형 디스플레이) 수동/엑셀/CSV 데이터 저장 — 파트너 API 미승인 대체.
 * 월별 { spend, convValue, conv } 를 Mongo KV('gfa-manual')에 보관.
 * (기존 server.js 인라인 로직을 모듈로 추출 + 파일저장 → Mongo KV로 전환)
 */
const { parseRows } = require('./xlsx-lite');
const { kvGet, kvSet } = require('./store');

const KEY = 'gfa-manual';
const num = (s) => { const n = parseFloat(String(s == null ? '' : s).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; };

function normMonth(s) {
  s = String(s == null ? '' : s).trim(); let m;
  if ((m = /(\d{4})\s*[.\-/년]\s*(\d{1,2})/.exec(s))) return m[1] + '-' + String(+m[2]).padStart(2, '0');
  if ((m = /^(\d{4})(\d{2})$/.exec(s))) return m[1] + '-' + m[2];
  if (/^\d{4,6}(\.\d+)?$/.test(s)) { const n = Math.floor(+s); if (n > 20000 && n < 60000) { const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); } }
  return '';
}

async function getData() { return kvGet(KEY, {}); }

async function setMonth(d) {
  const month = String((d && d.month) || '').trim();
  if (!/^\d{4}-\d{2}$/.test(month)) { const e = new Error('month는 YYYY-MM 형식'); e.code = 400; throw e; }
  const data = await kvGet(KEY, {});
  if (d.delete) delete data[month];
  else data[month] = { spend: Math.round(+d.spend || 0), convValue: Math.round(+d.convValue || 0), conv: Math.round(+d.conv || 0) };
  await kvSet(KEY, data);
  return data;
}

async function uploadXlsx(buf) {
  const rows = parseRows(buf);
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
  if (hi < 0) { const e = new Error('헤더(월/광고비/전환매출)를 못 찾았습니다. 컬럼명을 확인하세요.'); e.code = 400; throw e; }
  const agg = {};
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] || []; const month = normMonth(r[mC]); if (!month) continue;
    const o = agg[month] || (agg[month] = { spend: 0, convValue: 0 });
    if (sC >= 0) o.spend += num(r[sC]);
    if (vC >= 0) o.convValue += num(r[vC]);
  }
  const data = await kvGet(KEY, {});
  const months = Object.keys(agg).sort();
  for (const month of months) data[month] = { spend: Math.round(agg[month].spend), convValue: Math.round(agg[month].convValue), conv: (data[month] && data[month].conv) || 0 };
  await kvSet(KEY, data);
  return { added: months.length, months, data };
}

module.exports = { getData, setMonth, uploadXlsx };
