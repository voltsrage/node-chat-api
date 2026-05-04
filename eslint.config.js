import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console':     'warn',
      'eqeqeq':         'error',
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType:  'module',
      globals: {
        process: 'readonly',
      },
    },
  },
  {
    // Test files may use describe/it/expect without imports
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        describe:   'readonly',
        it:         'readonly',
        expect:     'readonly',
        beforeAll:  'readonly',
        afterAll:   'readonly',
        beforeEach: 'readonly',
        afterEach:  'readonly',
      },
    },
  },
];