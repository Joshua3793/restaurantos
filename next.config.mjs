/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  // sharp is a native Node module — must stay outside webpack bundling
  // (Next.js 14 uses experimental.serverComponentsExternalPackages)
  experimental: {
    serverComponentsExternalPackages: ['sharp'],
  },
};

export default nextConfig;