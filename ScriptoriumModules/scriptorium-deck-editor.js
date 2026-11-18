'use strict';

(() => {
    const INLINE_STYLES = Object.freeze({
        bold: ['fontWeight', '700'],
        italic: ['fontStyle', 'italic'],
        underline: ['textDecorationLine', 'underline'],
        strikethrough: ['textDecorationLine', 'line-through'],
    });

    function createDeckEditor(context = {}) {
        const adapter = context.adapter;
        const documentPort = context.documentPort;
        const selectionPrimitives = context.selectionPrimitives;
        const core = context.core;
        const textFragment = context.textFragment || window.ScriptoriumTextFragment;
        if (!textFragment) throw new TypeError('Deck editor requires the shared text fragment codec.');
        const verifiedKernel = context.verifiedKernel || window.ScriptoriumVerifiedKernel;
        if (!verifiedKernel?.createInputMailbox || !verifiedKernel.createSettledBarrier || !verifiedKernel.settledGate
            || !verifiedKernel.selectionReceipt || !verifiedKernel.prepareSelectionReceipt) {
            throw new TypeError('Deck editor requires the verified input mailbox, settling protocol and selection receipt.');
        }
        const notificationPort = context.notificationPort || {};
        if (!adapter || adapter.kind !== 'deck' || !documentPort
            || !selectionPrimitives || !core) {
            throw new TypeError(
                'Deck editor requires a deck adapter, DocumentPort, DOM selection primitives and VDocCore.'
            );
        }

        const inputSyncModule = context.inputSync
            || window.ScriptoriumInputSync;
        if (!inputSyncModule?.createInputSync) {
            throw new TypeError(
                'Deck editor requires the shared input synchronization module.'
            );
        }

        const state = {
            root: null,
            abortController: null,
            activeEditable: null,
            inputSync: null,
            selectionRange: null,
            selectionText: '',
            lastRestoreResult: null,
            selectedBlockIds: [],
            explicitBlockSelection: false,
            blockSelectionAnchorId: null,
            pendingNodes: new Map(),
            pendingAttributes: new Map(),
            acceptedNodes: new Map(),
            acceptedSequences: new Map(),
            committedTree: null,
            committedSource: null,
            sourceEpoch: 0,
            commitError: null,
            barriers: new Map(),
            settlingFrames: new Map(),
            draftRevision: 0,
            snapshotSequence: 0,
            flushTimer: null,
            copiedHtml: '',
            copiedText: '',
            disposed: false,
        };

        function surfaceGate(target = null) {
            const barriers = target ? [...state.barriers].filter(([node]) =>
                target === node || target.contains(node) || node.contains(target)).map(([, handle]) => handle)
                : [...state.barriers.values()];
            const gate = verifiedKernel.settledGate(barriers);
            if (!gate) throw new Error('Invalid surface settling state.');
            return gate;
        }

        function barrierPhase(block) {
            const handle = state.barriers.get(block);
            return handle ? verifiedKernel.readSettledBarrier(handle).phase : 0;
        }

        function advanceBarrier(block, action, ticket = 0) {
            const current = state.barriers.get(block) || verifiedKernel.createSettledBarrier();
            const next = verifiedKernel.stepSettledBarrier(current, action, ticket);
            if (!next) throw new Error('Invalid composition barrier action.');
            state.barriers.set(block, next);
            return verifiedKernel.readSettledBarrier(next);
        }

        function cancelSettlingFrame(block) {
            const pending = state.settlingFrames.get(block);
            if (pending) window.cancelAnimationFrame(pending.frame);
            state.settlingFrames.delete(block);
        }

        // Snapshot DOM is private: committing a captured transaction must never
        // read a newer acceptedNodes entry or mutable live DOM.
        const snapshotDOM = new WeakMap();
        const renderedEpoch = new WeakMap();
        const nodeSelector = id => `[data-vdoc-text="${CSS.escape(id)}"]`;

        function acceptRenderedTree(root) {
            const nodes = [...root.querySelectorAll('[data-vdoc-text]')];
            if (root.matches?.('[data-vdoc-text]')) nodes.unshift(root);
            for (const node of nodes) {
                renderedEpoch.set(node, state.sourceEpoch);
                state.acceptedNodes.set(node.dataset.vdocText, node.cloneNode(true));
                state.acceptedSequences.set(node.dataset.vdocText, state.snapshotSequence);
            }
        }

        function resetCommittedTree(nextTree = null) {
            const tree = nextTree || document.createDocumentFragment();
            if (!nextTree) for (const node of state.root?.childNodes || []) tree.appendChild(node.cloneNode(true));
            state.committedTree = tree;
            state.committedSource = adapter.currentSource();
            state.acceptedNodes.clear();
            state.acceptedSequences.clear();
            acceptRenderedTree(tree);
            for (const node of state.root?.querySelectorAll('[data-vdoc-text]') || []) {
                renderedEpoch.set(node, state.sourceEpoch);
            }
        }

        function committedTree() {
            if (state.committedTree && state.committedSource === adapter.currentSource()) {
                return state.committedTree;
            }
            // Source changes outside this surface invalidate its render snapshot.
            // The document model remains the authoritative committed value.
            const template = document.createElement('template');
            template.innerHTML = adapter.currentSource();
            template.content.querySelectorAll(core.EDITABLE_SELECTOR).forEach(node => {
                node.setAttribute('contenteditable', 'true');
                node.setAttribute('spellcheck', 'false');
            });
            state.sourceEpoch++;
            state.acceptedNodes.clear();
            state.acceptedSequences.clear();
            state.committedTree = template.content;
            state.committedSource = adapter.currentSource();
            return state.committedTree;
        }

        function epochOf(node) {
            for (let current = node; current && state.root?.contains(current);
                current = current.parentElement?.closest('[data-vdoc-text]')) {
                if (renderedEpoch.has(current)) return renderedEpoch.get(current);
            }
            return undefined;
        }

        function currentSurface() {
            committedTree();
            return [...state.root?.querySelectorAll('[data-vdoc-text]') || []]
                .every(node => epochOf(node) === state.sourceEpoch);
        }

        function applySnapshot(target, snapshot, attributes, rendered = false) {
            if (rendered) {
                const saved = snapshotDOM.get(snapshot);
                if (!saved) throw new Error('编辑快照已失效，请重新编辑后重试。');
                target.replaceChildren(...[...saved.childNodes].map(child => child.cloneNode(true)));
            } else target.innerHTML = snapshot.html;
            for (const attribute of attributes || []) {
                const value = snapshot.attributes[attribute];
                if (value === undefined || value === '') target.removeAttribute(attribute);
                else target.setAttribute(attribute, value);
            }
        }

        function assertActive() {
            if (state.disposed) throw new Error('Deck editor has been disposed.');
        }

        function renderedBlocks() {
            return state.root
                ? [...state.root.querySelectorAll('[data-vdoc-text]')]
                : [];
        }

        function blocksForIds(ids = state.selectedBlockIds) {
            const selected = new Set(ids);
            return renderedBlocks().filter((block) =>
                selected.has(block.dataset.vdocText)
            );
        }

        function currentSelection() {
            return selectionPrimitives.selectionFor(state.root);
        }

        function liveRange(expanded = false) {
            return selectionPrimitives.cloneLiveRange(state.root, {
                expanded,
            });
        }

        function selectedRange(preferSaved = false) {
            if (preferSaved
                && state.selectionRange?.startContainer?.isConnected
                && state.selectionRange?.endContainer?.isConnected) {
                return state.selectionRange;
            }
            return liveRange(true) || (
                state.selectionRange?.startContainer?.isConnected
                    ? state.selectionRange
                    : null
            );
        }

        function blocksForRange(range) {
            if (!range || range.collapsed) return [];
            return renderedBlocks().filter((block) =>
                selectionPrimitives.intersectsNode(range, block)
            );
        }

        function selectedBlocks(preferSaved = false) {
            if (state.explicitBlockSelection) {
                const blocks = blocksForIds();
                if (blocks.length) return blocks;
            }
            const range = selectedRange(preferSaved);
            const ranged = blocksForRange(range);
            if (ranged.length) return ranged;
            return state.activeEditable?.isConnected
                ? [state.activeEditable]
                : [];
        }

        function presentBlockSelection() {
            const selected = new Set(state.selectedBlockIds);
            renderedBlocks().forEach((block) => {
                if (state.explicitBlockSelection
                    && selected.has(block.dataset.vdocText)) {
                    block.dataset.vdocEditorSelected = 'true';
                } else {
                    block.removeAttribute('data-vdoc-editor-selected');
                }
            });
            context.onSelectionChange?.(selectionState());
        }

        function clearBlockSelection() {
            state.explicitBlockSelection = false;
            state.selectedBlockIds = [];
            state.blockSelectionAnchorId = null;
            state.selectionRange = null;
            state.selectionText = '';
            currentSelection()?.removeAllRanges();
            presentBlockSelection();
        }

        function setBlockSelection(ids, options = {}) {
            const wanted = new Set(ids);
            const blocks = renderedBlocks().filter((block) =>
                wanted.has(block.dataset.vdocText)
            );
            if (!blocks.length) {
                clearBlockSelection();
                return false;
            }
            state.explicitBlockSelection = true;
            state.selectedBlockIds = blocks.map((block) =>
                block.dataset.vdocText
            );
            if (!options.preserveAnchor) {
                state.blockSelectionAnchorId = state.selectedBlockIds[0];
            }

            const range = document.createRange();
            range.setStartBefore(blocks[0]);
            range.setEndAfter(blocks[blocks.length - 1]);
            state.selectionRange = range.cloneRange();
            state.selectionText = blocks.map((block) =>
                block.textContent || ''
            ).join('\n');
            try {
                blocks[0].focus({ preventScroll: true });
            } catch {
                blocks[0].focus();
            }
            const selection = currentSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            state.activeEditable = blocks[0];
            presentBlockSelection();
            return true;
        }

        function selectBlockInterval(anchorId, focusId) {
            const blocks = renderedBlocks();
            const anchorIndex = blocks.findIndex((block) =>
                block.dataset.vdocText === anchorId
            );
            const focusIndex = blocks.findIndex((block) =>
                block.dataset.vdocText === focusId
            );
            if (anchorIndex < 0 || focusIndex < 0) return false;
            const start = Math.min(anchorIndex, focusIndex);
            const end = Math.max(anchorIndex, focusIndex);
            return setBlockSelection(
                blocks.slice(start, end + 1).map((block) =>
                    block.dataset.vdocText
                ),
                { preserveAnchor: true }
            );
        }

        function toggleBlock(blockId) {
            const ids = new Set(
                state.explicitBlockSelection ? state.selectedBlockIds : []
            );
            if (ids.has(blockId)) ids.delete(blockId);
            else ids.add(blockId);
            if (!state.blockSelectionAnchorId) {
                state.blockSelectionAnchorId = blockId;
            }
            return setBlockSelection([...ids], { preserveAnchor: true });
        }

        function captureSelection() {
            const range = liveRange(true);
            if (!range) return false;
            state.explicitBlockSelection = false;
            state.selectionRange = range;
            state.selectionText = range.toString();
            state.selectedBlockIds = blocksForRange(range)
                .map((block) => block.dataset.vdocText)
                .filter(Boolean);
            presentBlockSelection();
            return true;
        }

        function selectionState() {
            return Object.freeze({
                range: state.selectionRange,
                text: state.selectionText,
                blockIds: [...state.selectedBlockIds],
                explicitBlocks: state.explicitBlockSelection,
                activeEditable: state.activeEditable,
            });
        }

        function viewStatePoint(block, node, offset) {
            const fragment = textFragment.fromDOM(block);
            const affinity = node.nodeType === Node.TEXT_NODE && offset === node.length
                ? 'upstream' : 'downstream';
            return textFragment.domToLogical(fragment, node, offset, affinity);
        }

        function captureViewState() {
            const selection = currentSelection();
            const endpoint = (node, offset) => {
                const element = selectionPrimitives.elementOf(node);
                const block = element?.closest('[data-vdoc-text]');
                if (!block || !state.root?.contains(block)) return null;
                const path = [];
                for (let current = node; current !== block; current = current.parentNode) {
                    path.unshift([...current.parentNode.childNodes].indexOf(current));
                }
                return {
                    blockId: block.dataset.vdocText,
                    position: viewStatePoint(block, node, offset),
                    path,
                    nodeType: node.nodeType,
                    nodeOffset: offset,
                };
            };
            const active = state.root?.activeElement || document.activeElement;
            const scrollHost = state.root?.host?.parentElement;
            return Object.freeze({
                anchor: selection?.rangeCount
                    ? endpoint(selection.anchorNode, selection.anchorOffset) : null,
                focus: selection?.rangeCount
                    ? endpoint(selection.focusNode, selection.focusOffset) : null,
                focused: Boolean(active?.isContentEditable && state.root?.contains(active)),
                blockIds: state.explicitBlockSelection ? [...state.selectedBlockIds] : [],
                scrollLeft: Number(scrollHost?.scrollLeft) || 0,
                scrollTop: Number(scrollHost?.scrollTop) || 0,
            });
        }

        function restoreViewState(viewState) {
            state.lastRestoreResult = Object.freeze({ mode: 'none', restored: false, kind: 0,
                clamped: false, anchor: null, focus: null });
            if (!viewState || !state.root) return false;
            const requestedFragments = new Map();
            const endpoint = (saved) => {
                if (!saved?.blockId) return null;
                const block = state.root.querySelector(
                    `[data-vdoc-text="${CSS.escape(saved.blockId)}"]`
                );
                if (!block) return null;
                const fragment = requestedFragments.get(block) || textFragment.fromDOM(block);
                requestedFragments.set(block, fragment);
                // A path is only a hint; the shared codec owns line and style-side positions.
                if (Array.isArray(saved.path) && Number.isInteger(saved.nodeOffset)
                    && saved.nodeOffset >= 0) {
                    let node = block;
                    for (const index of saved.path) {
                        node = Number.isInteger(index) && index >= 0
                            ? node?.childNodes[index] : null;
                        if (!node) break;
                    }
                    const length = node?.nodeType === Node.TEXT_NODE
                        ? node.length : node?.childNodes.length;
                    const point = node && textFragment.domToLogical(
                        fragment, node, saved.nodeOffset, saved.position?.affinity
                    );
                    if (node?.nodeType === saved.nodeType && saved.nodeOffset <= length
                        && (saved.position ? point?.offset === saved.position.offset : !fragment.supported)) {
                        return { block, node, offset: saved.nodeOffset, fragment, position: point,
                            clamped: false };
                    }
                }
                if (!saved.position || !fragment.supported) return null;
                const point = textFragment.logicalToDOM(fragment, {
                    ...saved.position,
                    offset: Math.min(fragment.length, Math.max(0, saved.position.offset)),
                });
                return point ? { block, ...point, fragment,
                    position: textFragment.domToLogical(fragment, point.node, point.offset, point.affinity),
                    clamped: saved.position.offset !== Math.min(fragment.length, Math.max(0, saved.position.offset)) } : null;
            };
            const ownerOf = node => selectionPrimitives.elementOf(node)?.closest('[data-vdoc-text]') || null;
            const bindOwner = point => {
                if (!point) return null;
                const owner = ownerOf(point.node);
                return { ...point, owner, ownerId: owner?.dataset.vdocText || null };
            };
            const anchor = bindOwner(endpoint(viewState.anchor));
            const focus = bindOwner(endpoint(viewState.focus));
            const focusHost = (block) => {
                let host = block;
                while (host?.parentElement?.isContentEditable
                    && state.root.contains(host.parentElement)) host = host.parentElement;
                host?.focus({ preventScroll: true });
                state.activeEditable = block;
            };
            let restored = false;
            if (viewState.blockIds?.length) {
                restored = setBlockSelection(viewState.blockIds);
                if (restored && viewState.focused) focusHost(state.activeEditable);
                state.lastRestoreResult = Object.freeze({ mode: 'blocks', restored, kind: null,
                    clamped: false, anchor: null, focus: null });
            } else if (anchor && focus) {
                const observedFragments = new Map();
                const readEndpoint = (wanted, node, offset) => {
                    const contained = Boolean(state.root?.contains(wanted.block) && wanted.owner && node
                        && (node === wanted.block || wanted.block.contains(node))
                        && ownerOf(node) === wanted.owner);
                    const fragment = contained
                        ? observedFragments.get(wanted.block) || textFragment.fromDOM(wanted.block) : null;
                    if (fragment) observedFragments.set(wanted.block, fragment);
                    const position = fragment ? textFragment.domToLogical(fragment, node, offset,
                        wanted.position?.affinity || 'downstream') : null;
                    return { contained, exact: node === wanted.node && offset === wanted.offset, position };
                };
                try {
                    if (viewState.focused) focusHost(focus.block);
                    const selection = currentSelection();
                    if (typeof selection?.setBaseAndExtent !== 'function') throw new Error('Selection is unavailable.');
                    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
                    // Browser Selection may canonicalize a valid Range point.
                    // Compare both directed endpoints against the actual readback.
                    const actual = currentSelection();
                    const available = Boolean(actual?.rangeCount && actual.anchorNode && actual.focusNode);
                    const actualAnchor = readEndpoint(anchor, actual?.anchorNode, actual?.anchorOffset);
                    const actualFocus = readEndpoint(focus, actual?.focusNode, actual?.focusOffset);
                    const facts = verifiedKernel.prepareSelectionReceipt(available,
                        Boolean(anchor.position), Boolean(focus.position),
                        Boolean(actualAnchor.position), Boolean(actualFocus.position),
                        actualAnchor.exact && actualAnchor.contained, actualFocus.exact && actualFocus.contained,
                        actualAnchor.contained, actualFocus.contained,
                        anchor.position?.offset ?? 0, focus.position?.offset ?? 0,
                        actualAnchor.position?.offset ?? 0, actualFocus.position?.offset ?? 0);
                    if (!facts) throw new Error('Invalid selection observation facts.');
                    const receipt = verifiedKernel.selectionReceipt(facts.available, facts.supported,
                        facts.exact, facts.sameAnchor, facts.sameFocus,
                        facts.wantedAnchor, facts.wantedFocus, facts.actualAnchor, facts.actualFocus);
                    if (!receipt) throw new Error('Invalid selection restoration receipt.');
                    restored = receipt.restored;
                    const summary = (wanted, observed) => Object.freeze({
                        blockId: wanted.block.dataset.vdocText,
                        wanted: wanted.position ? Object.freeze({ ...wanted.position }) : null,
                        actual: observed.position ? Object.freeze({ offset: observed.position.offset }) : null,
                        mappingAffinity: wanted.position?.affinity || null,
                        ownerId: wanted.ownerId,
                        contained: observed.contained, exact: observed.exact });
                    state.lastRestoreResult = Object.freeze({ mode: 'selection', ...receipt,
                        clamped: anchor.clamped || focus.clamped,
                        anchor: summary(anchor, actualAnchor), focus: summary(focus, actualFocus) });
                } catch (error) {
                    state.lastRestoreResult = Object.freeze({ mode: 'selection', restored: false, kind: 0,
                        clamped: anchor.clamped || focus.clamped, anchor: null, focus: null,
                        error: String(error.message || error) });
                }
                state.selectionRange = liveRange();
                state.selectionText = state.selectionRange?.toString() || '';
                captureSelection();
            }
            const scrollHost = state.root?.host?.parentElement;
            scrollHost?.scrollTo?.({
                left: Number(viewState.scrollLeft) || 0,
                top: Number(viewState.scrollTop) || 0,
                behavior: 'auto',
            });
            return restored;
        }

        function semanticInnerHtml(renderedNode) {
            const clone = renderedNode.cloneNode(true);
            context.restoreSemantics?.(clone);
            const html = textFragment.normalizeBlock(clone, core);
            if (html !== null) return html;
            throw new Error('此编辑无法无损保存，请撤销本次编辑后重试；当前内容仍保留在编辑区。');
        }

        function captureNode(node) {
            const id = node?.dataset?.vdocText;
            if (!id || !surfaceGate(node).canCapture) return null;
            committedTree();
            const epoch = epochOf(node);
            const sequence = ++state.snapshotSequence;
            const attributes = Object.freeze(Object.fromEntries(
                [...node.attributes].map(({ name, value }) => [name, value])
            ));
            try {
                if (epoch !== state.sourceEpoch) throw new Error('源码版本已更新，请撤销旧编辑后重试。');
                const html = semanticInnerHtml(node);
                state.acceptedNodes.set(id, node.cloneNode(true));
                state.acceptedSequences.set(id, sequence);
                const snapshot = Object.freeze({ id, html, attributes, sequence, epoch, error: null,
                    documentId: documentPort.status().documentId, slideId: adapter.activeSlide()?.id });
                snapshotDOM.set(snapshot, node.cloneNode(true));
                return snapshot;
            } catch (error) {
                return Object.freeze({ id, html: null, attributes, sequence, epoch, error: error.message,
                    documentId: documentPort.status().documentId, slideId: adapter.activeSlide()?.id });
            }
        }

        function commitSnapshots(snapshots, attributesById = new Map()) {
            if (!surfaceGate().canCommit) return null;
            if (!snapshots.length) return false;
            try {
                if (snapshots.some(snapshot => snapshot.documentId !== documentPort.status().documentId
                    || snapshot.slideId !== adapter.activeSlide()?.id)) {
                    throw new Error('编辑所属的文档或幻灯片已变化，不能提交旧快照。');
                }
                committedTree();
                if (snapshots.some(snapshot => snapshot.epoch !== state.sourceEpoch)) {
                    throw new Error('源码版本已更新，请撤销旧编辑后重试。');
                }
                const invalid = snapshots.find(snapshot => snapshot.error);
                if (invalid) throw new Error(invalid.error);
                const template = document.createElement('template');
                template.innerHTML = adapter.currentSource();
                const nextTree = committedTree().cloneNode(true);
                for (const snapshot of [...snapshots].sort((a, b) => a.sequence - b.sequence)) {
                    const target = template.content.querySelector(nodeSelector(snapshot.id));
                    const rendered = nextTree.querySelector(nodeSelector(snapshot.id));
                    if (!target || !rendered) throw new Error('文本块身份已变化，请撤销本次编辑后重试。');
                    applySnapshot(target, snapshot, attributesById.get(snapshot.id));
                    applySnapshot(rendered, snapshot, attributesById.get(snapshot.id), true);
                }
                const source = core.normalizeCompleteSlideSource(core.serializeFragment(template.content));
                const restored = document.createElement('template');
                restored.innerHTML = source;
                if (!textFragment.sameSemantics(textFragment.semanticModel(template.content),
                    textFragment.semanticModel(restored.content))) {
                    throw new Error('保存会改变文本或换行结构，请撤销本次编辑后重试。');
                }
                const changed = adapter.replaceCurrentSource(source, {
                    reason: 'deck-stable-nodes-updated',
                });
                state.committedTree = nextTree;
                state.committedSource = source;
                state.commitError = null;
                return changed;
            } catch (error) {
                if (state.commitError !== error.message) notificationPort.show?.(error.message, 'error');
                state.commitError = error.message;
                return null;
            }
        }

        function updateSourceNodes(renderedNodes, attributesById = new Map()) {
            if (!surfaceGate().canCommit) return null;
            const snapshots = new Map();
            for (const node of renderedNodes) {
                const snapshot = captureNode(node);
                if (snapshot) snapshots.set(snapshot.id, snapshot);
            }
            return commitSnapshots([...snapshots.values()], attributesById);
        }

        function flush() {
            if (!surfaceGate().canCommit) return false;
            state.inputSync?.flush();
            if (state.inputSync?.hasPending?.()) return false;
            window.clearTimeout(state.flushTimer);
            state.flushTimer = null;
            if (!state.pendingNodes.size) return true;
            const nodes = [...state.pendingNodes.values()];
            const attributes = new Map(state.pendingAttributes);
            const changed = commitSnapshots(nodes, attributes);
            if (changed === null) return false;
            state.pendingNodes.clear();
            state.pendingAttributes.clear();
            if (changed) {
                context.historyPort?.capture?.();
                context.onFlush?.();
            }
            return true;
        }

        function noteEdit() {
            state.draftRevision++;
            documentPort.markDirty?.({ reason: 'deck-draft-edited', incrementRevision: false });
            context.historyPort?.schedule?.({ reason: 'deck-draft-edited' });
        }

        function queueNode(node, options = {}) {
            if (!surfaceGate().canCommit) return false;
            noteEdit();
            return queueSnapshot(captureNode(node), options);
        }

        function queueSnapshot(snapshot, options = {}) {
            if (!snapshot) return false;
            const { id } = snapshot;
            state.pendingNodes.set(id, snapshot);
            if (options.attributes?.length) {
                const attributes = state.pendingAttributes.get(id) || new Set();
                options.attributes.forEach((attribute) =>
                    attributes.add(attribute)
                );
                state.pendingAttributes.set(id, attributes);
            }
            window.clearTimeout(state.flushTimer);
            state.flushTimer = window.setTimeout(
                flush,
                Number.isFinite(options.delay) ? options.delay : 2000
            );
            return true;
        }

        function recoverPendingEdit() {
            if (!surfaceGate().canCommit) return false;
            state.inputSync?.flush();
            const invalid = [...state.pendingNodes.values()].filter(snapshot => snapshot.error);
            const rejected = invalid.length ? invalid
                : state.commitError ? [...state.pendingNodes.values()] : [];
            if (!rejected.length) return false;
            const viewState = captureViewState();
            if (rejected.some(snapshot => snapshot.documentId !== documentPort.status().documentId
                || snapshot.slideId !== adapter.activeSlide()?.id)) return false;
            const committed = committedTree();
            const targets = rejected.map(({ id }) => {
                const accepted = invalid.length ? state.acceptedNodes.get(id) : null;
                const saved = (accepted || committed.querySelector(nodeSelector(id)))?.cloneNode(true);
                if (saved && accepted) {
                    const version = state.acceptedSequences.get(id) || 0;
                    const newer = [...state.acceptedSequences].filter(([, value]) => value > version)
                        .sort((a, b) => a[1] - b[1]);
                    for (const [childId] of newer) {
                        const child = saved.querySelector(`[data-vdoc-text="${CSS.escape(childId)}"]`);
                        const accepted = state.acceptedNodes.get(childId);
                        if (child && accepted) child.replaceWith(accepted.cloneNode(true));
                    }
                }
                return { node: state.root?.querySelector(`[data-vdoc-text="${CSS.escape(id)}"]`), saved };
            });
            if (targets.some(({ node, saved }) => !node || !saved)) return false;
            // Restore the ancestor antichain once; nested targets are already
            // represented by the same complete recovery value.
            const roots = targets.filter(target => !targets.some(other =>
                other !== target && other.node.contains(target.node)));
            for (const { node } of targets) {
                state.pendingNodes.delete(node.dataset.vdocText);
                if (!roots.some(root => root.node === node)) state.pendingAttributes.delete(node.dataset.vdocText);
            }
            for (const { node, saved } of roots) {
                for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
                for (const { name, value } of saved.attributes) node.setAttribute(name, value);
                node.querySelectorAll('[data-vdoc-text]').forEach(child => state.inputSync?.unbind?.(child));
                node.replaceChildren(...[...saved.childNodes].map(child => child.cloneNode(true)));
                acceptRenderedTree(node);
                queueNode(node);
            }
            state.commitError = null;
            restoreViewState(viewState);
            context.onSelectionChange?.(selectionState());
            return true;
        }
        function wrapRanges(configure, preferSaved = false) {
            const range = selectedRange(preferSaved);
            if (!range || range.collapsed) return [];
            const blocks = state.explicitBlockSelection
                ? blocksForIds()
                : blocksForRange(range);
            const ranges = blocks.map((block) => {
                if (state.explicitBlockSelection) {
                    const blockRange = document.createRange();
                    blockRange.selectNodeContents(block);
                    return blockRange;
                }
                return selectionPrimitives.rangeWithinNode(range, block);
            }).filter(Boolean);
            const wrappers = [];
            [...ranges].reverse().forEach((targetRange) => {
                const wrapper = document.createElement('span');
                configure(wrapper);
                try {
                    targetRange.surroundContents(wrapper);
                } catch {
                    wrapper.appendChild(targetRange.extractContents());
                    targetRange.insertNode(wrapper);
                }
                wrappers.unshift(wrapper);
            });
            if (!wrappers.length) return [];
            const nextRange = document.createRange();
            nextRange.setStartBefore(wrappers[0]);
            nextRange.setEndAfter(wrappers.at(-1));
            state.selectionRange = nextRange.cloneRange();
            state.selectionText = nextRange.toString();
            const selection = currentSelection();
            selection.removeAllRanges();
            selection.addRange(nextRange);
            return wrappers;
        }

        function applyInlineStyle(property, value, preferSaved = false) {
            const wrappers = wrapRanges((wrapper) => {
                wrapper.style[property] = value;
            }, preferSaved);
            if (!wrappers.length) return false;
            const blocks = [...new Set(wrappers.map((wrapper) =>
                wrapper.closest('[data-vdoc-text]')
            ).filter(Boolean))];
            blocks.forEach(block => queueNode(block));
            context.onSelectionChange?.(selectionState());
            return true;
        }

        function executeFormatting(command, value, options = {}) {
            if (!surfaceGate().canCommit) return false;
            if (command === 'advanced-style') {
                const className = String(value?.className || '')
                    .replace(/[^a-zA-Z0-9_-]/g, '');
                const styleId = String(value?.id || '')
                    .replace(/["<>&]/g, '');
                if (!className || !styleId) return false;
                const range = selectedRange(options.preferSaved);
                const blocks = selectedBlocks(options.preferSaved);
                if (!range || !blocks.length) return false;
                const fullSingleBlock = blocks.length === 1
                    && range.toString().trim()
                        === blocks[0].textContent.trim();
                const useBlock = value.targets?.includes('heading')
                    || value.targets?.includes('paragraph')
                    || (
                        value.targets?.includes('block')
                        && (blocks.length > 1 || fullSingleBlock)
                    );
                if (useBlock) {
                    blocks.forEach((block) => {
                        block.classList.add(className);
                        block.dataset.vdocStyle = styleId;
                        queueNode(block, {
                            attributes: ['class', 'data-vdoc-style'],
                        });
                    });
                    return true;
                }
                const wrappers = wrapRanges((wrapper) => {
                    wrapper.className = className;
                    wrapper.dataset.vdocStyle = styleId;
                }, options.preferSaved);
                if (!wrappers.length) return false;
                [...new Set(wrappers.map((wrapper) =>
                    wrapper.closest('[data-vdoc-text]')
                ).filter(Boolean))].forEach(block => queueNode(block));
                return true;
            }
            if (command === 'bullet-list'
                || command === 'numbered-list') {
                if (!flush() || !currentSurface()) return false;
                const nextTree = committedTree().cloneNode(true);
                const blocks = selectedBlocks(options.preferSaved);
                if (!blocks.length) return false;
                const list = document.createElement(
                    command === 'bullet-list' ? 'ul' : 'ol'
                );
                const first = blocks[0];
                first.before(list);
                blocks.forEach((block) => {
                    const item = document.createElement('li');
                    item.innerHTML = block.innerHTML;
                    item.dataset.vdocText = block.dataset.vdocText;
                    item.contentEditable = 'true';
                    item.spellcheck = false;
                    list.appendChild(item);
                    block.remove();
                });
                const source = document.createElement('template');
                source.innerHTML = adapter.currentSource();
                const sourceBlocks = blocks.map((block) =>
                    source.content.querySelector(
                        `[data-vdoc-text="${
                            CSS.escape(block.dataset.vdocText)
                        }"]`
                    )
                );
                if (sourceBlocks.some((block) => !block)) {
                    list.replaceWith(...blocks);
                    return false;
                }
                const sourceList = list.cloneNode(false);
                sourceBlocks[0].before(sourceList);
                sourceBlocks.forEach((block) => {
                    const item = document.createElement('li');
                    item.innerHTML = block.innerHTML;
                    item.dataset.vdocText = block.dataset.vdocText;
                    sourceList.appendChild(item);
                    block.remove();
                });
                const committedBlocks = blocks.map(block => nextTree.querySelector(nodeSelector(block.dataset.vdocText)));
                const committedList = list.cloneNode(false);
                committedBlocks[0].before(committedList);
                for (const block of committedBlocks) {
                    const item = document.createElement('li');
                    item.innerHTML = block.innerHTML;
                    item.dataset.vdocText = block.dataset.vdocText;
                    item.setAttribute('contenteditable', 'true');
                    item.setAttribute('spellcheck', 'false');
                    committedList.appendChild(item);
                    block.remove();
                }
                const changed = adapter.replaceCurrentSource(
                    core.serializeFragment(source.content),
                    { reason: `deck-${command}` }
                );
                resetCommittedTree(nextTree);
                if (changed) context.historyPort?.capture?.();
                return changed;
            }
            if (INLINE_STYLES[command]) {
                const [property, styleValue] = INLINE_STYLES[command];
                return applyInlineStyle(
                    property,
                    styleValue,
                    options.preferSaved
                );
            }
            const inlineProperties = {
                'font-family': 'fontFamily',
                'font-size': 'fontSize',
                'text-color': 'color',
                'highlight-color': 'backgroundColor',
            };
            if (inlineProperties[command]) {
                return applyInlineStyle(
                    inlineProperties[command],
                    value,
                    options.preferSaved
                );
            }
            if (command === 'line-height' || command === 'text-align') {
                const blocks = selectedBlocks(options.preferSaved);
                if (!blocks.length) return false;
                blocks.forEach((block) => {
                    if (command === 'line-height') {
                        block.style.lineHeight = String(value);
                    } else {
                        block.style.textAlign = String(value);
                    }
                    queueNode(block, { attributes: ['style'] });
                });
                return true;
            }
            if (command === 'image') {
                return context.mediaPort?.open?.() ?? false;
            }
            return false;
        }

        function canExecute(command, options = {}) {
            if (command === 'image') return true;
            return selectedBlocks(options.preferSaved).length > 0
                || Boolean(selectedRange(options.preferSaved));
        }

        function formattingState(target = null) {
            const element = selectionPrimitives.elementOf(target)
                || selectionPrimitives.elementOf(
                    currentSelection()?.focusNode
                )
                || state.activeEditable;
            if (!element || !state.root?.contains(element)) {
                return { available: false };
            }
            const textElement = element.closest?.(
                '[data-vdoc-text],span,strong,b,em,i,u,s,strike'
            ) || element;
            const computed = getComputedStyle(textElement);
            const activeCommands = [];
            if (Number.parseFloat(computed.fontWeight) >= 600
                || computed.fontWeight === 'bold') {
                activeCommands.push('bold');
            }
            if (/^(?:italic|oblique)/i.test(computed.fontStyle)) {
                activeCommands.push('italic');
            }
            if (computed.textDecorationLine.includes('underline')) {
                activeCommands.push('underline');
            }
            if (computed.textDecorationLine.includes('line-through')) {
                activeCommands.push('strikethrough');
            }
            return {
                available: true,
                fontFamily: computed.fontFamily,
                fontSize: computed.fontSize,
                textColor: context.colorToHex?.(computed.color) || '',
                lineHeight: computed.lineHeight,
                activeCommands,
                selectionTarget: /^H[1-6]$/.test(
                    textElement.closest?.('[data-vdoc-text]')?.tagName || ''
                )
                    ? 'heading'
                    : state.explicitBlockSelection
                        ? 'block'
                        : 'inline',
            };
        }

        function cleanBlock(block) {
            const clone = block.cloneNode(true);
            context.restoreSemantics?.(clone);
            clone.querySelectorAll(
                '[contenteditable], [spellcheck], [data-vdoc-editor-selected]'
            ).forEach((node) => {
                node.removeAttribute('contenteditable');
                node.removeAttribute('spellcheck');
                node.removeAttribute('data-vdoc-editor-selected');
            });
            clone.removeAttribute('contenteditable');
            clone.removeAttribute('spellcheck');
            clone.removeAttribute('data-vdoc-editor-selected');
            return clone;
        }

        function clipboardPayload() {
            const range = selectedRange(true);
            const blocks = state.explicitBlockSelection
                ? blocksForIds()
                : blocksForRange(range);
            if (!blocks.length || (!state.explicitBlockSelection && !range)) {
                return null;
            }
            const host = document.createElement('div');
            if (state.explicitBlockSelection) {
                const roots = blocks.filter(block => !blocks.some(parent => parent !== block && parent.contains(block)));
                for (const block of roots) {
                    const captured = textFragment.captureTransfer(block);
                    if (!captured) return null;
                    const clone = block.cloneNode(false);
                    clone.appendChild(captured);
                    host.appendChild(clone);
                }
            } else {
                const captured = textFragment.captureTransfer(state.root, range);
                if (!captured) return null;
                host.appendChild(captured);
            }
            const clean = cleanBlock(host);
            const text = textFragment.transferText(clean);
            if (text === null) return null;
            return Object.freeze({ html: core.sanitizeHtml(core.serializeFragment(clean)), text });
        }

        function rememberClipboard(payload) {
            if (!payload) return false;
            state.copiedHtml = String(payload.html || '');
            state.copiedText = String(payload.text || '');
            return true;
        }

        function structureHtml(type = 'paragraph') {
            let element = null;
            const centerHeadingMatch = /^heading-([1-6])-center(?:-html)?$/.exec(type);
            if (centerHeadingMatch) {
                const level = Number(centerHeadingMatch[1]);
                element = document.createElement(`h${level}`);
                element.style.textAlign = 'center';
                element.textContent = '新标题';
            } else if (/^heading-[1-6]$/.test(type)) {
                element = document.createElement(`h${type.slice(-1)}`);
                element.textContent = '新标题';
            } else if (type === 'blockquote') {
                element = document.createElement('blockquote');
                element.textContent = '引文';
            } else if (type === 'table') {
                element = document.createElement('table');
                element.style.width = '100%';
                element.style.borderCollapse = 'collapse';
                const body = document.createElement('tbody');
                for (let row = 0; row < 3; row += 1) {
                    const tableRow = document.createElement('tr');
                    for (let column = 0; column < 3; column += 1) {
                        const cell = document.createElement('td');
                        cell.style.padding = '.45em .65em';
                        cell.style.border = '1px solid currentColor';
                        cell.textContent = row === 0
                            ? `标题 ${column + 1}`
                            : '内容';
                        tableRow.appendChild(cell);
                    }
                    body.appendChild(tableRow);
                }
                element.appendChild(body);
            } else {
                element = document.createElement('p');
                element.innerHTML = '<br>';
            }
            return core.ensureTextNodeIds(element.outerHTML);
        }

        function insertStructure(type = 'paragraph') {
            return insertContent(
                structureHtml(type),
                { reason: `deck-structure-${type}` }
            );
        }

        function insertContent(fragment, options = {}) {
            if (!flush() || !currentSurface()) return false;
            const source = String(fragment || '');
            if (!source) return false;
            const template = document.createElement('template');
            template.innerHTML = core.sanitizeHtml(source);
            const partitioned = textFragment.transferBlocks(template.content, core);
            if (!partitioned) {
                notificationPort.show?.('粘贴内容无法保持完整节点顺序和语义，请调整内容后重试。', 'error');
                return false;
            }
            template.content.replaceChildren(...partitioned.childNodes);
            // Pasted objects receive fresh identities; copied IDs cannot alias existing blocks.
            template.content.querySelectorAll('*').forEach(node => {
                for (const attribute of ['data-vdoc-text', 'data-vdoc-block', 'data-vdoc-container']) {
                    node.removeAttribute(attribute);
                }
            });
            template.innerHTML = core.ensureTextNodeIds(core.serializeFragment(template.content));
            const blocks = [...template.content.children];
            if (!blocks.length) return false;
            const renderedAnchor = options.anchor || state.activeEditable || renderedBlocks().at(-1);
            const sourceTemplate = document.createElement('template');
            sourceTemplate.innerHTML = adapter.currentSource();
            const sourceAnchorId = renderedAnchor?.dataset?.vdocText;
            let sourceAnchor = sourceAnchorId
                ? sourceTemplate.content.querySelector(`[data-vdoc-text="${CSS.escape(sourceAnchorId)}"]`)
                : null;
            const renderedParent = renderedAnchor?.parentElement
                || state.root?.querySelector('.vdoc-slide-scene,[data-vdoc-slide]');
            const sourceParent = sourceAnchor?.parentElement
                || sourceTemplate.content.querySelector('.vdoc-slide-scene,[data-vdoc-slide]')
                || sourceTemplate.content.firstElementChild;
            if (!renderedParent || !sourceParent) return false;
            for (const block of blocks) {
                if (sourceAnchor?.parentElement) sourceAnchor.after(block);
                else sourceParent.appendChild(block);
                sourceAnchor = block;
            }
            const assembled = core.serializeFragment(sourceTemplate.content);
            try {
                if (core.normalizeCompleteSlideSource(assembled) !== assembled) {
                    throw new Error('粘贴内容在当前容器内无法保持结构与身份，请调整内容后重试。');
                }
            } catch (error) {
                notificationPort.show?.(error.message, 'error');
                return false;
            }
            const nextTree = committedTree().cloneNode(true);
            let committedCursor = sourceAnchorId ? nextTree.querySelector(nodeSelector(sourceAnchorId)) : null;
            const committedParent = committedCursor?.parentElement
                || nextTree.querySelector('.vdoc-slide-scene,[data-vdoc-slide]') || nextTree.firstElementChild;
            if (!committedParent) return false;
            let renderedCursor = renderedAnchor;
            for (const block of blocks) {
                const rendered = block.cloneNode(true);
                const editables = [...rendered.querySelectorAll(core.EDITABLE_SELECTOR)];
                if (rendered.matches(core.EDITABLE_SELECTOR)) editables.unshift(rendered);
                for (const node of editables) {
                    node.contentEditable = 'true';
                    node.spellcheck = false;
                }
                if (renderedCursor?.parentElement) renderedCursor.after(rendered);
                else renderedParent.appendChild(rendered);
                renderedCursor = rendered;
                const committed = rendered.cloneNode(true);
                if (committedCursor?.parentElement) committedCursor.after(committed);
                else committedParent.appendChild(committed);
                committedCursor = committed;
            }
            const changed = adapter.replaceCurrentSource(assembled, { reason: 'deck-content-inserted' });
            resetCommittedTree(nextTree);
            if (changed) context.historyPort?.capture?.();
            return changed;
        }

        function insertHardBreak(range) {
            let block = selectionPrimitives.elementOf(range?.startContainer)?.closest('[data-vdoc-text]');
            if (!range || !block || !state.root?.contains(block)) return null;
            while (block && !block.contains(range.endContainer)) {
                block = block.parentElement?.closest('[data-vdoc-text]');
            }
            if (!block || !state.root.contains(block)) {
                notificationPort.show?.('请在同一个文本对象内插入换行。', 'info');
                return null;
            }
            const fragment = textFragment.fromDOM(block);
            const before = textFragment.logicalUnits(textFragment.semanticModel(block, fragment));
            const start = textFragment.domToLogical(fragment, range.startContainer, range.startOffset, 'downstream');
            const end = range.collapsed ? start
                : textFragment.domToLogical(fragment, range.endContainer, range.endOffset, 'upstream');
            const expected = before && start && end
                ? textFragment.spliceLogicalUnits(before, start.offset, end.offset, [textFragment.HARD_BREAK]) : null;
            if (before && !expected) {
                notificationPort.show?.('选区已变化，请重新选择后插入换行。', 'info');
                return null;
            }
            // Inline edits obey the typed splice law; structural hosts retain their
            // existing Range behavior and are checked by the save-time structural gate.
            const backup = block.cloneNode(true);
            const beforeView = captureViewState();
            try {
                textFragment.releaseCaretPlaceholders(block);
                range.deleteContents();
                const br = document.createElement('br');
                range.insertNode(br);
                range.setStartAfter(br);
                range.collapse(true);
                const tail = range.cloneRange();
                tail.setEnd(block, block.childNodes.length);
                const remaining = tail.cloneContents();
                if (!remaining.textContent && !remaining.querySelector('br,img')) {
                    const filler = document.createElement('br');
                    filler.setAttribute('data-vdoc-caret-placeholder', 'true');
                    block.appendChild(filler);
                }
                block.normalize();
                if (expected) {
                    const actual = textFragment.logicalUnits(textFragment.semanticModel(block));
                    if (!actual || !textFragment.sameSemantics(expected, actual)) {
                        throw new Error('换行会改变已有文本，已保留编辑前的内容。');
                    }
                }
                const selection = currentSelection();
                selection.removeAllRanges();
                selection.addRange(range);
                return block;
            } catch (error) {
                block.replaceChildren(...[...backup.childNodes]);
                restoreViewState(beforeView);
                notificationPort.show?.(error.message, 'error');
                return null;
            }
        }

        function bindSurface(root) {
            assertActive();
            if (!disposeSurface()) return false;
            state.root = root;
            state.inputSync = inputSyncModule.createInputSync({
                verifiedKernel,
                delay: 0,
                snapshot: captureNode,
                canCommit: () => surfaceGate().canCommit,
                onVisualInput: ({ target }) => {
                    noteEdit();
                    // 原生 contenteditable 已经完成 DOM 修改；这里仅同步
                    // 选择状态，不触碰源码或渲染树，保证输入反馈立即可见。
                    state.activeEditable = target;
                    if (!state.explicitBlockSelection) captureSelection();
                },
                commit: ({ snapshot }) => {
                    // 源码提交与视觉输入解耦：这里只把最新节点放入
                    // deck 原有合并队列，真正写源码仍由 flush 完成。
                    return queueSnapshot(snapshot);
                },
            });
            state.abortController = new AbortController();
            const options = { signal: state.abortController.signal };

            root.querySelectorAll(core.EDITABLE_SELECTOR).forEach((editable) => {
                editable.contentEditable = 'true';
                editable.spellcheck = false;
            });

            resetCommittedTree();

            root.addEventListener('focusin', (event) => {
                const block = event.target.closest?.('[data-vdoc-text]');
                if (block) state.activeEditable = block;
                context.onFormattingTarget?.(event.target);
            }, options);

            root.addEventListener('pointerdown', (event) => {
                if (event.button !== 0 || event.defaultPrevented) return;
                const block = event.target.closest?.('[data-vdoc-text]');
                if (!block) return;
                const blockId = block.dataset.vdocText;
                state.activeEditable = block;
                if (event.shiftKey && state.blockSelectionAnchorId) {
                    event.preventDefault();
                    selectBlockInterval(state.blockSelectionAnchorId, blockId);
                } else if (event.ctrlKey || event.metaKey) {
                    event.preventDefault();
                    toggleBlock(blockId);
                } else {
                    state.blockSelectionAnchorId = blockId;
                    if (state.explicitBlockSelection) clearBlockSelection();
                }
                context.onFormattingTarget?.(event.target);
            }, options);

            root.addEventListener('mouseup', () => {
                if (!state.explicitBlockSelection) captureSelection();
            }, options);
            root.addEventListener('keyup', captureSelection, options);

            root.addEventListener('beforeinput', (event) => {
                if (event.defaultPrevented || !event.cancelable || event.isComposing
                    || !surfaceGate().canCapture) return;
                if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
                    event.preventDefault();
                    context.historyPort?.execute?.(event.inputType === 'historyUndo' ? 'undo' : 'redo');
                    return;
                }
                if (!['insertParagraph', 'insertLineBreak'].includes(event.inputType)) return;
                const range = liveRange();
                if (!range || !root.contains(range.startContainer)) return;
                event.preventDefault();
                const block = insertHardBreak(range);
                if (!block) return;
                block.dispatchEvent(new InputEvent('input', {
                    bubbles: true, composed: true, inputType: event.inputType,
                }));
            }, options);

            root.addEventListener('input', (event) => {
                if (event.defaultPrevented) return;
                const block = event.target.closest?.(core.EDITABLE_SELECTOR)
                    || event.target.closest?.('[data-vdoc-text]');
                if (!block) return;
                if (event.isComposing && barrierPhase(block) !== 1) {
                    cancelSettlingFrame(block);
                    advanceBarrier(block, verifiedKernel.SETTLED_ACTION.START);
                    state.inputSync?.compositionStart(block, event);
                }
                if (!event.isComposing && barrierPhase(block) !== 1) {
                    advanceBarrier(block, verifiedKernel.SETTLED_ACTION.FINAL_INPUT);
                    cancelSettlingFrame(block);
                }
                state.inputSync?.markInput(block, event);
            }, options);

            root.addEventListener('compositionstart', (event) => {
                const block = event.target.closest?.(core.EDITABLE_SELECTOR)
                    || event.target.closest?.('[data-vdoc-text]');
                if (!block) return;
                cancelSettlingFrame(block);
                advanceBarrier(block, verifiedKernel.SETTLED_ACTION.START);
                state.inputSync?.compositionStart(block, event);
            }, options);

            root.addEventListener('compositionend', (event) => {
                const block = event.target.closest?.(core.EDITABLE_SELECTOR)
                    || event.target.closest?.('[data-vdoc-text]');
                if (!block) return;
                cancelSettlingFrame(block);
                const { epoch: ticket } = advanceBarrier(block, verifiedKernel.SETTLED_ACTION.END);
                const frame = window.requestAnimationFrame(() => {
                    if (options.signal.aborted) return;
                    const current = advanceBarrier(block, verifiedKernel.SETTLED_ACTION.FRAME, ticket);
                    // Host handles are cancellation bookkeeping; the proved epoch
                    // transition decides whether this callback releases a barrier.
                    if (state.settlingFrames.get(block)?.ticket === ticket) state.settlingFrames.delete(block);
                    if (current.phase === 0 && surfaceGate().canCommit) state.inputSync?.flush();
                });
                state.settlingFrames.set(block, { frame, ticket });
                state.inputSync?.compositionEnd(block, event);
            }, options);

            root.addEventListener('copy', (event) => {
                const payload = clipboardPayload();
                if (!payload) return;
                rememberClipboard(payload);
                event.clipboardData?.setData('text/plain', payload.text);
                event.clipboardData?.setData('text/html', payload.html);
                event.preventDefault();
            }, options);

            root.addEventListener('cut', (event) => {
                const payload = clipboardPayload();
                if (!payload) return;
                rememberClipboard(payload);
                event.clipboardData?.setData('text/plain', payload.text);
                event.clipboardData?.setData('text/html', payload.html);
                event.preventDefault();
                context.deleteSelection?.(selectionState());
            }, options);

            const escapeText = value => String(value).replace(/[&<>]/g, character => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;',
            })[character]);
            const insertClipboard = (event, transfer) => {
                if (!transfer) return;
                event.preventDefault();
                const html = transfer.getData('text/html');
                const text = transfer.getData('text/plain');
                if (html) insertContent(html, { reason: 'deck-paste' });
                else if (text) insertContent(`<p>${text.split(/\r\n|\r|\n/)
                    .map(escapeText).join('<br>')}</p>`, { reason: 'deck-paste' });
            };
            root.addEventListener('paste', event => {
                insertClipboard(event, event.clipboardData);
            }, options);
            root.addEventListener('drop', event => {
                insertClipboard(event, event.dataTransfer);
            }, options);

            return api;
        }

        function disposeSurface() {
            if (!flush()) return false;
            state.inputSync?.dispose();
            state.inputSync = null;
            state.settlingFrames.forEach(({ frame }) => window.cancelAnimationFrame(frame));
            state.settlingFrames.clear();
            state.barriers.clear();
            state.abortController?.abort();
            state.abortController = null;
            state.root = null;
            state.acceptedNodes.clear();
            state.acceptedSequences.clear();
            state.committedTree = null;
            state.committedSource = null;
            state.commitError = null;
            state.activeEditable = null;
            state.selectionRange = null;
            state.selectionText = '';
            state.lastRestoreResult = null;
            state.selectedBlockIds = [];
            state.explicitBlockSelection = false;
            state.blockSelectionAnchorId = null;
            return true;
        }

        function dispose() {
            if (state.disposed) return true;
            if (!disposeSurface()) return false;
            state.disposed = true;
            return true;
        }

        const api = Object.freeze({
            kind: 'deck-editor',
            bindSurface,
            captureSelection,
            captureViewState,
            restoreViewState,
            lastRestoreResult: () => state.lastRestoreResult,
            selectionState,
            setBlockSelection,
            clearBlockSelection,
            executeFormatting,
            insertStructure,
            canExecute,
            formattingState,
            insertContent,
            clipboardPayload,
            flush,
            updateSourceNodes,
            recoverPendingEdit,
            draftRevision: () => state.draftRevision,
            disposeSurface,
            dispose,
        });

        return api;
    }

    window.ScriptoriumDeckEditor = Object.freeze({
        INLINE_STYLES,
        createDeckEditor,
    });
})();
