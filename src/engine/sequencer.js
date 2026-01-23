const Timer = require('../util/timer');
const Thread = require('./thread');
const execute = require('./execute.js');
const compilerExecute = require('../compiler/jsexecute');

/**
 * Profiler frame name for stepping a single thread.
 * @const {string}
 */
const stepThreadProfilerFrame = 'Sequencer.stepThread';

/**
 * Profiler frame name for the inner loop of stepThreads.
 * @const {string}
 */
const stepThreadsInnerProfilerFrame = 'Sequencer.stepThreads#inner';

/**
 * Profiler frame name for execute.
 * @const {string}
 */
const executeProfilerFrame = 'execute';

/**
 * Profiler frame ID for stepThreadProfilerFrame.
 * @type {number}
 */
let stepThreadProfilerId = -1;

/**
 * Profiler frame ID for stepThreadsInnerProfilerFrame.
 * @type {number}
 */
let stepThreadsInnerProfilerId = -1;

/**
 * Profiler frame ID for executeProfilerFrame.
 * @type {number}
 */
let executeProfilerId = -1;

class Sequencer {
    constructor (runtime) {
        /**
         * A utility timer for timing thread sequencing.
         * @type {!Timer}
         */
        this.timer = new Timer();

        /**
         * Reference to the runtime owning this sequencer.
         * @type {!Runtime}
         */
        this.runtime = runtime;

        this.activeThread = null;
    }

    /**
     * Time to run a warp-mode thread, in ms.
     * @type {number}
     */
    static get WARP_TIME () {
        return 500;
    }

