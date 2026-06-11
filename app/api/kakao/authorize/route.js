// 카카오모먼트 비즈니스 토큰 발급 1단계 — 동의 화면으로 리다이렉트.
import kakao from '@/providers/kakao';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req) {
  const url = new URL(req.url);
  if (!kakao.enabled()) return new Response('KAKAO_REST_API_KEY / KAKAO_AD_ACCOUNT_ID 환경변수가 필요합니다.', { status: 400 });
  const redirectUri = `${url.origin}/api/kakao/callback`; // 카카오 로그인 Redirect URI 에 이 주소가 등록돼 있어야 함
  return Response.redirect(kakao.authorizeUrl(redirectUri), 302);
}
