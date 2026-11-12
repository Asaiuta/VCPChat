'use strict';

/**
 * Minimal QR Code encoder (ISO/IEC 18004): byte mode, ECC level M, versions 1-10.
 * Enough for `WIFI:T:ADB;S:<name>;P:<password>;;` pairing payloads (<= 213 bytes).
 * Output is an SVG string; no runtime dependency, no canvas.
 */

const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const MAX_VERSION = 10;

function rawModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
        const align = Math.floor(ver / 7) + 2;
        result -= (25 * align - 10) * align - 55;
        if (ver >= 7) result -= 36;
    }
    return result;
}

const dataCodewords = (ver) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
}

function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < degree; j++) {
            result[j] = gfMul(result[j], root);
            if (j + 1 < degree) result[j] ^= result[j + 1];
        }
        root = gfMul(root, 2);
    }
    return result;
}

function rsRemainder(data, divisor) {
    const result = new Array(divisor.length).fill(0);
    for (const byte of data) {
        const factor = byte ^ result.shift();
        result.push(0);
        divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
    }
    return result;
}

function encodeData(bytes, ver) {
    const bits = [];
    const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    push(0b0100, 4);
    push(bytes.length, ver <= 9 ? 8 : 16);
    for (const byte of bytes) push(byte, 8);
    const capacity = dataCodewords(ver) * 8;
    push(0, Math.min(4, capacity - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
    return out;
}

function interleave(data, ver) {
    const numBlocks = BLOCKS[ver];
    const eccLen = ECC_PER_BLOCK[ver];
    const raw = Math.floor(rawModules(ver) / 8);
    const numShort = numBlocks - (raw % numBlocks);
    const shortLen = Math.floor(raw / numBlocks);
    const divisor = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
        const block = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
        k += block.length;
        const ecc = rsRemainder(block, divisor);
        if (i < numShort) block.push(0);
        blocks.push(block.concat(ecc));
    }
    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
        blocks.forEach((block, j) => {
            if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]);
        });
    }
    return result;
}

function buildMatrix(codewords, ver, mask) {
    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { modules[y][x] = dark; fixed[y][x] = true; };

    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
            const x = cx + dx;
            const y = cy + dy;
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
        }
    }
    const align = ALIGN[ver];
    const last = align.length - 1;
    align.forEach((ax, i) => align.forEach((ay, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
    }));

    // Format bits: ECC M = 0b00.
    const data = mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const format = ((data << 10) | rem) ^ 0x5412;
    const bit = (value, i) => ((value >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(format, i));
    set(8, 7, bit(format, 6));
    set(8, 8, bit(format, 7));
    set(7, 8, bit(format, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(format, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(format, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(format, i));
    set(8, size - 8, true);

    if (ver >= 7) {
        let vrem = ver;
        for (let i = 0; i < 12; i++) vrem = (vrem << 1) ^ ((vrem >>> 11) * 0x1f25);
        const vbits = (ver << 12) | vrem;
        for (let i = 0; i < 18; i++) {
            const a = size - 11 + (i % 3);
            const b = Math.floor(i / 3);
            set(a, b, bit(vbits, i));
            set(b, a, bit(vbits, i));
        }
    }

    let index = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
                if (fixed[y][x] || index >= codewords.length * 8) continue;
                modules[y][x] = bit(codewords[index >>> 3], 7 - (index & 7));
                index++;
            }
        }
    }

    const masks = [
        (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
        (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
        (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
    ];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (!fixed[y][x] && masks[mask](x, y)) modules[y][x] = !modules[y][x];
    }
    return modules;
}

/** Penalty rules N1, N2, N4 (N3 omitted: only affects scan robustness, never validity). */
function penalty(modules) {
    const size = modules.length;
    let score = 0;
    for (let pass = 0; pass < 2; pass++) {
        for (let a = 0; a < size; a++) {
            let run = 1;
            for (let b = 1; b < size; b++) {
                const cur = pass ? modules[b][a] : modules[a][b];
                const prev = pass ? modules[b - 1][a] : modules[a][b - 1];
                if (cur === prev) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1;
            }
        }
    }
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (modules[y][x]) dark++;
        if (x < size - 1 && y < size - 1) {
            const c = modules[y][x];
            if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
        }
    }
    const total = size * size;
    score += Math.ceil(Math.abs(dark * 20 - total * 10) / total - 1) * 10;
    return score;
}

function encodeQr(text) {
    const bytes = [...Buffer.from(String(text), 'utf8')];
    let ver = 1;
    while (ver <= MAX_VERSION && 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver++;
    if (ver > MAX_VERSION) throw new RangeError('QR payload too long');
    const codewords = interleave(encodeData(bytes, ver), ver);
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
        const modules = buildMatrix(codewords, ver, mask);
        const score = penalty(modules);
        if (!best || score < best.score) best = { modules, score, mask };
    }
    return { version: ver, mask: best.mask, modules: best.modules };
}

function qrSvg(text, { quiet = 4, scale = 6 } = {}) {
    const { modules } = encodeQr(text);
    const size = modules.length + quiet * 2;
    let path = '';
    modules.forEach((row, y) => row.forEach((dark, x) => {
        if (dark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * scale}" height="${size * scale}" shape-rendering="crispEdges">`
        + `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

module.exports = { encodeQr, qrSvg };
