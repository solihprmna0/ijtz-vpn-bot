const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const crypto = require('node:crypto');

const {
    getBalance,
    deductBalance,
    addBalance,
    checkAndSetTrial,
    getQiospayInvoice,
    createQiospayInvoice,
    updateQiospayInvoice,
    creditQiospayInvoiceOnce
} = require('./modules/db');
const { getServers, createVpnAccount, getAccountDetails, renewVpnAccount } = require('./modules/nadiaApi');
const { getServerCapacity, formatCapacityLabel, supportsServerOption } = require('./modules/serverCapacity');
const { QiosPayClient, QiosPayError, verifyWebhook, isMatchingPaidInvoice } = require('./modules/qiospay');
const {
    unwrapAccountResponse,
    findAccountField,
    getAdditionalAccountFields,
    getSshConnectionDetails,
    isSuccessfulAccountResponse,
    combineAccountResponses
} = require('./modules/accountDetails');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
    throw new Error("TELEGRAM_TOKEN belum diatur. Tambahkan token bot melalui Environment Variables Vercel.");
}

// Inisialisasi bot TANPA polling karena berjalan di Vercel (Serverless)
const bot = new TelegramBot(TELEGRAM_TOKEN);

const BOT_NAME = "IJTZ VPN STORE";
const ADMIN_USERNAME = "ijtzvpn";
const ADMIN_ID = 8115833362;
const WA_NUMBER = "6287849336275";
const WA_LINK = `https://wa.me/${WA_NUMBER}`;
const WA_CHANNEL = "https://whatsapp.com/channel/0029VbDUgV0JuyA61VcB3p1S";
const TG_CHANNEL = "https://t.me/your_channel_telegram";

const userSessions = {};

