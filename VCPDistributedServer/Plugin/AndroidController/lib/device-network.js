'use strict';

const os = require('node:os');
const ADB_HOST_RE = /^(\d{1,3}(?:\.\d{1,3}){3}|[a-zA-Z0-9.-]+):(\d{1,5})$/;
/**
 * 解析用户输入的 "IP:端口"。无线调试的端口每次都不一样，必须由用户填。
 * 允许只填 IP，此时按 adb 默认的 5555 处理（配对端口仍需用户看手机）。
 */
function parseHostPort(raw, fallbackPort = null) {
    const text = String(raw ?? '').trim();
    if (!text) throw new Error('请填写手机地址，例如 192.168.1.20:37105');

    const bare = text.replace(/^adb\s+(pair|connect)\s+/i, '');
    if (ADB_HOST_RE.test(bare)) {
        const [, host, port] = bare.match(ADB_HOST_RE);
        const portNum = Number(port);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
            throw new Error(`端口不合法：${port}`);
        }
        return { host, port: portNum, address: `${host}:${portNum}` };
    }

    // 只有 IP / 主机名
    if (/^(\d{1,3}(?:\.\d{1,3}){3}|[a-zA-Z0-9.-]+)$/.test(bare)) {
        if (!fallbackPort) throw new Error('请连同端口一起填写，例如 192.168.1.20:37105');
        return { host: bare, port: fallbackPort, address: `${bare}:${fallbackPort}` };
    }

    throw new Error('地址格式不对，应形如 192.168.1.20:37105');
}

/**
 * 配对码校验：必须是 6 位数字（Android 11+ 的固定规则）。
 */
function parsePairCode(raw) {
    const text = String(raw ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(text)) throw new Error('配对码是手机屏幕上显示的 6 位数字');
    return text;
}





/** 无同步子进程；保留真实私网地址，只排除回环、链路本地及已知虚拟接口。 */
function localAddresses() {
    const virtual = /zerotier|tailscale|vethernet|vmware|virtualbox|hyper-v|wsl|docker|vgate|loopback|bluetooth/i;
    const seen = new Set();
    const addresses = [];
    for (const [name, entries] of Object.entries(os.networkInterfaces() || {})) {
        if (virtual.test(name)) continue;
        for (const net of entries || []) {
            if (net.family !== 'IPv4' || net.internal || net.address.startsWith('169.254.') || seen.has(net.address)) continue;
            seen.add(net.address);
            addresses.push({ address: net.address, interface: name });
        }
    }
    return addresses.sort((a, b) => a.interface.localeCompare(b.interface) || a.address.localeCompare(b.address));
}

/**
 * 对目标地址做一次真实 TCP 探测，把「连不上」这个模糊结论拆成具体原因。
 *
 * 三种结果对应完全不同的处置：
 * - ECONNREFUSED：网络通、端口没开 → 无线调试关了，或端口填错
 * - ETIMEDOUT / EHOSTUNREACH：网络层就不通 → 不同 WiFi、手机休眠、防火墙
 * - 连上了：adb 的问题，不是网络的问题
 */
function probePort(host, port, timeoutMs = 2500) {
    const net = require('net');
    return new Promise((resolve) => {
        const started = Date.now();
        const socket = new net.Socket();
        let settled = false;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve({ ...result, elapsedMs: Date.now() - started });
        };

        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish({ kind: 'OPEN' }));
        socket.once('timeout', () => finish({ kind: 'TIMEOUT' }));
        socket.once('error', (error) => finish({ kind: error.code || 'ERROR', error }));
        socket.connect(port, host);
    });
}

async function diagnoseEndpoint(address) {
    const [host, portText] = address.split(':');
    const port = Number(portText);
    const probe = await probePort(host, port);

    if (probe.kind === 'OPEN') {
        return {
            kind: 'PORT_OPEN',
            message: `手机的 ${port} 端口是通的，但 adb 连接失败。`,
            hint: '多半是还没配对。回到第 2 步配对一次再连。',
        };
    }

    if (probe.kind === 'ECONNREFUSED') {
        return {
            kind: 'PORT_CLOSED',
            message: `能找到手机（${host}），但 ${port} 端口没有程序在监听。`,
            hint: '无线调试可能已经关闭，或手机重启过。去手机「开发者选项 → 无线调试」重新打开，然后回到第 2 步重新配对。',
        };
    }

    if (probe.kind === 'TIMEOUT' || probe.kind === 'EHOSTUNREACH' || probe.kind === 'ENETUNREACH') {
        const local = localAddresses()[0]?.address || '本机 IP';
        return {
            kind: 'UNREACHABLE',
            message: `连 ${host} 完全没响应，网络层就不通。`,
            hint: `核对两件事：①手机 Wi-Fi 详情里的 IP 是不是 ${host}（不是的话填成实际那个）`
                + ` ②电脑当前的局域网地址是 ${local}，手机要在同一个网段。`
                + ' 另外确认手机没连到另一个 WiFi，或开着「Wi-Fi 助理」自动切了流量。',
        };
    }

    return {
        kind: probe.kind || 'UNKNOWN',
        message: `探测 ${address} 失败：${probe.error?.message || probe.kind}`,
        hint: '检查地址是否填对，以及手机和电脑是否在同一网络。',
    };
}



