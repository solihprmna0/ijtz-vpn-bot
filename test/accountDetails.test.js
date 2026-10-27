const test = require('node:test');
const assert = require('node:assert/strict');
const {
    unwrapAccountResponse,
    findAccountField,
    getAdditionalAccountFields,
    getSshConnectionDetails,
    isSuccessfulAccountResponse,
    combineAccountResponses
} = require('../modules/accountDetails');

test('unwraps nested NadiaVPN account data and keeps surrounding details', () => {
    const response = {
        status: true,
        data: {
            isp: 'Example ISP',
            account: {
                username: 'vpnuser',
                links: { tls: 'vless://example' }
            }
        }
    };
    const account = unwrapAccountResponse(response);

    assert.equal(account.username, 'vpnuser');
    assert.equal(account.isp, 'Example ISP');
    assert.equal(findAccountField(account, ['links.tls']), 'vless://example');
});

test('includes additional response fields without leaking token-like keys', () => {
    const fields = getAdditionalAccountFields({
        username: 'vpnuser',
        account_id: 42,
        relay: { protocol: 'ws' },
        links: { tls: 'vless://tls' },
        transaction: { price: 6000, balance_before: 20000, balance_after: 14000 },
        server: { server_id: 'internal-server-id' },
        access_token: 'must-not-appear'
    }, ['username', 'links.tls']);

    assert.deepEqual(fields, [['Relay / Protocol', 'ws']]);
});

test('accepts successful account responses and rejects failures or empty success payloads', () => {
    assert.equal(isSuccessfulAccountResponse({ status: true, data: { username: 'vpnuser' } }), true);
    assert.equal(isSuccessfulAccountResponse({ status: false, data: { username: 'vpnuser' } }), false);
    assert.equal(isSuccessfulAccountResponse({ status: true, message: 'ok' }), false);
});

test('merges full account details over the basic order response', () => {
    const merged = combineAccountResponses(
        { status: true, data: { account: { account_id: 'id-1', username: 'vpnuser', ports: { tls: 443 } } } },
        { status: true, data: { account: { expired_at: '2026-12-01', ports: { grpc: 5000 } } } }
    );

    assert.equal(merged.account_id, 'id-1');
    assert.equal(merged.username, 'vpnuser');
    assert.equal(merged.expired_at, '2026-12-01');
    assert.deepEqual(merged.ports, { tls: 443, grpc: 5000 });
});

test('reads the nested config structure returned by the order API', () => {
    const account = unwrapAccountResponse({
        status: true,
        data: {
            account_id: 'account-1',
            username: 'vpnuser',
            uuid: 'uuid-value',
            config: {
                hostname: 'vpn.example',
                port: { tls: '443, 8443', none: '80, 8080', any: '2052' },
                path: { stn: '/vmess', multi: '/yourbug', grpc: 'vmess', up: '/upvmess' },
                link: { tls: 'vmess://tls-config', none: 'vmess://none-config', uptls: 'vmess://upgrade-config' }
            }
        }
    });

    assert.equal(findAccountField(account, ['account_id']), 'account-1');
    assert.equal(findAccountField(account, ['config.hostname']), 'vpn.example');
    assert.equal(findAccountField(account, ['config.port.tls']), '443, 8443');
    assert.equal(findAccountField(account, ['config.path.multi']), '/yourbug');
    assert.equal(findAccountField(account, ['config.link.uptls']), 'vmess://upgrade-config');
});

test('structures SSH ports, proxy settings, and payload variants from account config', () => {
    const details = getSshConnectionDetails({
        config: {
            port: {
                openssh: '22, 3303',
                dropbear: 109,
                ws_tls: 443,
                ws_http: '80, 8888',
                squid: 3128,
                badvpn: 7300,
                openvpn_tcp: 1194
            },
            squid_proxy: 'proxy.example:3128',
            http_proxy: 'proxy.example:3128',
            http_custom: 'proxy.example:1-65535@vpnuser:password',
            ovpn_tcp: 'https://example.test/config.zip',
            servername: 'vpn.example',
            payloadads: {
                payloadadtls: 'GET /ssh [crlf]Host: vpn.example',
                payloadadnontls: 'GET /ssh [crlf]Host: vpn.example'
            }
        }
    });

    assert.deepEqual(details.ports.map(([label]) => label), [
        'OpenSSH', 'Dropbear', 'SSH WS TLS', 'SSH WS HTTP',
        'Squid', 'BadVPN', 'OpenVPN TCP'
    ]);
    assert.deepEqual(details.services.map(([label]) => label), [
        'Squid Proxy', 'HTTP Proxy', 'HTTP Custom',
        'OpenVPN TCP Config', 'Server Name / SNI'
    ]);
    assert.deepEqual(details.payloads.map(([label]) => label), [
        'Payload TLS', 'Payload Non-TLS'
    ]);
    assert.equal(details.payloadPaths.length, 2);
});
