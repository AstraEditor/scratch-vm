const dispatch = require('../dispatch/central-dispatch');
const log = require('../util/log');
const maybeFormatMessage = require('../util/maybe-format-message');

const BlockType = require('./block-type');
const SecurityManager = require('./tw-security-manager');
const defaultExtensionURLs = require('./tw-default-extension-urls');

// These extensions are currently built into the VM repository but should not be loaded at startup.
// TODO: move these out into a separate repository?
// TODO: change extension spec so that library info, including extension ID, can be collected through static methods

const defaultBuiltinExtensions = {
    // This is an example that isn't loaded with the other core blocks,
    // but serves as a reference for loading core blocks as extensions.
    coreExample: () => require('../blocks/scratch3_core_example'),
    // These are the non-core built-in extensions.
    pen: () => require('../extensions/scratch3_pen'),
    wedo2: () => require('../extensions/scratch3_wedo2'),
    music: () => require('../extensions/scratch3_music'),
    microbit: () => require('../extensions/scratch3_microbit'),
    text2speech: () => require('../extensions/scratch3_text2speech'),
    translate: () => require('../extensions/scratch3_translate'),
    videoSensing: () => require('../extensions/scratch3_video_sensing'),
    ev3: () => require('../extensions/scratch3_ev3'),
    makeymakey: () => require('../extensions/scratch3_makeymakey'),
    boost: () => require('../extensions/scratch3_boost'),
    gdxfor: () => require('../extensions/scratch3_gdx_for'),
    // tw: core extension
    tw: () => require('../extensions/tw')
};

/**
 * @typedef {object} ArgumentInfo - Information about an extension block argument
 * @property {ArgumentType} type - the type of value this argument can take
 * @property {*|undefined} default - the default value of this argument (default: blank)
 */

/**
 * @typedef {object} ConvertedBlockInfo - Raw extension block data paired with processed data ready for scratch-blocks
 * @property {ExtensionBlockMetadata} info - the raw block info
 * @property {object} json - the scratch-blocks JSON definition for this block
 * @property {string} xml - the scratch-blocks XML definition for this block
 */

/**
 * @typedef {object} CategoryInfo - Information about a block category
 * @property {string} id - the unique ID of this category
 * @property {string} name - the human-readable name of this category
 * @property {string|undefined} blockIconURI - optional URI for the block icon image
 * @property {string} color1 - the primary color for this category, in '#rrggbb' format
 * @property {string} color2 - the secondary color for this category, in '#rrggbb' format
 * @property {string} color3 - the tertiary color for this category, in '#rrggbb' format
 * @property {Array.<ConvertedBlockInfo>} blocks - the blocks, separators, etc. in this category
 * @property {Array.<object>} menus - the menus provided by this category
 */

/**
 * @typedef {object} PendingExtensionWorker - Information about an extension worker still initializing
 * @property {string} extensionURL - the URL of the extension to be loaded by this worker
 * @property {Function} resolve - function to call on successful worker startup
 * @property {Function} reject - function to call on failed worker startup
 */

const createExtensionService = extensionManager => {
    const service = {};
    service.registerExtensionServiceSync = extensionManager.registerExtensionServiceSync.bind(extensionManager);
    service.allocateWorker = extensionManager.allocateWorker.bind(extensionManager);
    service.onWorkerInit = extensionManager.onWorkerInit.bind(extensionManager);
    service.registerExtensionService = extensionManager.registerExtensionService.bind(extensionManager);
    return service;
};

class ExtensionManager {
    constructor (vm) {
        /**
         * The ID number to provide to the next extension worker.
         * @type {int}
         */
        this.nextExtensionWorker = 0;

        /**
         * FIFO queue of extensions which have been requested but not yet loaded in a worker,
         * along with promise resolution functions to call once the worker is ready or failed.
         *
         * @type {Array.<PendingExtensionWorker>}
         */
        this.pendingExtensions = [];

        /**
         * Map of worker ID to workers which have been allocated but have not yet finished initialization.
         * @type {Array.<PendingExtensionWorker>}
         */
        this.pendingWorkers = [];

        /**
         * Map of worker ID to the URL where it was loaded from.
         * @type {Array<string>}
         */
        this.workerURLs = [];

        /**
         * Map of loaded extension URLs/IDs (equivalent for built-in extensions) to service name.
         * @type {Map.<string,string>}
         * @private
         */
        this._loadedExtensions = new Map();

        /**
         * Responsible for determining security policies related to custom extensions.
         */
        this.securityManager = new SecurityManager();

        /**
         * @type {VirtualMachine}
         */
        this.vm = vm;

        /**
         * Keep a reference to the runtime so we can construct internal extension objects.
         * TODO: remove this in favor of extensions accessing the runtime as a service.
         * @type {Runtime}
         */
        this.runtime = vm.runtime;

        this.loadingAsyncExtensions = 0;
        this.asyncExtensionsLoadedCallbacks = [];

        this.builtinExtensions = Object.assign({}, defaultBuiltinExtensions);

        dispatch.setService('extensions', createExtensionService(this)).catch(e => {
            log.error(`ExtensionManager was unable to register extension service: ${JSON.stringify(e)}`);
        });
    }

