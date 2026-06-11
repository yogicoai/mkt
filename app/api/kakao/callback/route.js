// 카카오모먼트 비즈니스 토큰 발급 2단계 — 인가 코드 → 토큰 교환 후 Mongo KV 저장.
import kakao from '@/providers/kakao';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function html(msg) {
  return new Response(
    '<!doctype html><meta charset="utf-8"><div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;font-size:16px;line-height:1.75;color:#191f28">' + msg + '</div>',
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

export async function GET(req) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  if (err) return html('❌ 카카오 연결 실패: ' + err + ' ' + (url.searchParams.get('error_description') || ''));
  if (!code) return html('❌ 인가 코드가 없습니다. 다시 시도해주세요.');
  try {
    const redirectUri = `${url.origin}/api/kakao/callback`;
    const tok = await kakao.exchangeCode(code, redirectUri);
    return html('✅ <b>카카오모먼트 연결 완료!</b><br>승인 범위: ' + (tok.scope || '-') + '<br><br>이제 대시보드 <b>카카오 탭</b>과 <b>전체 통합표</b>에 광고비·전환·매출이 표시됩니다. 이 창은 닫으셔도 됩니다.');
  } catch (e) {
    return html('❌ 연결 실패: ' + e.message);
  }
}
