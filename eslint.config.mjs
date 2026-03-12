import antfu from '@antfu/eslint-config'

export default antfu({
  astro: true,
  typescript: true,
  ignores: [
    'dist/**',
    'node_modules/**',
    '.astro/**',
    'src/content/docs/**',
  ],
  rules: {
    'node/prefer-global/process': 'off',
    'e18e/prefer-static-regex': 'off',
    'regexp/no-super-linear-backtracking': 'off',
    'e18e/prefer-array-to-sorted': 'off',
  },
})