/**
 * 列出扫描用的全部网段。
 *
 * 和 localAddresses() 的区别很关键：
 * - localAddresses() 过滤虚拟网卡，用于「告诉用户填哪个 IP」
 * - scanSubnets() 必须包含所有真实网段 —— 手机很可能连着电脑开的移动热点
 *   （192.168.137.x，接口名「本地连接* 2」），这个网段被过滤掉就永远扫不到手机。
 *
 * 只排除：回环、链路本地、纯虚拟专用网（ZeroTier/Tailscale/vgate）。
 */
function scanSubnets() {

    const interfaces = os.networkInterfaces() || {};

    // 这些是真正的 overlay 网络，设备不会直接出现在上面
    const OVERLAY_HINTS = ['zerotier', 'tailscale', 'vgate', 'wintun', 'openvpn'];
    const isOverlay = (name) => OVERLAY_HINTS.some((hint) => name.toLowerCase().includes(hint));

    const prefixes = [];
    for (const [name, list] of Object.entries(interfaces)) {
        if (isOverlay(name)) continue;
        for (const net of list || []) {
            if (net.family !== 'IPv4' || net.internal) continue;
            if (net.address.startsWith('169.254.')) continue;   // 没拿到 DHCP
            if (net.address.startsWith('100.64.')) continue;    // CGNAT
            const prefix = net.address.split('.').slice(0, 3).join('.');
            if (!prefixes.includes(prefix)) prefixes.push(prefix);
        }
    }
    return prefixes;
}

/**
 * 扫描局域网，找出开放的 adb 端口。
 *
 * 关键约束：Android 11+ 无线调试端口是随机的（实测 32787），
 * 所以扫 5555 永远扫不到。但全端口 × 全网段是不可能的组合。
 *
 * 采用两段式：
 * 1) 用 ARP 表拿到网段里存活的主机 —— 瞬时，不用发包
 * 2) 只对这些存活主机扫高概率端口段 —— 单机约 3 秒
 */
async function scanLocalNetwork(options = {}) {
    const net = require('net');
    const { execFile } = require('child_process');
    const deadlineMs = options.deadlineMs ?? Date.now() + 15000;
    const readTable = (command, args) => new Promise((resolve) => {
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) return resolve('');
        execFile(command, args, {
            encoding: 'utf8', timeout: Math.max(1, Math.min(4000, remainingMs)), windowsHide: true,
        }, (error, output) => resolve(error ? '' : String(output)));
    });

    const from = options.from || 30000;
    const to = options.to || 50000;
    // 并发不能开到 1024：Windows 临时端口池扛不住连续 8 万次探测，
    // 后半程的连接会静默失败，表现为「扫了一大圈什么都没找到」。
    // 实测 512 是稳定上限（5.3s/主机），1024 会导致漏检。
    const concurrency = options.concurrency || 512;
    const timeoutMs = options.timeoutMs || 120;

    // ---- 1) 收集局域网存活主机 ----
    const prefixes = options.prefixes || scanSubnets();

    const alive = new Set();
    try {
        const output = await readTable('arp', ['-a']);
        for (const line of String(output).split(/\r?\n/)) {
            // 形如：  192.168.137.178     86-db-d5-5c-f1-84     动态
            const match = /(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})/i.exec(line);
            if (!match) continue;
            const [, ip, mac] = match;
            if (mac === 'ff-ff-ff-ff-ff-ff') continue;   // 广播
            if (/^0{2}-/.test(mac)) continue;            // 无效条目
            if (!prefixes.some((prefix) => ip.startsWith(`${prefix}.`))) continue;
            alive.add(ip);
        }
    } catch { /* arp 不可用时退化为空 */ }

    // 排除本机自己的地址
    const selfAddresses = new Set();
    for (const list of Object.values(os.networkInterfaces() || {})) {
        for (const net_ of list || []) {
            if (net_.family === 'IPv4') selfAddresses.add(net_.address);
        }
    }
    for (const address of selfAddresses) alive.delete(address);

    if (!alive.size) return { hosts: [], prefixes, scanned: 0, reason: 'NO_ALIVE_HOST' };

    // 已知上次的手机地址时只扫这一台，把 3 台的 20 秒降到 1 台的 7 秒
    const onlyHosts = Array.isArray(options.hosts) && options.hosts.length
        ? new Set(options.hosts)
        : null;
    if (onlyHosts) {
        for (const host of [...alive]) {
            if (!onlyHosts.has(host)) alive.delete(host);
        }
        if (!alive.size) {
            return { hosts: [], prefixes, scanned: 0, reason: 'HOST_NOT_ALIVE' };
        }
    }

    // ---- 2) 对每台存活主机扫端口 ----
    // 默认已连网关（通常是路由器）不可能是手机，跳过能省一大截
    const skipGateway = options.skipGateway !== false;
    if (skipGateway) {
        const routes = await readTable('route', ['print', '-4']);
        const gateway = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d{1,3}(?:\.\d{1,3}){3})/m.exec(routes)?.[1];
        if (gateway) alive.delete(gateway);
        if (!alive.size) return { hosts: [], prefixes, scanned: 0, reason: 'ONLY_GATEWAY' };
    }

    const targets = [];
    for (const host of alive) {
        for (let port = from; port <= to; port += 1) targets.push({ host, port });
    }

    const found = [];
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
        while (index < targets.length && Date.now() < deadlineMs) {
            const target = targets[index++];
            const state = await new Promise((resolve) => {
                const socket = new net.Socket();
                let settled = false;
                const finish = (kind) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    socket.destroy();
                    resolve(kind);
                };
                const probeMs = Math.max(1, Math.min(timeoutMs, deadlineMs - Date.now()));
                const timer = setTimeout(() => finish('TIMEOUT'), probeMs);
                socket.setTimeout(probeMs);
                socket.once('connect', () => finish('OPEN'));
                socket.once('timeout', () => finish('TIMEOUT'));
                socket.once('error', () => finish('CLOSED'));
                socket.connect(target.port, target.host);
            });
            if (state === 'OPEN') found.push(target);
        }
    });
    await Promise.all(workers);

    return { hosts: found, prefixes, scanned: alive.size, scannedPorts: index, timedOut: Date.now() >= deadlineMs };
}