function escapeHtml(text) {
    if (!text) return "";
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function qiospaySafeUrl(value) {
    if (!value) return null;
    try {
        const url = new URL(String(value));
        if (url.protocol !== 'https:' || !['my.qiospay.com'].includes(url.hostname)) return null;
        return url.toString();
    } catch {
        return null;
    }
}

function formatRupiah(value) {
    return `Rp ${Number(value).toLocaleString('id-ID')}`;
}

async function settleQiospayInvoice(orderId, remoteInvoice) {
    const localInvoice = getQiospayInvoice(orderId);
    if (!localInvoice) return { ok: false, reason: 'unknown_invoice' };
    if (!isMatchingPaidInvoice(localInvoice, remoteInvoice, process.env.QIOSPAY_MERCHANT_ID)) {
        return { ok: false, reason: 'provider_data_mismatch' };
    }

    const settlement = creditQiospayInvoiceOnce(orderId, {
        invoiceId: remoteInvoice.id,
        amount: remoteInvoice.amount,
        totalAmount: remoteInvoice.total_amount,
        paidAt: remoteInvoice.paid_at
    });

    if (settlement.credited) {
        bot.sendMessage(
            settlement.chatId,
            `✅ <b>Pembayaran berhasil dikonfirmasi.</b>\n\nSaldo bertambah ${formatRupiah(settlement.amount)}.\nSaldo sekarang: ${formatRupiah(settlement.balance)}.`,
            { parse_mode: 'HTML' }
        ).catch(error => console.error('Gagal mengirim notifikasi pembayaran QiosPay:', error.message || error));
        return { ok: true, credited: true };
    }
    if (settlement.alreadyPaid) return { ok: true, alreadyPaid: true };
    return { ok: false, reason: settlement.reason || 'not_credited' };
}

async function createQiospayTopup(chatId, userId, amount) {
    const orderId = `TOPUP-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    let invoiceRecord;
    try {
        const client = new QiosPayClient();
        if (!process.env.QIOSPAY_MERCHANT_ID || !process.env.QIOSPAY_PRIVATE_KEY) {
            throw new QiosPayError('Konfigurasi merchant atau webhook belum lengkap.', 'CONFIG_MISSING');
        }

        invoiceRecord = createQiospayInvoice(orderId, userId, chatId, amount);
        const response = await client.createInvoice({
            order_id: orderId,
            amount,
            keterangan: `Top up saldo VPN Telegram ${userId}`,
            metadata: { user_id: String(userId) }
        });

        const totalAmount = Number(response?.total_amount);
        const responseAmount = Number(response?.amount);
        const invoiceId = String(response?.id || '');
        const returnedOrderId = String(response?.ref_id || '');
        const qrImageUrl = qiospaySafeUrl(response?.qr_image_url);
        const payUrl = qiospaySafeUrl(response?.pay_url);

        if (
            !invoiceId ||
            returnedOrderId !== orderId ||
            responseAmount !== amount ||
            !Number.isSafeInteger(totalAmount) ||
            totalAmount < amount ||
            String(response?.merchant_code || '') !== String(process.env.QIOSPAY_MERCHANT_ID) ||
            (response?.status && response.status !== 'pending') ||
            (!qrImageUrl && !payUrl)
        ) {
            throw new QiosPayError('Data invoice dari QiosPay tidak cocok dengan pesanan.', 'INVALID_INVOICE_RESPONSE');
        }

        invoiceRecord = updateQiospayInvoice(orderId, {
            status: 'pending',
            invoiceId,
            totalAmount,
            uniqueCode: response.unique_code ?? null,
            qrImageUrl,
            payUrl,
            expiresAt: response.expires_at || null
        });
    } catch (error) {
        if (invoiceRecord) {
            try {
                updateQiospayInvoice(orderId, {
                    status: 'failed',
                    errorCode: error.code || 'QIOSPAY_ERROR'
                });
            } catch (saveError) {
                console.error('Gagal menyimpan status invoice QiosPay:', saveError.message || saveError);
            }
        }

        await bot.sendMessage(chatId, `❌ Invoice QiosPay belum dapat dibuat. Silakan coba lagi nanti.`);
        return;
    }

    const expiryDate = invoiceRecord.expiresAt ? new Date(invoiceRecord.expiresAt) : null;
    const expiry = expiryDate && Number.isFinite(expiryDate.getTime())
        ? expiryDate.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
        : 'mengikuti masa berlaku dari QiosPay';
    const caption =
        `💎 <b>Invoice Top Up Saldo</b>\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `Saldo yang diterima: <b>${formatRupiah(invoiceRecord.amount)}</b>\n` +
        `Total yang harus dibayar: <b>${formatRupiah(invoiceRecord.totalAmount)}</b>\n` +
        `Batas pembayaran: <b>${escapeHtml(expiry)}</b>\n` +
        `ID pesanan: <code>${escapeHtml(orderId)}</code>\n\n` +
        `QR dibuat khusus untuk invoice ini. Setelah membayar, tekan tombol cek status.`;
    const keyboard = [
        [{ text: '🔎 Cek Status Pembayaran', callback_data: `qiospay_status_${orderId}` }]
    ];
    if (invoiceRecord.payUrl) keyboard.push([{ text: '🔗 Buka Halaman Pembayaran', url: invoiceRecord.payUrl }]);

    try {
        if (invoiceRecord.qrImageUrl) {
            await bot.sendPhoto(chatId, invoiceRecord.qrImageUrl, {
                caption,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
            });
        } else {
            await bot.sendMessage(chatId, `${caption}\n\n${invoiceRecord.payUrl}`, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
            });
        }
    } catch (error) {
        await bot.sendMessage(chatId, `${caption}`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
        });
    }
}

async function sendAdditionalAccountFields(chatId, fields) {
    if (!fields.length) return;
    let message = "🧩 Detail tambahan akun:\n";
    for (const [label, value] of fields) {
        message += `${label}: ${value}\n`;
    }
    await bot.sendMessage(chatId, message);
}

async function sendMainMenu(chatId, userId, firstName) {
    const balance = await getBalance(userId);
    const isAdmin = Number(userId) === ADMIN_ID;
    const statusText = isAdmin ? "👑 Administrator / Owner" : "Active Reseller / Member";

    const welcomeText = 
`👑 <b>${BOT_NAME}</b>
━━━━━━━━━━━━━━━━━━━
👋 Halo, <b>${escapeHtml(firstName)}</b>! Selamat datang di bot penyedia akun VPN otomatis dan terpercaya.

🆔 <b>ID Anda:</b> <code>${userId}</code>
💰 <b>Saldo Anda:</b> Rp ${balance.toLocaleString('id-ID')}
👤 <b>Status:</b> ${statusText}

📞 <b>INFORMASI KONTAK & LAYANAN:</b>
💬 <b>WhatsApp Admin:</b> <code>+${WA_NUMBER}</code> (${WA_LINK})
✈️ <b>Telegram Admin:</b> @${ADMIN_USERNAME} (https://t.me/${ADMIN_USERNAME})
📢 <b>Saluran WhatsApp:</b> ${WA_CHANNEL}
📢 <b>Channel Telegram:</b> ${TG_CHANNEL}

📌 <i>Silakan pilih menu di bawah untuk mulai membuat atau mengelola akun VPN Anda:</i>`;

    bot.sendMessage(chatId, welcomeText, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "➕ Buat Akun", callback_data: "menu_buat_akun" },
                    { text: "🔄 Perpanjang Akun", callback_data: "menu_renew" }
                ],
                [
                    { text: "📊 Cek Server", callback_data: "menu_cek_server" },
                    { text: "🎁 Trial Akun", callback_data: "menu_trial" }
                ],
                [
                    { text: "💎 TopUp Saldo", callback_data: "menu_topup" }
                ]
            ]
        }
    });
}

