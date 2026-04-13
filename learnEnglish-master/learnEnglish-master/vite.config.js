import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    // Skip gzip/brotli size reporting to speed up production build.
    reportCompressedSize: false,
  },
})
