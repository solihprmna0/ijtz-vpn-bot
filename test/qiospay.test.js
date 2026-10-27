'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const {
    QiosPayClient,
    QiosPayError,
    verifyWebhook,
    isMatchingPaidInvoice
} = require('../modules/qiospay');

function makeSignature(payload, secret, timestamp) {
    const rawBody = Buffer.from(JSON.stringify(payload));
    const digest = crypto
        .createHmac('sha256', secret)
        .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
        .digest('hex');
    return { rawBody, header: `t=${timestamp},v1=${digest}` };
}

test('QiosPay invoice request uses the documented host auth header and payload', async () => {
    let request;
    const client = new QiosPayClient({
        apiKey: 'qp_live_unit_test_key',
        fetchImpl: async (url, options) => {
            request = { url, options };
            return {
                ok: true,
                status: 201,
                json: async () => ({ data: { id: 'invoice-1', ref_id: 'TOPUP-1' } })
            };
        }
    });

    const result = await client.createInvoice({
        order_id: 'TOPUP-1',
        amount: 15000,
        keterangan: 'Top up saldo VPN',
        metadata: { user_id: '42' }
    });

    assert.equal(request.url, 'https://my.qiospay.com/v1/invoices');
    assert.equal(request.options.headers['x-api-key'], 'qp_live_unit_test_key');
    assert.deepEqual(JSON.parse(request.options.body), {
        order_id: 'TOPUP-1',
        amount: 15000,
        keterangan: 'Top up saldo VPN',
        metadata: { user_id: '42' }
    });
    assert.equal(result.ref_id, 'TOPUP-1');
});

test('QiosPay refuses a test key because the provider account has no sandbox', () => {
    assert.throws(
        () => new QiosPayClient({ apiKey: 'qp_test_unit_test_key' }),
        error => error instanceof QiosPayError && error.code === 'KEY_MODE_MISMATCH'
    );
});

test('QiosPay webhook signature accepts a valid event and rejects tampering and stale timestamps', () => {
    const secret = 'test-webhook-secret';
    const timestamp = 1_800_000_000;
    const payload = { event: 'invoice.paid', data: { ref_id: 'TOPUP-1' } };
    const signed = makeSignature(payload, secret, timestamp);

    assert.deepEqual(
        verifyWebhook(signed.rawBody, signed.header, secret, 600, timestamp * 1000),
        payload
    );
    assert.throws(
        () => verifyWebhook(Buffer.from('{"event":"invoice.paid"}'), signed.header, secret, 600, timestamp * 1000),
        error => error.code === 'BAD_SIGNATURE'
    );
    assert.throws(
        () => verifyWebhook(signed.rawBody, signed.header, secret, 600, (timestamp + 601) * 1000),
        error => error.code === 'BAD_SIGNATURE'
    );
});

test('paid invoice must match the locally created invoice and merchant', () => {
    const local = {
        orderId: 'TOPUP-1',
        invoiceId: 'invoice-1',
        amount: 15000,
        totalAmount: 15027
    };
    const paid = {
        ref_id: 'TOPUP-1',
        id: 'invoice-1',
        status: 'paid',
        merchant_code: 'merchant-test',
        amount: 15000,
        total_amount: 15027
    };

    assert.equal(isMatchingPaidInvoice(local, paid, 'merchant-test'), true);
    assert.equal(isMatchingPaidInvoice(local, { ...paid, amount: 14000 }, 'merchant-test'), false);
    assert.equal(isMatchingPaidInvoice(local, paid, 'another-merchant'), false);
});
