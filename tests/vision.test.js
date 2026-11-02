'use strict';

/**
 * 视觉通道（vision）契约测试。
 *
 * 每条 test 对应一条对模型可见的行为契约。核心是**坐标换算**——
 * 图上看走眼是小事，算错倍率把点击落到隔壁按钮才是灾难。
 *
 * 裁剪/缩放的正确性用「独立参考实现」校验：同一条 sharp 管线换一条写路径，
 * 逐字节比对。这样不依赖肉眼，也不必真机。
 */

const assert = require('assert/strict');
const test = require('node:test');

const vision = require('../VCPDistributedServer/Plugin/AndroidController/lib/vision');

let sharp = null;
try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    sharp = require('sharp');
} catch {
    sharp = null;
}

const skipNoSharp = sharp ? false : '缺少 sharp 依赖';

/** 造一张左上/右下颜色不同的合成图，用来验证裁剪没有错位。 */
async function makeQuadrantImage(width, height) {
    const w = Math.floor(width / 2);
    const h = Math.floor(height / 2);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect x="0" y="0" width="${w}" height="${h}" fill="#ff0000"/>
      <rect x="${w}" y="0" width="${width - w}" height="${h}" fill="#00ff00"/>
      <rect x="0" y="${h}" width="${w}" height="${height - h}" fill="#0000ff"/>
      <rect x="${w}" y="${h}" width="${width - w}" height="${height - h}" fill="#ffffff"/>
    </svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
}

