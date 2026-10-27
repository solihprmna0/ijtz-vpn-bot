'use strict';

const crypto = require('node:crypto');

const DEFAULT_BASE_URL = 'https://my.qiospay.com';

class QiosPayError extends Error {
    constructor(message, code = 'QIOSPAY_ERROR', status = 0) {
        super(message);
        this.name = 'QiosPayError';
        this.code = code;
        this.status = status;
    }
}

class QiosPayClient {
    constructor({
        apiKey = process.env.QIOSPAY_API_KEY,
        baseUrl = DEFAULT_BASE_URL,
        timeoutMs = 15000,
        fetchImpl = globalThis.fetch
    } = {}) {
        if (!apiKey) {
            throw new QiosPayError('QIOSPAY_API_KEY belum diatur di Replit Secrets.', 'CONFIG_MISSING');
        }
        const expectedPrefix = 'qp_live_';
        if (!apiKey.startsWith(expectedPrefix)) {
            throw new QiosPayError(
                `QiosPay hanya diaktifkan dengan API key live ${expectedPrefix}…`,
                'KEY_MODE_MISMATCH'
            );
        }
        if (typeof fetchImpl !== 'function') {
            throw new QiosPayError('Runtime Node.js tidak menyediakan fetch.', 'FETCH_UNAVAILABLE');
        }

        this.apiKey = apiKey;
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.timeoutMs = timeoutMs;
        this.fetchImpl = fetchImpl;
    }

    createInvoice({ order_id, amount, keterangan, metadata }) {
        if (!order_id || String(order_id).length > 64) {
            throw new QiosPayError('order_id invoice tidak valid.', 'INVALID_ORDER_ID');
        }
        if (!Number.isSafeInteger(Number(amount)) || Number(amount) < 1000) {
            throw new QiosPayError('Nominal invoice minimal Rp 1.000.', 'INVALID_AMOUNT');
        }

        return this._request('POST', '/v1/invoices', {
            order_id: String(order_id),
            amount: Number(amount),
            keterangan: String(keterangan || 'Top up saldo VPN'),
            ...(metadata && typeof metadata === 'object' ? { metadata } : {})
        });
    }

    getInvoice(idOrRef) {
        if (!idOrRef) throw new QiosPayError('ID invoice tidak valid.', 'INVALID_INVOICE_ID');
        return this._request('GET', `/v1/invoices/${encodeURIComponent(String(idOrRef))}`);
    }

    async _request(method, route, body) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetchImpl(`${this.baseUrl}${route}`, {
                method,
                signal: controller.signal,
                headers: {
                    'x-api-key': this.apiKey,
                    Accept: 'application/json',
                    ...(body ? { 'Content-Type': 'application/json' } : {})
                },
                ...(body ? { body: JSON.stringify(body) } : {})
            });

            let payload = {};
            try {
                payload = await response.json();
            } catch {
                throw new QiosPayError(
                    `Respons QiosPay bukan JSON (HTTP ${response.status}).`,
                    'INVALID_RESPONSE',
                    response.status
                );
            }

            if (!response.ok) {
                throw new QiosPayError(
                    payload?.error?.message || `QiosPay menolak permintaan (HTTP ${response.status}).`,
                    payload?.error?.code || `HTTP_${response.status}`,
                    response.status
                );
            }
            if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'data')) {
                throw new QiosPayError('Format respons QiosPay tidak sesuai dokumentasi.', 'INVALID_RESPONSE', response.status);
            }
            return payload.data;
        } catch (error) {
            if (error instanceof QiosPayError) throw error;
            const code = error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
            throw new QiosPayError(
                code === 'TIMEOUT' ? 'Permintaan ke QiosPay melewati batas waktu.' : 'Tidak dapat terhubung ke QiosPay.',
                code
            );
        } finally {
            clearTimeout(timer);
        }
    }
}

function verifyWebhook(rawBody, signatureHeader, secret, toleranceSec = 600, nowMs = Date.now()) {
    if (!secret) throw new QiosPayError('QIOSPAY_PRIVATE_KEY belum diatur.', 'CONFIG_MISSING');
    if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') {
        throw new QiosPayError('Webhook harus menggunakan raw body.', 'INVALID_BODY', 400);
    }

    const parts = Object.fromEntries(
        String(signatureHeader || '')
            .split(',')
            .map(part => part.trim().split('=', 2))
            .filter(pair => pair.length === 2)
    );
    const timestamp = Number(parts.t);
    if (!parts.v1 || !/^[a-f0-9]{64}$/i.test(parts.v1) || !Number.isFinite(timestamp)) {
        throw new QiosPayError('Header tanda tangan QiosPay tidak valid.', 'BAD_SIGNATURE', 400);
    }
    if (toleranceSec > 0 && Math.abs(nowMs / 1000 - timestamp) > toleranceSec) {
        throw new QiosPayError('Timestamp webhook QiosPay sudah kedaluwarsa.', 'BAD_SIGNATURE', 400);
    }

    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
    const expected = crypto
        .createHmac('sha256', secret)
        .update(Buffer.concat([Buffer.from(`${parts.t}.`), body]))
        .digest();
    const received = Buffer.from(parts.v1, 'hex');
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
        throw new QiosPayError('Tanda tangan webhook QiosPay tidak cocok.', 'BAD_SIGNATURE', 401);
    }

    try {
        return JSON.parse(body.toString('utf8'));
    } catch {
        throw new QiosPayError('Isi webhook QiosPay bukan JSON valid.', 'INVALID_BODY', 400);
    }
}

function isMatchingPaidInvoice(localInvoice, remoteInvoice, expectedMerchantCode) {
    if (!localInvoice || !remoteInvoice || remoteInvoice.status !== 'paid') return false;
    if (String(remoteInvoice.ref_id || '') !== String(localInvoice.orderId || '')) return false;
    if (String(remoteInvoice.id || '') !== String(localInvoice.invoiceId || '')) return false;
    if (String(remoteInvoice.merchant_code || '') !== String(expectedMerchantCode || '')) return false;
    if (Number(remoteInvoice.amount) !== Number(localInvoice.amount)) return false;
    if (Number(remoteInvoice.total_amount) !== Number(localInvoice.totalAmount)) return false;
    return true;
}

module.exports = {
    QiosPayClient,
    QiosPayError,
    verifyWebhook,
    isMatchingPaidInvoice
};