// Handler logic untuk update Telegram
async function handleTelegramUpdate(update) {
    if (update.message) {
        const msg = update.message;
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const text = msg.text || '';

        if (text.startsWith('/start')) {
            await sendMainMenu(chatId, userId, msg.from.first_name || "User");
            return;
        }

        const session = userSessions[userId];
        if (session && session.awaitingInput) {
            if (session.awaitingInput === "topup_amount") {
                const input = text.trim();
                session.awaitingInput = null;
                if (!/^\d+$/.test(input)) {
                    return bot.sendMessage(chatId, 'Nominal harus berupa bilangan bulat dalam rupiah, contoh: 10000.');
                }
                const amount = Number(input);
                if (!Number.isSafeInteger(amount) || amount < 1000) {
                    return bot.sendMessage(chatId, 'Nominal top up minimum Rp 1.000.');
                }
                session.pendingTopupAmount = amount;
                session.pendingTopupNonce = crypto.randomBytes(6).toString('hex');
                await bot.sendMessage(
                    chatId,
                    `⚠️ <b>Konfirmasi invoice QRIS nyata</b>\n\nSaldo yang akan diterima: <b>${formatRupiah(amount)}</b>\n\nLanjutkan?`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '✅ Buat Invoice QRIS', callback_data: `qiospay_confirm_${session.pendingTopupNonce}` }],
                                [{ text: 'Batal', callback_data: `qiospay_cancel_${session.pendingTopupNonce}` }]
                            ]
                        }
                    }
                );
            } else if (session.awaitingInput === "username") {
                const inputUsername = text.trim();
                if (!/^[a-zA-Z0-9]+$/.test(inputUsername)) {
                    return bot.sendMessage(chatId, "❌ <b>Username tidak valid!</b> Hanya huruf dan angka.", { parse_mode: 'HTML' });
                }
                session.customUsername = inputUsername;
                if (session.protocol === "ssh") {
                    session.awaitingInput = "password";
                    return bot.sendMessage(chatId, `🔑 Masukkan <b>Password</b> untuk SSH:`, { parse_mode: 'HTML' });
                } else {
                    session.awaitingInput = null;
                    await processAccountCreation(chatId, userId);
                }
            } else if (session.awaitingInput === "password") {
                session.customPassword = text.trim();
                session.awaitingInput = null;
                await processAccountCreation(chatId, userId);
            }
        }
    } else if (update.callback_query) {
        const query = update.callback_query;
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        const userId = query.from.id;
        const data = query.data;

        if (!userSessions[userId]) userSessions[userId] = {};
        bot.answerCallbackQuery(query.id).catch(() => {});

        if (data.startsWith('qiospay_confirm_')) {
            const session = userSessions[userId];
            const nonce = data.slice('qiospay_confirm_'.length);
            if (!session || nonce !== session.pendingTopupNonce) {
                await bot.sendMessage(chatId, 'Tombol sudah kedaluwarsa.');
                return;
            }
            const amount = session.pendingTopupAmount;
            delete userSessions[userId].pendingTopupAmount;
            delete userSessions[userId].pendingTopupNonce;
            await createQiospayTopup(chatId, userId, amount);
        } else if (data === "menu_main") {
            bot.deleteMessage(chatId, messageId).catch(() => {});
            userSessions[userId].awaitingInput = null;
            await sendMainMenu(chatId, userId, query.from.first_name || "User");
        } else if (["menu_buat_akun", "menu_renew", "menu_trial"].includes(data)) {
            userSessions[userId].actionType = data;
            let title = "➕ <b>Pilih Kategori Server:</b>";
            bot.editMessageText(title, {
                chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "☁️ Cloudfront", callback_data: "cat_cloudfront" }, { text: "💎 Premium", callback_data: "cat_premium" }],
                        [{ text: "⬅️ Menu Utama", callback_data: "menu_main" }]
                    ]
                }
            });
        } else if (data.startsWith("cat_")) {
            const category = data.split("_")[1];
            userSessions[userId].category = category;
            bot.editMessageText(`📂 <b>Kategori: ${category}</b>\nPilih protokol:`, {
                chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🚀 Vmess", callback_data: "proto_vmess" }, { text: "⚡ Vless", callback_data: "proto_vless" }],
                        [{ text: "🔑 Trojan", callback_data: "proto_trojan" }, { text: "🔒 SSH", callback_data: "proto_ssh" }],
                        [{ text: "⬅️ Kembali", callback_data: userSessions[userId].actionType || "menu_buat_akun" }]
                    ]
                }
            });
        } else if (data.startsWith("proto_")) {
            const protocol = data.split("_")[1];
            userSessions[userId].protocol = protocol;
            const servers = await getServers();
            const keyboard = servers.map(s => [{ text: s.name || s.domain, callback_data: `select_srv_${s.server_id || s.id}` }]);
            keyboard.push([{ text: "⬅️ Kembali", callback_data: `cat_${userSessions[userId].category}` }]);
            bot.editMessageText(`🌐 <b>Pilih Server (${protocol.toUpperCase()}):</b>`, {
                chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
            });
        } else if (data.startsWith("select_srv_")) {
            const serverId = data.split("_")[2];
            userSessions[userId].serverId = serverId;
            userSessions[userId].awaitingInput = "username";
            bot.sendMessage(chatId, `👤 <b>Masukkan Username:</b>`, { parse_mode: 'HTML' });
        } else if (data === "menu_topup") {
            bot.deleteMessage(chatId, messageId).catch(() => {});
            userSessions[userId].awaitingInput = "topup_amount";
            bot.sendMessage(chatId, `💎 <b>Masukkan nominal top up (Rupiah):</b>`, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: "⬅️ Menu Utama", callback_data: "menu_main" }]] }
            });
        }
    }
}

