/** @type {import('next').NextConfig} */
// 무프레임워크 대시보드를 Next.js(App Router)로 이식.
//  - 프론트는 검증된 public/index.html 정적 그대로 사용 → '/' 를 /index.html 로 rewrite.
//  - mongodb는 번들링 제외(서버 외부 패키지)로 네이티브 의존성 이슈 회피.
const nextConfig = {
  serverExternalPackages: ['mongodb'],
  async rewrites() {
    return [{ source: '/', destination: '/index.html' }];
  },
};

module.exports = nextConfig;
