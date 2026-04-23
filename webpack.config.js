const CopyWebpackPlugin = require('copy-webpack-plugin');
const defaultsDeep = require('lodash.defaultsdeep');
const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');
const webpack = require('webpack');

const base = {
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    devServer: {
        static: false,
        host: '0.0.0.0',
        port: process.env.PORT || 8073,
        hot: true,
        allowedHosts: 'all'
    },
    devtool: 'cheap-module-source-map',
    output: {
        library: 'VirtualMachine',
        filename: '[name].js'
    },
    resolve: {
        fallback: {
            "path": require.resolve("path-browserify"),
            "buffer": require.resolve("buffer/"),
            "process": require.resolve("process/browser")
        }
    },
    module: {
        rules: [{
            test: /\.js$/,
            loader: 'babel-loader',
            include: path.resolve(__dirname, 'src'),
            options: {
                presets: [['@babel/preset-env', {
                    targets: {
                        browsers: ['last 2 versions', 'not ie <= 11']
                    }
                }]]
            }
        },
        {
            test: /\.mp3$/,
            type: 'asset/resource',
            generator: {
                filename: 'media/music/[name][contenthash][ext]'
            }
        },
        {
            test: /\.worker\.js$/,
            use: [
                {
                    loader: 'worker-loader',
                    options: {
                        filename: 'js/extension-worker/extension-worker.[hash].js',
                        esModule: false
                    }
                }
            ]
        }
        ]
    },
    optimization: {
        minimize: process.env.NODE_ENV === 'production',
        minimizer: [
            new TerserPlugin({
                terserOptions: {
                    compress: {
                        drop_console: false
                    }
                }
            })
        ]
    },
    plugins: [
        new webpack.ProvidePlugin({
            Buffer: ['buffer', 'Buffer'],
            process: 'process/browser'
        })
    ]
};

module.exports = [
    // Web-compatible
    defaultsDeep({}, base, {
        name: 'web',
        target: 'web',
        entry: {
            'scratch-vm': './src/index.js',
            'scratch-vm.min': './src/index.js'
        },
        output: {
            libraryTarget: 'umd',
            path: path.resolve('dist', 'web'),
            globalObject: 'this',
            umdNamedDefine: true
        },
        module: {
            rules: base.module.rules.concat([
                {
                    test: require.resolve('./src/index.js'),
                    loader: 'expose-loader',
                    options: {
                        exposes: 'VirtualMachine'
                    }
                }
            ])
        }
    }),
    // Node-compatible
    defaultsDeep({}, base, {
        name: 'node',
        target: 'node',
        entry: {
            'scratch-vm': './src/index.js'
        },
        output: {
            libraryTarget: 'commonjs2',
            path: path.resolve('dist', 'node')
        },
        externals: {
            'decode-html': true,
            'format-message': true,
            'htmlparser2': true,
            'immutable': true,
            'scratch-parser': true,
            'socket.io-client': true,
            'text-encoding': true
        },
        resolve: {
            fallback: false
        }
    }),
    // Playground
    defaultsDeep({}, base, {
        name: 'playground',
        target: 'web',
        entry: {
            'benchmark': './src/playground/benchmark',
            'video-sensing-extension-debug': './src/extensions/scratch3_video_sensing/debug'
        },
        output: {
            path: path.resolve(__dirname, 'playground'),
            filename: '[name].js'
        },
        module: {
            rules: base.module.rules.concat([
                {
                    test: require.resolve('./src/index.js'),
                    loader: 'expose-loader',
                    options: {
                        exposes: 'VirtualMachine'
                    }
                },
                {
                    test: require.resolve('./src/extensions/scratch3_video_sensing/debug.js'),
                    loader: 'expose-loader',
                    options: {
                        exposes: 'Scratch3VideoSensingDebug'
                    }
                },
                {
                    test: require.resolve('stats.js/build/stats.min.js'),
                    type: 'javascript/auto',
                    use: [{
                        loader: 'expose-loader',
                        options: {
                            exposes: 'Stats'
                        }
                    }]
                },
                {
                    test: require.resolve('scratch-blocks/dist/vertical.js'),
                    loader: 'expose-loader',
                    options: {
                        exposes: 'Blockly'
                    }
                },
                {
                    test: require.resolve('scratch-audio/src/index.js'),
                    loader: 'expose-loader',
                    options: {
                        exposes: 'AudioEngine'
                    }
                },
                {
                    test: require.resolve('scratch-storage/src/index.js'),
                    loader: 'expose-loader',
                    options: {
                        exposes: 'ScratchStorage'
                    }
                },
                {
                    test: require.resolve('scratch-render/src/index.js'),
                    loader: 'expose-loader',
                    options: {
                        exposes: 'ScratchRender'
                    }
                }
            ])
        },
        performance: {
            hints: false
        },
        plugins: base.plugins.concat([
            new CopyWebpackPlugin({
                patterns: [
                    {
                        from: 'node_modules/scratch-blocks/media',
                        to: 'media'
                    },
                    {
                        from: 'node_modules/scratch-storage/dist/web',
                        to: '.'
                    },
                    {
                        from: 'node_modules/scratch-render/dist/web',
                        to: '.'
                    },
                    {
                        from: 'node_modules/@turbowarp/scratch-svg-renderer/dist/web',
                        to: '.'
                    },
                    {
                        from: 'src/playground',
                        to: '.'
                    }
                ]
            })
        ])
    })
];