    /**
     * Check whether an extension is registered or is in the process of loading. This is intended to control loading or
     * adding extensions so it may return `true` before the extension is ready to be used. Use the promise returned by
     * `loadExtensionURL` if you need to wait until the extension is truly ready.
     * @param {string} extensionID - the ID of the extension.
     * @returns {boolean} - true if loaded, false otherwise.
     */
    isExtensionLoaded (extensionID) {
        return this._loadedExtensions.has(extensionID);
    }

    /**
     * Determine whether an extension with a given ID is built in to the VM, such as pen.
     * Note that "core extensions" like motion will return false here.
     * @param {string} extensionId
     * @returns {boolean}
     */
    isBuiltinExtension (extensionId) {
        return Object.prototype.hasOwnProperty.call(this.builtinExtensions, extensionId);
    }

    /**
     * Synchronously load an internal extension (core or non-core) by ID. This call will
     * fail if the provided id is not does not match an internal extension.
     * @param {string} extensionId - the ID of an internal extension
     */
    loadExtensionIdSync (extensionId) {
        if (!this.isBuiltinExtension(extensionId)) {
            log.warn(`Could not find extension ${extensionId} in the built in extensions.`);
            return;
        }

        /** @TODO dupe handling for non-builtin extensions. See commit 670e51d33580e8a2e852b3b038bb3afc282f81b9 */
        if (this.isExtensionLoaded(extensionId)) {
            const message = `Rejecting attempt to load a second extension with ID ${extensionId}`;
            log.warn(message);
            return;
        }

        const extension = this.builtinExtensions[extensionId]();
        const extensionInstance = new extension(this.runtime);
        const serviceName = this._registerInternalExtension(extensionInstance);
        this._loadedExtensions.set(extensionId, serviceName);
        this.runtime.compilerRegisterExtension(extensionId, extensionInstance);
    }

    addBuiltinExtension (extensionId, extensionClass) {
        this.builtinExtensions[extensionId] = () => extensionClass;
    }

    _normalizeExtensionInput (extensionInput) {
        if (typeof extensionInput !== 'string') {
            return '';
        }
        return extensionInput.trim();
    }

    _resolveBuiltinExtensionId (extensionId) {
        if (!extensionId) {
            return null;
        }
        if (this.isBuiltinExtension(extensionId)) {
            return extensionId;
        }
        const normalized = extensionId.toLowerCase();
        const builtinIds = Object.keys(this.builtinExtensions);
        for (let i = 0; i < builtinIds.length; i++) {
            if (builtinIds[i].toLowerCase() === normalized) {
                return builtinIds[i];
            }
        }
        return null;
    }

    _normalizeExtensionURL (extensionURL) {
        let url = this._normalizeExtensionInput(extensionURL);
        if (!url) {
            return null;
        }

        if (/^\/\/.+/.test(url)) {
            url = `https:${url}`;
        } else if (/^(?:github|raw\.githubusercontent)\.com\//i.test(url)) {
            url = `https://${url}`;
        } else if (
            !/^[a-z][a-z0-9+.-]*:/i.test(url) &&
            /^[a-z0-9.-]+\.[a-z]{2,}(?:\/|$)/i.test(url)
        ) {
            url = `https://${url}`;
        }

        let parsed;
        try {
            parsed = new URL(url);
        } catch (e) {
            return url;
        }

        if (parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'github.com') {
            const parts = parsed.pathname.split('/').filter(Boolean);
            if (parts.length >= 5 && parts[2] === 'blob') {
                const owner = parts[0];
                const repository = parts[1];
                const branch = parts[3];
                const filePath = parts.slice(4).join('/');
                if (owner && repository && branch && filePath) {
                    return `https://raw.githubusercontent.com/${owner}/${repository}/${branch}/${filePath}`;
                }
            }
        }

        return parsed.href;
    }

    _getExtensionLoadCandidates (extensionInput) {
        const candidates = [];
        const add = url => {
            if (!url || candidates.includes(url)) {
                return;
            }
            candidates.push(url);
        };

        const normalizedInput = this._normalizeExtensionInput(extensionInput);
        if (!normalizedInput) {
            return candidates;
        }

        if (Object.prototype.hasOwnProperty.call(defaultExtensionURLs, normalizedInput)) {
            add(defaultExtensionURLs[normalizedInput]);
        }

        const normalizedURL = this._normalizeExtensionURL(normalizedInput);
        add(normalizedURL);

        if (/^https:\/\/raw\.githubusercontent\.com\//i.test(normalizedURL || '')) {
            add(`https://trampoline.turbowarp.org/proxy/${normalizedURL}`);
        }

        return candidates;
    }

    _isValidExtensionURL (extensionURL) {
        try {
            const parsedURL = new URL(extensionURL);
            return (
                parsedURL.protocol === 'https:' ||
                parsedURL.protocol === 'http:' ||
                parsedURL.protocol === 'data:' ||
                parsedURL.protocol === 'file:'
            );
        } catch (e) {
            return false;
        }
    }

