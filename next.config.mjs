/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.module.rules.push({
      test: /\.(ttf|html)$/i,
      type: 'asset/resource'
    });
    return config;
  },
  experimental: {
    serverMinification: false, // the server minification unfortunately breaks the selector class names
    // curl-cffi ships a native N-API addon (@tocha688/libcurl's platform .node binary); webpack
    // can't parse that file, so it must stay a real runtime require() instead of being bundled.
    serverComponentsExternalPackages: ['curl-cffi', '@tocha688/libcurl'],
  },
};  

export default nextConfig;
