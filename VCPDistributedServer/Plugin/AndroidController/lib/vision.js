'use strict';

/**
 * 视觉通道：把屏幕像素送到模型眼前。
 *
 * 自绘引擎（Unity / Cocos / GL 地图 / 视频流）的内容只存在于像素里，
 * uiautomator 拿到的全是空壳节点。这条路是它们唯一的可操作通道。
 *
 * 三个必须钉死的契约：
 *
 * 1) **坐标换算必须显式给出**。截图通常被缩小过（1440 宽的屏 → 1080 的图），
 *    模型看着图说「点 (540,800)」，那是图上的位置，不是设备上的位置。
 *    差 1.33 倍就点飞。所以每帧都附带 mapping，且给出可直接套用的换算式。
 *
 * 2) **网格标注的是设备坐标**，不是图上坐标。这样模型读到的数字可以直接
 *    拿去点，不用做乘法 —— 少一步运算就少一类错。
 *
 * 3) **裁剪必须精确**。裁剪区域用的是设备坐标，和 ui-graph 给出的
 *    canvas.bounds / control.bounds 同一套坐标系，不需要中间转换。
 */

const DEFAULT_MAX_WIDTH = 1080;
const DEFAULT_QUALITY = 82;
/** 小区域放大上限：按钮级目标放大 2.5 倍就够看清，再大只是浪费 token。 */
const MAX_ZOOM = 2.5;
/** 网格目标格数：一轴切 4–8 格最好读，太少没法定位，太密盖住内容。 */
const GRID_TARGET_DIVISIONS = 6;
/** 网格步长候选（设备像素）。都是常见分辨率下的整数约数。 */
const GRID_STEPS = [50, 100, 120, 150, 200, 240, 300, 360, 400, 480, 540, 600, 720, 800, 900, 1080];

function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

/**
 * 裁剪区域收敛到屏幕内。接受 {left,top,width,height} 或 {x,y,width,height}。
 * 越界一律夹紧 —— 宁可裁小一点，也不要让 sharp 直接抛错。
 */
function normalizeRegion(region, screen) {
    const sw = screen && screen.width > 0 ? Math.round(screen.width) : 0;
    const sh = screen && screen.height > 0 ? Math.round(screen.height) : 0;
    if (!sw || !sh) throw new Error('缺少屏幕尺寸，无法计算裁剪区域。');

    if (!region) return { left: 0, top: 0, width: sw, height: sh };

    // 显式给了非正尺寸就是调用方的错，不能默默夹成 1 —— 那会生成一张
    // 1×1 的图，模型对着它一无所措，排查还得多绕一圈。
    if (region.width !== undefined && !(Number(region.width) > 0)) {
        throw new Error(`裁剪区域无效：width=${region.width}`);
    }
    if (region.height !== undefined && !(Number(region.height) > 0)) {
        throw new Error(`裁剪区域无效：height=${region.height}`);
    }

    const rawLeft = clampInt(region.left ?? region.x, 0, -Infinity, Infinity);
    const rawTop = clampInt(region.top ?? region.y, 0, -Infinity, Infinity);
    const right = clampInt(rawLeft + clampInt(region.width, sw - rawLeft, 1, Infinity), sw, 0, sw);
    const bottom = clampInt(rawTop + clampInt(region.height, sh - rawTop, 1, Infinity), sh, 0, sh);
    const left = clampInt(rawLeft, 0, 0, sw);
    const top = clampInt(rawTop, 0, 0, sh);
    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) {
        throw new Error(`裁剪区域无效：${JSON.stringify(region)}（屏幕 ${sw}×${sh}）`);
    }
    return { left, top, width, height };
}

/**
 * 建立映射。stepX/stepY 是「图上一个像素 = 设备多少像素」，
 * offset 是裁剪区域在设备上的原点。
 */
function buildMapping({ screen, region, imageWidth, imageHeight }) {
    return {
        screen: { width: screen.width, height: screen.height },
        region: { ...region },
        imageWidth,
        imageHeight,
        stepX: region.width / imageWidth,
        stepY: region.height / imageHeight,
        offsetX: region.left,
        offsetY: region.top,
    };
}

/** 图上坐标 → 设备坐标 */
function imagePointToDevice(mapping, x, y) {
    return {
        x: Math.round(mapping.offsetX + Number(x) * mapping.stepX),
        y: Math.round(mapping.offsetY + Number(y) * mapping.stepY),
    };
}