    /**
     * Load an extension by URL or internal extension ID
     * @param {string} extensionURL - the URL for the extension to load OR the ID of an internal extension
     * @returns {Promise} resolved once the extension is loaded and initialized or rejected on failure
     */
    async loadExtensionURL (extensionURL, Trust) {
        const normalizedInput = this._normalizeExtensionInput(extensionURL);
        const builtinExtensionId = this._resolveBuiltinExtensionId(normalizedInput);
        if (builtinExtensionId) {
            this.loadExtensionIdSync(builtinExtensionId);
            return;
        }

        const candidates = this._getExtensionLoadCandidates(normalizedInput);
        if (candidates.length === 0) {
            throw new Error(`Invalid extension URL: ${extensionURL}`);
        }

        let lastError = null;
        for (const candidateURL of candidates) {
            if (this.isExtensionURLLoaded(candidateURL)) {
                return;
            }

            if (!this._isValidExtensionURL(candidateURL)) {
                lastError = new Error(`Invalid extension URL: ${candidateURL}`);
                continue;
            }

            try {
                await this._loadCustomExtensionURL(candidateURL, Trust);
                return;
            } catch (e) {
                lastError = e;
            }
        }

        if (lastError) {
            throw lastError;
        }
        throw new Error(`Invalid extension URL: ${extensionURL}`);
    }

    async _loadCustomExtensionURL (extensionURL, Trust) {
        if (this.isExtensionURLLoaded(extensionURL)) {
            return;
        }

        this.runtime.setExternalCommunicationMethod('customExtensions', true);

        this.loadingAsyncExtensions++;
        try {
            const sandboxMode = await this.securityManager.getSandboxMode(extensionURL);
            const rewritten = await this.securityManager.rewriteExtensionURL(extensionURL);
            if (this.isExtensionURLLoaded(rewritten)) {
                this._finishedLoadingExtensionScript();
                return;
            }
            if (sandboxMode === 'unsandboxed' || Trust) {
                const {load} = require('./tw-unsandboxed-extension-runner');
                const extensionObjects = await load(rewritten, this.vm);
                const fakeWorkerId = this.nextExtensionWorker++;
                this.workerURLs[fakeWorkerId] = extensionURL;

                for (const extensionObject of extensionObjects) {
                    const extensionInfo = extensionObject.getInfo();
                    if (this.isExtensionLoaded(extensionInfo.id)) {
                        log.warn(`Rejecting attempt to load a second extension with ID ${extensionInfo.id}`);
                        continue;
                    }
                    const serviceName = `unsandboxed.${fakeWorkerId}.${extensionInfo.id}`;
                    dispatch.setServiceSync(serviceName, extensionObject);
                    dispatch.callSync('extensions', 'registerExtensionServiceSync', serviceName);
                    this._loadedExtensions.set(extensionInfo.id, serviceName);
                }

                this._finishedLoadingExtensionScript();
                return;
            }

            /* eslint-disable max-len */
            let ExtensionWorker;
            if (sandboxMode === 'worker') {
                ExtensionWorker = require('worker-loader?name=js/extension-worker/extension-worker.[hash].js!./extension-worker');
            } else if (sandboxMode === 'iframe') {
                ExtensionWorker = (await import(/* webpackChunkName: "iframe-extension-worker" */ './tw-iframe-extension-worker')).default;
            } else {
                throw new Error(`Invalid sandbox mode: ${sandboxMode}`);
            }
            /* eslint-enable max-len */

            await new Promise((resolve, reject) => {
                this.pendingExtensions.push({extensionURL: rewritten, resolve, reject});
                dispatch.addWorker(new ExtensionWorker());
            });
        } catch (error) {
            this._failedLoadingExtensionScript(error);
        }
    }

    /**
     * Wait until all async extensions have loaded
     * @returns {Promise} resolved when all async extensions have loaded
     */
    allAsyncExtensionsLoaded () {
        if (this.loadingAsyncExtensions === 0) {
            return;
        }
        return new Promise((resolve, reject) => {
            this.asyncExtensionsLoadedCallbacks.push({
                resolve,
                reject
            });
        });
    }

    /**
     * Regenerate blockinfo for any loaded extensions
     * @param {string} [optExtensionId] Optional extension ID for refreshing
     * @returns {Promise} resolved once all the extensions have been reinitialized
     */
    refreshBlocks (optExtensionId) {
        const refresh = serviceName => dispatch.call(serviceName, 'getInfo')
            .then(info => {
                info = this._prepareExtensionInfo(serviceName, info);
                dispatch.call('runtime', '_refreshExtensionPrimitives', info);
            })
            .catch(e => {
                log.error('Failed to refresh built-in extension primitives', e);
            });
        if (optExtensionId) {
            if (!this._loadedExtensions.has(optExtensionId)) {
                return Promise.reject(new Error(`Unknown extension: ${optExtensionId}`));
            }
            return refresh(this._loadedExtensions.get(optExtensionId));
        }
        const allPromises = Array.from(this._loadedExtensions.values()).map(refresh);
        return Promise.all(allPromises);
    }