/** 取图像某点的 RGB。 */
async function pixelAt(buffer, x, y) {
    const { data, info } = await sharp(buffer).removeAlpha().raw()
        .toBuffer({ resolveWithObject: true });
    const idx = (y * info.width + x) * info.channels;
    return { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
}

// ---------------------------------------------------------------------------
// 坐标换算
// ---------------------------------------------------------------------------

test('vision: 图上坐标与设备坐标可以无损往返', () => {
    const mapping = vision.buildMapping({
        screen: { width: 1440, height: 3168 },
        region: { left: 0, top: 0, width: 1440, height: 3168 },
        imageWidth: 1080,
        imageHeight: 2376,
    });

    assert.equal(mapping.stepX, 1440 / 1080);
    assert.equal(mapping.stepY, 3168 / 2376);

    for (const [imgX, imgY] of [[0, 0], [540, 1188], [1079, 2375], [12, 2000]]) {
        const device = vision.imagePointToDevice(mapping, imgX, imgY);
        const back = vision.devicePointToImage(mapping, device.x, device.y);
        assert.ok(Math.abs(back.x - imgX) < 0.6, `x 往返漂移过大：${imgX} -> ${device.x} -> ${back.x}`);
        assert.ok(Math.abs(back.y - imgY) < 0.6, `y 往返漂移过大：${imgY} -> ${device.y} -> ${back.y}`);
    }
});

test('vision: 裁剪+放大后换算仍以设备原点为基准', () => {
    // 裁出设备坐标 (400,900)-(1000,1500)，放大 2 倍
    const mapping = vision.buildMapping({
        screen: { width: 1440, height: 3168 },
        region: { left: 400, top: 900, width: 600, height: 600 },
        imageWidth: 1200,
        imageHeight: 1200,
    });

    // 放大 2 倍 → 图上 1 像素 = 设备 0.5 像素
    assert.equal(mapping.stepX, 0.5);
    assert.equal(mapping.stepY, 0.5);

    // 图左上角必须落在裁剪区左上角
    assert.deepEqual(vision.imagePointToDevice(mapping, 0, 0), { x: 400, y: 900 });
    // 图正中 → 裁剪区中心
    assert.deepEqual(vision.imagePointToDevice(mapping, 600, 600), { x: 700, y: 1200 });
    // 图右下角 → 裁剪区右下角
    assert.deepEqual(vision.imagePointToDevice(mapping, 1200, 1200), { x: 1000, y: 1500 });
});

test('vision: 换算说明把倍率写成可套用的式子，不留歧义', () => {
    const mapping = vision.buildMapping({
        screen: { width: 1440, height: 3168 },
        region: { left: 0, top: 0, width: 1440, height: 3168 },
        imageWidth: 1080,
        imageHeight: 2376,
    });
    const text = vision.describeMapping(mapping);

    assert.ok(text.includes('图像 1080×2376'), '必须说明图像尺寸');
    assert.ok(text.includes('1440×3168'), '必须说明设备尺寸');
    assert.ok(text.includes('设备X = 0 + 图上X × 1.333'), `换算式缺失或倍率错：${text}`);
    assert.ok(text.includes('设备坐标'), '必须提醒网格标注的是设备坐标');

    // 裁剪场景要标出原点，否则模型会把图上 0 当成设备 0
    const cropped = vision.describeMapping(vision.buildMapping({
        screen: { width: 1440, height: 3168 },
        region: { left: 400, top: 900, width: 600, height: 600 },
        imageWidth: 1200,
        imageHeight: 1200,
    }));
    assert.ok(cropped.includes('(400,900)'), `裁剪原点未标出：${cropped}`);
    assert.ok(cropped.includes('已放大 2.00×'), `放大方向写错：${cropped}`);

    // 缩小场景必须说缩小 —— 说反了模型会以为图比源图更精细。
    const shrunk = vision.describeMapping(vision.buildMapping({
        screen: { width: 1440, height: 3168 },
        region: { left: 0, top: 0, width: 1440, height: 2908 },
        imageWidth: 1080,
        imageHeight: 2181,
    }));
    assert.ok(shrunk.includes('已缩小到 0.75×'), `缩小方向写错：${shrunk}`);
    assert.ok(!shrunk.includes('已放大'), '缩小不得说成放大');

    // 原尺寸场景不应出现方向词
    const same = vision.describeMapping(vision.buildMapping({
        screen: { width: 400, height: 400 },
        region: { left: 0, top: 0, width: 400, height: 400 },
        imageWidth: 400,
        imageHeight: 400,
    }));
    assert.ok(same.includes('原尺寸'), `原尺寸措辞缺失：${same}`);
});

// ---------------------------------------------------------------------------
// 网格
// ---------------------------------------------------------------------------

test('vision: 网格步长让每轴落在 4-8 格，且标签是设备坐标', () => {
    // 契约是「每轴 4-8 格」，不是某个具体步长值：
    // 写死步长会把候选表顺序当成对外契约，调表就得改测试。
    for (const span of [3168, 1440, 800, 1200]) {
        const divisions = span / vision.pickStep(span);
        assert.ok(divisions >= 4 && divisions <= 8,
            `跨度 ${span} 切出了 ${divisions.toFixed(1)} 格，超出 4-8 的可读范围`);
    }
    // 很小的区域也要有格线（不能因跨度小就直接不画）
    assert.ok(vision.pickStep(300) >= 50);

    const mapping = vision.buildMapping({
        screen: { width: 1440, height: 3168 },
        region: { left: 0, top: 0, width: 1440, height: 3168 },
        imageWidth: 1080,
        imageHeight: 2376,
    });
    const svg = vision.buildGridSvg(mapping);

    assert.ok(svg.includes('<svg'), '必须产出合法 SVG');

    // 标签必须是设备坐标：对每条线上标注的数字，都应等于「图上位置 × 倍率」，
    // 也就是设备坐标中落在选定步长倍数上的值。
    const stepX = vision.pickStep(1440);
    const stepY = vision.pickStep(3168);
    const xLabels = [...svg.matchAll(/x=(\d+)/g)].map((m) => Number(m[1]));
    const yLabels = [...svg.matchAll(/y=(\d+)/g)].map((m) => Number(m[1]));

    assert.ok(xLabels.length > 0, '缺少竖线设备坐标标签');
    assert.ok(yLabels.length > 0, '缺少横线设备坐标标签');
    for (const x of xLabels) assert.equal(x % stepX, 0, `x 标签 ${x} 不是步长 ${stepX} 的倍数`);
    for (const y of yLabels) assert.equal(y % stepY, 0, `y 标签 ${y} 不是步长 ${stepY} 的倍数`);
    // 图宽 1080 时，图上像素值永远不会超过 1080；真实设备坐标必须能超过它，
    // 以此区分「标的是设备坐标」还是「标的只是图上像素」。
    assert.ok(yLabels.some((y) => y > 1080), '标签疑似标的是图上像素而非设备坐标');
});

// ---------------------------------------------------------------------------
// 裁剪正确性（用独立参考实现比对）
// ---------------------------------------------------------------------------

test('vision: 裁剪区域对应设备坐标，不与参考实现错位', { skip: skipNoSharp }, async () => {
    const deviceW = 400;
    const deviceH = 800;
    const source = await makeQuadrantImage(deviceW, deviceH);

    // 裁右下角 200×400：应当整块是白色
    const out = await vision.buildVisionFrame({
        sharp,
        frame: { buffer: source, width: deviceW, height: deviceH },
        screen: { width: deviceW, height: deviceH },
        region: { left: 200, top: 400, width: 200, height: 400 },
        maxWidth: 200,
        format: 'png',
        grid: false,
    });

    assert.equal(out.width, 200);
    assert.equal(out.height, 400);
    const center = await pixelAt(out.buffer, 100, 200);
    assert.deepEqual(center, { r: 255, g: 255, b: 255 }, '裁右下角必须得到白色象限');

    // 裁左上角：应当整块是红色
    const tl = await vision.buildVisionFrame({
        sharp,
        frame: { buffer: source, width: deviceW, height: deviceH },
        screen: { width: deviceW, height: deviceH },
        region: { left: 0, top: 0, width: 200, height: 400 },
        maxWidth: 200,
        format: 'png',
        grid: false,
    });
    const tlCenter = await pixelAt(tl.buffer, 100, 200);
    assert.deepEqual(tlCenter, { r: 255, g: 0, b: 0 }, '裁左上角必须得到红色象限');
});

test('vision: 关掉网格时与独立 sharp 管线逐字节一致', { skip: skipNoSharp }, async () => {
    const deviceW = 360;
    const deviceH = 640;
    const source = await makeQuadrantImage(deviceW, deviceH);
    const region = { left: 20, top: 40, width: 300, height: 500 };

    const out = await vision.buildVisionFrame({
        sharp,
        frame: { buffer: source, width: deviceW, height: deviceH },
        screen: { width: deviceW, height: deviceH },
        region,
        maxWidth: 150,
        format: 'jpeg',
        quality: 80,
        grid: false,
    });

    // 参考实现：走完全独立的一条 sharp 调用链
    const expected = await sharp(source)
        .extract({ left: 20, top: 40, width: 300, height: 500 })
        .resize({ width: 150, height: 250, fit: 'fill', kernel: 'lanczos3' })
        .removeAlpha()
        .jpeg({ quality: 80, mozjpeg: false })
        .toBuffer();

    assert.ok(Buffer.compare(out.buffer, expected) === 0, '裁剪+缩放结果与参考实现不一致');
});

// ---------------------------------------------------------------------------
// 尺寸策略
// ---------------------------------------------------------------------------

test('vision: 大区域缩小到上限，小区域放大但有上限', { skip: skipNoSharp }, async () => {
    const big = await makeQuadrantImage(1440, 3168);
    const full = await vision.buildVisionFrame({
        sharp,
        frame: { buffer: big, width: 1440, height: 3168 },
        screen: { width: 1440, height: 3168 },
        maxWidth: 1080,
        format: 'jpeg',
        grid: false,
    });
    assert.equal(full.width, 1080, '整屏截图必须缩到 maxWidth');
    assert.equal(full.height, Math.round(3168 * (1080 / 1440)));

    // 小区域（120×120）应当放大，而不是原样输出
    const small = await vision.buildVisionFrame({
        sharp,
        frame: { buffer: big, width: 1440, height: 3168 },
        screen: { width: 1440, height: 3168 },
        region: { left: 100, top: 100, width: 120, height: 120 },
        maxWidth: 1080,
        format: 'jpeg',
        grid: false,
    });
    assert.equal(small.width, 300, '小区域应放大到 2.5 倍上限');
    assert.equal(small.height, 300);

    // 但放大不得超过 MAX_ZOOM，避免 token 爆炸
    assert.ok(small.width / 120 <= vision.MAX_ZOOM + 1e-9);
});

test('vision: 越界裁剪被夹紧，非法输入直接失败', { skip: skipNoSharp }, async () => {
    const source = await makeQuadrantImage(400, 800);

    assert.deepEqual(
        vision.normalizeRegion({ left: -50, top: -50, width: 9999, height: 9999 }, { width: 400, height: 800 }),
        { left: 0, top: 0, width: 400, height: 800 },
        '负坐标与超宽必须夹到屏幕内',
    );
    assert.throws(() => vision.normalizeRegion({ left: 0, top: 0, width: 0, height: 0 },
        { width: 400, height: 800 }), /无效/);
    assert.throws(() => vision.normalizeRegion(null, null), /屏幕尺寸/);

    const clamped = await vision.buildVisionFrame({
        sharp,
        frame: { buffer: source, width: 400, height: 800 },
        screen: { width: 400, height: 800 },
        region: { left: 380, top: 780, width: 9999, height: 9999 },
        maxWidth: 200,
        format: 'png',
        grid: false,
    });
    assert.equal(clamped.mapping.region.width, 20, '宽度须被夹到屏幕边界');
    assert.equal(clamped.mapping.region.height, 20);
});

test('vision: 采集端已缩放过的帧仍按设备坐标裁剪', { skip: skipNoSharp }, async () => {
    // 设备 800×1600，但帧只有 400×800（采集端缩了一半）
    const deviceW = 800;
    const deviceH = 1600;
    const full = await makeQuadrantImage(deviceW, deviceH);
    const half = await sharp(full).resize({ width: 400, height: 800 }).png().toBuffer();

    const out = await vision.buildVisionFrame({
        sharp,
        frame: { buffer: half, width: 400, height: 800 },
        screen: { width: deviceW, height: deviceH },
        region: { left: 400, top: 800, width: 400, height: 800 },   // 设备坐标右下角
        maxWidth: 200,
        format: 'png',
        grid: false,
    });

    const center = await pixelAt(out.buffer, 100, 100);
    assert.deepEqual(center, { r: 255, g: 255, b: 255 }, '帧被缩过也必须按设备坐标裁到右下角');
});

test('vision: raw 像素帧与编码帧产出相同结果', { skip: skipNoSharp }, async () => {
    const w = 200;
    const h = 400;
    const png = await makeQuadrantImage(w, h);
    const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    const viaPng = await vision.buildVisionFrame({
        sharp,
        frame: { buffer: png, width: w, height: h },
        screen: { width: w, height: h },
        region: { left: 100, top: 200, width: 100, height: 200 },
        maxWidth: 100,
        format: 'png',
        grid: false,
    });
    const viaRaw = await vision.buildVisionFrame({
        sharp,
        frame: { raw: { data, width: w, height: h, channels: 4 }, width: w, height: h },
        screen: { width: w, height: h },
        region: { left: 100, top: 200, width: 100, height: 200 },
        maxWidth: 100,
        format: 'png',
        grid: false,
    });

    assert.equal(viaRaw.width, viaPng.width);
    assert.equal(viaRaw.height, viaPng.height);
    assert.deepEqual(viaRaw.mapping, viaPng.mapping);
    // 裁右下角：两条路径都应得到白色
    assert.deepEqual(await pixelAt(viaRaw.buffer, 50, 100), { r: 255, g: 255, b: 255 });
    assert.deepEqual(await pixelAt(viaPng.buffer, 50, 100), { r: 255, g: 255, b: 255 });
});

test('vision: 输出带可用的 data URL 与元信息', { skip: skipNoSharp }, async () => {
    const source = await makeQuadrantImage(200, 400);
    const out = await vision.buildVisionFrame({
        sharp,
        frame: { buffer: source, width: 200, height: 400 },
        screen: { width: 200, height: 400 },
        maxWidth: 200,
        format: 'jpeg',
    });

    assert.equal(out.mime, 'image/jpeg');
    assert.ok(out.dataUrl.startsWith('data:image/jpeg;base64,'));
    assert.ok(out.byteLength > 64);
    assert.equal(out.grid, true, '默认应叠网格');
    assert.ok(out.mapping, '必须带映射信息');
    // base64 解码后应与 buffer 一致
    const decoded = Buffer.from(out.dataUrl.split(',')[1], 'base64');
    assert.ok(Buffer.compare(decoded, out.buffer) === 0);
});
