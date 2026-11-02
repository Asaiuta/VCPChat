'use strict';
const { AdbClient } = require('../VCPDistributedServer/Plugin/AndroidController/lib/adb');
const { executeSystem, catalog } = require('../VCPDistributedServer/Plugin/AndroidController/lib/system-api');
const serial = process.argv[2];
if (!serial) throw new Error('Usage: node scripts/check-android-system.cjs SERIAL');
const client = new AdbClient({ serial, timeoutMs: 5000 });
const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
(async () => {
    const user = (await client.runText(['shell', 'am', 'get-current-user'])).trim();
    if (user !== '0') throw new Error('Primary Android user required');
    for (const row of catalog.filter(row => row.operation !== 'draft')) {
        const operation = row.operation === 'read' ? 'read' : 'probe';
        const request = { serial, operation, capability: row.id, ...(operation === 'probe' ? { targetOperation: row.operation } : {}) };
        try {
            const result = await executeSystem(request, {
                async authorize(device, group) { if (device !== serial || group !== 'read') throw new Error('Read-only test authority'); },
                run: tokens => client.enqueue(['shell', ...tokens.map(quote)], { maxBuffer: 32768 }),
                beforeDispatch() { throw new Error('Smoke must never dispatch'); },
            });
            console.log(JSON.stringify(result));
        } catch (error) { console.log(JSON.stringify({ capability: row.id, operation, code: error.code || 'ERROR', outcome: 'failed' })); }
    }
})().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
