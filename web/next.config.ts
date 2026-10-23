import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // This project sits inside the API repo, which has its own lockfile: pin the root here.
  turbopack: { root: process.cwd() },
};

export default config;
