/**
 * Vitest config: inline the npm-published `@deepseek-ai/*` packages whose built
 * lib bundles css side-effect imports. Installed from the registry they live
 * under `node_modules/.pnpm` and are externalized by vitest — Node then chokes
 * on the `.css` import. Inlining routes them through Vite's transform, which
 * stubs css imports (the default `css: false`).
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    server: {
      deps: {
        inline: [/@deepseek-ai\/dsh-client-ui-primitives/],
      },
    },
  },
})