    allocateWorker () {
        const id = this.nextExtensionWorker++;
        const workerInfo = this.pendingExtensions.shift();
        this.pendingWorkers[id] = workerInfo;
        this.workerURLs[id] = workerInfo.extensionURL;
        return [id, workerInfo.extensionURL];
    }

    /**
     * Synchronously collect extension metadata from the specified service and begin the extension registration process.
     * @param {string} serviceName - the name of the service hosting the extension.
     */
    registerExtensionServiceSync (serviceName) {
        const info = dispatch.callSync(serviceName, 'getInfo');
        this._registerExtensionInfo(serviceName, info);
    }

    /**
     * Collect extension metadata from the specified service and begin the extension registration process.
     * @param {string} serviceName - the name of the service hosting the extension.
     */
    registerExtensionService (serviceName) {
        dispatch.call(serviceName, 'getInfo')
            .then(info => {
                if (this.isExtensionLoaded(info.id)) {
                    log.warn(`Rejecting attempt to load a second extension with ID ${info.id}`);
                    return;
                }
                this._loadedExtensions.set(info.id, serviceName);
                this._registerExtensionInfo(serviceName, info);
            })
            .catch(e => {
                log.error(`Failed to initialize extension service ${serviceName}:`, e);
            })
            .then(() => {
                this._finishedLoadingExtensionScript();
            });
    }

    _finishedLoadingExtensionScript () {
        this.loadingAsyncExtensions = Math.max(0, this.loadingAsyncExtensions - 1);
        if (this.loadingAsyncExtensions === 0) {
            this.asyncExtensionsLoadedCallbacks.forEach(i => i.resolve());
            this.asyncExtensionsLoadedCallbacks = [];
        }
    }

    _failedLoadingExtensionScript (error) {
        // Don't set the current extension counter to 0, otherwise it will go negative if another
        // extension finishes or fails to load.
        this.loadingAsyncExtensions = Math.max(0, this.loadingAsyncExtensions - 1);
        this.asyncExtensionsLoadedCallbacks.forEach(i => i.reject(error));
        this.asyncExtensionsLoadedCallbacks = [];
        // Re-throw error so the promise still rejects.
        throw error;
    }

    static _getWorkerIdFromServiceName (serviceName) {
        if (typeof serviceName !== 'string') {
            return null;
        }
        const workerServiceMatch = serviceName.match(/^(?:extension|unsandboxed)\.(\d+)\./);
        if (workerServiceMatch) {
            return Number(workerServiceMatch[1]);
        }
        const internalServiceMatch = serviceName.match(/^extension_(\d+)_/);
        if (internalServiceMatch) {
            return Number(internalServiceMatch[1]);
        }
        return null;
    }

    /**
     * Called by an extension worker to indicate that the worker has finished initialization.
     * @param {int} id - the worker ID.
     * @param {*?} e - the error encountered during initialization, if any.
     */
    onWorkerInit (id, e) {
        const workerInfo = this.pendingWorkers[id];
        delete this.pendingWorkers[id];
        if (e) {
            workerInfo.reject(e);
        } else {
            workerInfo.resolve();
        }
    }

    /**
     * Register an internal (non-Worker) extension object
     * @param {object} extensionObject - the extension object to register
     * @returns {string} The name of the registered extension service
     */
    _registerInternalExtension (extensionObject) {
        const extensionInfo = extensionObject.getInfo();
        const fakeWorkerId = this.nextExtensionWorker++;
        const serviceName = `extension_${fakeWorkerId}_${extensionInfo.id}`;
        dispatch.setServiceSync(serviceName, extensionObject);
        dispatch.callSync('extensions', 'registerExtensionServiceSync', serviceName);
        return serviceName;
    }

    /**
     * Sanitize extension info then register its primitives with the VM.
     * @param {string} serviceName - the name of the service hosting the extension
     * @param {ExtensionInfo} extensionInfo - the extension's metadata
     * @private
     */
    _registerExtensionInfo (serviceName, extensionInfo) {
        extensionInfo = this._prepareExtensionInfo(serviceName, extensionInfo);
        dispatch.call('runtime', '_registerExtensionPrimitives', extensionInfo).catch(e => {
            log.error(`Failed to register primitives for extension on service ${serviceName}:`, e);
        });
    }

