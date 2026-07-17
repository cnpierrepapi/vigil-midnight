/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: import.meta.dirname,
  // the engine loads the contract runtime with webpackIgnore dynamic
  // imports (WASM classes break across duplicate module instances), so the
  // file tracer cannot see those imports; ship the files explicitly
  serverExternalPackages: [
    "@midnight-ntwrk/compact-runtime",
    "@midnight-ntwrk/onchain-runtime-v3",
  ],
  outputFileTracingIncludes: {
    "/api/**": [
      "./contract/src/managed/vigil/contract/**",
      "./node_modules/@midnight-ntwrk/**",
      "./node_modules/object-inspect/**",
    ],
  },
};

export default nextConfig;
