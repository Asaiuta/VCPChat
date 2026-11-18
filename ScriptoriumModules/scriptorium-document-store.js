'use strict';

(() => {
    const stringify = JSON.stringify.bind(JSON);
    const parse = JSON.parse.bind(JSON);
    const freeze = Object.freeze;
    const createObject = Object.create;
    const ByteArray = Uint8Array;
    const NativeMap = Map;
    const NativeWeakMap = WeakMap;
    const call = Function.prototype.call.bind(Function.prototype.call);
    const mapEntries = Map.prototype.entries;
    const mapGet = Map.prototype.get;
    const mapHas = Map.prototype.has;
    const mapSet = Map.prototype.set;
    const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
    const mapNext = Object.getPrototypeOf(new Map().entries()).next;
    const weakGet = WeakMap.prototype.get;
    const weakSet = WeakMap.prototype.set;
    const isArray = Array.isArray;
    const isView = ArrayBuffer.isView;
    const isInteger = Number.isInteger;
    const typedLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length').get;

    function cloneResourceBytes(bytes) {
        const length = isArray(bytes) ? bytes.length
            : isView(bytes) ? call(typedLength, bytes) : undefined;
        if (!isInteger(length) || length < 0) throw new TypeError('Resource bytes must be a byte array.');
        const copy = new ByteArray(length);
        for (let index = 0; index < length; index += 1) {
            const value = bytes[index];
            if (!isInteger(value) || value < 0 || value > 255) {
                throw new TypeError('Resource bytes must contain integers from 0 to 255.');
            }
            copy[index] = value;
        }
        return copy;
    }

    function cloneResourceMap(resources) {
        const copy = new NativeMap();
        const entries = call(mapEntries, resources);
        for (let item = call(mapNext, entries); !item.done; item = call(mapNext, entries)) {
            const [id, bytes] = item.value;
            if (typeof id !== 'string') throw new TypeError('Resource IDs must be strings.');
            call(mapSet, copy, id, cloneResourceBytes(bytes));
        }
        return copy;
    }

    const EVENTS = Object.freeze({
        DOCUMENT_REPLACED: 'document-replaced',
        DOCUMENT_MUTATED: 'document-mutated',
        STATUS_CHANGED: 'status-changed',
        SAVED: 'saved',
        DISPOSED: 'disposed',
    });

    function createDocumentStore(options = {}) {
        const core = options.core;
        const containerModule = options.containerModule;
        const settingsPort = options.settingsPort || {};
        if (!core) throw new TypeError('Document store requires VDocCore.');

        const listeners = new Map();
        const persistenceSnapshots = new NativeWeakMap();
        const state = {
            document: null,
            currentPath: null,
            currentName: '未命名文稿.vdocx',
            dirty: false,
            ready: false,
            saving: false,
            loading: false,
            revision: 0,
            persistenceRevision: 0,
            generation: 0,
            resourceData: new Map(),
            resourceObjectUrls: new Map(),
            resourceResolver: null,
            disposed: false,
        };

        function assertActive() {
            if (state.disposed) throw new Error('Document store has been disposed.');
        }

        function emit(type, detail = {}) {
            const event = Object.freeze({
                type,
                document: state.document,
                documentId: state.document?.manifest?.id || null,
                revision: state.revision,
                persistenceRevision: state.persistenceRevision,
                generation: state.generation,
                ...detail,
            });
            [...(listeners.get(type) || [])].forEach((listener) => {
                try {
                    listener(event);
                } catch (error) {
                    console.error(`[ScriptoriumDocumentStore] ${type} listener failed:`, error);
                }
            });
            [...(listeners.get('*') || [])].forEach((listener) => {
                try {
                    listener(event);
                } catch (error) {
                    console.error('[ScriptoriumDocumentStore] wildcard listener failed:', error);
                }
            });
            return event;
        }

        function subscribe(type, listener) {
            assertActive();
            if (typeof listener !== 'function') {
                throw new TypeError('Document store listener must be a function.');
            }
            const key = String(type || '*');
            const bucket = listeners.get(key) || new Set();
            bucket.add(listener);
            listeners.set(key, bucket);
            return () => {
                bucket.delete(listener);
                if (!bucket.size) listeners.delete(key);
            };
        }

        function status() {
            return Object.freeze({
                documentId: state.document?.manifest?.id || null,
                currentPath: state.currentPath,
                currentName: state.currentName,
                dirty: state.dirty,
                ready: state.ready,
                saving: state.saving,
                loading: state.loading,
                revision: state.revision,
                persistenceRevision: state.persistenceRevision,
                generation: state.generation,
            });
        }

        function documentModel() {
            return state.document;
        }

        function resourceData() {
            return state.resourceData;
        }

        function resourceResolver() {
            return state.resourceResolver;
        }

        function defaultNameFor(documentModel) {
            const extension = core.extensionForKind(documentModel.manifest.scene.kind);
            const fallback = documentModel.manifest.scene.kind === core.PROJECT_KINDS.SLIDE_DECK
                ? '未命名演示'
                : '未命名文稿';
            const supplied = String(documentModel.manifest.title || fallback);
            return supplied.toLowerCase().endsWith(extension)
                ? supplied
                : `${supplied.replace(/\.[^.]+$/, '')}${extension}`;
        }

        function revokeResources() {
            try {
                state.resourceResolver?.revoke?.();
            } catch (error) {
                console.warn('[ScriptoriumDocumentStore] Resource revocation failed:', error);
            }
            state.resourceResolver = null;
            state.resourceObjectUrls = new Map();
        }

        function replaceDocument(documentModel, metadata = {}) {
            assertActive();
            const normalized = core.normalizeDocument(documentModel);
            revokeResources();
            state.generation += 1;
            state.document = normalized;
            state.currentPath = metadata.filePath || null;
            state.currentName = String(metadata.name || defaultNameFor(normalized));
            const extension = core.extensionForKind(normalized.manifest.scene.kind);
            // 从 .md 原位打开的文稿保存回原文件（modules/scriptorium/markdownFiles），保留原文件名。
            if (!normalized.manifest.markdownFile && !state.currentName.toLowerCase().endsWith(extension)) {
                state.currentName = `${
                    state.currentName.replace(/\.[^.]+$/, '')
                }${extension}`;
            }
            state.resourceData = metadata.resourceData instanceof Map
                ? metadata.resourceData
                : new Map();
            state.resourceResolver = containerModule?.createRuntimeResolver?.(
                normalized,
                state.resourceData,
                state.resourceObjectUrls,
                {
                    trustNetworkFonts: () =>
                        settingsPort.get?.('trustNetworkFonts') === true,
                }
            ) || null;
            state.dirty = metadata.dirty === true;
            state.ready = true;
            state.saving = false;
            state.loading = false;
            state.revision = 0;
            state.persistenceRevision = 0;
            emit(EVENTS.DOCUMENT_REPLACED, {
                previousDocumentId: metadata.previousDocumentId || null,
                reason: metadata.reason || 'replace',
            });
            emit(EVENTS.STATUS_CHANGED, { reason: 'document-replaced' });
            return normalized;
        }

        function mutate(mutator, options = {}) {
            assertActive();
            if (!state.document || typeof mutator !== 'function') return false;
            const beforeRevision = state.revision;
            const beforePersistenceRevision = state.persistenceRevision;
            const result = mutator(state.document);
            if (result === false) return false;
            state.document.manifest.modifiedAt = new Date().toISOString();
            state.revision += 1;
            state.persistenceRevision += 1;
            state.dirty = options.dirty !== false;
            emit(EVENTS.DOCUMENT_MUTATED, {
                reason: options.reason || 'mutation',
                beforeRevision,
                beforePersistenceRevision,
                result,
            });
            emit(EVENTS.STATUS_CHANGED, {
                reason: options.reason || 'mutation',
            });
            return result === undefined ? true : result;
        }

        function updateDerived(mutator, options = {}) {
            assertActive();
            if (!state.document || typeof mutator !== 'function') return false;
            const beforePersistenceRevision = state.persistenceRevision;
            const result = mutator(state.document);
            if (result === false) return false;
            // Derived fields are packed too, even when source and dirty stay unchanged.
            state.persistenceRevision += 1;
            emit(EVENTS.DOCUMENT_MUTATED, {
                reason: options.reason || 'derived-state',
                beforeRevision: state.revision,
                beforePersistenceRevision,
                derived: true,
                result,
            });
            return result === undefined ? true : result;
        }

        function markDirty(options = {}) {
            assertActive();
            if (!state.ready || state.loading || !state.document) return false;
            const beforeRevision = state.revision;
            const beforePersistenceRevision = state.persistenceRevision;
            if (options.incrementRevision !== false) state.revision += 1;
            state.persistenceRevision += 1;
            state.dirty = true;
            emit(EVENTS.DOCUMENT_MUTATED, {
                reason: options.reason || 'dirty',
                beforeRevision,
                beforePersistenceRevision,
                metadataOnly: options.metadataOnly === true,
            });
            emit(EVENTS.STATUS_CHANGED, { reason: options.reason || 'dirty' });
            return true;
        }

        function markSaved(metadata = {}) {
            assertActive();
            let completion = null;
            if (metadata.persistenceSnapshot !== undefined) {
                const snapshot = call(weakGet, persistenceSnapshots, metadata.persistenceSnapshot);
                if (!snapshot || metadata.operationContext !== snapshot.context
                    || !isContextCurrent(snapshot.context)) return false;
                const kernel = options.verifiedKernel || window.ScriptoriumVerifiedKernel;
                if (!kernel?.completeSaveWitness) throw new Error('Verified save content witness is not loaded.');
                const ticket = snapshot.context;
                completion = kernel.completeSaveWitness(state.generation, ticket.generation,
                    state.persistenceRevision, ticket.persistenceRevision, metadata.currentDraftRevision, metadata.savedDraftRevision,
                    ticket.documentId === (state.document?.manifest?.id || null), metadata.success === true, state.dirty,
                    matchesPersistenceSnapshot(metadata.persistenceSnapshot));
                if (!completion?.apply) return false;
            } else if (metadata.operationContext) {
                const kernel = options.verifiedKernel || window.ScriptoriumVerifiedKernel;
                if (!kernel?.completeSave) throw new Error('Verified save protocol is not loaded.');
                const ticket = metadata.operationContext;
                completion = kernel.completeSave(state.generation, ticket.generation,
                    state.persistenceRevision, ticket.persistenceRevision, metadata.currentDraftRevision, metadata.savedDraftRevision,
                    ticket.documentId === (state.document?.manifest?.id || null), metadata.success === true, state.dirty);
                if (!completion?.apply) return false;
            }
            if (metadata.filePath !== undefined) state.currentPath = metadata.filePath;
            if (metadata.name !== undefined) state.currentName = String(metadata.name);
            const savedRevision = metadata.revision;
            const savedPersistenceRevision = metadata.operationContext?.persistenceRevision ?? metadata.persistenceRevision;
            if (completion) {
                state.dirty = completion.dirty;
            } else if (metadata.pendingChanges === true) {
                state.dirty = true;
            } else if (savedPersistenceRevision !== undefined) {
                state.dirty = savedPersistenceRevision !== state.persistenceRevision;
            } else if (savedRevision === undefined || savedRevision === state.revision) {
                state.dirty = false;
            }
            emit(EVENTS.SAVED, {
                savedRevision: savedRevision ?? state.revision,
                savedPersistenceRevision: savedPersistenceRevision ?? null,
                dirtyAfterSave: state.dirty,
            });
            emit(EVENTS.STATUS_CHANGED, { reason: 'saved' });
            return !state.dirty;
        }

        function setActivity(patch = {}) {
            assertActive();
            if (patch.loading !== undefined) state.loading = patch.loading === true;
            if (patch.saving !== undefined) state.saving = patch.saving === true;
            if (patch.ready !== undefined) state.ready = patch.ready === true;
            emit(EVENTS.STATUS_CHANGED, { reason: patch.reason || 'activity' });
            return status();
        }

        function updateIdentity(metadata = {}) {
            assertActive();
            if (metadata.filePath !== undefined) state.currentPath = metadata.filePath;
            if (metadata.name !== undefined) state.currentName = String(metadata.name);
            emit(EVENTS.STATUS_CHANGED, { reason: metadata.reason || 'identity' });
            return status();
        }

        function serialize() {
            assertActive();
            return state.document ? core.serialize(state.document) : '';
        }

        function captureContext(extra = {}) {
            assertActive();
            return Object.freeze({
                generation: state.generation,
                documentId: state.document?.manifest?.id || null,
                revision: state.revision,
                persistenceRevision: state.persistenceRevision,
                ...extra,
            });
        }

        function capturePersistenceSnapshot() {
            assertActive();
            if (!state.document) throw new Error('No document is available to save.');
            // JSON and bytes are captured synchronously. Plain JSON data and
            // ordinary byte arrays are required; accessors/proxies are outside
            // this adapter's trusted representation contract.
            const modelJson = stringify(state.document);
            const resources = cloneResourceMap(state.resourceData);
            const context = captureContext();
            const handle = freeze(createObject(null));
            call(weakSet, persistenceSnapshots, handle, { modelJson, resources, context });
            return handle;
        }

        function readPersistenceSnapshot(handle) {
            assertActive();
            const snapshot = call(weakGet, persistenceSnapshots, handle);
            if (!snapshot) throw new TypeError('Unknown persistence snapshot.');
            return {
                document: parse(snapshot.modelJson),
                resourceData: cloneResourceMap(snapshot.resources),
                context: snapshot.context,
            };
        }

        function matchesPersistenceSnapshot(handle) {
            try {
                const snapshot = call(weakGet, persistenceSnapshots, handle);
                if (!snapshot || !isContextCurrent(snapshot.context)
                    || stringify(state.document) !== snapshot.modelJson
                    || call(mapSize, state.resourceData) !== call(mapSize, snapshot.resources)) return false;
                const entries = call(mapEntries, snapshot.resources);
                for (let item = call(mapNext, entries); !item.done; item = call(mapNext, entries)) {
                    const [id, expected] = item.value;
                    if (!call(mapHas, state.resourceData, id)) return false;
                    const actual = cloneResourceBytes(call(mapGet, state.resourceData, id));
                    if (actual.length !== expected.length) return false;
                    for (let index = 0; index < expected.length; index += 1) {
                        if (actual[index] !== expected[index]) return false;
                    }
                }
                return true;
            } catch (_) {
                // Cycles, invalid byte values and unsupported resources cannot
                // establish equality, even if no revision notification fired.
                return false;
            }
        }

        function isContextCurrent(context, checks = {}) {
            if (!context || state.disposed) return false;
            if (context.generation !== state.generation) return false;
            if (checks.document !== false
                && context.documentId !== (state.document?.manifest?.id || null)) {
                return false;
            }
            if (checks.revision === true && context.revision !== state.revision) {
                return false;
            }
            if (checks.persistenceRevision === true
                && context.persistenceRevision !== state.persistenceRevision) {
                return false;
            }
            return true;
        }

        function dispose() {
            if (state.disposed) return;
            revokeResources();
            state.disposed = true;
            emit(EVENTS.DISPOSED);
            listeners.clear();
            state.document = null;
            state.resourceData.clear();
        }

        return Object.freeze({
            EVENTS,
            subscribe,
            status,
            document: documentModel,
            resourceData,
            resourceResolver,
            replaceDocument,
            mutate,
            updateDerived,
            markDirty,
            markSaved,
            setActivity,
            updateIdentity,
            serialize,
            captureContext,
            capturePersistenceSnapshot,
            readPersistenceSnapshot,
            materializePersistenceSnapshot: readPersistenceSnapshot,
            matchesPersistenceSnapshot,
            isContextCurrent,
            dispose,
        });
    }

    window.ScriptoriumDocumentStore = Object.freeze({
        EVENTS,
        createDocumentStore,
    });
})();