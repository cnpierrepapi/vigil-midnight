/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: import.meta.dirname,
  outputFileTracingIncludes: {
    "/api/**": ["./contract/src/managed/vigil/contract/**"],
  },
};

export default nextConfig;
