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
    throw new Error("TELEGRAM_TOKEN belum diatur. Tambahkan token bot melalui Replit Secrets.");
}
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

function errorSummary(error) {
    return {
        name: error?.name || 'Error',
        code: error?.response?.body?.error_code || error?.response?.statusCode || error?.code || 'UNKNOWN'
    };
}

function safeAsyncBotHandler(eventName, handler) {
    return (...args) => {
        Promise.resolve()
            .then(() => handler(...args))
            .catch(error => {
                console.error(`Telegram ${eventName} handler failed:`, errorSummary(error));
                const update = args[0];
                const chatId = update?.chat?.id || update?.message?.chat?.id;
                if (chatId) {
                    bot.sendMessage(chatId, 'Bot sedang mengalami gangguan sementara. Silakan coba lagi sebentar.')
                        .catch(() => {});
                }
            });
    };
}

bot.on('polling_error', error => {
    const details = errorSummary(error);
    console.error('Telegram polling error:', details);
    if (Number(details.code) === 409) {
        console.error('Telegram menolak polling ganda. Hentikan bot lain yang memakai token ini.');
    }
});

bot.on('error', error => {
    console.error('Telegram fatal error; meminta VM memulai ulang proses:', errorSummary(error));
    process.exit(1);
});

process.on('unhandledRejection', reason => {
    console.error('Unhandled promise rejection; meminta VM memulai ulang proses:', errorSummary(reason));
    process.exit(1);
});

process.on('uncaughtException', error => {
    console.error('Uncaught exception; meminta VM memulai ulang proses:', errorSummary(error));
    process.exit(1);
});

const BOT_NAME = "IJTZ VPN STORE";
const ADMIN_USERNAME = "ijtzvpn";
const ADMIN_ID = 8115833362; // ID Telegram Admin (Kamu)
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

        console.error('Pembuatan invoice QiosPay gagal:', {
            code: error.code || 'UNKNOWN',
            status: error.status || 0
        });
        const message = error.status === 401
            ? 'Autentikasi QiosPay ditolak. Admin perlu memeriksa API key di Secrets.'
            : error.code === 'KEY_MODE_MISMATCH'
                ? 'API key QiosPay bukan key live yang cocok. Admin perlu memeriksa kredensial QiosPay di Secrets.'
                : 'Invoice QiosPay belum dapat dibuat. Silakan coba lagi nanti atau hubungi admin.';
        await bot.sendMessage(chatId, `❌ ${message}`);
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
        console.error('Gagal mengirim QR invoice QiosPay ke Telegram:', error.message || error);
        const fallback = invoiceRecord.payUrl
            ? `\n\nHalaman pembayaran: ${invoiceRecord.payUrl}`
            : '';
        await bot.sendMessage(chatId, `${caption}${fallback}`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
        });
    }
}

async function sendAdditionalAccountFields(chatId, fields) {
    if (!fields.length) return;

    const maxLength = 3500;
    let message = "🧩 Detail tambahan akun:\n";
    for (const [label, value] of fields) {
        const line = `${label}: ${value}`;
        const parts = [];
        let remaining = Array.from(line);

        while (remaining.length > maxLength - 1) {
            parts.push(remaining.splice(0, maxLength - 1).join(''));
        }
        if (remaining.length) parts.push(remaining.join(''));

        for (const part of parts) {
            if (message.length + part.length + 1 > maxLength) {
                await bot.sendMessage(chatId, message);
                message = "🧩 Detail tambahan akun:\n";
            }
            message += `${part}\n`;
        }
    }

    if (message.trim() !== "🧩 Detail tambahan akun:") {
        await bot.sendMessage(chatId, message);
    }
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

bot.onText(/\/start/, safeAsyncBotHandler('start', async (msg) => {
    await sendMainMenu(msg.chat.id, msg.from.id, msg.from.first_name || "User");
}));

bot.on('message', safeAsyncBotHandler('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const session = userSessions[userId];

    if (!session || !session.awaitingInput) return;

    if (session.awaitingInput === "topup_amount") {
        const input = msg.text.trim();
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
            `⚠️ <b>Konfirmasi invoice QRIS nyata</b>\n\nSaldo yang akan diterima: <b>${formatRupiah(amount)}</b>\nQiosPay tidak menyediakan sandbox; membuat invoice ini akan menghasilkan transaksi nyata yang kedaluwarsa jika tidak dibayar.\n\nLanjutkan?`,
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
    }
    else if (session.awaitingInput === "username") {
        const inputUsername = msg.text.trim();

        if (!/^[a-zA-Z0-9]+$/.test(inputUsername)) {
            return bot.sendMessage(chatId, "❌ <b>Username tidak valid!</b>\n\nUsername hanya boleh berisi huruf dan angka saja. Silakan ketik ulang:", { parse_mode: 'HTML' });
        }

        session.customUsername = inputUsername;

        if (session.protocol === "ssh") {
            session.awaitingInput = "password";
            return bot.sendMessage(chatId, `🔑 <b>Username:</b> <code>${inputUsername}</code>\n\nSilakan masukkan <b>Password</b> untuk akun SSH Anda:`, { parse_mode: 'HTML' });
        } else {
            session.awaitingInput = null;
            await processAccountCreation(chatId, userId);
        }
    } 
    else if (session.awaitingInput === "password") {
        const inputPassword = msg.text.trim();
        session.customPassword = inputPassword;
        session.awaitingInput = null;

        await processAccountCreation(chatId, userId);
    }
}));