    /**
     * Step through all threads in `this.runtime.threads`, running them in order.
     * @return {Array.<!Thread>} List of inactive threads after stepping.
     */
    stepThreads () {
        // Work time is 75% of the thread stepping interval.
        const WORK_TIME = 0.75 * this.runtime.currentStepTime;
        // For compatibility with Scatch 2, update the millisecond clock
        // on the Runtime once per step (see Interpreter.as in Scratch 2
        // for original use of `currentMSecs`)
        this.runtime.updateCurrentMSecs();
        // Start counting toward WORK_TIME.
        this.timer.start();
        // Count of active threads.
        let numActiveThreads = Infinity;
        // Whether `stepThreads` has run through a full single tick.
        let ranFirstTick = false;
        const doneThreads = [];

        // Cache PTM threads with their custom max iterations for performance
        const ptmThreads = new Map();
        // Track auto turbo threads with their current turbo value
        const autoTurboThreads = new Map();
        const threads = this.runtime.threads;
        for (let i = 0; i < threads.length; i++) {
            const thread = threads[i];
            if (thread.target && thread.topBlock) {
                const block = thread.target.blocks.getBlock(thread.topBlock);
                if (block && block.comment) {
                    const comment = thread.target.comments[block.comment];
                    if (comment && comment.text && comment.text.includes('[Turbo')) {
                        // Parse custom max iterations from comment, format: [Turbo:50], [Turbo], or [Turbo:auto]
                        const turboMatch = comment.text.match(/\[Turbo(?::(\d+|auto))?\]/);
                        if (turboMatch) {
                            const value = turboMatch[1];
                            if (value === 'auto') {
                                // Auto mode: use existing value from persistent storage, or start with 10
                                const existingValue = this._autoTurboCache ? this._autoTurboCache.get(thread.getId()) : null;
                                const startValue = existingValue || 10;
                                autoTurboThreads.set(thread, startValue);
                                ptmThreads.set(thread, startValue);
                            } else if (value) {
                                const maxIterations = parseInt(value, 10);
                                ptmThreads.set(thread, maxIterations);
                            } else {
                                // Default to 10 if no value specified
                                ptmThreads.set(thread, 10);
                            }
                        }
                    }
                }
            }
        }

        // Track whether non-PTM threads have been executed at least once when redraw is requested
        let nonPTMThreadsExecuted = false;
        // Track PTM thread iterations per thread
        const ptmIterations = new Map();
        // Global iteration counter for PTM threads
        let globalPTMIterations = 0;
        // Get the maximum allowed iterations from all PTM threads
        let maxPTMIterations = 0;
        for (const iterations of ptmThreads.values()) {
            maxPTMIterations = Math.max(maxPTMIterations, Math.floor(iterations));
        }

        // Conditions for continuing to stepping threads:
        // 1. We must have threads in the list, and some must be active.
        // 2. Time elapsed must be less than WORK_TIME.
        // 3. Either turbo mode, or no redraw has been requested by a primitive,
        //    or there are PTM threads running when redraw is requested.
        // 4. PTM iterations haven't exceeded limit to prevent frame rate drops.
        while (this.runtime.threads.length > 0 &&
               numActiveThreads > 0 &&
               this.timer.timeElapsed() < WORK_TIME &&
               (this.runtime.turboMode || !this.runtime.redrawRequested ||
                (this.runtime.redrawRequested && ptmThreads.size > 0 && globalPTMIterations < maxPTMIterations))) {
            if (this.runtime.profiler !== null) {
                if (stepThreadsInnerProfilerId === -1) {
                    stepThreadsInnerProfilerId = this.runtime.profiler.idByName(stepThreadsInnerProfilerFrame);
                }
                this.runtime.profiler.start(stepThreadsInnerProfilerId);
            }

            numActiveThreads = 0;
            let stoppedThread = false;
            let hasPTMThread = false;
            // Attempt to run each thread one time.
            for (let i = 0; i < threads.length; i++) {
                const activeThread = this.activeThread = threads[i];
                // Check if the thread is done so it is not executed.
                if (activeThread.stack.length === 0 ||
                    activeThread.status === Thread.STATUS_DONE) {
                    // Finished with this thread.
                    stoppedThread = true;
                    continue;
                }
                if (activeThread.status === Thread.STATUS_YIELD_TICK &&
                    !ranFirstTick) {
                    // Clear single-tick yield from the last call of `stepThreads`.
                    activeThread.status = Thread.STATUS_RUNNING;
                }
                if (activeThread.status === Thread.STATUS_RUNNING ||
                    activeThread.status === Thread.STATUS_YIELD) {
                    const isPTM = ptmThreads.has(activeThread);
                    const maxIterations = isPTM ? Math.floor(ptmThreads.get(activeThread)) : 0;
                    const currentIterations = ptmIterations.get(activeThread) || 0;
                    if (isPTM) {
                        hasPTMThread = true;
                    }
                    // Execute PTM threads always, or non-PTM threads only on first iteration when redraw is requested
                    // For PTM threads, also check if iterations haven't exceeded custom limit
                    if (isPTM || !this.runtime.redrawRequested || !nonPTMThreadsExecuted) {
                        if (!isPTM || currentIterations < maxIterations) {
                            // Normal-mode thread: step.
                            if (this.runtime.profiler !== null) {
                                if (stepThreadProfilerId === -1) {
                                    stepThreadProfilerId = this.runtime.profiler.idByName(stepThreadProfilerFrame);
                                }

                                // Increment the number of times stepThread is called.
                                this.runtime.profiler.increment(stepThreadProfilerId);
                            }
                            this.stepThread(activeThread);
                            activeThread.warpTimer = null;
                        }
                    }
                }
                if (activeThread.status === Thread.STATUS_RUNNING) {
                    numActiveThreads++;
                }
                // Check if the thread completed while it just stepped to make
                // sure we remove it before the next iteration of all threads.
                if (activeThread.stack.length === 0 ||
                    activeThread.status === Thread.STATUS_DONE) {
                    // Finished with this thread.
                    stoppedThread = true;
                }
            }
            // We successfully ticked once. Prevents running STATUS_YIELD_TICK
            // threads on the next tick.
            ranFirstTick = true;
            nonPTMThreadsExecuted = true;

            // Increment PTM iteration counter for each PTM thread if we executed them
            if (hasPTMThread && this.runtime.redrawRequested) {
                for (const thread of ptmThreads.keys()) {
                    const current = ptmIterations.get(thread) || 0;
                    ptmIterations.set(thread, current + 1);
                }
                globalPTMIterations++;

// Auto-adjust turbo values for auto threads based on actual FPS
                if (autoTurboThreads.size > 0) {
                    const currentFPS = this.runtime.getCurrentFPS();
                    const targetFPS = this.runtime.frameLoop.framerate === 0 ? 60 : this.runtime.frameLoop.framerate;
                    const fpsRatio = currentFPS / targetFPS;

                    for (const [thread, currentTurbo] of autoTurboThreads) {
                        let newTurbo = currentTurbo;

                        // If FPS is very low (<10% of target), decrease turbo significantly
                        if (fpsRatio < 0.1) {
                            newTurbo = Math.max(1, currentTurbo * 0.999);
                        }
                        // If FPS is low (<20% of target), decrease turbo slightly
                        else if (fpsRatio < 0.2) {
                            newTurbo = Math.max(1, currentTurbo * 0.9995);
                        }
                        // If FPS is good (>80% of target), increase turbo slightly
                        else if (fpsRatio > 0.8) {
                            newTurbo = Math.min(1000000, currentTurbo * 1.001);
                        }
                        // If FPS is very high (>90% of target), increase turbo
                        else if (fpsRatio > 0.9) {
                            newTurbo = Math.min(1000000, currentTurbo * 1.0005);
                        }

                        if (newTurbo !== currentTurbo) {
                            autoTurboThreads.set(thread, newTurbo);
                            ptmThreads.set(thread, newTurbo);
                            // Save to persistent cache
                            if (!this._autoTurboCache) {
                                this._autoTurboCache = new Map();
                            }
                            this._autoTurboCache.set(thread.getId(), newTurbo);
                            // Update maxPTMIterations if needed (round when comparing)
                            if (Math.floor(newTurbo) > maxPTMIterations) {
                                maxPTMIterations = Math.floor(newTurbo);
                            }
                        }
                    }
                    
                }
            }

            if (this.runtime.profiler !== null) {
                this.runtime.profiler.stop();
            }

            // Filter inactive threads from `this.runtime.threads`.
            if (stoppedThread) {
                let nextActiveThread = 0;
                for (let i = 0; i < this.runtime.threads.length; i++) {
                    const thread = this.runtime.threads[i];
                    if (thread.stack.length !== 0 &&
                        thread.status !== Thread.STATUS_DONE) {
                        this.runtime.threads[nextActiveThread] = thread;
                        nextActiveThread++;
                    } else {
                        this.runtime.threadMap.delete(thread.getId());
                        doneThreads.push(thread);
                    }
                }
                this.runtime.threads.length = nextActiveThread;
            }
        }

        this.activeThread = null;

        return doneThreads;
    }