/** 读取 ARP 表：[{ ip, mac }]，mac 统一为小写冒号分隔。arp 不可用时返回空数组。 */
function readArpTable(options = {}) {
    const { execFile } = require('child_process');
    const timeout = Math.max(1, Math.min(4000, options.timeoutMs ?? 3000));
    return new Promise((resolve) => {
        execFile('arp', ['-a'], { encoding: 'utf8', timeout, windowsHide: true }, (error, output) => {
            if (error) return resolve([]);
            const entries = [];
            for (const line of String(output).split(/\r?\n/)) {
                // Windows: `192.168.1.5   aa-bb-cc-dd-ee-ff   动态`；macOS/Linux: `? (192.168.1.5) at aa:bb:cc:dd:ee:ff`
                const match = /(\d{1,3}(?:\.\d{1,3}){3})\)?\s+(?:at\s+)?([0-9a-f]{1,2}(?:[-:][0-9a-f]{1,2}){5})/i.exec(line);
                if (!match) continue;
                const mac = match[2].toLowerCase().split(/[-:]/).map((part) => part.padStart(2, '0')).join(':');
                if (mac === 'ff:ff:ff:ff:ff:ff' || mac === '00:00:00:00:00:00' || /^01:00:5e:/.test(mac)) continue;
                entries.push({ ip: match[1], mac });
            }
            resolve(entries);
        });
    });
}

/**
 * 让系统为整个 /24 发起 ARP 解析，而不必 spawn 254 个 ping。
 * 发一个 UDP 空包到 discard 端口即可触发邻居解析；不关心是否送达。
 */
function primeArp(prefixes = scanSubnets(), options = {}) {
    const dgram = require('dgram');
    const waitMs = options.waitMs ?? 1200;
    return new Promise((resolve) => {
        let socket;
        try { socket = dgram.createSocket('udp4'); } catch { resolve(0); return; }
        let sent = 0;
        socket.on('error', () => {});
        const payload = Buffer.alloc(0);
        for (const prefix of prefixes.slice(0, 4)) {
            for (let host = 1; host < 255; host++) {
                try { socket.send(payload, 9, `${prefix}.${host}`, () => {}); sent += 1; } catch { /* 单个地址失败不影响其余 */ }
            }
        }
        const timer = setTimeout(() => { try { socket.close(); } catch { /* 已关闭 */ } resolve(sent); }, waitMs);
        timer.unref?.();
    });
}

/** 网卡 IPv4 地址集合的稳定指纹；切换 Wi-Fi / 开关热点都会改变它。 */
function networkFingerprint() {
    const entries = [];
    for (const [name, list] of Object.entries(os.networkInterfaces() || {})) {
        for (const net of list || []) {
            if (net.family !== 'IPv4' || net.internal || net.address.startsWith('169.254.')) continue;
            entries.push(`${name}=${net.address}/${net.netmask || ''}`);
        }
    }
    return entries.sort().join('|');
}

module.exports = { parseHostPort, parsePairCode, localAddresses, probePort, diagnoseEndpoint, scanSubnets, scanLocalNetwork,
    readArpTable, primeArp, networkFingerprint };
