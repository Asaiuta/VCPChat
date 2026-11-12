import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { jevServiceSection } from '../modules/settings/schema/jev-service.js';
import { renderSchemaSection } from '../modules/settings/render/field-renderer.js';
test('Jev retry delay accepts default and documented integer interval', () => {
    const doc = new JSDOM('<form></form>').window.document;
    globalThis.document = doc;
    doc.querySelector('form').append(...renderSchemaSection(jevServiceSection, doc));
    const input = doc.getElementById('jevRetryBaseDelayMs');
    for (const value of ['500', '1', '499', '30000']) { input.value = value; assert.equal(input.checkValidity(), true, value); }
    for (const value of ['0', '30001', '1.5']) { input.value = value; assert.equal(input.checkValidity(), false, value); }
});
