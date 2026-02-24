const {test} = require('tap');
const ExtensionManager = require('../../src/extension-support/extension-manager');
const VM = require('../../src/virtual-machine');
const {Map} = require('immutable');
const dispatch = require('../../src/dispatch/central-dispatch');
const defaultExtensionURLs = require('../../src/extension-support/tw-default-extension-urls');

test('isBuiltinExtension', t => {
    const fakeRuntime = {};
    const manager = new ExtensionManager(fakeRuntime);
    t.equal(manager.isBuiltinExtension('pen'), true);
    t.equal(manager.isBuiltinExtension('lksdfjlskdf'), false);
    t.end();
});

test('_isValidExtensionURL', t => {
    const fakeRuntime = {};
    const manager = new ExtensionManager(fakeRuntime);
    t.equal(manager._isValidExtensionURL('fetch'), false);
    t.equal(manager._isValidExtensionURL(''), false);
    t.equal(manager._isValidExtensionURL('extensions.turbowarp.org/fetch.js'), false);
    t.equal(manager._isValidExtensionURL('https://extensions.turbowarp.org/fetch.js'), true);
    t.equal(manager._isValidExtensionURL('http://extensions.turbowarp.org/fetch.js'), true);
    t.equal(manager._isValidExtensionURL('http://localhost:8000'), true);
    t.equal(manager._isValidExtensionURL('data:application/javascript;base64,YWxlcnQoMSk='), true);
    t.equal(manager._isValidExtensionURL('file:///home/test/extension.js'), true);
    t.end();
});

test('loadExtensionURL, getExtensionURLs, deduplication', async t => {
    const vm = new VM();

    let loadedExtensions = 0;
    vm.extensionManager.securityManager.getSandboxMode = () => 'unsandboxed';
    global.document = {
        createElement: () => {
            loadedExtensions++;
            const element = {};
            setTimeout(() => {
                global.Scratch.extensions.register({
                    getInfo: () => ({
                        id: `extension${loadedExtensions}`
                    })
                });
            });
            return element;
        },
        body: {
            appendChild: () => {}
        }
    };

    const url1 = 'https://turbowarp.org/1.js';
    t.equal(vm.extensionManager.isExtensionURLLoaded(url1), false);
    t.same(vm.extensionManager.getExtensionURLs(), {});
    await vm.extensionManager.loadExtensionURL(url1);
    t.equal(vm.extensionManager.isExtensionURLLoaded(url1), true);
    t.equal(loadedExtensions, 1);
    t.same(vm.extensionManager.getExtensionURLs(), {
        extension1: url1
    });

    // Loading the extension again should do nothing.
    await vm.extensionManager.loadExtensionURL(url1);
    t.equal(vm.extensionManager.isExtensionURLLoaded(url1), true);
    t.equal(loadedExtensions, 1);
    t.same(vm.extensionManager.getExtensionURLs(), {
        extension1: url1
    });

    // Loading another extension should work
    const url2 = 'https://turbowarp.org/2.js';
    t.equal(vm.extensionManager.isExtensionURLLoaded(url2), false);
    await vm.extensionManager.loadExtensionURL(url2);
    t.equal(vm.extensionManager.isExtensionURLLoaded(url2), true);
    t.equal(loadedExtensions, 2);
    t.same(vm.extensionManager.getExtensionURLs(), {
        extension1: url1,
        extension2: url2
    });

    t.end();
});

test('loadExtensionURL supports shorthand and URL normalization', async t => {
    const vm = new VM();
    const loadedURLs = [];

    vm.extensionManager._loadCustomExtensionURL = url => {
        loadedURLs.push(url);
    };
    vm.extensionManager.isExtensionURLLoaded = url => loadedURLs.includes(url);

    await vm.extensionManager.loadExtensionURL('text');
    t.same(loadedURLs, [defaultExtensionURLs.text], 'can load default extension URL by extension ID');

    loadedURLs.length = 0;
    await vm.extensionManager.loadExtensionURL('https://github.com/example/repo/blob/main/ext.js');
    t.same(loadedURLs, ['https://raw.githubusercontent.com/example/repo/main/ext.js'], 'github blob URLs are normalized');

    loadedURLs.length = 0;
    await vm.extensionManager.loadExtensionURL('extensions.example.com/custom.js');
    t.same(loadedURLs, ['https://extensions.example.com/custom.js'], 'host/path URLs infer https');

    t.end();
});

test('isExtensionURLLoaded supports equivalent URL variants', t => {
    const vm = new VM();
    const loaded = 'https://raw.githubusercontent.com/example/repo/main/ext.js';
    vm.extensionManager.workerURLs[3] = loaded;

    t.equal(vm.extensionManager.isExtensionURLLoaded(loaded), true);
    t.equal(
        vm.extensionManager.isExtensionURLLoaded('https://github.com/example/repo/blob/main/ext.js'),
        true,
        'github blob URL matches loaded raw URL'
    );

    t.end();
});

