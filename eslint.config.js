import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/artifacts/**',
      '**/cache/**',
      'packages/contracts/types/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['packages/contracts/scripts/**/*.js'],
    languageOptions: { globals: { console: 'readonly' } },
  },
  {
    files: ['packages/contracts/test/**/*.js'],
    languageOptions: {
      globals: { describe: 'readonly', beforeEach: 'readonly', it: 'readonly' },
    },
  },
)
