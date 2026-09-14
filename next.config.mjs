/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // First-request bootstrap and Reset world execute these files at runtime, so
  // they have to reach every serverless bundle. Any route can be the first
  // request against a fresh database.
  outputFileTracingIncludes: {
    '/**': ['./db/*.sql'],
  },
};