bot.on('callback_query', safeAsyncBotHandler('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const userId = query.from.id;
    const data = query.data;

    if (!userSessions[userId]) userSessions[userId] = {};

    bot.answerCallbackQuery(query.id);

    if (data.startsWith('qiospay_confirm_')) {
        const session = userSessions[userId];
        const nonce = data.slice('qiospay_confirm_'.length);
        if (!session || nonce !== session.pendingTopupNonce) {
            await bot.sendMessage(chatId, 'Tombol konfirmasi ini sudah kedaluwarsa. Mulai lagi dari menu Top Up.');
            return;
        }
        const amount = session.pendingTopupAmount;
        delete userSessions[userId].pendingTopupAmount;
        delete userSessions[userId].pendingTopupNonce;
        if (!Number.isSafeInteger(amount) || amount < 1000) {
            await bot.sendMessage(chatId, 'Tidak ada nominal top up yang menunggu konfirmasi. Mulai lagi dari menu Top Up.');
            return;
        }
        await createQiospayTopup(chatId, userId, amount);
        return;
    }

    else if (data.startsWith('qiospay_cancel_')) {
        const session = userSessions[userId];
        const nonce = data.slice('qiospay_cancel_'.length);
        if (!session || nonce !== session.pendingTopupNonce) {
            await bot.sendMessage(chatId, 'Tombol batal ini sudah kedaluwarsa.');
            return;
        }
        delete userSessions[userId].pendingTopupAmount;
        delete userSessions[userId].pendingTopupNonce;
        await bot.sendMessage(chatId, 'Pembuatan invoice dibatalkan; belum ada transaksi QiosPay yang dibuat.');
        return;
    }

    else if (data.startsWith('qiospay_status_')) {
        const orderId = data.slice('qiospay_status_'.length);
        const invoice = getQiospayInvoice(orderId);
        if (!invoice || invoice.userId !== String(userId)) {
            await bot.sendMessage(chatId, 'Invoice tidak ditemukan atau bukan milik akun Anda.');
            return;
        }
        if (invoice.status === 'paid') {
            await bot.sendMessage(chatId, '✅ Pembayaran ini sudah dikonfirmasi dan saldonya sudah masuk.');
            return;
        }

        try {
            const client = new QiosPayClient();
            const remoteInvoice = await client.getInvoice(invoice.invoiceId || orderId);
            if (remoteInvoice?.status === 'paid') {
                const settlement = await settleQiospayInvoice(orderId, remoteInvoice);
                if (!settlement.ok) {
                    console.error('Status invoice QiosPay tidak cocok:', settlement.reason);
                    await bot.sendMessage(chatId, 'Status pembayaran diterima, tetapi datanya belum cocok dengan pesanan. Saldo tidak diubah; hubungi admin.');
                }
            } else if (['expired', 'cancelled', 'canceled'].includes(String(remoteInvoice?.status || '').toLowerCase())) {
                updateQiospayInvoice(orderId, { status: 'expired' });
                await bot.sendMessage(chatId, 'Invoice sudah kedaluwarsa atau dibatalkan. Buat invoice top up baru.');
            } else {
                await bot.sendMessage(chatId, 'Pembayaran belum terdeteksi. Jika baru membayar, tunggu sebentar lalu cek kembali.');
            }
        } catch (error) {
            console.error('Pengecekan status QiosPay gagal:', { code: error.code || 'UNKNOWN', status: error.status || 0 });
            await bot.sendMessage(chatId, 'Status belum bisa diperiksa. Coba lagi beberapa saat.');
        }
        return;
    }

    else if (data === "menu_main") {
        bot.deleteMessage(chatId, messageId).catch(() => {});
        userSessions[userId].awaitingInput = null;
        delete userSessions[userId].pendingTopupAmount;
        delete userSessions[userId].pendingTopupNonce;
        await sendMainMenu(chatId, userId, query.from.first_name || "User");
        return;
    }

    else if (["menu_buat_akun", "menu_renew", "menu_trial"].includes(data)) {
        userSessions[userId].actionType = data;
        
        let title = "➕ <b>Pilih Kategori Server (Buat Akun):</b>";
        if (data === "menu_renew") title = "🔄 <b>Pilih Kategori Server (Perpanjang):</b>";
        if (data === "menu_trial") title = "🎁 <b>Pilih Kategori Server (Trial Gratis):</b>";

        bot.editMessageText(title, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "☁️ Cloudfront", callback_data: "cat_cloudfront" },
                        { text: "💎 Premium", callback_data: "cat_premium" }
                    ],
                    [{ text: "⬅️ Menu Utama", callback_data: "menu_main" }]
                ]
            }
        });
    }

    else if (data.startsWith("cat_")) {
        const category = data.split("_")[1];
        userSessions[userId].category = category;
        const catName = category === "cloudfront" ? "Cloudfront" : "Premium";

        bot.editMessageText(`📂 <b>Kategori: ${catName}</b>\nSilakan pilih protokol:`, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "🚀 Vmess", callback_data: "proto_vmess" },
                        { text: "⚡ Vless", callback_data: "proto_vless" }
                    ],
                    [
                        { text: "🔑 Trojan", callback_data: "proto_trojan" },
                        { text: "🔒 SSH", callback_data: "proto_ssh" }
                    ],
                    [{ text: "⬅️ Kembali", callback_data: userSessions[userId].actionType || "menu_buat_akun" }]
                ]
            }
        });
    }

    else if (data.startsWith("proto_")) {
        const protocol = data.split("_")[1];
        userSessions[userId].protocol = protocol;
        const category = userSessions[userId].category || "cloudfront";
        const actionType = userSessions[userId].actionType;

        bot.editMessageText(`⏳ <b>Mengambil daftar server ${protocol.toUpperCase()}...</b>`, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML'
        });

        const servers = await getServers();
        if (!servers || servers.length === 0) {
            return bot.editMessageText("❌ <b>Gagal mengambil daftar server dari NadiaVPN.</b>", {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: `cat_${category}` }]] }
            });
        }

        const filtered = servers.filter(s => {
            const name = (s.name || s.domain || "").toLowerCase();
            const categoryMatches = category === "cloudfront"
                ? name.includes("cloudfront")
                : !name.includes("cloudfront");
            const protocolMatches = supportsServerOption(s, 'supported_protocols', protocol);
            const trialMatches = actionType !== "menu_trial" || s.trial_enabled !== false;
            return categoryMatches && protocolMatches && trialMatches;
        });

        const targetServers = filtered;
        if (targetServers.length === 0) {
            const categoryName = category === "cloudfront" ? "Cloudfront" : "Premium";
            return bot.editMessageText(`❌ <b>Belum ada server ${categoryName} yang mendukung ${protocol.toUpperCase()}${actionType === "menu_trial" ? " untuk trial" : ""}.</b>`, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: `cat_${category}` }]] }
            });
        }

        const keyboard = targetServers.map(s => {
            const sName = s.name || s.domain || "Server";
            const sId = s.server_id || s.id;

            const capacity = getServerCapacity(s);
            const countLabel = `[${formatCapacityLabel(capacity)}]`;

            const isFreeSsh = protocol === "ssh" && category === "cloudfront" && (sName.toLowerCase().includes("free") || sName.toLowerCase().includes("gratis"));
            const priceLabel = actionType === "menu_trial" ? "" : (isFreeSsh ? "(GRATIS)" : "(Rp 10.000)");

            const indicator = capacity.isFull || capacity.isUnavailable
                ? "🔴"
                : capacity.known ? "🟢" : "⚪";
            return [{ text: `${indicator} ${sName} ${countLabel} ${priceLabel}`, callback_data: `select_srv_${sId}` }];
        });

        keyboard.push([{ text: "⬅️ Kembali", callback_data: `cat_${category}` }]);

        bot.editMessageText(`🌐 <b>Pilih Server ${category.toUpperCase()} (${protocol.toUpperCase()})</b>`, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
        });
    }

    else if (data === "server_full") {
        bot.answerCallbackQuery(query.id, { text: "⚠️ Server ini sudah penuh (Full)! Silakan pilih server lain.", show_alert: true });
        return;
    }
    else if (data === "server_unavailable") {
        bot.answerCallbackQuery(query.id, { text: "⚠️ Server sedang offline atau tidak tersedia. Silakan pilih server lain.", show_alert: true });
        return;
    }

    else if (data.startsWith("select_srv_")) {
        const serverId = data.split("_")[2];
        const actionType = userSessions[userId].actionType;
        const protocol = userSessions[userId].protocol || "vless";
        const category = userSessions[userId].category || "cloudfront";

        const servers = await getServers();
        const selectedServer = servers.find(s => String(s.server_id || s.id) === String(serverId));
        if (!selectedServer) {
            return bot.sendMessage(chatId, "⚠️ Status server tidak dapat diverifikasi saat ini. Silakan muat ulang daftar server sebelum order.", {
                reply_markup: { inline_keyboard: [[{ text: "🔄 Muat Ulang Server", callback_data: `proto_${protocol}` }]] }
            });
        }

        const capacity = getServerCapacity(selectedServer);
        if (capacity.isFull || capacity.isUnavailable) {
            return bot.sendMessage(chatId, `⚠️ Server ${selectedServer.name || selectedServer.domain || serverId} sedang ${capacity.isFull ? "penuh" : "offline"}. Silakan pilih server lain.`, {
                reply_markup: { inline_keyboard: [[{ text: "🔄 Muat Ulang Server", callback_data: `proto_${protocol}` }]] }
            });
        }
        if (!supportsServerOption(selectedServer, 'supported_protocols', protocol)) {
            return bot.sendMessage(chatId, `⚠️ Server ini tidak mendukung protokol ${protocol.toUpperCase()}. Silakan pilih server lain.`, {
                reply_markup: { inline_keyboard: [[{ text: "🔄 Muat Ulang Server", callback_data: `proto_${protocol}` }]] }
            });
        }
        if (actionType === "menu_trial" && selectedServer.trial_enabled === false) {
            return bot.sendMessage(chatId, "⚠️ Server ini tidak menyediakan akun trial. Silakan pilih server lain.", {
                reply_markup: { inline_keyboard: [[{ text: "🔄 Muat Ulang Server", callback_data: `proto_${protocol}` }]] }
            });
        }

        userSessions[userId].serverId = serverId;
        const sName = (selectedServer?.name || "").toLowerCase();
        
        const isFreeSshServer = protocol === "ssh" && category === "cloudfront" && (sName.includes("free") || sName.includes("gratis"));
        userSessions[userId].isFreeSsh = isFreeSshServer;

        if (actionType === "menu_trial") {
            userSessions[userId].durType = "day";
            userSessions[userId].awaitingInput = null;
            await processAccountCreation(chatId, userId);
            return;
        }

        const durationOptions = [
            { value: "day", label: "📆 Hari" },
            { value: "week", label: "🗓 Minggu" },
            { value: "month", label: "📅 Bulan" }
        ].filter(option => supportsServerOption(selectedServer, 'supported_types', option.value));

        if (durationOptions.length === 0) {
            return bot.sendMessage(chatId, "⚠️ Server ini tidak menyediakan durasi order yang dikenali bot.", {
                reply_markup: { inline_keyboard: [[{ text: "🔄 Muat Ulang Server", callback_data: `proto_${protocol}` }]] }
            });
        }

        const durationKeyboard = [];
        for (let index = 0; index < durationOptions.length; index += 2) {
            durationKeyboard.push(durationOptions.slice(index, index + 2).map(option => ({
                text: option.label,
                callback_data: `dur_type_${option.value}`
            })));
        }
        durationKeyboard.push([{ text: "⬅️ Kembali", callback_data: `proto_${protocol}` }]);

        bot.editMessageText("📅 <b>Pilih Tipe Durasi:</b>", {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: durationKeyboard }
        });
    }

    else if (data.startsWith("dur_type_")) {
        const durType = data.split("_")[2];
        userSessions[userId].durType = durType;

        userSessions[userId].awaitingInput = "username";

        bot.sendMessage(chatId, `👤 <b>Masukkan Username untuk Akun ${userSessions[userId].protocol.toUpperCase()}:</b>\n<i>(Hanya huruf dan angka, contoh: user123)</i>`, {
            parse_mode: 'HTML'
        });
    }

    else if (data === "menu_topup") {
        bot.deleteMessage(chatId, messageId).catch(() => {});
        userSessions[userId].awaitingInput = "topup_amount";
        delete userSessions[userId].pendingTopupAmount;
        delete userSessions[userId].pendingTopupNonce;
        bot.sendMessage(chatId,
`💎 <b>Top Up Saldo via QRIS QiosPay</b>
━━━━━━━━━━━━━━━━━━━
Masukkan nominal saldo dalam rupiah (minimum Rp 1.000). Bot akan membuat invoice dan QR khusus untuk pesanan ini. Saldo hanya bertambah setelah pembayaran terverifikasi.`, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "⬅️ Menu Utama", callback_data: "menu_main" }]
                ]
            }
        });
    }

    else if (data === "menu_cek_server") {
        bot.editMessageText("⏳ <b>Memeriksa status server NadiaVPN...</b>", {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML'
        });

        const servers = await getServers();
        let statusText = "🟢 <b>STATUS SERVER & KUOTA (REAL-TIME):</b>\n━━━━━━━━━━━━━━━━━━━\n\n";

        if (servers && servers.length > 0) {
            servers.forEach(s => {
                const capacity = getServerCapacity(s);
                const badge = capacity.isFull
                    ? "🔴 FULL"
                    : capacity.isUnavailable
                        ? "⚫ Offline"
                        : capacity.isAvailable
                            ? "🟢 Tersedia"
                            : "⚪ Status tidak diketahui";

                statusText += `🌐 <b>${escapeHtml(s.name || s.domain)}</b>\n└ Status: ${badge} [${formatCapacityLabel(capacity)}]\n\n`;
            });
        } else {
            statusText += "❌ Gagal memuat data server.";
        }

        bot.editMessageText(statusText, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: "⬅️ Menu Utama", callback_data: "menu_main" }]] }
        });
    }
}));

