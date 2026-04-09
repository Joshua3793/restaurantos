/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // pdf-parse reads files from disk at import time — must not be bundled by webpack
    serverComponentsExternalPackages: ['pdf-parse'],
  },
};

export default nextConfig;
