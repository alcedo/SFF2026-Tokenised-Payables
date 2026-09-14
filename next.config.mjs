/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The reset control reloads the world by executing these files at runtime, so
  // they have to reach the deployment. Without this they are left behind as
  // "unused" and Reset world fails only in production, which is the worst place
  // to find out.
  outputFileTracingIncludes: {
    '/reset': ['./db/*.sql'],
  },
};
