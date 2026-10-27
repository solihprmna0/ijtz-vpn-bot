const test = require('node:test');
const assert = require('node:assert/strict');
const {
    getServerCapacity,
    formatCapacityLabel,
    supportsServerOption
} = require('../modules/serverCapacity');

test('reads common capacity fields without inventing defaults', () => {
    const capacity = getServerCapacity({ current_users: '7 akun', max_users: '10' });

    assert.equal(capacity.used, 7);
    assert.equal(capacity.limit, 10);
    assert.equal(capacity.isAvailable, true);
    assert.equal(formatCapacityLabel(capacity), '7/10 · sisa 3');
});

test('recognizes nested capacity and full status variants', () => {
    const nested = getServerCapacity({ capacity: { active_accounts: 12, account_limit: 12 } });
    const status = getServerCapacity({ server_status: 'FULL' });

    assert.equal(nested.isFull, true);
    assert.equal(formatCapacityLabel(nested), 'FULL 12/12');
    assert.equal(status.isFull, true);
});

test('recognizes zero remaining slots and offline servers', () => {
    assert.equal(getServerCapacity({ remaining_slots: 0 }).isFull, true);
    assert.equal(getServerCapacity({ status: 'offline' }).isUnavailable, true);
});

test('handles NadiaVPN capacity objects with unlimited limits', () => {
    const capacity = getServerCapacity({
        is_active: true,
        capacity: { limit: 'Unlimited', used: 861, is_full: false }
    });

    assert.equal(capacity.isFull, false);
    assert.equal(capacity.isAvailable, true);
    assert.equal(formatCapacityLabel(capacity), '861 terpakai · tidak terbatas');
});

test('filters servers by supported protocols and order types', () => {
    const server = {
        supported_protocols: ['ssh', 'VMESS'],
        supported_types: ['month']
    };

    assert.equal(supportsServerOption(server, 'supported_protocols', 'vmess'), true);
    assert.equal(supportsServerOption(server, 'supported_protocols', 'vless'), false);
    assert.equal(supportsServerOption(server, 'supported_types', 'month'), true);
    assert.equal(supportsServerOption(server, 'supported_types', 'day'), false);
    assert.equal(supportsServerOption({}, 'supported_types', 'day'), true);
});

test('does not label an unknown server as 0/50 available', () => {
    const capacity = getServerCapacity({ name: 'Example' });

    assert.equal(capacity.known, false);
    assert.equal(formatCapacityLabel(capacity), 'status tidak dilaporkan');
});
