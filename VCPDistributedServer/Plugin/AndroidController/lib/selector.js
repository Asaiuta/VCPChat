'use strict';

const CONDITIONS = ['id', 'text', 'desc', 'any', 'contains', 'regex', 'class', 'role'];
const RELATIONS = ['within', 'childOf', 'siblingOf', 'hasDescendant'];
const FIELDS = new Set([...CONDITIONS, 'nth', ...RELATIONS]);
const EXACT_FIELDS = new Set(['id', 'text', 'desc', 'any']);
const MAX_PATTERN_LENGTH = 512;
const MAX_REGEX_TEXT_LENGTH = 16384;
const MAX_CONDITION_LENGTH = 4096;
const MAX_REGEX_WORK = 8 * 1024 * 1024;
const LEGACY_ORDINAL = Symbol('legacyOrdinal');
const REGEX_MATCHER = Symbol('regexMatcher');
const PARSED = new WeakSet();
const MATCH_LABEL = Symbol('matchLabel');
let RE2 = null;
for (const name of ['node:re2', 're2']) {
    try {
        const implementation = require(name);
        const candidate = implementation.RE2 || implementation;
        if (typeof candidate === 'function') { RE2 = candidate; break; }
    } catch { /* Optional native linear-time engine; no dependency is required. */ }
}

function invalid(message) {
    const error = new TypeError(`Invalid Android selector: ${message}`);
    error.code = 'ANDROID_SELECTOR_INVALID';
    throw error;
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype === null) return true;
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
    return Object.getPrototypeOf(prototype) === null && typeof constructor === 'function'
        && constructor.prototype === prototype
        && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(Object);
}


/**
 * Fallback grammar: concatenated literals, dot, character classes, ^/$ edge anchors,
 * escapes d/D/s/S/w/W and escaped punctuation, with single *, + or ? quantifiers.
 * Groups, alternation, counted repetitions, lookarounds and backreferences are rejected.
 * Thompson-style state simulation is O(pattern length * text length), without backtracking.
 */
function linearRegex(source) {
    let cursor = 0;
    const anchoredStart = source[0] === '^';
    if (anchoredStart) cursor += 1;
    let anchoredEnd = false;
    const tokens = [];
    const literal = (char) => (value) => value === char;
    const escaped = () => {
        if (cursor >= source.length) invalid('unfinished regex escape');
        const char = source[cursor++];
        const classes = {
            d: (c) => c >= '0' && c <= '9',
            w: (c) => /[A-Za-z0-9_]/.test(c),
            s: (c) => /\s/.test(c),
        };
        if (classes[char.toLowerCase()]) {
            const predicate = classes[char.toLowerCase()];
            return { test: char === char.toLowerCase() ? predicate : (c) => !predicate(c) };
        }
        if (char === 'n' || char === 'r' || char === 't') {
            const value = { n: '\n', r: '\r', t: '\t' }[char];
            return { test: literal(value), value };
        }
        if (!/[\w]/.test(char)) return { test: literal(char), value: char };
        invalid('unsupported regex escape');
    };
    const classAtom = () => {
        if (cursor >= source.length) invalid('unfinished regex character class');
        if (source[cursor] === '\\') { cursor += 1; return escaped(); }
        const value = source[cursor++];
        if (value === '[' || value === ']') invalid('invalid regex character class');
        return { test: literal(value), value };
    };
    while (cursor < source.length) {
        const char = source[cursor++];
        if (char === '$' && cursor === source.length) { anchoredEnd = true; break; }
        let test;
        if (char === '\\') test = escaped().test;
        else if (char === '.') test = (c) => !'\n\r\u2028\u2029'.includes(c);
        else if (char === '[') {
            const negate = source[cursor] === '^';
            if (negate) cursor += 1;
            const predicates = [];
            while (cursor < source.length && source[cursor] !== ']') {
                const first = classAtom();
                if (source[cursor] === '-' && source[cursor + 1] !== ']' && cursor + 1 < source.length) {
                    cursor += 1;
                    const last = classAtom();
                    if (first.value === undefined || last.value === undefined || first.value > last.value) {
                        invalid('invalid regex character range');
                    }
                    predicates.push((c) => c >= first.value && c <= last.value);
                } else predicates.push(first.test);
            }
            if (!predicates.length || source[cursor++] !== ']') invalid('unfinished or empty regex character class');
            test = (c) => predicates.some((predicate) => predicate(c)) !== negate;
        } else {
            if ('^$()|{}*+?]'.includes(char)) invalid('unsupported regex syntax (linear subset only)');
            test = literal(char);
        }
        const quantifier = source[cursor];
        if (quantifier === '*' || quantifier === '+' || quantifier === '?') cursor += 1;
        if (quantifier === '+') tokens.push({ test, optional: false, repeat: false });
        tokens.push({ test, optional: quantifier === '*' || quantifier === '?' || quantifier === '+',
            repeat: quantifier === '*' || quantifier === '+' });
    }
    const closure = (states) => {
        for (let i = 0; i < tokens.length; i += 1) {
            if (states.has(i) && tokens[i].optional) states.add(i + 1);
        }
        return states;
    };
    return (text) => {
        if (text.length > MAX_REGEX_TEXT_LENGTH) return false;
        let states = closure(new Set([0]));
        for (let pos = 0; ; pos += 1) {
            if (states.has(tokens.length) && (!anchoredEnd || pos === text.length)) return true;
            if (pos === text.length) return false;
            const next = new Set();
            for (const index of states) {
                const token = tokens[index];
                if (token && token.test(text[pos])) next.add(token.repeat ? index : index + 1);
            }
            if (!anchoredStart) next.add(0);
            states = closure(next);
            if (anchoredStart && !states.size) return false;
        }
    };
}

