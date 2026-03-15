import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig(async () => {
  const { default: react } = await (Function(
    'return import("@vitejs/plugin-react")',
  )() as Promise<typeof import('@vitejs/plugin-react')>);

  const { default: tailwindcss } = await (Function(
    'return import("@tailwindcss/vite")',
  )() as Promise<typeof import('@tailwindcss/vite')>);

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src/renderer'),
      },
    },
    // Only reload when source or config changes; ignore project data and build output
    server: {
      watch: {
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/dist/**',
          '**/.vite/**',
          '**/pnpm-lock.yaml',
          '**/package-lock.json',
          // Ignore anything outside src, public, and root config files so opening
          // a project folder inside the repo doesn’t trigger reloads on data changes
          (pathName: string) => {
            const n = pathName.replace(/\\/g, '/');
            if (n.includes('node_modules') || n.includes('.git') || n.includes('/dist/') || n.includes('/.vite/')) return true;
            if (n.startsWith('src/') || n.startsWith('public/')) return false;
            if (n === 'index.html') return false;
            const rootFile = /^[^/]+\.(ts|js|json|mjs|cjs)$/;
            if (rootFile.test(n) && !n.includes('/')) return false;
            return true;
          },
        ],
      },
    },
  };
});
