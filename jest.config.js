process.env.TZ = 'Pacific/Easter';

module.exports = {
  ...require('./.config/jest.config'),
  testMatch: [
    ...require('./.config/jest.config').testMatch,
    '<rootDir>/protected-data-app/src/**/*.{spec,test,jest}.{js,jsx,ts,tsx}',
  ],
  moduleNameMapper: {
    ...require('./.config/jest.config').moduleNameMapper,
    '^monaco-editor$': '<rootDir>/src/__mocks__/monaco-editor.ts',
  },
  transformIgnorePatterns: [
    require('./.config/jest/utils').nodeModulesToTransform([
      ...require('./.config/jest/utils').grafanaESModules,
      '@grafana/plugin-ui',
      '@noble/ciphers',
      '@marcbachmann/cel-js',
      'monaco-editor',
      '@openfeature/ofrep-web-provider',
      '@openfeature/web-sdk',
      '@lezer/lr',
      '@lezer/common',
      '@lezer/highlight',
      '@grafana/lezer-traceql',
      '@grafana/lezer-logql',
    ]),
  ],
};
