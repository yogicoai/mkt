'use strict';

/**
 * 네이버 검색광고 API - 브랜드스토어(쇼핑검색광고 브랜드형) 광고 효율 조회 테스트
 *
 * 무의존성 (Node 18+ 내장 fetch / crypto 사용).
 * 사용법:
 *   node naver-ad.js              # 어제 데이터
 *   node naver-ad.js 20260607     # 특정 일자(YYYYMMDD)
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

function need() {
  const miss = [];
  if (!API_KEY) miss.push('NAVER_AD_API_KEY');
  if (!SECRET) miss.push('NAVER_AD_SECRET_KEY');
  if (!CUSTOMER) miss.push('NAVER_AD_CUSTOMER_ID');
  if (miss.length) {
    console.error('\n❌ .env 설정 누락:', miss.join(', '));
    console.error('   .env.example 을 복사해 .env 를 만들고 값을 채워주세요.\n');
    process.exit(1);
  }
}

// ── 서명 (HMAC-SHA256, base64) : message = "{ts}.{method}.{uri}" ──
function sign(ts, method, uri) {
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

// ── 날짜 유틸 ────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const dash = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

function targetDate() {
  const arg = process.argv[2];
  if (arg && /^\d{8}$/.test(arg)) return arg;
  const d = new Date();
  d.setDate(d.getDate() - 1); // 어제 (로컬=KST 기준)
  return ymd(d);
}

// ── 1) 인증 확인 + 캠페인 목록 ───────────────────────────
async function listCampaigns() {
  console.log('\n━━ 1) 인증 확인 + 캠페인 목록 ━━━━━━━━━━━━━━━━');
  const camps = await api('GET', '/ncc/campaigns');
  console.log(`✅ 인증 성공 — 캠페인 ${camps.length}개\n`);
  for (const c of camps) {
    console.log(`  [${c.campaignTp}] ${c.name}  (id=${c.nccCampaignId}, status=${c.status})`);
  }
  // 쇼핑검색광고(브랜드스토어 포함) 캠페인만 추려서 반환
  const shopping = camps.filter((c) => c.campaignTp === 'SHOPPING');
  console.log(`\n  → 쇼핑검색광고(SHOPPING) 캠페인: ${shopping.length}개`);
  return camps;
}

// ── 2) 캠페인별 일자 효율 (Stat API: 명명된 지표 JSON) ───
const FIELDS = ['impCnt', 'clkCnt', 'ctr', 'cpc', 'salesAmt', 'ccnt', 'convAmt', 'ror'];
const LABEL = {
  impCnt: '노출', clkCnt: '클릭', ctr: 'CTR%', cpc: 'CPC',
  salesAmt: '광고비', ccnt: '전환수', convAmt: '전환매출', ror: 'ROAS%',
};

async function campaignStats(camps, dateStr) {
  console.log(`\n━━ 2) 캠페인별 효율 — ${dash(dateStr)} ━━━━━━━━━━━━━━`);
  const since = dash(dateStr);
  const rows = [];
  for (const c of camps) {
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
    } catch (e) {
      console.log(`  ▸ ${c.name}: 통계 조회 실패 — ${e.message}`);
      if (e.data) console.log(`    ${JSON.stringify(e.data)}`);
    }
    rows.push({
      name: c.name, tp: c.campaignTp, status: c.status,
      impCnt: +m.impCnt || 0, clkCnt: +m.clkCnt || 0, ctr: +m.ctr || 0,
      cpc: +m.cpc || 0, salesAmt: +m.salesAmt || 0, ccnt: +m.ccnt || 0,
      convAmt: +m.convAmt || 0, ror: +m.ror || 0,
    });
  }

  // 엑셀용 CSV 저장 (전체 캠페인, 한글 깨짐 방지 BOM)
  const outDir = path.join(__dirname, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const csvFile = path.join(outDir, `campaigns_${dateStr}.csv`);
  const head = '일자,캠페인,유형,상태,노출,클릭,CTR,CPC,광고비,전환수,전환매출,ROAS';
  const csv = [head, ...rows.map((r) =>
    [dateStr, `"${r.name.replace(/"/g, '""')}"`, r.tp, r.status,
     r.impCnt, r.clkCnt, r.ctr, r.cpc, r.salesAmt, r.ccnt, r.convAmt, r.ror].join(','))].join('\n');
  fs.writeFileSync(csvFile, '﻿' + csv, 'utf8');

  // 콘솔 요약 (노출>0 만, 광고비 내림차순)
  const n = (v) => Number(v).toLocaleString('ko-KR');
  const active = rows.filter((r) => r.impCnt > 0).sort((a, b) => b.salesAmt - a.salesAmt);
  console.log(`  (전체 ${rows.length}개 중 노출 발생 ${active.length}개 — 나머지는 OFF/노출0, CSV에 전부 저장)\n`);
  active.forEach((r, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}) ${r.name}\n` +
      `      광고비 ${n(r.salesAmt)}  노출 ${n(r.impCnt)}  클릭 ${n(r.clkCnt)}  ` +
      `CTR ${r.ctr}%  CPC ${n(r.cpc)}  전환 ${r.ccnt}  전환매출 ${n(r.convAmt)}  ROAS ${Math.round(r.ror)}%`);
  });

  // 합계 (노출 발생분 기준)
  const s = active.reduce((a, r) => ({
    imp: a.imp + r.impCnt, clk: a.clk + r.clkCnt, cost: a.cost + r.salesAmt,
    conv: a.conv + r.ccnt, rev: a.rev + r.convAmt,
  }), { imp: 0, clk: 0, cost: 0, conv: 0, rev: 0 });
  const ctr = s.imp ? (s.clk / s.imp * 100).toFixed(2) : '0';
  const cpc = s.clk ? Math.round(s.cost / s.clk) : 0;
  const roas = s.cost ? Math.round(s.rev / s.cost * 100) : 0;
  console.log('\n  ━ 합계 ━');
  console.log(`    광고비 ${n(s.cost)}  노출 ${n(s.imp)}  클릭 ${n(s.clk)}  ` +
    `CTR ${ctr}%  CPC ${n(cpc)}  전환 ${s.conv}  전환매출 ${n(s.rev)}  ROAS ${roas}%`);
  console.log(`\n  💾 CSV 저장: ${csvFile}`);
}

// ── 3) 브랜드스토어 상품별 보고서 (StatReport) ──────────
async function brandStoreReport(dateStr) {
  console.log(`\n━━ 3) 브랜드스토어 상품별 보고서(SHOPPINGBRANDPRODUCT) — ${dateStr} ━━`);
  let job;
  try {
    job = await api('POST', '/stat-reports', {
      body: { reportTp: 'SHOPPINGBRANDPRODUCT', statDt: dateStr },
    });
  } catch (e) {
    console.log(`  ⚠️ 보고서 생성 실패 — ${e.message}`);
    if (e.data) console.log(`    ${JSON.stringify(e.data)}`);
    return;
  }
  const jobId = job.reportJobId;
  console.log(`  생성됨: jobId=${jobId}, status=${job.status}`);

  let status = job.status, info = job, tries = 0;
  while (['REGIST', 'RUNNING', 'WAITING', 'AGGREGATING'].includes(status) && tries < 60) {
    await sleep(3000);
    info = await api('GET', `/stat-reports/${jobId}`);
    status = info.status;
    process.stdout.write(`\r  상태: ${status} (${++tries})        `);
  }
  console.log('');

  if (status === 'NONE') {
    console.log('  ℹ️ 데이터 없음(NONE) — 해당 일자에 브랜드형 쇼핑광고 노출이 없습니다.');
    console.log('     ("001. 브랜드형 쇼핑광고_스토어" 캠페인이 OFF면 정상. 광고 돌린 날짜로 다시 시도)');
    return;
  }
  if (status !== 'BUILT') {
    console.log(`  ⚠️ 미완료 (status=${status}). 잠시 후 다시 시도해 주세요.`);
    return;
  }

  const dl = info.downloadUrl;
  const dlPath = new URL(dl).pathname;
  const res = await fetch(dl, { method: 'GET', headers: authHeaders('GET', dlPath) });
  if (!res.ok) { console.log(`  ⚠️ 다운로드 실패 — HTTP ${res.status}`); return; }
  const tsv = await res.text();

  const outDir = path.join(__dirname, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `SHOPPINGBRANDPRODUCT_${dateStr}.tsv`);
  fs.writeFileSync(outFile, tsv, 'utf8');

  const rows = tsv.split(/\r?\n/).filter(Boolean);
  console.log(`  ✅ 저장: ${outFile}`);
  console.log(`  데이터 행수: ${rows.length}`);
  if (rows.length) {
    console.log('  ── 상위 5행 (탭 구분 원본) ──');
    rows.slice(0, 5).forEach((r, i) => console.log(`  [${i}] ${r.split('\t').join(' | ')}`));
    console.log('\n  ※ 이 파일은 헤더 없는 TSV 입니다. 실제 컬럼 순서를 확인한 뒤');
    console.log('     효율(노출·클릭·광고비·전환) 집계 매핑을 붙이면 됩니다.');
  } else {
    console.log('  (행 없음 — 해당 일자 브랜드스토어 노출/지표가 없을 수 있습니다.)');
  }
}

// ── main ────────────────────────────────────────────────
(async () => {
  need();
  const dateStr = targetDate();
  console.log(`\n대상 일자: ${dateStr}   |   고객 ID: ${CUSTOMER}`);
  const camps = await listCampaigns();
  await campaignStats(camps, dateStr);
  await brandStoreReport(dateStr);
  console.log('\n완료 ✅\n');
})().catch((e) => {
  console.error('\n실패:', e.message);
  if (e.data) console.error('응답:', JSON.stringify(e.data, null, 2));
  console.error('\n[자주 나는 오류]');
  console.error(' - 401 / invalid-signature : SECRET_KEY 또는 시스템 시계(시간) 확인');
  console.error(' - 403                    : API_KEY / CUSTOMER_ID 권한 확인');
  process.exit(1);
});
