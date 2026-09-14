/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // Base units are bigint end to end; serialising them is the API boundary's job.
  experimental: { typedRoutes: false },
};