    /**
     * Apply minor cleanup and defaults for optional extension fields.
     * TODO: make the ID unique in cases where two copies of the same extension are loaded.
     * @param {string} serviceName - the name of the service hosting this extension block
     * @param {ExtensionInfo} extensionInfo - the extension info to be sanitized
     * @returns {ExtensionInfo} - a new extension info object with cleaned-up values
     * @private
     */
    _prepareExtensionInfo (serviceName, extensionInfo) {
        extensionInfo = Object.assign({}, extensionInfo);
        if (!/^[a-z0-9]+$/i.test(extensionInfo.id)) {
            throw new Error('Invalid extension id');
        }
        extensionInfo.name = extensionInfo.name || extensionInfo.id;
        extensionInfo.blocks = extensionInfo.blocks || [];
        extensionInfo.targetTypes = extensionInfo.targetTypes || [];
        extensionInfo.blocks = extensionInfo.blocks.reduce((results, blockInfo) => {
            try {
                let result;
                switch (blockInfo) {
                case '---': // separator
                    result = '---';
                    break;
                default: // an ExtensionBlockMetadata object
                    result = this._prepareBlockInfo(serviceName, blockInfo);
                    break;
                }
                results.push(result);
            } catch (e) {
                // TODO: more meaningful error reporting
                log.error(`Error processing block: ${e.message}, Block:\n${JSON.stringify(blockInfo)}`);
            }
            return results;
        }, []);
        extensionInfo.menus = extensionInfo.menus || {};
        extensionInfo.menus = this._prepareMenuInfo(serviceName, extensionInfo.menus);
        return extensionInfo;
    }

    /**
     * Prepare extension menus. e.g. setup binding for dynamic menu functions.
     * @param {string} serviceName - the name of the service hosting this extension block
     * @param {Array.<MenuInfo>} menus - the menu defined by the extension.
     * @returns {Array.<MenuInfo>} - a menuInfo object with all preprocessing done.
     * @private
     */
    _prepareMenuInfo (serviceName, menus) {
        const menuNames = Object.getOwnPropertyNames(menus);
        for (let i = 0; i < menuNames.length; i++) {
            const menuName = menuNames[i];
            let menuInfo = menus[menuName];

            // If the menu description is in short form (items only) then normalize it to general form: an object with
            // its items listed in an `items` property.
            if (!menuInfo.items) {
                menuInfo = {
                    items: menuInfo
                };
                menus[menuName] = menuInfo;
            }
            // If `items` is a string, it should be the name of a function in the extension object. Calling the
            // function should return an array of items to populate the menu when it is opened.
            if (typeof menuInfo.items === 'string') {
                const menuItemFunctionName = menuInfo.items;
                const serviceObject = dispatch.services[serviceName];
                // Bind the function here so we can pass a simple item generation function to Scratch Blocks later.
                menuInfo.items = this._getExtensionMenuItems.bind(this, serviceObject, menuItemFunctionName);
            }
        }
        return menus;
    }

    /**
     * Fetch the items for a particular extension menu, providing the target ID for context.
     * @param {object} extensionObject - the extension object providing the menu.
     * @param {string} menuItemFunctionName - the name of the menu function to call.
     * @returns {Array} menu items ready for scratch-blocks.
     * @private
     */
    _getExtensionMenuItems (extensionObject, menuItemFunctionName) {
        // Fetch the items appropriate for the target currently being edited. This assumes that menus only
        // collect items when opened by the user while editing a particular target.
        const editingTarget = this.runtime.getEditingTarget() || this.runtime.getTargetForStage();
        const editingTargetID = editingTarget ? editingTarget.id : null;
        const extensionMessageContext = this.runtime.makeMessageContextForTarget(editingTarget);

        // TODO: Fix this to use dispatch.call when extensions are running in workers.
        const menuFunc = extensionObject[menuItemFunctionName];
        const menuItems = menuFunc.call(extensionObject, editingTargetID).map(
            item => {
                item = maybeFormatMessage(item, extensionMessageContext);
                switch (typeof item) {
                case 'object':
                    return [
                        maybeFormatMessage(item.text, extensionMessageContext),
                        item.value
                    ];
                case 'string':
                    return [item, item];
                default:
                    return item;
                }
            });

        if (!menuItems || menuItems.length < 1) {
            throw new Error(`Extension menu returned no items: ${menuItemFunctionName}`);
        }
        return menuItems;
    }

