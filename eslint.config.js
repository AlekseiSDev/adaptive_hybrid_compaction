import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      // Docker bind-mounts (langfuse stack) — live data dirs with transient
      // files that come and go during scans; gitignored.
      'observability/data/**',
      'observability/.langfuse/**',
      'benchmarks/runs/**',
      // Next.js generated artifacts (build output + route type stubs).
      '**/.next/**',
      'src/ui/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    extends: [
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Design doc (A_ahc-algorithm.md §2.4) uses `type` aliases —
      // mandatory for unions like ContentPart. Mixing interface+type harms readability.
      '@typescript-eslint/consistent-type-definitions': 'off',
    },
  },
  {
    files: ['*.{js,ts,cjs,mjs}', 'scripts/**/*'],
    extends: [tseslint.configs.disableTypeChecked],
  },
)
