// vite.config.js
// iOS Remastered — Vite configuration
// React plugin, path aliases, proxy a backend (Browserless), optimizaciones.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig(({ command, mode }) => {
  const isDev = command === 'serve';
  const isProd = command === 'build';

  return {
    /* -------------------------- Plugins -------------------------- */
    plugins: [
      react({
        // Fast Refresh en dev, sin babel extra
        jsxRuntime: 'automatic',
        fastRefresh: isDev,
      }),
    ],

    /* -------------------------- Aliases -------------------------- */
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

    /* -------------------------- Dev server -------------------------- */
    server: {
      port: 5173,
      host: true,
      strictPort: false,
      open: false,
      cors: true,

      // Proxy al backend de Browserless
      proxy: {
        '/api': {
          target: process.env.API_URL || 'http://localhost:3001',
          changeOrigin: true,
          secure: false,
          // No reescribimos la ruta: /api/proxy → /api/proxy
          rewrite: (path) => path,
          configure: (proxy) => {
            proxy.on('error', (err) => {
              console.warn('[vite-proxy] Error conectando al backend:', err.message);
            });
          },
        },
      },

      // HMR opcional más suave
      hmr: {
        overlay: true,
      },
    },

    /* -------------------------- Build -------------------------- */
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
          // Chunks separados por capa del OS
          manualChunks: (id) => {
            if (id.includes('node_modules')) {
              return 'vendor';
            }
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

      // Evitamos problemas con el motor de render en canvas
      assetsInlineLimit: 4096,
    },

    /* -------------------------- Optimizaciones -------------------------- */
    optimizeDeps: {
      include: ['react', 'react-dom', 'react-dom/client'],
      exclude: [],
    },

    /* -------------------------- CSS -------------------------- */
    css: {
      devSourcemap: isDev,
      postcss: {},
    },

    /* -------------------------- Define -------------------------- */
    define: {
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version || '1.0.0'),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      __DEV__: JSON.stringify(isDev),
    },

    /* -------------------------- Preview -------------------------- */
    preview: {
      port: 4173,
      host: true,
      strictPort: false,
      open: false,
    },

    /* -------------------------- ESBuild -------------------------- */
    esbuild: {
      jsx: 'automatic',
      legalComments: 'none',
      drop: isProd ? ['debugger'] : [],
      // No tiramos console en prod: el OS puede querer loguear
      // drop: isProd ? ['debugger', 'console'] : [],
    },

    /* -------------------------- Logging -------------------------- */
    logLevel: 'info',
    clearScreen: false,
  };
});