/** 设备坐标 → 图上坐标（网格绘制与校验用） */
function devicePointToImage(mapping, x, y) {
    return {
        x: (Number(x) - mapping.offsetX) / mapping.stepX,
        y: (Number(y) - mapping.offsetY) / mapping.stepY,
    };
}

/**
 * 给模型看的换算说明。
 * 写成人话而不是丢一个 JSON —— 模型对「设备X = 图上X × 1.333」这种句式
 * 的遵循率明显高于自己去解析结构体再做算术。
 */
function describeMapping(mapping) {
    const { region, screen, imageWidth, imageHeight, stepX, stepY } = mapping;
    const regionRight = region.left + region.width;
    const regionBottom = region.top + region.height;
    const full = region.left === 0 && region.top === 0
        && region.width === screen.width && region.height === screen.height;

    const lines = [];
    // 「放大 / 缩小」必须指对方向：模型会照这句话判断细节是否可信。
    // 写反了它就会以为 1080 宽的图比 1440 的源图更精细。
    const scale = imageWidth / region.width;
    const scaleText = Math.abs(scale - 1) < 0.01
        ? '原尺寸'
        : scale > 1
            ? `已放大 ${scale.toFixed(2)}×`
            : `已缩小到 ${scale.toFixed(2)}×`;

    // 整屏也要报缩放：1440→1080 同样是缩小，不写出来模型就不知道细节丢了多少。
    lines.push(full
        ? `图像 ${imageWidth}×${imageHeight}，对应整个屏幕 ${screen.width}×${screen.height}（${scaleText}）`
        : `图像 ${imageWidth}×${imageHeight}，对应屏幕区域 (${region.left},${region.top})-(${regionRight},${regionBottom})`
          + `，原区域 ${region.width}×${region.height}（${scaleText}）`);
    lines.push(`坐标换算：设备X = ${region.left} + 图上X × ${stepX.toFixed(3)}，`
        + `设备Y = ${region.top} + 图上Y × ${stepY.toFixed(3)}`);
    lines.push('图上网格线标注的已经是设备坐标，直接读数字用即可。');
    return lines.join('\n');
}

/** 选一个让该轴落在 4–8 格的步长。 */
function pickStep(spanPx, target = GRID_TARGET_DIVISIONS) {
    for (const step of GRID_STEPS) {
        if (spanPx / step <= target) return step;
    }
    return GRID_STEPS[GRID_STEPS.length - 1];
}

/**
 * 网格叠加层缓存。
 *
 * 实测：直接 composite SVG 每帧要 73–103ms（librsvg 要重新光栅化整个
 * 1080×2376 画布），而 composite 一张已经光栅化好的 PNG 只要 41–51ms。
 * 同一尺寸的截图会反复出现（同一台设备、同一套参数），所以按几何键缓存。
 *
 * 只存 Buffer，不存 sharp 实例 —— 后者持有原生内存句柄，缓存多份容易泄漏。
 * 上限 4 份：实际只会命中「整屏」与「画布」两种，留点余量给临时裁剪。
 */
const GRID_OVERLAY_CACHE = new Map();
const GRID_OVERLAY_CACHE_LIMIT = 4;

function gridOverlayKey(mapping) {
    const { imageWidth, imageHeight, region } = mapping;
    return `${imageWidth}x${imageHeight}:${region.left},${region.top},${region.width},${region.height}`;
}

async function getGridOverlay(sharp, mapping) {
    const key = gridOverlayKey(mapping);
    const hit = GRID_OVERLAY_CACHE.get(key);
    if (hit) {
        // 命中就移到队尾，保持近似 LRU
        GRID_OVERLAY_CACHE.delete(key);
        GRID_OVERLAY_CACHE.set(key, hit);
        return hit;
    }

    const svg = Buffer.from(buildGridSvg(mapping));
    const overlay = await sharp({
        create: {
            width: mapping.imageWidth,
            height: mapping.imageHeight,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    }).composite([{ input: svg, top: 0, left: 0 }]).png({ compressionLevel: 1 }).toBuffer();

    GRID_OVERLAY_CACHE.set(key, overlay);
    while (GRID_OVERLAY_CACHE.size > GRID_OVERLAY_CACHE_LIMIT) {
        GRID_OVERLAY_CACHE.delete(GRID_OVERLAY_CACHE.keys().next().value);
    }
    return overlay;
}

/** 清空缓存（测试用；也供配置变更时避免拿到旧尺寸的叠加层）。 */
function clearGridOverlayCache() {
    GRID_OVERLAY_CACHE.clear();
}

function escapeXmlText(value) {
    return String(value).replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]
    ));
}

