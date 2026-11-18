'use strict';

/**
 * Text-block codec, not a document parser or sanitizer.
 *
 * fromDOM(root) reads the root's contents without changing the live DOM. Its
 * immutable Fragment contains Text, Break, Inline, Atom, BlockLine and Unknown nodes.
 * Text lengths are UTF-16 code units; explicit BR and implied line boundaries
 * each occupy one unit. A DIV whose only content is one BR is an empty browser
 * line: that BR is a zero-length placeholder. No other BR is discarded.
 *
 * Only DIVs without attributes (apart from editor attributes, lang, dir and
 * whitelisted text styles) are browser lines. Layout, identity, classes, unknown
 * elements and unsupported namespaces fail closed. Original inline tags and
 * attributes survive. A generated terminal caret BR is explicitly marked and
 * occupies zero logical units; ordinary authored BRs always remain explicit.
 * BlockLine encodes as BR boundaries plus an inline style wrapper when needed.
 * Generated kernels own tree scheduling, line boundaries, offsets and render
 * commands. This adapter captures source nodes and executes DOM primitives.
 *
 * encode/toPlainText return null for unsupported fragments. Callers can retain
 * their source or use a separate lossless document path; never save that null.
 * The codec does not replace VDocCore.sanitizeHtml at the trust boundary.
 *
 * Position APIs use {offset, affinity:'upstream'|'downstream'}. At an implicit
 * break the same parent child boundary can mean either side, selected by
 * affinity. Adjacent styled runs similarly restore to the requested run side.
 * Mapping references the captured DOM; recapture after editing/replacing it.
 */