async function processAccountCreation(chatId, userId) {
    const session = userSessions[userId];
    const serverId = session.serverId;
    const protocol = (session.protocol || "vless").toLowerCase();
    const username = session.customUsername || `user${Math.floor(1000 + Math.random() * 9000)}`;
    const password = session.customPassword || "123456";

    const loadMsg = await bot.sendMessage(chatId, `⏳ <b>Memproses akun ke NadiaVPN...</b>`, { parse_mode: 'HTML' });
    let result = await createVpnAccount(serverId, protocol, false, 'day', 1, username, password);

    if (isSuccessfulAccountResponse(result)) {
        const acc = unwrapAccountResponse(result);
        bot.deleteMessage(chatId, loadMsg.message_id).catch(() => {});
        bot.sendMessage(chatId, `✅ <b>Akun Berhasil Dibuat!</b>\nUsername: <code>${username}</code>`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: "⬅️ Menu Utama", callback_data: "menu_main" }]] }
        });
    } else {
        bot.deleteMessage(chatId, loadMsg.message_id).catch(() => {});
        bot.sendMessage(chatId, `❌ Gagal membuat akun.`, { parse_mode: 'HTML' });
    }
}

// Setup Express Web Server untuk Vercel
const app = express();

app.post('/api/bot', express.json(), async (req, res) => {
    try {
        await handleTelegramUpdate(req.body);
        res.status(200).send('OK');
    } catch (err) {
        console.error('Error handling telegram update:', err);
        res.status(500).send('Error');
    }
});

app.post('/webhook/qiospay', express.raw({ type: 'application/json', limit: '100kb' }), async (req, res) => {
    try {
        const event = verifyWebhook(req.body, req.get('X-QiosPay-Signature'), process.env.QIOSPAY_PRIVATE_KEY, 600);
        if (event?.event === 'invoice.paid' && event.data) {
            await settleQiospayInvoice(String(event.data.ref_id), event.data);
        }
        res.status(200).json({ received: true });
    } catch (err) {
        res.status(400).json({ received: false });
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: "ok", mode: "webhook" });
});

// Jalankan server lokal jika diuji di luar Vercel
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server berjalan di port ${PORT}`);
    });
}

module.exports = app;