/**
 * 生成网格 SVG。格线位置按**设备坐标**的整数倍取，文字标的就是设备坐标。
 * 文字描边用「先画黑描边、再画填充」两遍，不依赖 paint-order 支持情况。
 */
function buildGridSvg(mapping) {
    const { region, imageWidth, imageHeight } = mapping;
    const stepX = pickStep(region.width);
    const stepY = pickStep(region.height);
    const fontSize = Math.max(11, Math.min(20, Math.round(Math.min(imageWidth, imageHeight) / 45)));
    const pad = Math.round(fontSize * 0.35);

    const vertical = [];   // 设备 x 上的竖线
    const firstX = Math.ceil(region.left / stepX) * stepX;
    for (let deviceX = firstX; deviceX <= region.left + region.width; deviceX += stepX) {
        const imgX = devicePointToImage(mapping, deviceX, 0).x;
        if (imgX < 1 || imgX > imageWidth - 1) continue;
        vertical.push({ imgX, deviceX });
    }

    const horizontal = [];
    const firstY = Math.ceil(region.top / stepY) * stepY;
    for (let deviceY = firstY; deviceY <= region.top + region.height; deviceY += stepY) {
        const imgY = devicePointToImage(mapping, 0, deviceY).y;
        if (imgY < 1 || imgY > imageHeight - 1) continue;
        horizontal.push({ imgY, deviceY });
    }

    const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidth}" height="${imageHeight}">`];

    for (const { imgX } of vertical) {
        parts.push(`<line x1="${imgX.toFixed(1)}" y1="0" x2="${imgX.toFixed(1)}" y2="${imageHeight}" `
            + 'stroke="#00e5ff" stroke-width="1" stroke-opacity="0.55"/>');
    }
    for (const { imgY } of horizontal) {
        parts.push(`<line x1="0" y1="${imgY.toFixed(1)}" x2="${imageWidth}" y2="${imgY.toFixed(1)}" `
            + 'stroke="#00e5ff" stroke-width="1" stroke-opacity="0.55"/>');
    }

    // 标签：竖线标 x 值（顶部），横线标 y 值（左侧）
    const label = (x, y, text, anchor) => {
        const safe = escapeXmlText(text);
        const stroke = `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="sans-serif" `
            + `font-size="${fontSize}" fill="none" stroke="#000" stroke-width="3" `
            + `text-anchor="${anchor}" stroke-linejoin="round">${safe}</text>`;
        const fill = `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="sans-serif" `
            + `font-size="${fontSize}" fill="#ffe100" text-anchor="${anchor}">${safe}</text>`;
        parts.push(stroke, fill);
    };

    for (const { imgX, deviceX } of vertical) {
        label(imgX + pad, fontSize + pad, `x=${deviceX}`, 'start');
    }
    for (const { imgY, deviceY } of horizontal) {
        label(pad, imgY - pad, `y=${deviceY}`, 'start');
    }

    parts.push('</svg>');
    return parts.join('');
}

/**
 * 截一帧并做成「可直接喂给模型」的图。
 *
 * @param {object} options
 * @param {Function} options.sharp    sharp 构造函数
 * @param {{buffer:Buffer,mime:string,width:number,height:number}} options.frame 原始截图
 * @param {{width:number,height:number}} options.screen 设备分辨率
 * @param {{left:number,top:number,width:number,height:number}} [options.region] 设备坐标下的裁剪区
 * @param {number} [options.maxWidth]  输出图宽上限
 * @param {'jpeg'|'png'} [options.format]
 * @param {number} [options.quality]
 * @param {boolean} [options.grid]     是否叠加坐标网格（默认开）
 */
