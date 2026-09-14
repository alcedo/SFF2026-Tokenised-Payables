/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Reset world and the empty-database bootstrap both execute these files at
  // runtime, so they have to reach every serverless bundle. Without this they
  // are left behind as "unused" and those paths fail only in production.
  outputFileTracingIncludes: {
    // Any route can be the first request against a fresh database, and Reset
    // world can be posted from /reset. Both read these files at runtime.
    '/**': ['./db/*.sql'],
  },
};
