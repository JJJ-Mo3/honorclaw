import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/*/vitest.config.ts',
  'packages/channels/*/vitest.config.ts',
  'packages/providers/*/vitest.config.ts',
  'packages/tools/*/vitest.config.ts',
  {
    test: {
      include: ['tests/**/*.{test,spec}.ts'],
      name: 'root',
    },
  },
]);
