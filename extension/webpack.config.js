
const path = require('path');

const extensionConfig = {
    name: 'extension',
    mode: 'production',
    target: 'node',
    entry: {
        extension: './src/extension.ts',
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'extension.js',
        libraryTarget: 'commonjs',
    },
    externals: {
        vscode: 'commonjs vscode',
    },
    resolve: {
        extensions: ['.ts', '.js', '.json']
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: 'ts-loader',
            },
        ],
    },
    devtool: 'nosources-source-map',
};

const webviewConfig = {
    name: 'webview',
    mode: 'production',
    target: 'web', // Webview runs in browser
    entry: {
        webview: './src/webview/index.tsx', // React entry
    },
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'webview.js',
    },
    resolve: {
        extensions: ['.ts', '.tsx', '.js', '.jsx', '.json']
    },
    module: {
        rules: [
            {
                test: /\.(ts|tsx)$/,
                exclude: /node_modules/,
                use: 'ts-loader',
            },
            {
                test: /\.css$/,
                use: ['style-loader', 'css-loader', 'postcss-loader'] // For tailwind if we add it
            }
        ],
    },
    devtool: 'nosources-source-map',
};

module.exports = [extensionConfig, webviewConfig];
