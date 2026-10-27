const WRAPPER_KEYS = ['account', 'vpn', 'data', 'result', 'payload', 'response'];
const MAX_DEPTH = 8;

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(target, source) {
    const merged = { ...target };
    for (const [key, value] of Object.entries(source)) {
        if (isPlainObject(value) && isPlainObject(merged[key])) {
            merged[key] = deepMerge(merged[key], value);
        } else {
            merged[key] = value;
        }
    }
    return merged;
}

function unwrapAccountResponse(response) {
    let current = response;
    const seen = new Set();
    let collected = {};

    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
        if (Array.isArray(current)) current = current[0];
        if (!isPlainObject(current) || seen.has(current)) break;
        seen.add(current);

        let next;
        for (const key of WRAPPER_KEYS) {
            if (isPlainObject(current[key]) || Array.isArray(current[key])) {
                next = current[key];
                break;
            }
        }

        if (!next) {
            collected = deepMerge(collected, current);
            break;
        }

        const outerFields = { ...current };
        for (const key of WRAPPER_KEYS) delete outerFields[key];
        collected = deepMerge(collected, outerFields);
        current = next;
    }

    return isPlainObject(current) ? deepMerge(collected, current) : collected;
}

function flattenPrimitiveFields(value, prefix = '', output = [], depth = 0) {
    if (depth > MAX_DEPTH || value === null || value === undefined) return output;

    if (Array.isArray(value)) {
        if (value.every(item => item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
            output.push([prefix, value.filter(item => item !== null).join(', ')]);
        } else {
            value.forEach((item, index) => flattenPrimitiveFields(item, `${prefix}[${index + 1}]`, output, depth + 1));
        }
        return output;
    }

    if (isPlainObject(value)) {
        for (const [key, child] of Object.entries(value)) {
            const path = prefix ? `${prefix}.${key}` : key;
            flattenPrimitiveFields(child, path, output, depth + 1);
        }
        return output;
    }

    if (['string', 'number', 'boolean'].includes(typeof value)) {
        output.push([prefix, String(value)]);
    }
    return output;
}

function normalizeKey(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findAccountField(account, aliases) {
    const aliasSet = new Set(aliases.map(normalizeKey));
    for (const alias of aliases.filter(value => String(value).includes('.'))) {
        let current = account;
        for (const segment of String(alias).split('.')) {
            if (!isPlainObject(current)) {
                current = undefined;
                break;
            }
            const entry = Object.entries(current).find(([key]) => normalizeKey(key) === normalizeKey(segment));
            current = entry?.[1];
        }
        if (current !== null && current !== undefined && !isPlainObject(current) && !Array.isArray(current) && String(current) !== '') {
            return String(current);
        }
    }

    const fields = flattenPrimitiveFields(account);
    for (const [path, value] of fields) {
        const key = path.split('.').pop().replace(/\[\d+\]$/, '');
        if (aliasSet.has(normalizeKey(key)) && value !== '') return value;
    }
    return undefined;
}

function getAdditionalAccountFields(account, consumedKeys = []) {
    const consumed = new Set(consumedKeys.map(normalizeKey));
    const ignored = new Set([
        'status', 'success', 'code', 'message', 'msg', 'headers',
        'accountid', 'serverid', 'price', 'balance', 'balancebefore',
        'balanceafter', 'apitrxcount'
    ]);

    return flattenPrimitiveFields(account)
        .filter(([path, value]) => {
            const key = path.split('.').pop().replace(/\[\d+\]$/, '');
            const normalized = normalizeKey(key);
            const normalizedPath = normalizeKey(path);
            const alreadyDisplayed = consumed.has(normalized) ||
                [...consumed].some(alias => normalizedPath === alias || normalizedPath.endsWith(alias));
            const internalSection = /^(transaction|server)(\.|$)/i.test(path);
            const internalIdentifier = normalized.includes('accountid') ||
                normalized.includes('serverid') ||
                normalized.includes('serveruuid');
            return value !== '' &&
                !alreadyDisplayed &&
                !internalSection &&
                !internalIdentifier &&
                !ignored.has(normalized) &&
                !/(api.?key|access.?token|auth(orization)?|secret|cookie)/i.test(path);
        })
        .map(([path, value]) => [
            path
                .replace(/\[(\d+)\]/g, ' $1')
                .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
                .split(/[._]+/)
                .filter(Boolean)
                .map(part => part.charAt(0).toUpperCase() + part.slice(1))
                .join(' / '),
            value
        ]);
}

function getSshConnectionDetails(account) {
    const find = (...aliases) => findAccountField(account, aliases);
    const ports = [
        ['OpenSSH', find('config.port.openssh', 'config.port.ssh', 'ssh_port', 'port_ssh')],
        ['Dropbear', find('config.port.dropbear', 'dropbear_port')],
        ['SSH WS TLS', find('config.port.ws_tls', 'config.port.wstls', 'ws_tls_port')],
        ['SSH WS HTTP', find('config.port.ws_http', 'config.port.wshttp', 'ws_http_port')],
        ['Squid', find('config.port.squid', 'squid_port')],
        ['BadVPN', find('config.port.badvpn', 'badvpn_port')],
        ['OpenVPN TCP', find('config.port.openvpn_tcp', 'config.port.openvpn', 'openvpn_tcp_port')]
    ].filter(([, value]) => value);

    const services = [
        ['Squid Proxy', find('config.squid_proxy', 'config.proxy.squid', 'squid_proxy')],
        ['HTTP Proxy', find('config.http_proxy', 'config.proxy.http', 'http_proxy')],
        ['HTTP Custom', find('config.http_custom', 'config.proxy.http_custom', 'http_custom')],
        ['OpenVPN TCP Config', find('config.ovpn_tcp', 'config.openvpn_tcp', 'config.openvpn.tcp')],
        ['Server Name / SNI', find('config.servername', 'config.server_name', 'servername', 'server_name')]
    ].filter(([, value]) => value);

    const payloadFields = flattenPrimitiveFields(account)
        .filter(([path, value]) => /(^|\.)payload/i.test(path) && value !== '');
    const payloads = payloadFields
        .map(([path, value]) => {
            const normalizedPath = path.toLowerCase();
            const label = /non.?tls|nontls/.test(normalizedPath)
                ? 'Payload Non-TLS'
                : /tls/.test(normalizedPath)
                    ? 'Payload TLS'
                    : 'Payload WS';
            return [label, value];
        });

    const payloadCounts = new Map();
    const uniquePayloads = payloads.map(([label, value]) => {
        const count = (payloadCounts.get(label) || 0) + 1;
        payloadCounts.set(label, count);
        return [count === 1 ? label : `${label} ${count}`, value];
    });

    return {
        ports,
        services,
        payloads: uniquePayloads,
        payloadPaths: payloadFields.map(([path]) => path)
    };
}

function isSuccessfulAccountResponse(response) {
    if (!isPlainObject(response)) return false;
    if (response.success === false || response.status === false) return false;

    const statusText = typeof response.status === 'string' ? response.status.trim().toLowerCase() : '';
    if (['error', 'failed', 'failure', 'false', 'fail'].includes(statusText)) return false;

    const codeValue = response.code ?? response.statusCode ?? response.status_code;
    if (codeValue !== undefined && /^\d+$/.test(String(codeValue))) {
        const code = Number(codeValue);
        if (code >= 100 && code <= 599 && (code < 200 || code >= 300)) return false;
    }

    const account = unwrapAccountResponse(response);
    const accountKeys = new Set([
        'username', 'user', 'login', 'password', 'pass', 'uuid', 'domain',
        'hostname', 'host', 'ip', 'serverid', 'sshlink', 'link', 'url',
        'config', 'connection', 'accountid'
    ]);
    const hasAccountDetails = flattenPrimitiveFields(account).some(([path]) =>
        accountKeys.has(normalizeKey(path.split('.').pop().replace(/\[\d+\]$/, '')))
    );

    if (response.success === true || response.status === true) return hasAccountDetails;
    return hasAccountDetails;
}

function combineAccountResponses(...responses) {
    return responses.reduce(
        (combined, response) => deepMerge(combined, unwrapAccountResponse(response)),
        {}
    );
}

module.exports = {
    unwrapAccountResponse,
    findAccountField,
    getAdditionalAccountFields,
    getSshConnectionDetails,
    isSuccessfulAccountResponse,
    combineAccountResponses
};