const app = express();

app.post('/webhook/qiospay', express.raw({ type: 'application/json', limit: '100kb' }), async (req, res) => {
    try {
        const event = verifyWebhook(
            req.body,
            req.get('X-QiosPay-Signature'),
            process.env.QIOSPAY_PRIVATE_KEY,
            600
        );

        if (event?.event !== 'invoice.paid') {
            return res.status(200).json({ received: true });
        }
        if (!event.data || !event.data.ref_id) {
            return res.status(400).json({ received: false, error: 'invalid_event' });
        }

        const result = await settleQiospayInvoice(String(event.data.ref_id), event.data);
        if (!result.ok) {
            console.warn('Webhook pembayaran QiosPay tidak dikreditkan:', result.reason);
        }
        return res.status(200).json({ received: true });
    } catch (error) {
        if (error.code === 'BAD_SIGNATURE' || error.code === 'INVALID_BODY') {
            return res.status(error.status || 401).json({ received: false, error: 'invalid_signature_or_body' });
        }
        console.error('Webhook QiosPay gagal diproses:', { code: error.code || 'UNKNOWN' });
        return res.status(error.code === 'CONFIG_MISSING' ? 503 : 500)
            .json({ received: false, error: 'webhook_processing_failed' });
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/healthz', (_req, res) => {
    res.status(200).json({
        status: "ok",
        telegramPolling: bot.isPolling()
    });
});

async function processAccountCreation(chatId, userId) {
    const session = userSessions[userId];
    const isTrialMenu = session.actionType === "menu_trial";
    const durType = session.durType || "day";
    const durVal = 1;
    const serverId = session.serverId;
    const protocol = (session.protocol || "vless").toLowerCase();
    const isFreeSsh = session.isFreeSsh || false;
    
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    const username = isTrialMenu ? `trial${randomNum}` : (session.customUsername || `user${randomNum}`);
    const password = isTrialMenu ? `pass${randomNum}` : (session.customPassword || "123456");

    const isAdmin = Number(userId) === ADMIN_ID;
    const PRICE = (isTrialMenu || isFreeSsh) ? 0 : 10000;

    const latestServers = await getServers();
    const latestServer = latestServers.find(server => String(server.server_id || server.id) === String(serverId));
    if (!latestServer) {
        return bot.sendMessage(chatId, "⚠️ Status server tidak dapat diverifikasi. Saldo belum dipotong. Silakan muat ulang daftar server sebelum order.", {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: "🔄 Muat Ulang Server", callback_data: `proto_${protocol}` }]] }
        });
    }

    if (!supportsServerOption(latestServer, 'supported_protocols', protocol)) {
        return bot.sendMessage(chatId, `⚠️ Server tidak mendukung protokol ${protocol.toUpperCase()}. Saldo belum dipotong.`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: "🔄 Muat Ulang Server", callback_data: `proto_${protocol}` }]] }
        });
    }
    if (isTrialMenu && latestServer.trial_enabled === false) {
        return bot.sendMessage(chatId, "⚠️ Server ini tidak menyediakan akun trial. Saldo belum dipotong.", {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: "🔄 Muat Ulang Server", callback_data: `proto_${protocol}` }]] }
        });
    }
    if (!isTrialMenu && !supportsServerOption(latestServer, 'supported_types', durType)) {
        return bot.sendMessage(chatId, `⚠️ Server tidak mendukung durasi ${durType}. Saldo belum dipotong.`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: "🔄 Muat Ulang Server", callback_data: `proto_${protocol}` }]] }
        });
    }

    const latestCapacity = getServerCapacity(latestServer);
    if (latestCapacity.isFull || latestCapacity.isUnavailable) {
        const statusLabel = latestCapacity.isFull ? "penuh" : "offline";
        return bot.sendMessage(chatId, `⚠️ Server ${escapeHtml(latestServer.name || latestServer.domain || serverId)} sedang ${statusLabel}. Saldo belum dipotong. Silakan pilih server lain.`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: "🔄 Muat Ulang Server", callback_data: `proto_${protocol}` }]] }
        });
    }

    let balanceCharged = false;
    if (isTrialMenu) {
        if (!isAdmin) {
            const canTrial = await checkAndSetTrial(userId);
            if (!canTrial) {
                return bot.sendMessage(chatId, "❌ <b>Kamu sudah mengambil jatah trial hari ini.</b>\n\nSilakan coba lagi besok!", {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: "⬅️ Menu Utama", callback_data: "menu_main" }]] }
                });
            }
        }
    } else if (PRICE > 0) {
        try {
            await deductBalance(userId, PRICE);
            balanceCharged = true;
        } catch (err) {
            return bot.sendMessage(chatId, `❌ <b>Gagal:</b> ${err.message || err}\n\nSaldo kamu tidak mencukupi untuk membuat akun.`, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "💎 TopUp Saldo", callback_data: "menu_topup" }],
                        [{ text: "⬅️ Menu Utama", callback_data: "menu_main" }]
                    ]
                }
            });
        }
    }

    const loadMsg = await bot.sendMessage(chatId, `⏳ <b>Sedang memproses akun ${protocol.toUpperCase()} ke NadiaVPN...</b>`, { parse_mode: 'HTML' });

    let result;
    try {
        result = await createVpnAccount(serverId, protocol, isTrialMenu, durType, durVal, username, password);
    } catch (error) {
        result = { status: false, message: error.message || "Kesalahan saat menghubungi NadiaVPN." };
    }

    if (isSuccessfulAccountResponse(result)) {
        const orderAccount = unwrapAccountResponse(result);
        const accountId =
            findAccountField(orderAccount, ['account_id', 'account_uuid', 'vpn_account_id', 'id_account']) ||
            findAccountField(orderAccount, ['id']);
        if (accountId) {
            const detailsResult = await getAccountDetails(accountId);
            if (isSuccessfulAccountResponse(detailsResult)) {
                result = {
                    status: true,
                    data: combineAccountResponses(result, detailsResult)
                };
            }
        }
    }

    if (isSuccessfulAccountResponse(result)) {
        const acc = unwrapAccountResponse(result);
        const accountField = (...aliases) => findAccountField(acc, aliases);

        const resUsername = accountField('username', 'user', 'login', 'login_user') || username;
        const resPassword = accountField('password', 'pass', 'passwd') || password;
        const uuidVal = accountField('uuid', 'uuid_key', 'client_uuid', 'password', 'pass') || resPassword;
        
        const host = accountField('config.hostname', 'domain', 'hostname', 'server_host', 'server_ip', 'ip_server', 'ip', 'host') || "NadiaVPN Server";
        const mode = accountField('mode', 'network_mode') || session.category?.toUpperCase() || "VPN";
        const isp = accountField('config.isp', 'isp', 'provider');
        const city = accountField('config.city', 'city', 'location', 'region');
        const accountType = accountField('type');
        const daysLeft = accountField('days_left', 'remaining_days');
        const apiDuration = accountField('config.time', 'time', 'trial_duration', 'duration', 'expired_duration');
        const duration = apiDuration ||
            [accountType, daysLeft ? `${daysLeft} hari tersisa` : null].filter(Boolean).join(' · ') ||
            (isTrialMenu ? "1 Jam" : `${durVal} ${durType}`);
        const expire = accountField('config.expired', 'expired', 'expire_at', 'expire', 'expired_at', 'expires_at');
        const ipLimit = accountField('ip_limit', 'limit_ip', 'max_ip', 'ip_limit_count');

        let successMsg = "";
        let structuredSshDetails = null;

        if (protocol === "ssh") {
            const sshDetails = getSshConnectionDetails(acc);
            structuredSshDetails = sshDetails;
            const renderRows = rows => rows.length
                ? rows.map(([label, value]) => `- <b>${escapeHtml(label)}</b>: <code>${escapeHtml(value)}</code>`).join('\n')
                : "<i>Tidak disertakan oleh API</i>";
            const renderPayloads = payloads => payloads.length
                ? payloads.map(([label, value]) => {
                    const formatted = String(value).replace(/\[crlf\]/gi, '\n').replace(/\[lf\]/gi, '\n');
                    return `- <b>${escapeHtml(label)}</b>\n<pre>${escapeHtml(formatted)}</pre>`;
                }).join('\n')
                : "<i>Tidak disertakan oleh API</i>";

            const sshLink = accountField('config.ssh_link', 'ssh_link', 'ssh_url', 'url', 'config_link');
            const headerTitle = isTrialMenu ? `✅ <b>TRIAL SSH BERHASIL</b>` : `✅ <b>AKUN SSH BERHASIL DIBUAT</b>`;

            successMsg = 
`${headerTitle}

🔒 <b>Akun SSH ${mode} ${isTrialMenu ? 'Trial' : ''}</b>
━━━━━━━━━━━━━━━━━━━
👤 <b>Username</b> : <code>${escapeHtml(resUsername)}</code>
🔑 <b>Password</b> : <code>${escapeHtml(resPassword)}</code>
🌐 <b>Host / IP</b> : <code>${escapeHtml(host)}</code>
🏢 <b>ISP</b> : ${escapeHtml(isp || "Tidak disertakan oleh API")}
🏙 <b>City</b> : ${escapeHtml(city || "Tidak disertakan oleh API")}
📌 <b>Masa Aktif</b> : ${escapeHtml(duration)}
⌛ <b>Expired</b> : <code>${escapeHtml(expire || "Tidak disertakan oleh API")}</code>
📌 <b>IP Limit</b> : ${escapeHtml(ipLimit || "Tidak disertakan oleh API")}
───────────────────
🔌 <b>Port Server:</b>
${renderRows(sshDetails.ports)}
───────────────────
🌐 <b>Proxy &amp; Konfigurasi:</b>
${renderRows(sshDetails.services)}
───────────────────
📊 <b>Payload:</b>
${renderPayloads(sshDetails.payloads)}
───────────────────
🔗 <b>Format / Link SSH:</b>
${sshLink ? `<code>${escapeHtml(sshLink)}</code>` : "<i>Tidak disertakan oleh API</i>"}`;
        } else {
            const portTls = accountField('config.port.tls', 'port_tls', 'tls_port', 'ports_tls', 'ports.tls');
            const portNonTls = accountField('config.port.none', 'config.port.nontls', 'port_nontls', 'port_non_tls', 'nontls_port', 'non_tls_port', 'ports.nontls', 'ports.non_tls');
            const portAny = accountField('config.port.any', 'port_any', 'any_port', 'ports_any', 'ports.any');

            const pathWs = accountField('config.path.stn', 'path_ws', 'ws_path', 'path', 'paths.ws');
            const pathMulti = accountField('config.path.multi', 'path_multi', 'multi_path');
            const pathGrpc = accountField('config.path.grpc', 'path_grpc', 'grpc_path', 'service_name', 'grpc_service', 'paths.grpc');
            const pathUpgrade = accountField('config.path.up', 'path_upgrade', 'upgrade_path', 'path_upgrade_ws', 'paths.upgrade');

            const encHost = encodeURIComponent(host);
            
            const linkTls = accountField('config.link.tls', 'link_tls', 'tls_link', 'tls_url', 'links.tls', 'link.tls') ||
                `${protocol}://${uuidVal}@${host}:443?path=%2F${protocol}&security=tls&encryption=none&host=${encHost}&type=ws&sni=${encHost}#${resUsername}`;

            const linkNonTls = accountField('config.link.none', 'link_nontls', 'link_non_tls', 'nontls_link', 'non_tls_link', 'links.none', 'link.none', 'links.non_tls', 'link.non_tls') ||
                `${protocol}://${uuidVal}@${host}:80?path=%2F${protocol}&security=none&encryption=none&host=${encHost}&type=ws#${resUsername}`;

            const linkGrpc = accountField('config.link.grpc', 'link_grpc', 'grpc_link', 'grpc_url', 'links.grpc', 'link.grpc') ||
                `${protocol}://${uuidVal}@${host}:443?mode=gun&security=tls&encryption=none&type=grpc&serviceName=${protocol}&sni=${encHost}#${resUsername}`;

            const linkUpTls = accountField('config.link.uptls', 'link_uptls', 'link_upgrade', 'upgrade_link', 'link_ws_upgrade', 'upgrade', 'links.upgrade', 'link.upgrade') ||
                `${protocol}://${uuidVal}@${host}:443?path=%2F__up${protocol}&security=tls&encryption=none&host=${encHost}&type=httpupgrade&sni=${encHost}#${resUsername}`;
            const linkUpNonTls = accountField('config.link.upntls', 'link_upntls', 'upgrade_non_tls_link');

            const headerTitle = isTrialMenu ? `✅ <b>TRIAL ${escapeHtml(mode)} BERHASIL</b>` : `✅ <b>AKUN ${protocol.toUpperCase()} BERHASIL DIBUAT</b>`;
            
            successMsg = 
`${headerTitle}

🟢 <b>Akun ${protocol.toUpperCase()} ${escapeHtml(mode)} ${isTrialMenu ? 'Trial' : ''}</b>

👤 <b>Username</b> : <code>${escapeHtml(resUsername)}</code>
🌐 <b>Host</b> : <code>${escapeHtml(host)}</code>
☁️ <b>Mode</b> : ${escapeHtml(mode)}
🏢 <b>ISP</b> : ${escapeHtml(isp || "Tidak disertakan oleh API")}
🏙 <b>City</b> : ${escapeHtml(city || "Tidak disertakan oleh API")}
🔑 <b>UUID</b> : <code>${escapeHtml(uuidVal)}</code>
📌 <b>Masa Aktif</b> : ${escapeHtml(duration)}
⌛ <b>Expired</b> : <code>${escapeHtml(expire || "Tidak disertakan oleh API")}</code>
📌 <b>IP Limit</b> : ${escapeHtml(ipLimit || "Tidak disertakan oleh API")}
───────────────────
🔌 <b>Ports:</b>
- TLS : ${escapeHtml(portTls || "Tidak disertakan oleh API")}
- Non TLS : ${escapeHtml(portNonTls || "Tidak disertakan oleh API")}
- Any Port : ${escapeHtml(portAny || "Tidak disertakan oleh API")}
───────────────────
📊 <b>Path:</b>
- WS : ${escapeHtml(pathWs || "Tidak disertakan oleh API")}
- Multi : ${escapeHtml(pathMulti || "Tidak disertakan oleh API")}
- gRPC : ${escapeHtml(pathGrpc || "Tidak disertakan oleh API")}
- Upgrade : ${escapeHtml(pathUpgrade || "Tidak disertakan oleh API")}
───────────────────
🔗 <b>${protocol.toUpperCase()} Links (${escapeHtml(mode)}):</b>
- <b>TLS</b> :
<code>${escapeHtml(linkTls)}</code>

- <b>Non TLS</b> :
<code>${escapeHtml(linkNonTls)}</code>

- <b>gRPC</b> :
<code>${escapeHtml(linkGrpc)}</code>

- <b>Up TLS</b> :
<code>${escapeHtml(linkUpTls)}</code>

- <b>Up Non TLS</b> :
${linkUpNonTls ? `<code>${escapeHtml(linkUpNonTls)}</code>` : "<i>Tidak disertakan oleh API</i>"}`;
        }

        const displayedKeys = [
            'username', 'user', 'login', 'login_user', 'password', 'pass', 'passwd',
            'uuid', 'uuid_key', 'client_uuid', 'password', 'pass', 'domain', 'hostname',
            'server_host', 'server_ip', 'ip_server', 'ip', 'host', 'mode', 'network_mode',
            'isp', 'provider', 'city', 'location', 'region', 'time', 'trial_duration',
            'duration', 'expired_duration', 'expired', 'expire_at', 'expire',
            'expired_at', 'expires_at', 'ip_limit', 'limit_ip', 'max_ip',
            'ip_limit_count', 'port', 'ssh_port', 'port_ssh', 'ssl_port',
            'port_ssl', 'port_tls', 'dropbear_port', 'ws_port', 'port_ws',
            'port_http', 'websocket_port', 'udp_custom', 'port_udp', 'udp_port',
            'payload', 'path', 'ws_path', 'payload_ws', 'ssh_link', 'link',
            'url', 'config_link', 'port_nontls', 'port_non_tls', 'nontls_port',
            'non_tls_port', 'port_any', 'any_port', 'ports_any', 'path_ws',
            'path_grpc', 'grpc_path', 'service_name', 'grpc_service',
            'path_upgrade', 'upgrade_path', 'path_upgrade_ws', 'link_tls',
            'tls_link', 'tls_url', 'link_nontls', 'link_non_tls', 'nontls_link',
            'non_tls_link', 'none', 'link_grpc', 'grpc_link', 'grpc_url',
            'link_uptls', 'link_upgrade', 'upgrade_link', 'link_ws_upgrade',
            'upgrade', 'ports.tls', 'ports.nontls', 'ports.non_tls', 'ports.any',
            'paths.ws', 'paths.grpc', 'paths.upgrade', 'links.tls', 'link.tls',
            'links.none', 'link.none', 'links.non_tls', 'link.non_tls',
            'links.grpc', 'link.grpc', 'links.upgrade', 'link.upgrade',
            'protocol', 'type', 'days_left', 'remaining_days',
            'config.port.openssh', 'config.port.ssh', 'config.port.dropbear',
            'config.port.ws_tls', 'config.port.ws_http', 'config.port.squid',
            'config.port.badvpn', 'config.port.openvpn_tcp', 'config.port.openvpn',
            'config.squid_proxy', 'config.proxy.squid', 'config.http_proxy',
            'config.proxy.http', 'config.http_custom', 'config.proxy.http_custom',
            'config.ovpn_tcp', 'config.openvpn_tcp', 'config.openvpn.tcp',
            'config.servername', 'config.server_name', 'servername', 'server_name',
            'config.ssh_link', 'ssh_link', 'ssh_url', 'config_link'
        ];
        if (structuredSshDetails) {
            displayedKeys.push(...structuredSshDetails.payloadPaths);
        }
        const additionalFields = getAdditionalAccountFields(acc, displayedKeys);

        bot.deleteMessage(chatId, loadMsg.message_id).catch(() => {});
        bot.sendMessage(chatId, successMsg, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: "⬅️ Menu Utama", callback_data: "menu_main" }]] }
        });
        await sendAdditionalAccountFields(chatId, additionalFields);
    } else {
        const errMsg = result?.message || result?.msg || "Gagal membuat akun / Server offline.";
        let refundMessage = "";
        if (balanceCharged) {
            try {
                await addBalance(userId, PRICE);
                refundMessage = "\n\nSaldo telah dikembalikan karena akun gagal dibuat.";
            } catch (refundError) {
                console.error("Gagal mengembalikan saldo setelah order gagal:", refundError.message || refundError);
                refundMessage = "\n\nSaldo belum berhasil dikembalikan. Silakan hubungi admin untuk pengecekan.";
            }
        }
        bot.deleteMessage(chatId, loadMsg.message_id).catch(() => {});
        bot.sendMessage(chatId, `❌ <b>Gagal Membuat Akun:</b>\n<code>${escapeHtml(errMsg)}</code>${refundMessage}`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: "⬅️ Menu Utama", callback_data: "menu_main" }]] }
        });
    }
}

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Bot Telegram dan health server berjalan di port ${PORT}`);
});
server.on('error', error => {
    console.error('Health server gagal berjalan:', errorSummary(error));
    process.exit(1);
});
