'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeRegion } = require('../VCPDistributedServer/Plugin/AndroidController/lib/vision');

const screen = { width: 1000, height: 2000 };

for (const [name, region, expected] of [
    ['left', { left: -100, top: 0, width: 200, height: 100 }, { left: 0, top: 0, width: 100, height: 100 }],
    ['top', { left: 0, top: -100, width: 100, height: 200 }, { left: 0, top: 0, width: 100, height: 100 }],
    ['right', { left: 900, top: 0, width: 200, height: 100 }, { left: 900, top: 0, width: 100, height: 100 }],
    ['bottom', { left: 0, top: 1900, width: 100, height: 200 }, { left: 0, top: 1900, width: 100, height: 100 }],
    ['all edges', { left: -100, top: -100, width: 1200, height: 2200 }, { left: 0, top: 0, width: 1000, height: 2000 }],
    ['x/y aliases', { x: -100, y: -100, width: 200, height: 200 }, { left: 0, top: 0, width: 100, height: 100 }],
]) {
    test(`vision region: ${name} clips the original endpoints without translating`, () => {
        assert.deepEqual(normalizeRegion(region, screen), expected);
    });
}

for (const [name, left, top] of [
    ['outside left', -201, 0],
    ['outside top', 0, -201],
    ['outside right', 1001, 0],
    ['outside bottom', 0, 2001],
    ['touch left', -200, 0],
    ['touch top', 0, -200],
    ['touch right', 1000, 0],
    ['touch bottom', 0, 2000],
]) {
    test(`vision region: ${name} rejects an empty intersection explicitly`, () => {
        assert.throws(() => normalizeRegion({ left, top, width: 200, height: 200 }, screen), /裁剪区域无效/);
    });
}

for (const [name, region, expected] of [
    ['valid rectangle', { left: 100, top: 200, width: 300, height: 400 }, { left: 100, top: 200, width: 300, height: 400 }],
    ['full screen', null, { left: 0, top: 0, width: 1000, height: 2000 }],
    ['default dimensions', { left: 100, top: 200 }, { left: 100, top: 200, width: 900, height: 1800 }],
    ['numeric strings', { x: '100', y: '200', width: '300', height: '400' }, { left: 100, top: 200, width: 300, height: 400 }],
]) {
    test(`vision region: ${name} keeps existing behavior`, () => {
        assert.deepEqual(normalizeRegion(region, screen), expected);
    });
}

for (const region of [
    { width: 0, height: 100 },
    { width: 100, height: 0 },
    { width: -1, height: 100 },
    { width: 100, height: -1 },
]) {
    test(`vision region: nonpositive dimensions ${JSON.stringify(region)} are rejected`, () => {
        assert.throws(() => normalizeRegion(region, screen), /裁剪区域无效/);
    });
}
