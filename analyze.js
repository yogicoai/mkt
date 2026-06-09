'use strict';

// Claude API로 광고 성과를 분석해 비마케터용 한국어 진단/추천을 생성
// SDK 없이 내장 fetch 사용. (Messages API: POST /v1/messages)
require('./naver-api'); // .env 로드 보장

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

function enabled() { return !!KEY; }

const SYSTEM = `당신은 한국 이커머스(요기보) 광고 성과 분석 전문가입니다. 보는 사람은 마케터가 아니므로 전문용어를 피하고 평이한 한국어로 설명합니다.
주어진 '대상 기간'의 광고 데이터(JSON, 단위 원)를 보고, 단순 현황 나열이 아니라 결과에 대한 평가와 앞으로의 방향성·실행 피드백을 주세요.
데이터 구성: 매체별 광고비/실매출/진짜ROAS, 네이버 파워링크 키워드별 성과, 메타 캠페인, Cafe24 유입 캠페인, 비즈머니 잔액.
⚠️ '광고매체 보고 전환매출'과 'Cafe24 실매출'은 집계 기준이 달라 차이날 수 있습니다. 진짜 성과 판단은 Cafe24 실매출(정산 기준)을 우선하세요.
아래 형식으로:
1) 📊 기간 총평 — 이 기간 광고가 전반적으로 어땠는지(실매출·ROAS 기준, 쉽게).
2) 🟢 잘 된 곳 — 효율 좋은 매체/키워드/소재. "예산 확대" 식 구체 추천.
3) 🔴 점검할 곳 — 광고비 대비 실매출/전환 낮은 항목. "축소·중단·점검" 식.
4) 🧭 방향성 — 앞으로 키워드·소재·예산을 어떻게 가져갈지. 전환 잘되는 키워드는 확장, 안되는 건 정리, 예산은 어디로 옮길지. 데이터 근거로 구체적으로.
5) 💡 지금 할 액션 3가지 — 숫자 인용한 실행가능한 행동.
규칙: 반드시 실제 숫자를 인용. 추천은 실행가능하게. 마크다운(##, **굵게**, - 목록)으로 간결하게. 서론·사족 없이 바로 분석부터. 데이터에 없는 건 추측하지 말 것.`;

async function analyze(data, focus) {
  if (!KEY) throw new Error('ANTHROPIC_API_KEY 미설정');
  const userContent =
    `대상 기간: ${data.기간 || data.date || '미상'}\n` +
    (focus ? `\n★ 사용자가 특별히 보고 싶은 것(이걸 우선·중점으로 다루되, 전체 형식도 유지): ${focus}\n` : '') +
    `\n아래는 해당 기간의 광고 성과 데이터(JSON)입니다. 위 형식대로 분석해 주세요.\n\n` +
    '```json\n' + JSON.stringify(data, null, 2) + '\n```';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  const j = await res.json();
  if (j.error) throw new Error(`Claude ${j.error.type}: ${j.error.message}`);
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { text, model: j.model, usage: j.usage };
}

module.exports = { analyze, enabled, model: () => MODEL };
