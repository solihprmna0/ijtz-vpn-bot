const USED_KEYS = [
    'used', 'users', 'active_account', 'active_accounts', 'current_users',
    'current_user', 'current_accounts', 'active_users', 'users_count',
    'user_count', 'accounts_count', 'account_count', 'total_users',
    'used_slots', 'slots_used', 'occupied_slots', 'occupied', 'taken'
];

const LIMIT_KEYS = [
    'limit', 'max_users', 'max_user', 'max_account', 'max_accounts',
    'max_capacity', 'total_limit', 'limit_users', 'user_limit',
    'account_limit', 'client_limit', 'maximum_users', 'max_clients',
    'capacity', 'slots_total', 'total_slots'
];

const REMAINING_KEYS = [
    'available_slots', 'slots_available', 'remaining_slots', 'slots_remaining',
    'free_slots', 'remaining', 'quota_remaining', 'available_count',
    'available_users', 'free_accounts', 'vacant_slots', 'available'
];

const FULL_KEYS = ['is_full', 'full', 'is_sold_out', 'sold_out'];
const UNAVAILABLE_KEYS = ['is_online', 'online', 'is_active', 'active', 'enabled', 'is_enabled'];
const STATUS_KEYS = ['status', 'server_status', 'availability', 'state'];

function normalizeKey(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function objectsBreadthFirst(value) {
    const queue = [value];
    const seen = new Set();
    const objects = [];

    while (queue.length) {
        const current = queue.shift();
        if (!current || typeof current !== 'object' || seen.has(current)) continue;
        seen.add(current);
        objects.push(current);
        for (const child of Object.values(current)) {
            if (child && typeof child === 'object') queue.push(child);
        }
    }

    return objects;
}

function findValue(value, aliases) {
    const aliasSet = new Set(aliases.map(normalizeKey));
    for (const object of objectsBreadthFirst(value)) {
        for (const [key, fieldValue] of Object.entries(object)) {
            if (
                aliasSet.has(normalizeKey(key)) &&
                fieldValue !== null &&
                fieldValue !== undefined &&
                typeof fieldValue !== 'object'
            ) {
                return fieldValue;
            }
        }
    }
    return undefined;
}

function toCount(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== 'string') return null;

    const text = value.trim().replace(/,/g, '');
    const ratio = text.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
    if (ratio) return null;
    const number = text.match(/\d+(?:\.\d+)?/);
    return number ? Number(number[0]) : null;
}

function toBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 0 ? false : value === 1 ? true : null;
    if (typeof value !== 'string') return null;

    const text = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'ya', 'y', 'full', 'penuh', 'offline', 'unavailable', 'sold out'].includes(text)) return true;
    if (['false', '0', 'no', 'tidak', 'n', 'available', 'tersedia', 'online', 'active'].includes(text)) return false;
    return null;
}

function parseStatus(value) {
    if (typeof value !== 'string') return null;
    const status = value.trim().toLowerCase().replace(/[_-]+/g, ' ');
    if (/\b(not full|belum penuh)\b/.test(status)) return 'available';
    if (/\b(full|penuh|sold out)\b/.test(status) && !/\b(not full|belum penuh)\b/.test(status)) {
        return 'full';
    }
    if (/\b(full|penuh|sold out|unavailable|offline|maintenance|disabled|inactive|closed|nonaktif)\b/.test(status)) {
        return 'unavailable';
    }
    if (/\b(available|tersedia|online|active|running|ready|open|aktif)\b/.test(status)) {
        return 'available';
    }
    return null;
}

function getServerCapacity(server) {
    const usedRaw = findValue(server, USED_KEYS);
    const limitRaw = findValue(server, LIMIT_KEYS);
    const remainingRaw = findValue(server, REMAINING_KEYS);
    const used = toCount(usedRaw);
    const limit = toCount(limitRaw);
    const remaining = toCount(remainingRaw);
    const isUnlimited = typeof limitRaw === 'string' &&
        /^(unlimited|infinite|no limit|tidak terbatas)$/i.test(limitRaw.trim());

    const fullFlag = toBoolean(findValue(server, FULL_KEYS));
    const activeFlag = toBoolean(findValue(server, UNAVAILABLE_KEYS));
    const status = parseStatus(findValue(server, STATUS_KEYS));
    const directAvailability = toBoolean(findValue(server, ['available', 'is_available']));
    const isFull =
        fullFlag === true ||
        status === 'full' ||
        (used !== null && limit !== null && used >= limit) ||
        directAvailability === false ||
        remaining === 0;
    const isUnavailable =
        activeFlag === false ||
        status === 'unavailable';

    const isAvailable = isFull || isUnavailable
        ? false
        : fullFlag === false || status === 'available' || directAvailability === true || isUnlimited ||
          (remaining !== null && remaining > 0) ||
          (used !== null && limit !== null && limit > used);

    const known = isFull || isUnavailable || isAvailable || isUnlimited ||
        used !== null || limit !== null || remaining !== null;

    return { used, limit, remaining, unlimited: isUnlimited, known, isFull, isUnavailable, isAvailable };
}

function formatCapacityLabel(capacity) {
    if (capacity.isFull) {
        return capacity.used !== null && capacity.limit !== null
            ? `FULL ${capacity.used}/${capacity.limit}`
            : 'FULL';
    }
    if (capacity.isUnavailable) return 'OFFLINE';
    if (capacity.unlimited) {
        return capacity.used !== null
            ? `${capacity.used} terpakai · tidak terbatas`
            : 'tidak terbatas';
    }
    if (capacity.used !== null && capacity.limit !== null) {
        const remaining = capacity.remaining ?? Math.max(0, capacity.limit - capacity.used);
        return `${capacity.used}/${capacity.limit} · sisa ${remaining}`;
    }
    if (capacity.remaining !== null) return `sisa ${capacity.remaining} slot`;
    if (capacity.isAvailable) return 'tersedia';
    return 'status tidak dilaporkan';
}

function supportsServerOption(server, fieldName, option) {
    const configured = server?.[fieldName];
    if (configured === undefined || configured === null) return true;

    const options = Array.isArray(configured)
        ? configured
        : typeof configured === 'string'
            ? configured.split(/[,\s]+/)
            : [];
    const normalized = options.map(value => String(value).trim().toLowerCase()).filter(Boolean);
    return normalized.includes(String(option).trim().toLowerCase());
}

module.exports = { getServerCapacity, formatCapacityLabel, supportsServerOption };