async function buildVisionFrame(options = {}) {
    const sharp = options.sharp;
    if (typeof sharp !== 'function') throw new Error('缺少 sharp 依赖，视觉通道不可用。');
    const frame = options.frame;
    const hasRaw = Boolean(frame && frame.raw && Buffer.isBuffer(frame.raw.data));
    if (!frame || (!hasRaw && !Buffer.isBuffer(frame.buffer))) throw new Error('没有可用的截图帧。');
    const screen = options.screen;
    // 下限 64：裁剪按钮级目标时，调用方可能只要一张小图。
    // 卡在 240 会把「我要 200 宽」强行撑成 240，换算倍率也跟着错。
    const maxWidth = clampInt(options.maxWidth, DEFAULT_MAX_WIDTH, 64, 4320);
    const format = options.format === 'png' ? 'png' : 'jpeg';
    const quality = clampInt(options.quality, DEFAULT_QUALITY, 10, 95);
    const wantGrid = options.grid !== false;

    const region = normalizeRegion(options.region, screen);

    // 帧可能已被采集端缩过；把裁剪区换算到帧坐标系。
    // 正常路径下采集端按原生分辨率出帧，这两个系数就是 1。
    let frameW;
    let frameH;
    let source;
    if (hasRaw) {
        // raw 像素路径：尺寸已知，省一次 metadata 读取与解码。
        frameW = frame.raw.width;
        frameH = frame.raw.height;
        source = sharp(frame.raw.data, {
            raw: { width: frameW, height: frameH, channels: frame.raw.channels || 4 },
        });
    } else {
        const meta = await sharp(frame.buffer).metadata();
        frameW = meta.width || frame.width;
        frameH = meta.height || frame.height;
        source = sharp(frame.buffer, { failOn: 'none' });
    }
    if (!frameW || !frameH) throw new Error('无法读取截图尺寸。');
    const fx = frameW / screen.width;
    const fy = frameH / screen.height;

    const extractLeft = clampInt(Math.round(region.left * fx), 0, 0, frameW - 1);
    const extractTop = clampInt(Math.round(region.top * fy), 0, 0, frameH - 1);
    const extractWidth = clampInt(Math.round(region.width * fx), frameW - extractLeft, 1, frameW - extractLeft);
    const extractHeight = clampInt(Math.round(region.height * fy), frameH - extractTop, 1, frameH - extractTop);

    // 缩放决策：大区域缩小到 maxWidth；小区域放大到能看清，但不超过 MAX_ZOOM。
    let scale;
    if (region.width > maxWidth) {
        scale = maxWidth / region.width;
    } else {
        scale = Math.min(MAX_ZOOM, maxWidth / region.width);
    }
    const imageWidth = Math.max(1, Math.round(region.width * scale));
    const imageHeight = Math.max(1, Math.round(region.height * scale));

    // 尺寸算准了才建 mapping —— 网格标注依赖它。
    const mapping = buildMapping({ screen, region, imageWidth, imageHeight });

    let pipeline = source
        .extract({ left: extractLeft, top: extractTop, width: extractWidth, height: extractHeight })
        .resize({ width: imageWidth, height: imageHeight, fit: 'fill', kernel: 'lanczos3' })
        .removeAlpha();

    if (wantGrid) {
        const overlay = await getGridOverlay(sharp, mapping);
        pipeline = pipeline.composite([{ input: overlay, top: 0, left: 0 }]);
    }

    const buffer = format === 'png'
        ? await pipeline.png({ compressionLevel: 6 }).toBuffer()
        : await pipeline.jpeg({ quality, mozjpeg: false }).toBuffer();

    if (!buffer || buffer.length < 64) throw new Error('视觉帧编码结果为空。');

    return {
        buffer,
        mime: format === 'png' ? 'image/png' : 'image/jpeg',
        width: imageWidth,
        height: imageHeight,
        byteLength: buffer.length,
        grid: wantGrid,
        mapping,
        dataUrl: `data:${format === 'png' ? 'image/png' : 'image/jpeg'};base64,${buffer.toString('base64')}`,
    };
}

module.exports = {
    DEFAULT_MAX_WIDTH,
    DEFAULT_QUALITY,
    GRID_STEPS,
    MAX_ZOOM,
    buildGridSvg,
    buildMapping,
    clearGridOverlayCache,
    getGridOverlay,
    buildVisionFrame,
    describeMapping,
    devicePointToImage,
    imagePointToDevice,
    normalizeRegion,
    pickStep,
};