    /**
     * Apply defaults for optional block fields.
     * @param {string} serviceName - the name of the service hosting this extension block
     * @param {ExtensionBlockMetadata} blockInfo - the block info from the extension
     * @returns {ExtensionBlockMetadata} - a new block info object which has values for all relevant optional fields.
     * @private
     */
    _prepareBlockInfo (serviceName, blockInfo) {
        if (blockInfo.blockType === BlockType.XML) {
            blockInfo = Object.assign({}, blockInfo);
            blockInfo.xml = String(blockInfo.xml) || '';
            return blockInfo;
        }

        blockInfo = Object.assign({}, {
            blockType: BlockType.COMMAND,
            terminal: false,
            blockAllThreads: false,
            arguments: {}
        }, blockInfo);
        blockInfo.text = blockInfo.text || blockInfo.opcode;

        switch (blockInfo.blockType) {
        case BlockType.EVENT:
            if (blockInfo.func) {
                log.warn(`Ignoring function "${blockInfo.func}" for event block ${blockInfo.opcode}`);
            }
            break;
        case BlockType.BUTTON:
            if (blockInfo.opcode) {
                log.warn(`Ignoring opcode "${blockInfo.opcode}" for button with text: ${blockInfo.text}`);
            }
            blockInfo.callFunc = () => {
                dispatch.call(serviceName, blockInfo.func);
            };
            break;
        case BlockType.LABEL:
            if (blockInfo.opcode) {
                log.warn(`Ignoring opcode "${blockInfo.opcode}" for label: ${blockInfo.text}`);
            }
            break;
        default: {
            if (!blockInfo.opcode) {
                throw new Error('Missing opcode for block');
            }

            const funcName = blockInfo.func || blockInfo.opcode;

            const getBlockInfo = blockInfo.isDynamic ?
                args => args && args.mutation && args.mutation.blockInfo :
                () => blockInfo;
            const callBlockFunc = (() => {
                if (dispatch._isRemoteService(serviceName)) {
                    return (args, util, realBlockInfo) =>
                        dispatch.call(serviceName, funcName, args, util, realBlockInfo)
                            .then(result => {
                                // Scratch is only designed to handle these types.
                                // If any other value comes in such as undefined, null, an object, etc.
                                // we'll convert it to a string to avoid undefined behavior.
                                if (
                                    typeof result === 'number' ||
                                    typeof result === 'string' ||
                                    typeof result === 'boolean'
                                ) {
                                    return result;
                                }
                                return `${result}`;
                            });
                }

                // avoid promise latency if we can call direct
                const serviceObject = dispatch.services[serviceName];
                if (!serviceObject[funcName]) {
                    // The function might show up later as a dynamic property of the service object
                    log.warn(`Could not find extension block function called ${funcName}`);
                }
                return (args, util, realBlockInfo) =>
                    serviceObject[funcName](args, util, realBlockInfo);
            })();

            blockInfo.func = (args, util) => {
                const realBlockInfo = getBlockInfo(args);
                // TODO: filter args using the keys of realBlockInfo.arguments? maybe only if sandboxed?
                return callBlockFunc(args, util, realBlockInfo);
            };
            break;
        }
        }

        return blockInfo;
    }

    /**
     * Confirm message translations for extension removal
     * @private
     */
    static _getRemovalConfirmMessage (locale) {
        const messages = {
            'en': 'This project is using an extension that will be removed. Do you want to continue?',
            'zh': '此项目正在使用将被移除的扩展。是否继续？',
            'zh-cn': '此项目正在使用将被移除的扩展。是否继续？',
            'es': 'Este proyecto está usando una extensión que será eliminada. ¿Desea continuar?',
            'fr': 'Ce projet utilise une extension qui sera supprimée. Voulez-vous continuer?',
            'de': 'Dieses Projekt verwendet eine Erweiterung, die entfernt wird. Möchten Sie fortfahren?',
            'ja': 'このプロジェクトは削除される拡張機能を使用しています。続行しますか？',
            'ko': '이 프로젝트는 제거될 확장 기능을 사용하고 있습니다. 계속하시겠습니까?',
            'pt': 'Este projeto está usando uma extensão que será removida. Deseja continuar?',
            'ru': 'Этот проект использует расширение, которое будет удалено. Хотите продолжить?',
            'it': 'Questo progetto sta utilizzando un\'estensione che verrà rimossa. Vuoi continuare?',
            'nl': 'Dit project gebruikt een extensie die wordt verwijderd. Wilt u doorgaan?',
            'pl': 'Ten projekt używa rozszerzenie, które zostanie usunięte. Czy chcesz kontynuować?',
            'tr': 'Bu projeje kaldırılacak bir uzantı kullanıyor. Devam etmek istiyor musunuz?',
            'ar': 'هذا المشروع يستخدم ملحقًا سيتم إزالته. هل تريد المتابعة؟',
            'th': 'โปรเจกต์นี้กำลังใช้ส่วนขยายที่จะถูกลบ คุณต้องการดำเนินการต่อหรือไม่?',
            'vi': 'Dự án này đang sử dụng tiện ích mở rộng sẽ bị xóa. Bạn có muốn tiếp tục?',
            'id': 'Proyek ini menggunakan ekstensi yang akan dihapus. Apakah Anda ingin melanjutkan?'
        };
        return messages[locale] || messages[locale.split('-')[0]] || messages.en;
    }

    static _isExtensionOpcode (block, extensionId) {
        return (
            block &&
            typeof block.opcode === 'string' &&
            block.opcode.startsWith(`${extensionId}_`)
        );
    }

    static _collectInputTree (blocks, startBlockId, result) {
        if (!startBlockId || result.has(startBlockId)) {
            return;
        }
        const block = blocks[startBlockId];
        if (!block) {
            return;
        }

        result.add(startBlockId);

        if (block.inputs) {
            for (const inputName in block.inputs) {
                const input = block.inputs[inputName];
                if (!input) {
                    continue;
                }
                if (input.block) {
                    ExtensionManager._collectInputTree(blocks, input.block, result);
                }
                if (input.shadow) {
                    ExtensionManager._collectInputTree(blocks, input.shadow, result);
                }
            }
        }

        if (block.next) {
            ExtensionManager._collectInputTree(blocks, block.next, result);
        }
    }