function compileRegex(source) {
    if (source.length > MAX_PATTERN_LENGTH) invalid(`regex exceeds ${MAX_PATTERN_LENGTH} characters`);
    if (RE2) {
        try {
            const compiled = new RE2(source);
            return (text) => text.length <= MAX_REGEX_TEXT_LENGTH && compiled.test(text);
        } catch { invalid('invalid or unsupported RE2 pattern'); }
    }
    return linearRegex(source);
}

/** Parse to a frozen selector. Throws TypeError with code ANDROID_SELECTOR_INVALID. */
function parseSelector(input, allowWithin = true) {
    if (input && typeof input === 'object' && PARSED.has(input)) {
        if (!allowWithin && RELATIONS.some(key => input[key])) invalid('relations may not be nested');
        return input;
    }
    let legacyOrdinal;
    if (typeof input === 'string') {
        const match = /^(id|text|desc|any|contains|regex|class|role)=([\s\S]*)$/.exec(input);
        if (!match) invalid('expected a condition=value string or a selector object');
        const [, kind] = match;
        let key = match[2];
        if (EXACT_FIELDS.has(kind)) {
            const ordinal = /#(\d+)$/.exec(key);
            if (ordinal) {
                legacyOrdinal = Number(ordinal[1]);
                if (!Number.isSafeInteger(legacyOrdinal) || legacyOrdinal < 1) invalid('legacy #N must be a positive safe integer');
                key = key.slice(0, ordinal.index);
            }
            key = key.replace(/%25|%23/gi, (code) => code.toLowerCase() === '%25' ? '%' : '#');
        }
        input = { [kind]: key };
    }
    if (!isPlainObject(input)) invalid('expected a plain selector object');
    const keys = Reflect.ownKeys(input);
    const output = {};
    for (const key of keys) {
        if (!FIELDS.has(key)) invalid(`unknown field ${String(key)}`);
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !('value' in descriptor)) invalid('selector fields must be data properties');
        const value = descriptor.value;
        if (CONDITIONS.includes(key)) {
            if (typeof value !== 'string' || !value.trim()) invalid(`${key} must be a non-empty string`);
            if (value.length > MAX_CONDITION_LENGTH) invalid(`${key} exceeds ${MAX_CONDITION_LENGTH} characters`);
            output[key] = key === 'role' ? value.toLowerCase() : value;
        } else if (key === 'nth') {
            if (!Number.isSafeInteger(value) || value < 0) invalid('nth must be a non-negative numeric safe integer');
            output.nth = value;
        } else {
            if (!allowWithin) invalid('relations may not be nested');
            output[key] = parseSelector(value, false);
        }
    }
    if (!CONDITIONS.some((key) => Object.hasOwn(output, key))) invalid('at least one matching condition is required');
    if (output.regex !== undefined) Object.defineProperty(output, REGEX_MATCHER, { value: compileRegex(output.regex) });
    if (legacyOrdinal !== undefined) Object.defineProperty(output, LEGACY_ORDINAL, { value: legacyOrdinal });
    PARSED.add(output);
    return Object.freeze(output);
}

/** Non-throwing validity probe; use parseSelector to obtain a diagnostic. */
function validateSelector(input) {
    try { parseSelector(input); return true; } catch { return false; }
}

function matches(control, selector, budget) {
    const text = String(control.text ?? '');
    if (selector.id !== undefined && control.id !== selector.id) return false;
    if (selector.text !== undefined && text !== selector.text) return false;
    if (selector.desc !== undefined && String(control.desc ?? '') !== selector.desc) return false;
    if (selector.any !== undefined && String(control[MATCH_LABEL] ?? control.label ?? '') !== selector.any) return false;
    if (selector.contains !== undefined && !text.includes(selector.contains)) return false;
    if (selector.regex !== undefined) {
        if (text.length > MAX_REGEX_TEXT_LENGTH) invalid('raw text exceeds regex input budget');
        budget.remaining -= Math.max(1, selector.regex.length) * Math.max(1, text.length);
        if (budget.remaining < 0) invalid('query exceeds total regex work budget');
        if (!selector[REGEX_MATCHER](text)) return false;
    }
    if (selector.class !== undefined && control.cls !== selector.class && control.fullClass !== selector.class) return false;
    return selector.role === undefined || control.role === selector.role;
}