test('unloadExtension removes blocks and runtime state', t => {
    const vm = new VM();
    const runtime = vm.runtime;
    const manager = vm.extensionManager;
    const extensionId = 'testext';

    const scripts = new Set(['extTop', 'parentInput']);
    const blocks = {
        extTop: {
            id: 'extTop',
            opcode: 'testext_cmd',
            next: 'after1',
            parent: null,
            topLevel: true,
            inputs: {}
        },
        after1: {
            id: 'after1',
            opcode: 'motion_movesteps',
            next: 'extMiddle',
            parent: 'extTop',
            topLevel: false,
            inputs: {}
        },
        extMiddle: {
            id: 'extMiddle',
            opcode: 'testext_loop',
            next: 'after2',
            parent: 'after1',
            topLevel: false,
            inputs: {
                SUBSTACK: {
                    block: 'sub1',
                    shadow: null
                }
            }
        },
        sub1: {
            id: 'sub1',
            opcode: 'operator_add',
            next: null,
            parent: 'extMiddle',
            topLevel: false,
            inputs: {}
        },
        after2: {
            id: 'after2',
            opcode: 'motion_turnright',
            next: null,
            parent: 'extMiddle',
            topLevel: false,
            inputs: {}
        },
        parentInput: {
            id: 'parentInput',
            opcode: 'looks_say',
            next: null,
            parent: null,
            topLevel: true,
            inputs: {
                MESSAGE: {
                    block: 'extReporter',
                    shadow: 'shadow1'
                }
            }
        },
        extReporter: {
            id: 'extReporter',
            opcode: 'testext_report',
            next: null,
            parent: 'parentInput',
            topLevel: false,
            inputs: {
                VALUE: {
                    block: 'nestedNonExt',
                    shadow: null
                }
            }
        },
        nestedNonExt: {
            id: 'nestedNonExt',
            opcode: 'operator_join',
            next: null,
            parent: 'extReporter',
            topLevel: false,
            inputs: {}
        },
        shadow1: {
            id: 'shadow1',
            opcode: 'text',
            next: null,
            parent: 'parentInput',
            topLevel: false,
            shadow: true,
            inputs: {}
        }
    };

    runtime.targets = [{
        blocks: {
            _blocks: blocks,
            _addScript: id => scripts.add(id),
            _deleteScript: id => scripts.delete(id),
            resetCache: () => {}
        },
        extensionStorage: {
            [extensionId]: {
                foo: 'bar'
            }
        }
    }];
    runtime.requestBlocksUpdate = () => {};
    runtime.requestToolboxExtensionsUpdate = () => {};
    runtime.emitProjectChanged = () => {};
    runtime.threads = [{
        stack: ['extMiddle']
    }];
    runtime._stopThread = thread => {
        thread.stopped = true;
    };

    runtime._primitives.testext_cmd = () => {};
    runtime._hats.testext_hat = {};
    runtime._flowing.testext_loop = {};
    runtime.monitorBlockInfo.testext_report = {};
    runtime._blockInfo.push({id: extensionId}, {id: 'other'});
    runtime.extensionButtons.set('testext_button', () => {});
    runtime.extensionStorage[extensionId] = {a: 1};
    runtime[`ext_${extensionId}`] = {};
    runtime._monitorState = runtime._monitorState.set('m1', Map([
        ['id', 'm1'],
        ['opcode', 'testext_report']
    ]));
    runtime.monitorBlocks = {
        _blocks: {
            m1: {
                id: 'm1',
                opcode: 'testext_report',
                next: null,
                parent: null,
                inputs: {}
            }
        },
        getBlock: id => runtime.monitorBlocks._blocks[id],
        deleteBlock: id => {
            delete runtime.monitorBlocks._blocks[id];
        }
    };

    manager._loadedExtensions.set(extensionId, 'unsandboxed.1.testext');
    manager.workerURLs[1] = 'https://example.com/ext.js';
    dispatch.services['unsandboxed.1.testext'] = {};

    const result = manager.unloadExtension(extensionId);
    t.equal(result, true);

    t.equal(blocks.after1.parent, null, 'next block after removed top-level block is promoted');
    t.equal(blocks.after1.topLevel, true);
    t.equal(blocks.after1.next, 'after2', 'next chain reconnects around removed extension block');
    t.equal(blocks.after2.parent, 'after1');
    t.equal(blocks.parentInput.inputs.MESSAGE.block, null, 'input connection to removed extension block is cleared');
    t.notOk(blocks.extTop);
    t.notOk(blocks.extMiddle);
    t.notOk(blocks.extReporter);
    t.notOk(blocks.sub1, 'input subtree under removed extension block is deleted');
    t.notOk(blocks.nestedNonExt, 'input subtree under removed reporter is deleted');

    t.equal(manager.isExtensionLoaded(extensionId), false);
    t.equal(manager.workerURLs[1], undefined);
    t.equal(dispatch.services['unsandboxed.1.testext'], undefined);

    t.equal(runtime._primitives.testext_cmd, undefined);
    t.equal(runtime._hats.testext_hat, undefined);
    t.equal(runtime._flowing.testext_loop, undefined);
    t.equal(runtime.monitorBlockInfo.testext_report, undefined);
    t.same(runtime._blockInfo.map(i => i.id), ['other']);
    t.equal(runtime.extensionButtons.has('testext_button'), false);
    t.equal(runtime.extensionStorage[extensionId], undefined);
    t.equal(runtime.targets[0].extensionStorage[extensionId], undefined);
    t.equal(runtime[`ext_${extensionId}`], undefined);
    t.equal(runtime._monitorState.has('m1'), false);
    t.equal(runtime.monitorBlocks.getBlock('m1'), undefined);

    t.equal(scripts.has('extTop'), false);
    t.equal(scripts.has('after1'), true);
    t.equal(scripts.has('parentInput'), true);
    t.equal(runtime.threads[0].stopped, true, 'threads touching removed blocks are stopped');

    t.end();
});
