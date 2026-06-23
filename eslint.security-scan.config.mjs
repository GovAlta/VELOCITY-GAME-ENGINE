
import security from 'file://C:/dev/pronghorn-red/hyper-factory-zone/velo/security/blueteam/node_modules/eslint-plugin-security/index.js';

export default [
  {
    files: ['**/*.js', '**/*.ts', '**/*.jsx', '**/*.tsx'],
    ignores: ['**/node_modules/**', '**/dist/**', '**/*.min.js'],
    plugins: { security },
    rules: {
      'security/detect-eval-with-expression': 'error',
      'security/detect-non-literal-fs-filename': 'error',
      'security/detect-non-literal-regexp': 'error',
      'security/detect-non-literal-require': 'error',
      'security/detect-object-injection': 'error',
      'security/detect-possible-timing-attacks': 'error',
      'security/detect-unsafe-regex': 'error',
      'security/detect-buffer-noassert': 'error',
      'security/detect-child-process': 'error',
      'security/detect-disable-mustache-escape': 'error',
      'security/detect-no-csrf-before-method-override': 'error',
      'security/detect-pseudoRandomBytes': 'error',
    },
  },
];