    /**
     * Step the requested thread for as long as necessary.
     * @param {!Thread} thread Thread object to step.
     */
    stepThread (thread) {
        if (thread.isCompiled) {
            compilerExecute(thread);
            return;
        }

        let currentBlockId = thread.peekStack();
        if (!currentBlockId) {
            // A "null block" - empty branch.
            thread.popStack();

            // Did the null follow a hat block?
            if (thread.stack.length === 0) {
                thread.status = Thread.STATUS_DONE;
                return;
            }
        }
        // Save the current block ID to notice if we did control flow.
        while ((currentBlockId = thread.peekStack())) {
            const initialStackSize = thread.stack.length;
            let isWarpMode = thread.peekStackFrame().warpMode;
            if (isWarpMode && !thread.warpTimer) {
                // Initialize warp-mode timer if it hasn't been already.
                // This will start counting the thread toward `Sequencer.WARP_TIME`.
                thread.warpTimer = new Timer();
                thread.warpTimer.start();
            }
            // Execute the current block.
            if (this.runtime.profiler !== null) {
                if (executeProfilerId === -1) {
                    executeProfilerId = this.runtime.profiler.idByName(executeProfilerFrame);
                }

                // Increment the number of times execute is called.
                this.runtime.profiler.increment(executeProfilerId);
            }
            if (thread.target === null) {
                this.retireThread(thread);
            } else {
                execute(this, thread);
            }
            thread.blockGlowInFrame = currentBlockId;
            // If the thread has yielded or is waiting, yield to other threads.
            if (thread.status === Thread.STATUS_YIELD) {
                // Mark as running for next iteration.
                thread.status = Thread.STATUS_RUNNING;
                // In warp mode, yielded blocks are re-executed immediately.
                if (isWarpMode &&
                    thread.warpTimer.timeElapsed() <= Sequencer.WARP_TIME) {
                    continue;
                }
                return;
            } else if (thread.status === Thread.STATUS_PROMISE_WAIT) {
                // A promise was returned by the primitive. Yield the thread
                // until the promise resolves. Promise resolution should reset
                // thread.status to Thread.STATUS_RUNNING.
                return;
            } else if (thread.status === Thread.STATUS_YIELD_TICK) {
                // stepThreads will reset the thread to Thread.STATUS_RUNNING
                return;
            } else if (thread.status === Thread.STATUS_DONE) {
                // Nothing more to execute.
                return;
            }
            // If no control flow has happened, switch to next block.
            if (
                thread.stack.length === initialStackSize &&
                thread.peekStack() === currentBlockId &&
                !thread.peekStackFrame().waitingReporter
            ) {
                thread.goToNextBlock();
            }
            // If no next block has been found at this point, look on the stack.
            while (!thread.peekStack()) {
                thread.popStack();

                if (thread.stack.length === 0) {
                    // No more stack to run!
                    thread.status = Thread.STATUS_DONE;
                    return;
                }

                const stackFrame = thread.peekStackFrame();
                isWarpMode = stackFrame.warpMode;

                if (stackFrame.isLoop) {
                    // The current level of the stack is marked as a loop.
                    // Return to yield for the frame/tick in general.
                    // Unless we're in warp mode - then only return if the
                    // warp timer is up.
                    if (!isWarpMode ||
                        thread.warpTimer.timeElapsed() > Sequencer.WARP_TIME) {
                        // Don't do anything to the stack, since loops need
                        // to be re-executed.
                        return;
                    }
                    // Don't go to the next block for this level of the stack,
                    // since loops need to be re-executed.
                    continue;

                } else if (stackFrame.waitingReporter) {
                    // This level of the stack was waiting for a value.
                    // This means a reporter has just returned - so don't go
                    // to the next block for this level of the stack.
                    continue;
                }
                // Get next block of existing block on the stack.
                thread.goToNextBlock();
            }
        }
    }

