'use strict';

const { SEARCH_POLICY } = require('./androidTaskPolicy');
const SEMANTICS_VERSION = SEARCH_POLICY.semanticsVersion;
const FEEDBACK_VERSION = SEARCH_POLICY.feedbackVersion;
const ROLES = Object.freeze(['textfield', 'button', 'image', 'text', 'other']);
const HINTS = Object.freeze(['search', 'query_field', 'search_entry', 'search_submit']);
const FIELD_RELATIONS = Object.freeze(['none', 'same_parent', 'other_parent', 'unproven', 'ambiguous']);
const FEEDBACK_EVENTS = Object.freeze(['initial', 'verified_entry', 'verified_fill', 'verified_focus', 'verified_seek', 'verified_back', 'stale_observation', 'stale_dispatch',
    'loading_finished', 'main_agent_reobserve', 'human_reobserve']);
const MAX_RECENT_ACTIONS = 3;
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s….:：]+$/u, '') : '';
// Exact closed vocabulary. v2 also recognizes AndroidX SearchView's standard IDs.
const SEARCH_LABELS = new Set(['search', 'search here', 'search query', 'search input', 'search button',
    '搜索', '搜尋', '搜寻', '查找', '查询', '搜尋內容', '搜索内容', '搜索框', '输入关键词', '请输入关键词']);
const FIELD_IDS = /^(?:query|search|search_(?:input|query|field|text|edit|src_text)|(?:input|edit|et)_search)$/;
const BUTTON_IDS = /^(?:search|(?:open|submit|btn|action|menu)_search|search_(?:open|go|go_btn|submit|button|btn|icon|entry))$/;
const ENTRY_IDS = /^(?:open_search|menu_search|search_open|search_entry)$/;
const SUBMIT_IDS = /^(?:submit_search|search_go|search_go_btn|search_submit)$/;

function searchEvidence(node, field) {
    const sources = [];
    const shortId = node.id.split(':id/')[1];
    if ((field ? FIELD_IDS : BUTTON_IDS).test(shortId)) sources.push('id');
    if (!field && SEARCH_LABELS.has(normalize(node.text))) sources.push('text');
    if (SEARCH_LABELS.has(normalize(node.desc))) sources.push('desc');
    return sources;
}

function candidateSemantics(node, fields) {
    const field = node.role === 'textfield', sources = searchEvidence(node, field);
    const shortId = node.id.split(':id/')[1];
    const hints = new Set();
    if (sources.includes('id')) hints.add(field ? 'query_field' : ENTRY_IDS.test(shortId) ? 'search_entry'
        : SUBMIT_IDS.test(shortId) ? 'search_submit' : 'search');
    if (sources.includes('text') || sources.includes('desc')) hints.add(field ? 'query_field' : 'search');
    const provenGroup = value => Number.isSafeInteger(value) && value > 0;
    const fieldRelation = fields.length === 0 ? 'none' : fields.length !== 1 ? 'ambiguous'
        : !provenGroup(node.parentGroup) || !provenGroup(fields[0].parentGroup) ? 'unproven'
            : node.parentGroup === fields[0].parentGroup ? 'same_parent' : 'other_parent';
    return Object.freeze({ role: ROLES.includes(node.role) ? node.role : 'other',
        hints: Object.freeze(HINTS.filter(hint => hints.has(hint))), fieldRelation });
}

const { questionKey } = require('./androidTaskDecision');

module.exports = { SEMANTICS_VERSION, FEEDBACK_VERSION, ROLES, HINTS, FIELD_RELATIONS, FEEDBACK_EVENTS,
    MAX_RECENT_ACTIONS, searchEvidence, candidateSemantics, questionKey };
