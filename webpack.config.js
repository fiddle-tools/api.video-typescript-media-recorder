const webpack = require('webpack');
const path = require('path');
const CopyPlugin = require("copy-webpack-plugin");

module.exports = {
    entry: {
        uploader: ['core-js/stable/promise', './src/index.ts']
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
            {
                test: /worker\.js$/,
                use: 'raw-loader'
            }
        ],
    },
    resolve: {
        extensions: ['.ts', '.js'],
        alias: {
            '@worker': path.resolve(__dirname, 'src/upload-worker.js')
        }
    },
    output: {
        libraryTarget: 'umd',
        filename: 'index.js',
        globalObject: 'this'
    },
    devtool: 'source-map',
    plugins: [
        new webpack.DefinePlugin({
            __PACKAGE_VERSION__: JSON.stringify(require('./package.json').version),
        }),
        new CopyPlugin({
            patterns: [
                { 
                    from: 'src/**/*.d.ts',
                    to: 'types/[path]/[name][ext]'
                }
            ]
        })
    ]
};