    /**
     * Step a thread into a block's branch.
     * @param {!Thread} thread Thread object to step to branch.
     * @param {number} branchNum Which branch to step to (i.e., 1, 2).
     * @param {boolean} isLoop Whether this block is a loop.
     */
    stepToBranch (thread, branchNum, isLoop) {
        if (!branchNum) {
            branchNum = 1;
        }
        const currentBlockId = thread.peekStack();
        const branchId = thread.target.blocks.getBranch(
            currentBlockId,
            branchNum
        );
        thread.peekStackFrame().isLoop = isLoop;
        if (branchId) {
            // Push branch ID to the thread's stack.
            thread.pushStack(branchId);
        } else {
            thread.pushStack(null);
        }
    }

    /**
     * Step a procedure.
     * @param {!Thread} thread Thread object to step to procedure.
     * @param {!string} procedureCode Procedure code of procedure to step to.
     */
    stepToProcedure (thread, procedureCode) {
        const definition = thread.target.blocks.getProcedureDefinition(procedureCode);
        if (!definition) {
            return;
        }
        // Check if the call is recursive.
        // If so, set the thread to yield after pushing.
        const isRecursive = thread.isRecursiveCall(procedureCode);
        // To step to a procedure, we put its definition on the stack.
        // Execution for the thread will proceed through the definition hat
        // and on to the main definition of the procedure.
        // When that set of blocks finishes executing, it will be popped
        // from the stack by the sequencer, returning control to the caller.
        thread.pushStack(definition);
        // In known warp-mode threads, only yield when time is up.
        if (thread.peekStackFrame().warpMode &&
            thread.warpTimer.timeElapsed() > Sequencer.WARP_TIME) {
            thread.status = Thread.STATUS_YIELD;
        } else {
            // Look for warp-mode flag on definition, and set the thread
            // to warp-mode if needed.
            const definitionBlock = thread.target.blocks.getBlock(definition);
            const innerBlock = thread.target.blocks.getBlock(
                definitionBlock.inputs.custom_block.block);
            let doWarp = false;
            if (innerBlock && innerBlock.mutation) {
                const warp = innerBlock.mutation.warp;
                if (typeof warp === 'boolean') {
                    doWarp = warp;
                } else if (typeof warp === 'string') {
                    doWarp = JSON.parse(warp);
                }
            }
            if (doWarp) {
                thread.peekStackFrame().warpMode = true;
            } else if (isRecursive) {
                // In normal-mode threads, yield any time we have a recursive call.
                thread.status = Thread.STATUS_YIELD;
            }
        }
    }

    /**
     * Retire a thread in the middle, without considering further blocks.
     * @param {!Thread} thread Thread object to retire.
     */
    retireThread (thread) {
        thread.stack = [];
        thread.stackFrame = [];
        thread.requestScriptGlowInFrame = false;
        thread.status = Thread.STATUS_DONE;
        if (thread.isCompiled) {
            thread.procedures = null;
            thread.generator = null;
        }
    }
}

module.exports = Sequencer;
