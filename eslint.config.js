import antfu from '@antfu/eslint-config';

export default antfu({
  formatters: true,
  // https://github.com/antfu/eslint-config?tab=readme-ov-file#editor-specific-disables
  isInEditor: false,
  jsx: true,
  stylistic: {
    semi: true,
  },
  ignores: ['**/node_modules/**', '.agents/**', '**/dist/**', '.archive/**', '**/docs/**'],
  vue: {
    overrides: {
      'vue/valid-template-root': 'off',
      'vue/max-attributes-per-line': [
        'warn',
        {
          singleline: { max: 5 },
        },
      ],
    },
  },
  rules: {
    'ts/no-require-imports': 'off',
    'ts/no-redeclare': 'off',
  },
});