/** nth is screen order, not identity. Legacy #N deliberately retains XML order. */
function screenOrder(a, b) {
    for (const key of ['top', 'left', 'bottom', 'right']) {
        const difference = (a.bounds?.[key] ?? Infinity) - (b.bounds?.[key] ?? Infinity);
        if (difference) return difference;
    }
    return (a.index ?? 0) - (b.index ?? 0);
}

function controlsOf(source, options = {}) {
    if (options.includeDisabled === true && source?.evidenceControls) return source.evidenceControls;
    const complete = source?.matchingControls;
    if (complete) return complete;
    if (source?.presentationOnly || source?.truncated) invalid('public projection lacks complete matching evidence');
    const controls = Array.isArray(source) ? source : source?.controls;
    if (!Array.isArray(controls)) invalid('graph lacks matching evidence');
    if (controls.some(control => control?.presentationOnly)) invalid('public controls lack complete matching evidence');
    return controls;
}

function select(controls, selector, scopes = controls, budget = { remaining: MAX_REGEX_WORK }) {
    let candidates = controls;
    const descendantOf = (node, parent) => {
        for (let ancestor = node?.parent; ancestor; ancestor = ancestor.parent) {
            if (--budget.remaining < 0) invalid('query exceeds relation work budget');
            if (ancestor === parent) return true;
        }
        return false;
    };
    for (const relation of RELATIONS) {
        if (!selector[relation]) continue;
        const anchors = select(scopes, selector[relation], scopes, budget);
        // hasDescendant is an existential predicate; duplicate matching descendants
        // do not make a single parent ambiguous. Anchor relations require one node.
        if ((relation !== 'hasDescendant' && anchors.length !== 1) || anchors.some(anchor => !anchor.rawNode)) {
            const error = new Error(`${relation} requires complete original-tree anchor evidence`);
            error.ambiguous = anchors.length > 1;
            throw error;
        }
        candidates = candidates.filter((control) => {
            if (--budget.remaining < 0) invalid('query exceeds relation work budget');
            const node = control.rawNode;
            if (!node) invalid('relation candidate lacks original-tree evidence');
            if (relation === 'hasDescendant') return anchors.some(anchor => descendantOf(anchor.rawNode, node));
            const anchor = anchors[0].rawNode;
            if (relation === 'childOf') return node.parent === anchor;
            if (relation === 'siblingOf') return node !== anchor && node.parent && node.parent === anchor.parent;
            return descendantOf(node, anchor);
        });
    }
    const hits = candidates.filter((control) => matches(control, selector, budget));
    if (selector[LEGACY_ORDINAL] !== undefined) {
        const hit = hits[selector[LEGACY_ORDINAL] - 1];
        return hit ? [hit] : [];
    }
    if (selector.nth !== undefined) {
        const hit = hits.sort(screenOrder)[selector.nth];
        return hit ? [hit] : [];
    }
    return hits;
}

/**
 * Evidence-aware matching for assertions: absence is proven only by complete && !hits.length.
 * Bare duplicates are complete evidence but ambiguous; invalid selectors, uncertain scopes,
 * missing truncation evidence and exhausted regex budgets are incomplete, never absent.
 */
function evaluateSelector(source, query, options = {}) {
    try {
        const parsed = parseSelector(query);
        const controls = controlsOf(source, options);
        const hits = select(controls, parsed, source?.scopeControls || controls);
        return { hits, complete: true, ambiguous: hits.length > 1 };
    } catch (error) {
        return { hits: [], complete: false, ambiguous: error.ambiguous === true };
    }
}

/**
 * Exact text/desc use only original node fields; any uses the full aggregate label.
 * within preserves these same source rules on original-tree ancestor scopes.
 */
function findControls(source, query) {
    return evaluateSelector(source, query).hits;
}

function resolveSelector(source, query) {
    const result = evaluateSelector(source, query);
    return result.complete && result.hits.length === 1 ? result.hits[0] : null;
}

module.exports = { parseSelector, validateSelector, evaluateSelector, findControls, resolveSelector, MATCH_LABEL,
    MAX_PATTERN_LENGTH, MAX_REGEX_TEXT_LENGTH, MAX_CONDITION_LENGTH, MAX_REGEX_WORK,
    regexEngine: RE2 ? 're2' : 'linear-subset' };
