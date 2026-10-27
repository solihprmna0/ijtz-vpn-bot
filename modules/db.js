const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

const resselPath = process.env.RESSEL_DATA_PATH || path.join(__dirname, '../ressel.json');
const trialPath = path.join(__dirname, '../trial.json');
const qiospayInvoicesKey = '__qiospayInvoices';

// Helper Buka Data
function loadData(filePath) {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify({}), 'utf8');
        return {};
    }
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        return {};
    }
}

// Helper Simpan Data
function saveData(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function saveDataAtomically(filePath, data) {
    const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        } catch {}
        throw error;
    }
}

function getQiospayInvoice(orderId) {
    const data = loadData(resselPath);
    const invoice = data[qiospayInvoicesKey]?.[String(orderId)];
    return invoice ? { ...invoice } : null;
}

function createQiospayInvoice(orderId, userId, chatId, amount) {
    const cleanOrderId = String(orderId || '');
    const value = Number(amount);
    if (!cleanOrderId || cleanOrderId.length > 64 || !Number.isSafeInteger(value) || value < 1000) {
        throw new Error('Data invoice QiosPay tidak valid.');
    }

    const data = loadData(resselPath);
    const invoices = data[qiospayInvoicesKey] || {};
    if (invoices[cleanOrderId]) {
        throw new Error('ID invoice QiosPay sudah pernah digunakan.');
    }

    invoices[cleanOrderId] = {
        orderId: cleanOrderId,
        userId: String(userId),
        chatId: String(chatId),
        amount: value,
        status: 'creating',
        createdAt: new Date().toISOString()
    };
    data[qiospayInvoicesKey] = invoices;
    saveDataAtomically(resselPath, data);
    return { ...invoices[cleanOrderId] };
}

function updateQiospayInvoice(orderId, updates) {
    const cleanOrderId = String(orderId || '');
    const data = loadData(resselPath);
    const invoices = data[qiospayInvoicesKey] || {};
    const invoice = invoices[cleanOrderId];
    if (!invoice) throw new Error('Invoice QiosPay tidak ditemukan.');
    if (invoice.status === 'paid') return { ...invoice };

    const allowedFields = new Set([
        'status',
        'invoiceId',
        'totalAmount',
        'uniqueCode',
        'qrImageUrl',
        'payUrl',
        'expiresAt',
        'errorCode'
    ]);
    for (const [key, value] of Object.entries(updates || {})) {
        if (allowedFields.has(key)) invoice[key] = value;
    }
    invoices[cleanOrderId] = invoice;
    data[qiospayInvoicesKey] = invoices;
    saveDataAtomically(resselPath, data);
    return { ...invoice };
}

function creditQiospayInvoiceOnce(orderId, payment) {
    const cleanOrderId = String(orderId || '');
    const data = loadData(resselPath);
    const invoices = data[qiospayInvoicesKey] || {};
    const invoice = invoices[cleanOrderId];
    if (!invoice) return { credited: false, reason: 'unknown_invoice' };
    if (invoice.status === 'paid') return { credited: false, alreadyPaid: true, balance: data[invoice.userId] || 0 };

    const amount = Number(payment?.amount);
    const totalAmount = Number(payment?.totalAmount);
    if (!Number.isSafeInteger(amount) || amount !== Number(invoice.amount)) {
        return { credited: false, reason: 'amount_mismatch' };
    }
    if (!Number.isSafeInteger(totalAmount) || totalAmount !== Number(invoice.totalAmount)) {
        return { credited: false, reason: 'total_mismatch' };
    }
    if (!payment?.invoiceId || String(payment.invoiceId) !== String(invoice.invoiceId)) {
        return { credited: false, reason: 'invoice_id_mismatch' };
    }

    const userId = String(invoice.userId);
    const currentBalance = Number(data[userId] || 0);
    if (!Number.isSafeInteger(currentBalance) || currentBalance < 0) {
        throw new Error('Saldo pengguna tidak valid; pembayaran belum dikreditkan.');
    }

    const newBalance = currentBalance + amount;
    if (!Number.isSafeInteger(newBalance)) {
        throw new Error('Saldo setelah pembayaran di luar batas aman.');
    }

    data[userId] = newBalance;
    invoice.status = 'paid';
    invoice.paidAt = String(payment.paidAt || new Date().toISOString());
    invoice.providerPaymentId = String(payment.invoiceId);
    invoices[cleanOrderId] = invoice;
    data[qiospayInvoicesKey] = invoices;
    saveDataAtomically(resselPath, data);

    return { credited: true, balance: newBalance, userId, chatId: invoice.chatId, amount };
}

// Ambil Saldo User
async function getBalance(userId) {
    const ressel = loadData(resselPath);
    const uid = String(userId);
    if (ressel[uid] === undefined) {
        ressel[uid] = 0;
        saveData(resselPath, ressel);
    }
    return ressel[uid];
}

// Potong Saldo User
async function deductBalance(userId, amount) {
    const ressel = loadData(resselPath);
    const uid = String(userId);
    const current = ressel[uid] || 0;

    if (current < amount) {
        throw new Error("Saldo tidak mencukupi!");
    }

    ressel[uid] = current - amount;
    saveData(resselPath, ressel);
    return ressel[uid];
}

async function addBalance(userId, amount) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error("Jumlah saldo tidak valid.");
    }

    const ressel = loadData(resselPath);
    const uid = String(userId);
    ressel[uid] = Number(ressel[uid] || 0) + value;
    saveData(resselPath, ressel);
    return ressel[uid];
}

// Cek & Set Limit Trial (1 Hari 1x)
async function checkAndSetTrial(userId) {
    const trial = loadData(trialPath);
    const uid = String(userId);
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    if (trial[uid] === today) {
        return false; // Sudah pernah trial hari ini
    }

    trial[uid] = today;
    saveData(trialPath, trial);
    return true; // Boleh trial
}

module.exports = {
    getBalance,
    deductBalance,
    addBalance,
    checkAndSetTrial,
    getQiospayInvoice,
    createQiospayInvoice,
    updateQiospayInvoice,
    creditQiospayInvoiceOnce
};
