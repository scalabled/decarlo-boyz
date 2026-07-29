import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves a project site from `/<repo>/`, not from the domain
  // root, so every asset URL needs that prefix. It comes from the environment
  // rather than being hard-coded because the same build has to keep working on
  // `localhost` (base `/`) and for anyone who forks this under a different repo
  // name — the Pages workflow sets OW_BASE, everything else gets the default.
  base: process.env.OW_BASE ?? '/',
  // Bind IPv4 explicitly: the default `localhost` binds ::1 only on macOS,
  // which the capture harness (127.0.0.1) cannot reach.
  // `hmr: false` when the capture harness owns the server (OW_NO_HMR=1): a file
  // saved by a concurrently-working agent otherwise reloads the page mid-capture
  // and playwright fails with "Execution context was destroyed".
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    hmr: process.env.OW_NO_HMR ? false : undefined,
  },
  preview: { host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 4096 },
  // Large binary game assets served verbatim.
  assetsInclude: ['**/*.ktx2', '**/*.hdr', '**/*.exr', '**/*.bin', '**/*.glb'],
});
