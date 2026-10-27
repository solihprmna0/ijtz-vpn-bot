const axios = require('axios');

const NADIA_API_TOKEN = process.env.NADIA_API_TOKEN;
if (!NADIA_API_TOKEN) {
    throw new Error("NADIA_API_TOKEN belum diatur. Tambahkan token NadiaVPN melalui Replit Secrets.");
}
const BASE_URL = "https://www.nadiavpn.web.id/api/v1";

const headers = {
    "Authorization": `Bearer ${NADIA_API_TOKEN}`,
    "Accept": "application/json",
    "Content-Type": "application/json"
};

function extractServerList(payload, depth = 0) {
    if (Array.isArray(payload)) {
        return payload.filter(server => server && typeof server === 'object' && !Array.isArray(server));
    }
    if (!payload || typeof payload !== 'object' || depth >= 6) return [];

    for (const key of ['servers', 'server_list', 'items', 'results', 'list', 'data']) {
        if (payload[key] !== undefined) {
            const servers = extractServerList(payload[key], depth + 1);
            if (servers.length) return servers;
        }
    }
    return [];
}

async function getUserBalance() {
    try {
        const res = await axios.get(`${BASE_URL}/user/balance`, { headers, timeout: 15000 });
        return res.data;
    } catch (err) {
        return { status: false, message: err.response?.data?.message || err.message };
    }
}

async function getServers() {
    try {
        const res = await axios.get(`${BASE_URL}/servers`, { headers, timeout: 15000 });
        if (res.status !== 200 || !res.data) return [];
        return extractServerList(res.data);
    } catch (err) {
        console.error("Error getServers:", err.message);
        return [];
    }
}

async function createVpnAccount(serverId, protocol = "vless", isTrial = false, durationType = "day", durationValue = 1, customUsername = "", customPassword = "") {
    const endpoint = isTrial ? `${BASE_URL}/vpn/trial` : `${BASE_URL}/vpn/order`;
    const cleanUsername = customUsername.replace(/[^a-zA-Z0-9]/g, "");

    const payload = {
        server_id: String(serverId),
        protocol: protocol.toLowerCase()
    };

    if (!isTrial) {
        payload.type = durationType;
        payload.duration = Number(durationValue);
        payload.username = cleanUsername;

        if (protocol.toLowerCase() === "ssh") {
            payload.password = customPassword || "123456";
        }
    } else {
        payload.username = cleanUsername;
    }

    try {
        const res = await axios.post(endpoint, payload, { headers, timeout: 15000 });
        return res.data;
    } catch (err) {
        console.error("API ERROR:", err.response?.data || err.message);
        return { 
            status: false, 
            message: err.response?.data?.message || err.response?.data?.msg || err.message 
        };
    }
}

async function getAccountDetails(accountId) {
    try {
        const res = await axios.post(
            `${BASE_URL}/vpn/account/details`,
            { account_id: String(accountId) },
            { headers, timeout: 15000 }
        );
        return res.data;
    } catch (err) {
        return {
            status: false,
            message: err.response?.data?.message || err.response?.data?.msg || err.message
        };
    }
}

async function renewVpnAccount(accountId, durationValue = 1, durationType = "month") {
    try {
        const payload = {
            account_id: String(accountId),
            type: durationType,
            duration: Number(durationValue)
        };
        const res = await axios.post(`${BASE_URL}/vpn/renew`, payload, { headers, timeout: 15000 });
        return res.data;
    } catch (err) {
        return { status: false, message: err.response?.data?.message || err.message };
    }
}

module.exports = {
    getUserBalance,
    getServers,
    createVpnAccount,
    getAccountDetails,
    renewVpnAccount
};
