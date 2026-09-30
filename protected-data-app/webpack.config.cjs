const path = require('node:path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const source = path.join(__dirname, 'src');

module.exports = {
  mode: 'production',
  context: source,
  entry: { module: './module.tsx' },
  devtool: 'source-map',
  externals: [
    'react',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    'react-dom',
    '@emotion/css',
    /^@grafana\/(data|runtime|ui)$/,
  ],
  module: {
    rules: [
      {
        test: /\.[tj]sx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'swc-loader',
          options: {
            jsc: {
              target: 'es2015',
              parser: { syntax: 'typescript', tsx: true },
              transform: { react: { runtime: 'automatic' } },
            },
          },
        },
      },
      { test: /\.css$/, use: ['style-loader', 'css-loader'] },
      { test: /\.(svg|png|jpe?g|gif)$/, type: 'asset/resource' },
    ],
  },
  resolve: { extensions: ['.tsx', '.ts', '.jsx', '.js'] },
  output: {
    path: path.join(__dirname, 'dist'),
    filename: '[name].js',
    chunkFilename: '[name].js',
    library: { type: 'amd' },
    publicPath: 'public/plugins/protected-data-app/',
    uniqueName: 'protected-data-app',
    clean: true,
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: 'plugin.json', to: 'plugin.json' },
        { from: 'img/logo.svg', to: 'img/logo.svg' },
      ],
    }),
  ],
};
