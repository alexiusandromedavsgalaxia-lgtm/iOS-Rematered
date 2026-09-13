// vite.config.js
// iOS Remastered — Vite configuration
// React plugin, path aliases, proxy a backend (Browserless), optimizaciones.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const normalizeDeviceModelImports = () => ({
  name: 'rainos-normalize-device-model-imports',
  enforce: 'pre',
  transform(code, id) {
    if (!/[/\\]src[/\\]drivers[/\\].+\.(?:js|jsx)$/.test(id)) return null;
    const legacy = "import { DEVICE_MODEL } from './HardwareBus.js';";
    if (!code.includes(legacy)) return null;
    return {
      code: code.replaceAll(legacy, "import { DEVICE_MODEL } from './DeviceModel.js';"),
      map: null,
    };
  },
});

export default defineConfig(({ command, mode }) => {
  const isDev = command === 'serve';
  const isProd = command === 'build';

  return {
    plugins: [
      react({
        jsxRuntime: 'automatic',
        fastRefresh: isDev,
      }),
      normalizeDeviceModelImports(),
    ],

    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@apps': fileURLToPath(new URL('./src/apps', import.meta.url)),
        '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
        '@engine': fileURLToPath(new URL('./src/engine', import.meta.url)),
        '@system': fileURLToPath(new URL('./src/system', import.meta.url)),
        '@kernel': fileURLToPath(new URL('./src/kernel', import.meta.url)),
        '@drivers': fileURLToPath(new URL('./src/drivers', import.meta.url)),
        '@loader': fileURLToPath(new URL('./src/loader', import.meta.url)),
        '@context': fileURLToPath(new URL('./src/context', import.meta.url)),
      },
      extensions: ['.js', '.jsx', '.json'],
    },

    server: {
      port: 5173,
      host: true,
      strictPort: false,
      open: false,
      cors: true,
      proxy: {
        '/api': {
          target: process.env.API_URL || 'http://localhost:3001',
          changeOrigin: true,
          secure: false,
          rewrite: (path) => path,
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.warn('[vite-proxy] Error conectando al backend:', err.message);
            });
          },
        },
      },
      hmr: { overlay: true },
    },

    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      sourcemap: isDev,
      minify: 'esbuild',
      target: 'es2020',
      cssMinify: true,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          manualChunks: (id) => {
            if (id.includes('node_modules')) return 'vendor';
            if (id.includes('/src/engine/')) return 'engine';
            if (id.includes('/src/kernel/')) return 'kernel';
            if (id.includes('/src/drivers/')) return 'drivers';
            if (id.includes('/src/loader/')) return 'loader';
            if (id.includes('/src/system/')) return 'system';
            if (id.includes('/src/apps/') && !id.includes('registry')) return 'apps';
            if (id.includes('/src/ui/')) return 'ui';
            return undefined;
          },
          chunkFileNames: 'assets/[name]-[hash].js',
          entryFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash].[ext]',
        },
      },
      assetsInlineLimit: 4096,
    },

    optimizeDeps: {
      include: ['react', 'react-dom', 'react-dom/client'],
      exclude: [],
    },

    css: {
      devSourcemap: isDev,
      postcss: {},
    },

    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '1.0.0'),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      __DEV__: JSON.stringify(isDev),
    },

    preview: {
      port: 4173,
      host: true,
      strictPort: false,
      open: false,
    },

    esbuild: {
      jsx: 'automatic',
      legalComments: 'none',
      drop: isProd ? ['debugger'] : [],
    },

    logLevel: 'info',
    clearScreen: false,
  };
});