    static _findNextSurvivingBlockId (blocks, startBlockId, blockIdsToDelete) {
        let nextId = startBlockId;
        while (nextId && blockIdsToDelete.has(nextId)) {
            const nextBlock = blocks[nextId];
            nextId = nextBlock ? nextBlock.next : null;
        }
        return nextId || null;
    }

    _isWorkerIdInUse (workerId) {
        for (const loadedServiceName of this._loadedExtensions.values()) {
            if (ExtensionManager._getWorkerIdFromServiceName(loadedServiceName) === workerId) {
                return true;
            }
        }
        return false;
    }

    /**
     * Unload an extension and remove all its blocks from the workspace
     * @param {string} extensionId - the ID of the extension to unload
     * @param {Object} options - Optional settings
     * @param {boolean} options.preserveBlocks - If true, keep blocks in workspace (for hot reload)
     * @param {boolean} options.skipConfirm - If true, skip confirmation dialog
     */
    unloadExtension (extensionId, options = {}) {
        const { preserveBlocks = false, skipConfirm = false } = options;
        
        if (!this.isExtensionLoaded(extensionId)) {
            return false;
        }

        const targetRemovalPlans = [];
        const allBlockIdsToDelete = new Set();
        for (const target of this.runtime.targets) {
            if (!target.blocks) {
                continue;
            }

            const blocks = target.blocks._blocks;
            const extensionRootBlockIds = [];
            for (const blockId of Object.keys(blocks)) {
                if (ExtensionManager._isExtensionOpcode(blocks[blockId], extensionId)) {
                    extensionRootBlockIds.push(blockId);
                }
            }
            if (extensionRootBlockIds.length === 0) {
                continue;
            }

            const blockIdsToDelete = new Set(extensionRootBlockIds);
            for (const rootBlockId of extensionRootBlockIds) {
                const rootBlock = blocks[rootBlockId];
                if (!rootBlock || !rootBlock.inputs) {
                    continue;
                }
                for (const inputName in rootBlock.inputs) {
                    const input = rootBlock.inputs[inputName];
                    if (!input) {
                        continue;
                    }
                    if (input.block) {
                        ExtensionManager._collectInputTree(blocks, input.block, blockIdsToDelete);
                    }
                    if (input.shadow) {
                        ExtensionManager._collectInputTree(blocks, input.shadow, blockIdsToDelete);
                    }
                }
            }

            targetRemovalPlans.push({
                target,
                rootBlockIds: extensionRootBlockIds,
                blockIdsToDelete
            });
            for (const blockId of blockIdsToDelete) {
                allBlockIdsToDelete.add(blockId);
            }
        }

        // 如果 preserveBlocks 为 true，跳过所有积木删除相关逻辑
        if (!preserveBlocks) {
            if (
                allBlockIdsToDelete.size > 0 &&
                !skipConfirm &&
                typeof window !== 'undefined' &&
                typeof window.confirm === 'function'
            ) {
                const formatMessage = require('format-message');
                const locale = formatMessage.setup().locale || 'en';
                const message = ExtensionManager._getRemovalConfirmMessage(locale);
                const confirmKey = 'confirm';
                const confirmRemoval = window[confirmKey];
                if (typeof confirmRemoval === 'function' && !confirmRemoval.call(window, message)) {
                    return false;
                }
            }
        }

        const removedBlockIds = new Set();
        if (!preserveBlocks) {
            for (const thread of this.runtime.threads) {
                if (!thread || !thread.stack) {
                    continue;
                }
                if (thread.stack.some(blockId => allBlockIdsToDelete.has(blockId))) {
                    this.runtime._stopThread(thread);
                }
            }

            for (const plan of targetRemovalPlans) {
                const {target, rootBlockIds, blockIdsToDelete} = plan;
                const blocks = target.blocks._blocks;

                for (const rootBlockId of rootBlockIds) {
                    const rootBlock = blocks[rootBlockId];
                    if (!rootBlock) {
                        continue;
                    }
                    const replacementNextId = ExtensionManager._findNextSurvivingBlockId(
                        blocks,
                        rootBlock.next,
                        blockIdsToDelete
                    );

                    const parentId = rootBlock.parent;
                    if (parentId && !blockIdsToDelete.has(parentId)) {
                        const parentBlock = blocks[parentId];
                        if (parentBlock) {
                            if (parentBlock.next === rootBlockId) {
                                parentBlock.next = replacementNextId;
                                if (replacementNextId && blocks[replacementNextId]) {
                                    blocks[replacementNextId].parent = parentId;
                                    blocks[replacementNextId].topLevel = false;
                                }
                            }
                            if (parentBlock.inputs) {
                                for (const inputName in parentBlock.inputs) {
                                    const input = parentBlock.inputs[inputName];
                                    if (!input) {
                                        continue;
                                    }
                                    if (input.block === rootBlockId) {
                                        input.block = null;
                                    }
                                    if (input.shadow === rootBlockId) {
                                        input.shadow = null;
                                    }
                                }
                            }
                        }
                    } else if (rootBlock.topLevel && replacementNextId && blocks[replacementNextId]) {
                        blocks[replacementNextId].topLevel = true;
                        blocks[replacementNextId].parent = null;
                        target.blocks._addScript(replacementNextId);
                    }
                }

                for (const blockId of blockIdsToDelete) {
                    const block = blocks[blockId];
                    if (!block) {
                        continue;
                    }
                    if (block.topLevel) {
                        target.blocks._deleteScript(blockId);
                    }
                    delete blocks[blockId];
                    removedBlockIds.add(blockId);
                }

                target.blocks.resetCache();
            }

            const monitorIdsToRemove = [];
            this.runtime._monitorState.forEach(monitorData => {
                const opcode = monitorData.get('opcode');
                if (typeof opcode === 'string' && opcode.startsWith(`${extensionId}_`)) {
                    monitorIdsToRemove.push(monitorData.get('id'));
                }
            });
            const monitorBlocks = this.runtime.monitorBlocks._blocks;
            for (const monitorId of Object.keys(monitorBlocks)) {
                if (ExtensionManager._isExtensionOpcode(monitorBlocks[monitorId], extensionId)) {
                    monitorIdsToRemove.push(monitorId);
                }
            }
            for (const monitorId of new Set(monitorIdsToRemove)) {
                this.runtime.requestRemoveMonitor(monitorId);
                if (this.runtime.monitorBlocks.getBlock(monitorId)) {
                    this.runtime.monitorBlocks.deleteBlock(monitorId);
                }
            }
        } // end of if (!preserveBlocks)

        const removeExtensionOpcodes = opcodes => {
            for (const opcode of Object.keys(opcodes)) {
                if (opcode.startsWith(`${extensionId}_`)) {
                    delete opcodes[opcode];
                }
            }
        };

        removeExtensionOpcodes(this.runtime._primitives);
        removeExtensionOpcodes(this.runtime._hats);
        removeExtensionOpcodes(this.runtime._flowing);
        removeExtensionOpcodes(this.runtime.monitorBlockInfo);

        if (Array.isArray(this.runtime._blockInfo)) {
            this.runtime._blockInfo = this.runtime._blockInfo.filter(info => info.id !== extensionId);
        }

        if (this.runtime.extensionButtons && typeof this.runtime.extensionButtons.keys === 'function') {
            const buttonIdsToDelete = [];
            for (const buttonId of this.runtime.extensionButtons.keys()) {
                if (buttonId.startsWith(`${extensionId}_`)) {
                    buttonIdsToDelete.push(buttonId);
                }
            }
            for (const buttonId of buttonIdsToDelete) {
                this.runtime.extensionButtons.delete(buttonId);
            }
        }

        if (this.runtime.extensionStorage) {
            delete this.runtime.extensionStorage[extensionId];
        }
        for (const target of this.runtime.targets) {
            if (target.extensionStorage) {
                delete target.extensionStorage[extensionId];
            }
        }

        delete this.runtime[`ext_${extensionId}`];

        if (this.runtime.compiler && typeof this.runtime.compiler.clearExtensionCache === 'function') {
            this.runtime.compiler.clearExtensionCache(extensionId);
        }

        const serviceName = this._loadedExtensions.get(extensionId);
        this._loadedExtensions.delete(extensionId);
        if (serviceName && Object.prototype.hasOwnProperty.call(dispatch.services, serviceName)) {
            delete dispatch.services[serviceName];
        }

        const workerId = ExtensionManager._getWorkerIdFromServiceName(serviceName);
        if (workerId !== null && !this._isWorkerIdInUse(workerId)) {
            delete this.workerURLs[workerId];
            delete this.pendingWorkers[workerId];
        }

        this.runtime.requestBlocksUpdate();
        this.runtime.requestToolboxExtensionsUpdate();
        this.runtime.emitProjectChanged();

        const removalDetail = {
            id: extensionId,
            blockIds: Array.from(removedBlockIds)
        };
        this.runtime.emit('EXTENSION_REMOVED', extensionId, removalDetail);
        return true;
    }

    getExtensionURLs () {
        const extensionURLs = {};
        for (const [extensionId, serviceName] of this._loadedExtensions.entries()) {
            if (Object.prototype.hasOwnProperty.call(this.builtinExtensions, extensionId)) {
                continue;
            }

            const workerId = ExtensionManager._getWorkerIdFromServiceName(serviceName);
            if (workerId === null) {
                continue;
            }
            const extensionURL = this.workerURLs[workerId];
            if (typeof extensionURL === 'string') {
                extensionURLs[extensionId] = extensionURL;
            }
        }
        return extensionURLs;
    }

    isExtensionURLLoaded (url) {
        const loadedURLs = Object.values(this.workerURLs);
        const candidates = this._getExtensionLoadCandidates(url);
        return candidates.some(candidateURL => loadedURLs.includes(candidateURL));
    }
}

module.exports = ExtensionManager;