((root, factory) => {
    const commonJS = typeof module === 'object' && module.exports;
    const kernel = commonJS ? require('./scriptorium-verified-kernel.js') : root?.ScriptoriumVerifiedKernel;
    const api = factory(kernel);
    if (commonJS) module.exports = api;
    if (root?.document) root.ScriptoriumTextFragment = api;
})(typeof window === 'object' ? window : globalThis, kernel => {
    if (!kernel) throw new Error('The verified text kernel must load before the text codec.');
    const INLINE_TAGS = new Set([
        'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN',
        'EM', 'FONT', 'I', 'INS', 'KBD', 'MARK', 'Q', 'RP', 'RT', 'RUBY', 'S',
        'SAMP', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP', 'TIME',
        'TT', 'U', 'VAR', 'WBR',
    ]);
    const INLINE_ATOMS = new Set(['IMG']);
    const EDITOR_ATTRIBUTES = new Set([
        'contenteditable', 'spellcheck', 'data-vdoc-editor-selected',
    ]);
    const TEXT_STYLES = new Set([
        'color', 'background-color', 'font', 'font-family', 'font-size',
        'font-style', 'font-weight', 'font-stretch', 'font-variant',
        'font-variant-caps', 'font-variant-ligatures', 'font-feature-settings',
        'font-kerning', 'font-variation-settings', 'letter-spacing',
        'word-spacing', 'line-height', 'text-decoration', 'text-decoration-line',
        'text-decoration-color', 'text-decoration-style', 'text-decoration-thickness',
        'text-transform', 'text-shadow', 'direction', 'unicode-bidi',
        'white-space', 'tab-size',
    ]);
    const PLACEHOLDER = 'data-vdoc-caret-placeholder';
    const snapshots = new WeakMap();
    const affinityOf = value => value === 'upstream' || value === 'downstream';
    const escapeText = kernel.escapeText;
    const escapeAttribute = value => escapeText(value).replace(/"/g, '&quot;');
    const openingTag = (tag, attributes) => `<${tag}${attributes.map(({ name, value }) =>
        ` ${name}="${escapeAttribute(value)}"`).join('')}>`;

    function isTerminal(node, root) {
        for (let current = node; current && current !== root; current = current.parentNode) {
            if (current.nextSibling) return false;
        }
        return true;
    }

    function releaseCaretPlaceholders(root) {
        for (const node of root.querySelectorAll(`br[${PLACEHOLDER}="true"]`)) {
            if (isTerminal(node, root)) node.remove();
            else node.removeAttribute(PLACEHOLDER);
        }
    }

    function fromDOM(root, options = {}) {
        return readDOM(root, options);
    }

    function readDOM(root, options = {}, source = {}) {
        if (!root || ![1, 11].includes(root.nodeType) || !root.ownerDocument) {
            throw new TypeError('A text-block element or DocumentFragment is required.');
        }
        const issues = [];
        const semanticNodes = [];
        const domNodes = [];
        const rows = [];
        const childIds = [];
        const rootChildren = Object.freeze([...root.childNodes]);
        const events = kernel.LINE_EVENT;
        // Normalization consumes semantics and HTML, not caret navigation tables.
        const capturePositions = source.capturePositions !== false;
        const stripEditorAttributes = options.stripEditorAttributes !== false;
        const attributesOf = element => [...element.attributes]
            .filter(attribute => !stripEditorAttributes || !EDITOR_ATTRIBUTES.has(attribute.name))
            .map(({ name, value, namespaceURI }) => Object.freeze({ name, value,
                ...(namespaceURI ? { namespace: namespaceURI } : {}) }));
        const unknown = (node, reason) => {
            const result = { type: 'Unknown', tag: node.nodeName.toLowerCase(), reason };
            issues.push(Object.freeze({ tag: result.tag, reason }));
            return result;
        };
        const terminal = source.terminal || (node => isTerminal(node, root));
        const sourceRole = node => {
            const captured = source.roles?.get(node);
            return captured === events.PLACEHOLDER ? 2 : captured === events.HARD_BREAK ? 1 : 0;
        };
        const families = kernel.DOM_TAG;
        const capture = (node, parent) => {
            const id = domNodes.length;
            domNodes.push(node);
            const text = node.nodeType === 3;
            const element = node.nodeType === 1 && node.namespaceURI === 'http://www.w3.org/1999/xhtml';
            const tag = element ? node.tagName : '';
            const attributes = element ? attributesOf(node) : [];
            let family = text ? families.TEXT : tag === 'BR' ? families.BR : tag === 'DIV' ? families.DIV
                : INLINE_ATOMS.has(tag) ? families.ATOM : INLINE_TAGS.has(tag) ? families.INLINE : families.UNKNOWN;
            let allowed = true;
            let reason = element ? 'unsupported-element' : 'unsupported-node';
            if (family === families.DIV) {
                const declarations = (node.getAttribute('style') || '').split(';').filter(x => x.trim());
                allowed = attributes.every(attribute => ['style', 'lang', 'dir'].includes(attribute.name))
                    && declarations.every(declaration => {
                        const colon = declaration.indexOf(':');
                        return colon >= 0 && TEXT_STYLES.has(declaration.slice(0, colon).trim().toLowerCase());
                    });
                reason = 'non-text-line-div';
            } else if (family === families.INLINE) {
                allowed = !node.style.display || ['inline', 'contents'].includes(node.style.display);
                reason = 'inline-layout';
            }
            const value = text ? node.data : '';
            const children = Object.freeze([...node.childNodes]);
            if ([families.TEXT, families.BR, families.ATOM].includes(family) && children.length) {
                family = families.UNKNOWN;
                allowed = false;
                reason = 'leaf-with-children';
            }
            rows[id] = Object.freeze({ family, allowed, role: sourceRole(node),
                marked: element && node.getAttribute(PLACEHOLDER) === 'true', terminal: terminal(node),
                width: value.length, attributes: Object.freeze(attributes), parent, tag: tag.toLowerCase(),
                value, children, reason });
            // Traversal is restricted to the codec's declared container domain.
            // Descendants of unsupported nodes remain on the structural path.
            childIds[id] = allowed && (family === families.DIV || family === families.INLINE)
                ? Object.freeze(children.map(child => capture(child, id + 1))) : Object.freeze([]);
            return id;
        };
        const roots = rootChildren.map(node => capture(node, 0));
        const column = name => rows.map(row => row[name]);
        const captured = kernel.normalizeDom(column('family'), column('allowed'), column('role'),
            column('marked'), column('terminal'), column('width'), rows.map(row => row.attributes.length), column('parent'));
        if (!captured) throw new Error('Invalid captured DOM forest descriptors.');
        const { kinds: nodeKinds, widths: nodeWidths, parents } = captured;
        const materialize = id => {
            const row = rows[id];
            const kind = nodeKinds[id];
            let result;
            if (kind === events.TEXT) result = { type: 'Text', value: row.value };
            else if (kind === events.HARD_BREAK || kind === events.PLACEHOLDER) {
                result = { type: 'Break', attributes: row.attributes,
                    placeholder: kind === events.PLACEHOLDER, generated: row.marked };
            } else if (kind === events.ATOM) result = { type: 'Atom', tag: row.tag, attributes: row.attributes };
            else if (kind === events.OPEN_INLINE || kind === events.OPEN_BLOCK) {
                result = { type: kind === events.OPEN_INLINE ? 'Inline' : 'BlockLine',
                    ...(kind === events.OPEN_INLINE ? { tag: row.tag } : {}), attributes: row.attributes,
                    children: childIds[id].map(materialize) };
            } else result = unknown(domNodes[id], row.reason);
            semanticNodes[id] = result;
            return result;
        };
        const children = roots.map(materialize);
        const normalization = captured.normalization;
        if (captured.supported && !normalization) issues.push(Object.freeze({ tag: root.nodeName.toLowerCase(),
            reason: 'invalid-normalization-program' }));
        const length = normalization?.length ?? 0;
        const records = capturePositions ? new WeakMap() : null;
        const segments = capturePositions ? [] : null;
        const endpointCandidates = capturePositions ? [] : null;
        let endpointIndex = null;
        const html = [];
        const text = [];
        const expectedDOM = root.ownerDocument.createElement('p');
        let outputParent = expectedDOM;
        const outputElement = (tag, attributes = []) => {
            const element = root.ownerDocument.createElement(tag);
            for (const { name, value, namespace } of attributes) {
                if (namespace) element.setAttributeNS(namespace, name, value);
                else element.setAttribute(name, value);
            }
            outputParent.appendChild(element);
            return element;
        };
        const emitBreak = () => {
            html.push('<br>');
            outputElement('br');
            text.push('\n');
        };
        if (!issues.length) {
            const ops = kernel.RENDER_OP;
            const outputParents = [];
            for (let index = 0; index < normalization.ops.length; index++) {
                const op = normalization.ops[index];
                if (op === ops.IMPLICIT_BREAK) {
                    emitBreak();
                    continue;
                }
                const semantic = semanticNodes[normalization.owners[index]];
                if (op === ops.TEXT) {
                    html.push(escapeText(semantic.value));
                    outputParent.appendChild(root.ownerDocument.createTextNode(semantic.value));
                    text.push(semantic.value);
                } else if (op === ops.HARD_BREAK || op === ops.CARET) {
                    const attributes = op === ops.CARET
                        ? semantic.attributes.filter(attribute => attribute.name !== PLACEHOLDER)
                            .concat({ name: PLACEHOLDER, value: 'true' })
                        : semantic.generated
                            ? semantic.attributes.filter(attribute => attribute.name !== PLACEHOLDER)
                            : semantic.attributes;
                    html.push(openingTag('br', attributes));
                    outputElement('br', attributes);
                    if (op === ops.HARD_BREAK) text.push('\n');
                } else if (op === ops.ATOM) {
                    html.push(openingTag(semantic.tag, semantic.attributes));
                    outputElement(semantic.tag, semantic.attributes);
                } else if (op === ops.OPEN) {
                    const tag = semantic.type === 'Inline' ? semantic.tag : 'span';
                    html.push(openingTag(tag, semantic.attributes));
                    outputParents.push(outputParent);
                    outputParent = outputElement(tag, semantic.attributes);
                } else if (op === ops.CLOSE) {
                    const tag = semantic.type === 'Inline' ? semantic.tag : 'span';
                    outputParent = outputParents.pop();
                    if (tag !== 'wbr') html.push(`</${tag}>`);
                } else {
                    throw new Error('Invalid verified render opcode.');
                }
            }
            if (capturePositions) {
                for (let id = 0; id < domNodes.length; id++) {
                    const node = domNodes[id];
                    const start = normalization.starts[normalization.first[id]];
                    const end = normalization.ends[normalization.last[id]];
                    records.set(node, { start, end, children: rows[id].children,
                        value: node.nodeType === 3 ? rows[id].value : null });
                    if (node.nodeType === 3) segments.push({ node, start, end });
                }
            }
        }
        if (capturePositions) records.set(root, { start: 0, end: length, children: rootChildren });
        const positionIndex = !capturePositions || issues.length ? null : kernel.createPositionIndex(
            segments.map(segment => segment.start), segments.map(segment => segment.end), length);
        if (capturePositions && !issues.length && !positionIndex) issues.push(Object.freeze({
            tag: root.nodeName.toLowerCase(), reason: 'invalid-position-index' }));

        if (capturePositions && !issues.length) {
            const index = (node, depth = 0, childOffset = 0, parent = null) => {
                const record = records.get(node);
                if (!record) return false;
                const kind = node.nodeType === 3 ? 0 : node.nodeName === 'BR' ? 1 : 2;
                const children = record.children.map(child => records.get(child));
                if (children.some(child => !child)) return false;
                const points = kernel.buildPointCandidates(kind, record.start, record.end,
                    kind === 0 ? record.value.length : kind === 1 ? 0 : children.length, childOffset,
                    children.map(child => child.start), children.map(child => child.end));
                if (!points || (kind === 1 && !parent)) return false;
                for (let point = 0; point < points.positions.length; point++) {
                    endpointCandidates.push({ position: points.positions[point], node: kind === 1 ? parent : node,
                        offset: points.offsets[point], affinity: points.downstream[point] ? 'downstream' : 'upstream',
                        role: points.roles[point], depth, order: endpointCandidates.length });
                }
                if (kind !== 2) return true;
                return record.children.every((child, offset) => index(child, depth + 1, offset, node));
            };
            if (!index(root)) {
                issues.push(Object.freeze({ tag: root.nodeName.toLowerCase(), reason: 'invalid-point-record' }));
            } else {
                endpointCandidates.sort((left, right) => left.position - right.position || left.order - right.order);
                endpointIndex = kernel.createEndpointIndex(endpointCandidates.map(point => point.position),
                    endpointCandidates.map(point => point.affinity === 'downstream'),
                    endpointCandidates.map(point => point.role), endpointCandidates.map(point => point.depth), length);
                if (!endpointIndex) issues.push(Object.freeze({ tag: root.nodeName.toLowerCase(), reason: 'invalid-endpoint-index' }));
            }
        }
        const freezeNode = node => {
            if (node.children) {
                node.children.forEach(freezeNode);
                Object.freeze(node.children);
            }
            if (node.attributes) Object.freeze(node.attributes);
            return Object.freeze(node);
        };
        const fragment = Object.freeze({
            type: 'Fragment',
            children: Object.freeze(children.map(freezeNode)),
            supported: issues.length === 0,
            issues: Object.freeze(issues),
            length: issues.length ? null : length,
        });
        expectedDOM.normalize();
        snapshots.set(fragment, { root, records, segments, endpointCandidates, endpointIndex, positionIndex, expectedDOM,
            domNodes, nodeKinds, html: html.join(''), text: text.join('') });
        return fragment;
    }

    function encode(fragment) {
        const snapshot = snapshots.get(fragment);
        if (!snapshot || !fragment.supported) return null;
        // Full P parsing catches invalid programmatic nesting (e.g. nested A),
        // parser recovery and text normalization before a caller overwrites source.
        const template = snapshot.root.ownerDocument.createElement('template');
        template.innerHTML = `<p>${snapshot.html}</p>`;
        const paragraph = template.content.firstChild;
        return template.content.childNodes.length === 1 && paragraph?.nodeName === 'P'
            && paragraph.isEqualNode(snapshot.expectedDOM) ? snapshot.html : null;
    }

    function authorAttributes(node) {
        return Object.freeze([...node.attributes].filter(attribute => !EDITOR_ATTRIBUTES.has(attribute.name))
            .map(({ namespaceURI, name, value }) => Object.freeze({ namespace: namespaceURI || '', name, value }))
            .sort((left, right) => {
                const a = `${left.namespace}\u0000${left.name}`;
                const b = `${right.namespace}\u0000${right.name}`;
                return a < b ? -1 : a > b ? 1 : 0;
            }));
    }

    // A value model, independent of DOM identity and text-node splitting. Literal
    // source LF is distinct from a BR, even when both project to plain text LF.
    // Browser BlockLine lowering is the existing, explicit fromDOM contract.
    function semanticModel(root, fragment = fromDOM(root)) {
        const snapshot = snapshots.get(fragment);
        const supported = fragment.supported && snapshot?.root === root;
        const contentRoot = supported ? snapshot.expectedDOM : root;
        const readChildren = parent => {
            const result = [];
            let pendingText = '';
            const flushText = () => {
                const lines = pendingText.split('\n');
                lines.forEach((value, index) => {
                    if (index) result.push(Object.freeze({ type: 'LiteralLF' }));
                    if (value) result.push(Object.freeze({ type: 'Text', value }));
                });
                pendingText = '';
            };
            for (const node of parent.childNodes) {
                if (node.nodeType === 3) { pendingText += node.data; continue; }
                if (supported && node.nodeName === 'BR'
                    && node.getAttribute(PLACEHOLDER) === 'true' && isTerminal(node, contentRoot)) continue;
                flushText();
                if (node.nodeType === 1) {
                    const attributes = authorAttributes(node);
                    const tag = node.localName;
                    const namespace = node.namespaceURI || '';
                    if (supported && node.nodeName === 'BR') {
                        result.push(Object.freeze({ type: 'HardBreak', attributes }));
                    } else {
                        result.push(Object.freeze({ type: 'Element', namespace, tag, attributes,
                            children: readChildren(node),
                            template: node.content?.nodeType === 11 ? readChildren(node.content) : null }));
                    }
                } else {
                    result.push(Object.freeze({ type: 'Node', nodeType: node.nodeType,
                        name: node.nodeName, value: node.nodeValue }));
                }
            }
            flushText();
            return Object.freeze(result);
        };
        return Object.freeze({ version: 1, kind: supported ? 'inline' : 'structural',
            children: readChildren(contentRoot) });
    }

    function sameSemantics(left, right) {
        return JSON.stringify(left) === JSON.stringify(right);
    }

    // 0..65535 are literal UTF-16 units (10 is LiteralLF); 65536 is HardBreak.
    // Formatting and atoms have zero logical length and remain in semanticModel.
    const HARD_BREAK = kernel.HARD_BREAK;
    function logicalUnits(model) {
        if (model?.kind !== 'inline') return null;
        const units = [];
        const visit = nodes => {
            for (const node of nodes) {
                if (node.type === 'Text') {
                    for (let index = 0; index < node.value.length; index++) units.push(node.value.charCodeAt(index));
                } else if (node.type === 'LiteralLF') units.push(10);
                else if (node.type === 'HardBreak') units.push(HARD_BREAK);
                else if (node.type === 'Element') visit(node.children);
            }
        };
        visit(model.children);
        return Object.freeze(units);
    }

    const spliceLogicalUnits = kernel.splice;

    // Editing is not import sanitization: refuse an edit if safety cleaning would
    // silently alter author content. Dafny compares frozen scalar snapshots; DOM
    // parsing and semantic extraction remain explicit JavaScript boundaries.
    function normalizeBlock(root, core) {
        const original = readDOM(root, {}, { capturePositions: false });
        const meaning = semanticModel(root, original);
        const originalMeaning = JSON.stringify(meaning);
        if (typeof originalMeaning !== 'string') return null;
        const candidate = (source, fragment) => {
            const clone = source.cloneNode(true);
            const strip = node => {
                for (const element of [node, ...node.querySelectorAll('*')]) {
                    for (const attribute of EDITOR_ATTRIBUTES) element.removeAttribute?.(attribute);
                    if (element.content?.nodeType === 11) strip(element.content);
                }
            };
            strip(clone);
            const sanitized = clone.cloneNode(true);
            if (!core.sanitizeFragment(sanitized) || !sanitized.isEqualNode(clone)) return null;
            // Inline lowering executes the kernel captured from the original DOM;
            // zero-width source nodes can determine the role of a generated BR.
            const encoded = encode(fragment);
            if (encoded !== null) return encoded;
            // Structural serialization may coalesce Text nodes, but its decoded
            // result is still checked against the pre-normalization value below.
            clone.normalize();
            const holder = clone.ownerDocument.createDocumentFragment();
            holder.appendChild(clone);
            const template = clone.ownerDocument.createElement('template');
            const wrappers = { TD: ['<table><tbody><tr>', '</tr></tbody></table>'],
                TH: ['<table><tbody><tr>', '</tr></tbody></table>'] };
            const [before, after] = wrappers[clone.tagName] || ['', ''];
            template.innerHTML = before + core.serializeFragment(holder) + after;
            const parent = before ? template.content.querySelector('tr') : template.content;
            parent?.normalize();
            return parent?.childNodes.length === 1 && parent.firstChild.isEqualNode(clone)
                ? core.serializeFragment(clone) : null;
        };
        const context = Object.freeze({ rootTag: root.tagName, namespace: root.namespaceURI || '' });
        const parsedSnapshots = new WeakMap();
        const parse = (_fixedContext, source) => {
            const decoded = root.cloneNode(false);
            decoded.innerHTML = source;
            const fragment = readDOM(decoded, {}, { capturePositions: false });
            const parsedMeaning = JSON.stringify(semanticModel(decoded, fragment));
            parsedSnapshots.set(decoded, { fragment, meaning: parsedMeaning });
            return decoded;
        };
        const produce = (_fixedContext, sourceRoot) => {
            const fragment = sourceRoot === root ? original : parsedSnapshots.get(sourceRoot)?.fragment;
            return fragment ? candidate(sourceRoot, fragment) : null;
        };
        const meaningSnapshot = sourceRoot => sourceRoot === root
            ? originalMeaning : parsedSnapshots.get(sourceRoot)?.meaning ?? null;
        return kernel.normalizeFixedPoint(context, parse, produce, meaningSnapshot, root)?.source ?? null;
    }

    // Transfer roles are the codec's declared HTML content domain, not CSS
    // layout guesses. Unknown/structural elements remain independent flow nodes.
    function transferKind(node) {
        if (node.nodeType === 3) return 0;
        if (node.nodeType === 8) return 2;
        return node.nodeType === 1 && node.namespaceURI === 'http://www.w3.org/1999/xhtml'
            && (INLINE_TAGS.has(node.tagName) || INLINE_ATOMS.has(node.tagName) || node.tagName === 'BR') ? 0 : 1;
    }

    // Reuse the codec's source classification even inside structural containers.
    // Unknown wrappers do not reset caret ownership; editable roots do.
    function transferRoles(root) {
        const roles = new WeakMap();
        const terminal = node => {
            const owner = node.closest?.('[data-vdoc-text]');
            return isTerminal(node, owner && root.contains(owner) ? owner : root);
        };
        const read = scope => {
            const fragment = readDOM(scope, {}, { terminal });
            const { domNodes, nodeKinds } = snapshots.get(fragment);
            domNodes.forEach((node, index) => {
                roles.set(node, nodeKinds[index]);
                if (nodeKinds[index] === 8 && node.nodeType === 1) read(node);
            });
        };
        read(root);
        return roles;
    }

    // Source roles cross Range.cloneContents through a private, collision-free
    // attribute. It is removed before returning; author attributes are untouched.
    // Canonical lowering runs only after roles have been captured in full context.
    function captureTransfer(root, range = null) {
        if (!root?.ownerDocument || (range && (!root.contains(range.startContainer)
            || !root.contains(range.endContainer)))) return null;
        const document = root.ownerDocument;
        const clone = document.createElement('div');
        const copies = new WeakMap([[root, clone]]);
        const pair = (source, target) => {
            copies.set(source, target);
            for (let index = 0; index < source.childNodes.length; index++) {
                pair(source.childNodes[index], target.childNodes[index]);
            }
        };
        for (const child of root.childNodes) {
            const copy = child.cloneNode(true); clone.appendChild(copy); pair(child, copy);
        }
        let selection;
        if (range) {
            selection = document.createRange();
            selection.setStart(copies.get(range.startContainer), range.startOffset);
            selection.setEnd(copies.get(range.endContainer), range.endOffset);
        }
        const roles = transferRoles(root);
        let key = 'data-vdoc-transfer-role';
        while (root.querySelector(`[${key}]`)) key += '-';
        const originalKinds = [];
        for (const node of root.querySelectorAll('br')) {
            copies.get(node).setAttribute(key, String(originalKinds.length));
            originalKinds.push(roles.get(node));
        }
        const captured = selection ? selection.cloneContents() : document.createDocumentFragment();
        if (!selection) captured.append(...clone.childNodes);
        const capturedRoles = new WeakMap();
        for (const node of captured.querySelectorAll(`br[${key}]`)) {
            capturedRoles.set(node, originalKinds[Number(node.getAttribute(key))]);
        }
        const lower = scope => {
            const fragment = readDOM(scope, {}, { roles: capturedRoles });
            if (fragment.supported && encode(fragment) !== null) {
                scope.replaceChildren(...[...snapshots.get(fragment).expectedDOM.childNodes]
                    .map(node => node.cloneNode(true)));
                releaseCaretPlaceholders(scope);
            } else {
                for (const child of scope.children) lower(child);
            }
        };
        lower(captured);
        for (const node of captured.querySelectorAll(`br[${key}]`)) {
            const kind = originalKinds[Number(node.getAttribute(key))];
            node.removeAttribute(key);
            if (kind === kernel.LINE_EVENT.PLACEHOLDER) node.remove();
            else node.removeAttribute(PLACEHOLDER);
        }
        return captured;
    }

    function transferText(root) {
        const kinds = [], widths = [], parents = [], leaves = [];
        const events = kernel.LINE_EVENT;
        const roles = transferRoles(root);
        const read = (node, parent) => {
            if (node.nodeType === 8) return;
            if (node.nodeType === 1 && ['SCRIPT', 'STYLE', 'TEMPLATE'].includes(node.tagName)) return;
            const id = kinds.length;
            const text = node.nodeType === 3;
            const br = node.nodeType === 1 && node.tagName === 'BR';
            const atom = node.nodeType === 1 && INLINE_ATOMS.has(node.tagName);
            const role = roles.get(node);
            kinds.push(role !== undefined && role !== 8 ? role
                : transferKind(node) === 0 ? events.OPEN_INLINE : events.OPEN_BLOCK);
            widths.push(text ? node.data.length : 0);
            parents.push(parent);
            leaves.push(text ? node.data : '');
            if (!text && !br && !atom) for (const child of node.childNodes) read(child, id + 1);
        };
        for (const node of root.childNodes) read(node, 0);
        const flags = kinds.map(() => false);
        const plan = kernel.normalizeTree(kinds, widths, parents, flags, flags);
        if (!plan) return null;
        const units = [];
        for (let index = 0; index < plan.ops.length; index++) {
            const op = plan.ops[index];
            if (op === kernel.RENDER_OP.IMPLICIT_BREAK || op === kernel.RENDER_OP.HARD_BREAK) units.push(HARD_BREAK);
            else if (op === kernel.RENDER_OP.TEXT) {
                const text = leaves[plan.owners[index]];
                for (let offset = 0; offset < text.length; offset++) units.push(text.charCodeAt(offset));
            }
        }
        return kernel.projectText(units);
    }

    // Materialize the verified partition without dropping or reordering nodes.
    // The erase-wrapper witness is checked before identities or parsing intervene.
    function transferBlocks(root, core) {
        const nodes = [...root.childNodes];
        const plan = kernel.partitionFlow(nodes.map(transferKind));
        if (!plan) return null;
        const result = root.ownerDocument.createDocumentFragment();
        const groups = [];
        for (let index = 0; index < nodes.length; index++) {
            const group = plan.groups[index];
            if (plan.wrapped[group]) {
                if (!groups[group]) {
                    groups[group] = root.ownerDocument.createElement('p');
                    result.appendChild(groups[group]);
                }
                groups[group].appendChild(nodes[index].cloneNode(true));
            } else {
                groups[group] = nodes[index].cloneNode(true);
                result.appendChild(groups[group]);
            }
        }
        const erased = root.ownerDocument.createDocumentFragment();
        groups.forEach((node, group) => {
            if (plan.wrapped[group]) erased.append(...[...node.childNodes].map(child => child.cloneNode(true)));
            else erased.appendChild(node.cloneNode(true));
        });
        if (!sameSemantics(semanticModel(root), semanticModel(erased))) return null;
        const decoded = root.ownerDocument.createElement('template');
        decoded.innerHTML = core.serializeFragment(result);
        return sameSemantics(semanticModel(result), semanticModel(decoded.content)) ? result : null;
    }

    function toPlainText(fragment) {
        const snapshot = snapshots.get(fragment);
        return snapshot && fragment.supported ? snapshot.text : null;
    }

    function domToLogical(fragment, node, offset, affinity = 'downstream') {
        const snapshot = snapshots.get(fragment);
        const record = snapshot?.records?.get(node);
        if (!fragment?.supported || !record || !Number.isInteger(offset) || offset < 0 || !affinityOf(affinity)) return null;
        if (node.nodeType === 3) {
            if (node.data !== record.value || offset > record.value.length) return null;
            const position = kernel.selectPoint(true, record.value.length, offset,
                record.start, record.end, record.start, record.end, affinity === 'downstream');
            return position === null ? null : { offset: position, affinity };
        }
        if (offset > record.children.length || node.childNodes.length !== record.children.length
            || (offset && node.childNodes[offset - 1] !== record.children[offset - 1])
            || (offset < record.children.length && node.childNodes[offset] !== record.children[offset])) return null;
        if (node.nodeName === 'BR') return { offset: record.start, affinity };
        const before = offset ? snapshot.records.get(record.children[offset - 1]).end : record.start;
        const after = offset < record.children.length ? snapshot.records.get(record.children[offset]).start : record.end;
        const position = kernel.selectPoint(false, record.children.length, offset,
            record.start, record.end, before, after, affinity === 'downstream');
        return position === null ? null : { offset: position, affinity };
    }

    function logicalToDOM(fragment, position) {
        const snapshot = snapshots.get(fragment);
        const offset = position?.offset;
        const affinity = position?.affinity ?? 'downstream';
        if (!snapshot?.records || !snapshot.endpointIndex || !snapshot.positionIndex
            || !fragment.supported || !Number.isInteger(offset)
            || offset < 0 || offset > fragment.length || !affinityOf(affinity)) return null;
        // The immutable index validates interval order once, then searches in
        // logarithmic time without copying arrays or indexing each UTF-16 unit.
        const selected = kernel.lookupEndpoints(snapshot.endpointIndex, offset);
        if (!selected) return null;
        const entry = { upstream: selected.upstream === null ? null : snapshot.endpointCandidates[selected.upstream],
            downstream: selected.downstream === null ? null : snapshot.endpointCandidates[selected.downstream] };
        const plan = kernel.restorePosition(snapshot.positionIndex, offset, affinity === 'downstream',
            Boolean(entry?.upstream), Boolean(entry?.downstream));
        if (!plan) return null;
        if (plan.kind === 1) {
            const segment = snapshot.segments[plan.segment];
            return segment.node.data === snapshot.records.get(segment.node).value
                ? { node: segment.node, offset: plan.offset,
                    affinity: plan.downstream ? 'downstream' : 'upstream' } : null;
        }
        const candidate = plan.downstream ? entry.downstream : entry.upstream;
        if (!candidate) return null;
        // A boundary represented only on one side must retain its own affinity.
        const check = domToLogical(fragment, candidate.node, candidate.offset, candidate.affinity);
        return check?.offset === offset
            ? { node: candidate.node, offset: candidate.offset, affinity: candidate.affinity } : null;
    }

    return Object.freeze({ fromDOM, encode, normalizeBlock, semanticModel, sameSemantics,
        HARD_BREAK, logicalUnits, spliceLogicalUnits,
        releaseCaretPlaceholders, captureTransfer, transferText, transferBlocks,
        toPlainText, domToLogical, logicalToDOM });
});
