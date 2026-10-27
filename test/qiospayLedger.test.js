'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qiospay-ledger-'));
const balancePath = path.join(tempDir, 'ressel.json');
process.env.RESSEL_DATA_PATH = balancePath;
fs.writeFileSync(balancePath, JSON.stringify({ '9001': 500 }), 'utf8');

const db = require('../modules/db');

test('QiosPay settlement credits the requested amount exactly once and preserves other balances', async () => {
    db.createQiospayInvoice('TOPUP-TEST-1', 9002, 9002, 15000);
    db.updateQiospayInvoice('TOPUP-TEST-1', {
        status: 'pending',
        invoiceId: 'qiospay-invoice-1',
        totalAmount: 15027
    });

    const payment = {
        invoiceId: 'qiospay-invoice-1',
        amount: 15000,
        totalAmount: 15027,
        paidAt: '2026-10-26T00:00:00.000Z'
    };
    const first = db.creditQiospayInvoiceOnce('TOPUP-TEST-1', payment);
    const duplicate = db.creditQiospayInvoiceOnce('TOPUP-TEST-1', payment);
    const saved = JSON.parse(fs.readFileSync(balancePath, 'utf8'));

    assert.equal(first.credited, true);
    assert.equal(first.balance, 15000);
    assert.equal(duplicate.credited, false);
    assert.equal(duplicate.alreadyPaid, true);
    assert.equal(saved['9001'], 500);
    assert.equal(saved['9002'], 15000);
});

test('QiosPay settlement rejects amount, total, and invoice ID mismatches', async () => {
    db.createQiospayInvoice('TOPUP-TEST-2', 9003, 9003, 20000);
    db.updateQiospayInvoice('TOPUP-TEST-2', {
        status: 'pending',
        invoiceId: 'qiospay-invoice-2',
        totalAmount: 20017
    });

    assert.equal(
        db.creditQiospayInvoiceOnce('TOPUP-TEST-2', {
            invoiceId: 'qiospay-invoice-2',
            amount: 19000,
            totalAmount: 20017
        }).reason,
        'amount_mismatch'
    );
    assert.equal(
        db.creditQiospayInvoiceOnce('TOPUP-TEST-2', {
            invoiceId: 'qiospay-invoice-2',
            amount: 20000,
            totalAmount: 20018
        }).reason,
        'total_mismatch'
    );
    assert.equal(
        db.creditQiospayInvoiceOnce('TOPUP-TEST-2', {
            invoiceId: 'different-invoice',
            amount: 20000,
            totalAmount: 20017
        }).reason,
        'invoice_id_mismatch'
    );
    assert.equal(await db.getBalance(9003), 0);
});

test.after(() => {
    delete process.env.RESSEL_DATA_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
});
