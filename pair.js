const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const yts = require("yt-search");
const fetch = require("node-fetch");
const { initUserEnvIfMissing } = require('./settingsdb');
const { initEnvsettings, getSetting } = require('./settings');

const mongoose = require('mongoose');

// ================= MONGODB SETUP =================
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/marwld';
mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
});
mongoose.connection.on('connected', () => console.log('MongoDB connected'));
mongoose.connection.on('error', (err) => console.error('MongoDB error', err));

// Schemas
const SessionSchema = new mongoose.Schema({
    number: { type: String, index: true, unique: true },
    creds: { type: mongoose.Schema.Types.Mixed },
    keys: { type: mongoose.Schema.Types.Mixed },
    updatedAt: { type: Date, default: Date.now }
}, { collection: 'sessions' });

const ConfigSchema = new mongoose.Schema({
    number: { type: String, index: true, unique: true },
    config: { type: mongoose.Schema.Types.Mixed },
    updatedAt: { type: Date, default: Date.now }
}, { collection: 'configs' });

const NumberListSchema = new mongoose.Schema({
    number: { type: String, index: true, unique: true }
}, { collection: 'numbers' });

const SessionModel = mongoose.model('Session', SessionSchema);
const ConfigModel = mongoose.model('Config', ConfigSchema);
const NumberModel = mongoose.model('Number', NumberListSchema);

// ================================================
const api = `https://api-dark-shan-yt.koyeb.app`;
const apikey = `edbcfabbca5a9750`;

const autoReact = getSetting('AUTO_REACT') || 'off';

//=======================================
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent
} = require('baileys');
//=======================================

const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['🫠', '🥶', '🇿🇼', '🇺🇬', '🔮'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/KRyARlvcUjoIv1CPSSyQA5?mode=ems_copy_t',
    ADMIN_LIST_PATH: './admin.json',
    IMAGE_PATH: 'https://files.catbox.moe/otx26d.jpg',
    NEWSLETTER_JID: '120363404529319592@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,
    NEWS_JSON_URL: '',
    BOT_NAME: 'MARWLD-MINI-BOT',
    OWNER_NAME: 'Ridz Coder',
    OWNER_NUMBER: '263714732501',
    BOT_VERSION: '1.0.0',
    BOT_FOOTER: '> © ᴘᴏᴡᴇʀᴇᴅ ʙʏ Rɪᴅᴢ Cᴏᴅᴇʀ',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029VarfjW04tRrmwfb8x306',
    BUTTON_IMAGES: {
        ALIVE: 'https://files.catbox.moe/cn78d8.jpg',
        MENU: 'https://files.catbox.moe/otx26d.jpg',
        OWNER: 'https://files.catbox.moe/f2d2n0.jpg',
        SONG: 'https://files.catbox.moe/otx26d.jpg',
        VIDEO: 'https://files.catbox.moe/otx26d.jpg'
    }
};

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json'; // still used for legacy compatibility
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

// Helpers
function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}
function formatMessage(title, content, footer) {
    return `${title}\n\n${content}\n\n${footer}`;
}
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}
function getSriLankaTimestamp() {
    return moment().tz('Africa/Kampala').format('YYYY-MM-DD HH:mm:ss');
}
async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        // Keep latest session record only
        const sessions = await SessionModel.find({ number: sanitizedNumber }).sort({ updatedAt: -1 }).exec();
        if (sessions.length > 1) {
            for (let i = 1; i < sessions.length; i++) {
                await SessionModel.deleteOne({ _id: sessions[i]._id });
                console.log(`Deleted duplicate session record for ${sanitizedNumber}`);
            }
        }
        // For config duplicates
        const configs = await ConfigModel.find({ number: sanitizedNumber }).sort({ updatedAt: -1 }).exec();
        if (configs.length > 1) {
            for (let i = 1; i < configs.length; i++) {
                await ConfigModel.deleteOne({ _id: configs[i]._id });
                console.log(`Deleted duplicate config record for ${sanitizedNumber}`);
            }
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}
//=======================================
async function joinGroup(socket) {
    let retries = config.MAX_RETRIES;
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (!inviteCodeMatch) {
        console.error('Invalid group invite link format');
        return { status: 'failed', error: 'Invalid group invite link' };
    }
    const inviteCode = inviteCodeMatch[1];

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            if (response?.gid) {
                console.log(`Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message.includes('gone')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group, retries left: ${retries}`, errorMessage);
            if (retries === 0) {
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}
//=======================================
async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const groupStatus = groupResult.status === 'success'
        ? `Joined (ID: ${groupResult.gid})`
        : `Failed to join group: ${groupResult.error}`;
    const caption = formatMessage(
        '*Connected Successful ✅*',
        `📞 Number: ${number}\n🩵 Status: Online`,
        `${config.BOT_FOOTER}`
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: config.IMAGE_PATH },
                    caption
                }
            );
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}
//=======================================
async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '"🔐 OTP VERIFICATION*',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`,
        `${config.BOT_FOOTER}`
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}
//=======================================
function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== config.NEWSLETTER_JID) return;

        try {
            const emojis = ['❤️'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No valid newsletterServerId found:', message);
                return;
            }

            let retries = config.MAX_RETRIES;
            while (retries > 0) {
                try {
                    await socket.newsletterReactMessage(
                        config.NEWSLETTER_JID,
                        messageId.toString(),
                        randomEmoji
                    );
                    console.log(`Reacted to newsletter message ${messageId} with ${randomEmoji}`);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to react to newsletter message ${messageId}, retries left: ${retries}`, error.message);
                    if (retries === 0) throw error;
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
        } catch (error) {
            console.error('Newsletter reaction error:', error);
        }
    });
}
//=======================================
async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (autoReact === 'on' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}
//=======================================
async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '╭──◯',
            `│ \`D E L E T E\`\n│ *⦁ From :* ${messageKey.remoteJid}\n│ *⦁ Time:* ${deletionTime}\n│ *⦁ Type: Normal*\n╰──◯`,
            `${config.BOT_FOOTER}`
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

// Image resizing function
async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

// Capitalize first letter
function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

// Generate serial
const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

// Send slide with news items
async function SendSlide(socket, jid, newsItems) {
    let anu = [];
    for (let item of newsItems) {
        let imgBuffer;
        try {
            imgBuffer = await resize(item.thumbnail, 300, 200);
        } catch (error) {
            console.error(`Failed to resize image for ${item.title}:`, error);
            imgBuffer = await Jimp.read('https://i.ibb.co/qFJ08v4J/da3ed85877e73e60.jpg');
            imgBuffer = await imgBuffer.resize(300, 200).getBufferAsync(Jimp.MIME_JPEG);
        }
        let imgsc = await prepareWAMessageMedia({ image: imgBuffer }, { upload: socket.waUploadToServer });
        anu.push({
            body: proto.Message.InteractiveMessage.Body.fromObject({
                text: `*${capital(item.title)}*\n\n${item.body}`
            }),
            header: proto.Message.InteractiveMessage.Header.fromObject({
                hasMediaAttachment: true,
                ...imgsc
            }),
            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
                buttons: [
                    {
                        name: "cta_url",
                        buttonParamsJson: `{"display_text":"𝐃𝙴𝙿𝙻𝙾𝚈","url":"https:/","merchant_url":"https://www.google.com"}`
                    },
                    {
                        name: "cta_url",
                        buttonParamsJson: `{"display_text":"𝐂𝙾𝙽𝚃𝙰𝙲𝚃","url":"https","merchant_url":"https://www.google.com"}`
                    }
                ]
            })
        });
    }
    const msgii = await generateWAMessageFromContent(jid, {
        viewOnceMessage: {
            message: {
                messageContextInfo: {
                    deviceListMetadata: {},
                    deviceListMetadataVersion: 2
                },
                interactiveMessage: proto.Message.InteractiveMessage.fromObject({
                    body: proto.Message.InteractiveMessage.Body.fromObject({
                        text: "*Latest News Updates*"
                    }),
                    carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.fromObject({
                        cards: anu
                    })
                })
            }
        }
    }, { userJid: jid });
    return socket.relayMessage(jid, msgii.message, {
        messageId: msgii.key.id
    });
}

// Fetch news from API
async function fetchNews() {
    try {
        const response = await axios.get(config.NEWS_JSON_URL);
        return response.data || [];
    } catch (error) {
        console.error('Failed to fetch news from raw JSON URL:', error.message);
        return [];
    }
}

// Setup command handlers with buttons and images
function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        let command = null;
        let args = [];
        let sender = msg.key.remoteJid;

        if (msg.message.conversation || msg.message.extendedTextMessage?.text) {
            const text = (msg.message.conversation || msg.message.extendedTextMessage.text || '').trim();
            if (text.startsWith(config.PREFIX)) {
                const parts = text.slice(config.PREFIX.length).trim().split(/\s+/);
                command = parts[0].toLowerCase();
                args = parts.slice(1);
            }
        }
        else if (msg.message.buttonsResponseMessage) {
            const buttonId = msg.message.buttonsResponseMessage.selectedButtonId;
            if (buttonId && buttonId.startsWith(config.PREFIX)) {
                const parts = buttonId.slice(config.PREFIX.length).trim().split(/\s+/);
                command = parts[0].toLowerCase();
                args = parts.slice(1);
            }
        }

        if (!command) return;

        try {
            switch (command) {   
                // ALIVE COMMAND WITH BUTTON
                case 'alive': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const title = '𝐌𝐀𝐑𝐖𝐋𝐃 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝐀𝐋𝐈𝐕𝐄 𝐍𝐎𝐖 😾❤*';
                    const content = `*𝐌𝐚𝐫𝐰𝐥𝐝-𝐌𝐢𝐧𝐢 𝐛𝐨𝐭 𝐛𝐲 Rɪᴅᴢ Cᴏᴅᴇʀ*\n` +
                                `*ʙᴏᴛ ᴏᴡɴᴇʀ :- Rɪᴅᴢ Cᴏᴅᴇʀ*\n` +
                                `*ʙᴏᴛ ɴᴀᴍᴇ :- 𝐌𝐚𝐫𝐰𝐥𝐝-𝐌𝐢𝐧𝐢-𝐁𝐨𝐭*\n` +
                                `*ʙᴏᴛ ᴡᴇʙ ꜱɪᴛᴇ*\n` +
                                `> *mawrldminibot.zone.id*`;
                    const footer = config.BOT_FOOTER;

                    await socket.sendMessage(sender, {
                        image: { url: config.BUTTON_IMAGES.ALIVE },
                        caption: formatMessage(title, content, footer),
                        buttons: [
                            { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: 'MENU' }, type: 1 },
                            { buttonId: `${config.PREFIX}ping`, buttonText: { displayText: 'PING' }, type: 1 }
                        ],
                        quoted: msg
                    });
                    break;
                }
                // ... (rest of commands remain largely unchanged except where strings refer to Arslan)
                case 'menu': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    await socket.sendMessage(sender, { 
                        react: { 
                            text: "👍",
                            key: msg.key 
                        } 
                    });

                    const title = '𝐌𝐀𝐑𝐖𝐋𝐃 𝐌𝐈𝐍𝐈 𝐁𝐎𝐓 𝐌𝐄𝐍𝐔 😾❤*';
                    const text = `╭──➢\n` +
                        `│ \`S T A T U S\`\n` +
                        `│ *⦁ ʙᴏᴛ ɴᴀᴍᴇ*: 𝐌𝐚𝐫𝐰𝐥𝐝-𝐌𝐢𝐧𝐢-𝐁𝐨𝐭\n` +
                        `│ *⦁ ʙᴏᴛ ᴏᴡɴᴇʀ*: Rɪᴅᴢ Cᴏᴅᴇʀ\n` +
                        `│ *⦁ ᴠᴇʀꜱɪᴏɴ*: 0.0001+\n` +
                        `│ *⦁ ᴘʟᴀᴛꜰᴏʀᴍ*: Heroku\n` +
                        `│ *⦁ ᴜᴘᴛɪᴍᴇ*: ${hours}h ${minutes}m ${seconds}s\n` +
                        `╰──➢`;

                    const sections = [
                        {
                            title: "🫩 ᴍᴀɪɴ ᴄᴏᴍᴍᴀɴᴅꜱ 🫩",
                            rows: [
                                { title: "📱 Bσƚ Sƚαƭυʂ 📱", description: "Show bot information", rowId: `${config.PREFIX}alive` },
                                { title: "📱 Sყʂƚҽɱ Iɳϝσ 📱", description: "Show system details", rowId: `${config.PREFIX}system` },
                                { title: "📱 Pιɳɠ 📱", description: "Check bot latency", rowId: `${config.PREFIX}ping` }
                            ]
                        },
                        {
                            title: "🫩 ᴍᴇᴅɪᴀ ᴅᴏᴡɴʟᴏᴅ 🫩",
                            rows: [
                                { title: "🎧 Dσɯɳʅσԃ Sσɳɠ 🎧", description: "Download audio from YouTube", rowId: `${config.PREFIX}play` },
                                { title: "📹 Dσɯɳʅσԃ Vιԃҽσ 📹", description: "Download video from YouTube", rowId: `${config.PREFIX}video` }
                            ]
                        },
                        {
                            title: "🫩 ᴏᴛʜᴇʀ ᴄᴏᴍᴍᴀɴᴅ 🫩",
                            rows: [
                                { title: "👨‍💻 Oɯɳҽʀ Iɳϝσ 👨‍💻", description: "Contact bot owner", rowId: `${config.PREFIX}owner` },
                                { title: "👨‍💻 Pɾҽϝҽɾҽɳƈҽʂ 👨‍💻", description: "Change bot settings", rowId: `${config.PREFIX}preferences` },
                                { title: "👨‍💻 Jσιɳ Cԋαɳɳҽʅ 👨‍💻", description: "Get our channel link", rowId: `${config.PREFIX}channel` }
                            ]
                        }
                    ];

                    await socket.sendMessage(sender, {
                        image: { url: config.BUTTON_IMAGES.MENU },
                        text: text,
                        footer: config.BOT_FOOTER,
                        title: title,
                        buttonText: "😾 ꜱᴇʟᴇᴄᴛ ᴏᴘᴛɪᴏɴ 😾",
                        sections: sections
                    });
                    break;
                }
                case 'ping': {
                    var inital = new Date().getTime();
                    let ping = await socket.sendMessage(sender, { text: '*_Pinging to Marwld-Mini-Bot Module..._* ❗' });
                    var final = new Date().getTime();
                    await socket.sendMessage(sender, { text: '《 █▒▒▒▒▒▒▒▒▒▒▒》10%', edit: ping.key });
                    await socket.sendMessage(sender, { text: '《 ████▒▒▒▒▒▒▒▒》30%', edit: ping.key });
                    await socket.sendMessage(sender, { text: '《 ███████▒▒▒▒▒》50%', edit: ping.key });
                    await socket.sendMessage(sender, { text: '《 ██████████▒▒》80%', edit: ping.key });
                    await socket.sendMessage(sender, { text: '《 ████████████》100%', edit: ping.key });

                    return await socket.sendMessage(sender, {
                        text: '*Pong '+ (final - inital) + ' Ms*', edit: ping.key });
                    break;
                }
                case 'owner': {
                    const vcard = 'BEGIN:VCARD\n'
                        + 'VERSION:3.0\n' 
                        + 'FN:MARWLD OWNER\n'
                        + 'ORG:MARWLD OWNER\n'
                        + 'TEL;type=CELL;type=VOICE;waid=263714732501:+263714732501\n'
                        + 'EMAIL: smtechofcmods@gmail.com\n'
                        + 'END:VCARD';

                    await socket.sendMessage(sender, {
                        contacts: {
                            displayName: "MARWLD OWNER",
                            contacts: [{ vcard }]
                        },
                        image: { url: config.BUTTON_IMAGES.OWNER },
                        caption: '*👨‍💻 MARWLD BOT OWNER DETAILS*',
                        buttons: [
                            { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 },
                            { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: '🤖 BOT INFO' }, type: 1 }
                        ]
                    });     
                    break;     
                }
                case 'system': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);
                        
                    const title = '*🥂𝑴𝒂𝒓𝒘𝒍𝒅 𝑴𝒊𝒏𝒊 𝑩𝒐𝒕 𝑺𝒚𝒔𝒕𝒆𝒎 🥂*';
                    const content = `┏━━━━━━━━━━━━━━━━\n` +
                        `┃🤖 \`ʙᴏᴛ ɴᴀᴍᴇ\` : ${config.BOT_NAME}\n` +
                        `┃🔖 \`ᴠᴇʀsɪᴏɴ\` : ${config.BOT_VERSION}\n` +
                        `┃📡 \`ᴘʟᴀᴛꜰᴏʀᴍ\` : Heroku\n` +
                        `┃🪢 \`ʀᴜɴᴛɪᴍᴇ\` : ${hours}h ${minutes}m ${seconds}s\n` +
                        `┃👨‍💻 \`ᴏᴡɴᴇʀ\` : ${config.OWNER_NAME}\n` +
                        `┗━━━━━━━━━━━━━━━━`;
                    const footer = config.BOT_FOOTER;

                    await socket.sendMessage(sender, {
                        image: { url: config.IMAGE_PATH },
                        caption: formatMessage(title, content, footer)
                    });
                    break;
                }
                case 'jid': {
                    await socket.sendMessage(sender, {
                        text: `*🆔 Chat JID:* ${sender}`
                    });
                    break;
                }
                case 'boom': {
                    if (args.length < 2) {
                        return await socket.sendMessage(sender, { 
                            text: "📛 *Usage:* `.boom <count> <message>`\n📌 *Example:* `.boom 100 Hello*`" 
                        });
                    }

                    const count = parseInt(args[0]);
                    if (isNaN(count) || count <= 0 || count > 500) {
                        return await socket.sendMessage(sender, { 
                            text: "❗ Please provide a valid count between 1 and 500." 
                        });
                    }

                    const message = args.slice(1).join(" ");
                    for (let i = 0; i < count; i++) {
                        await socket.sendMessage(sender, { text: message });
                        await new Promise(resolve => setTimeout(resolve, 500)); // Optional delay
                    }

                    break;
                }
                case 'play': {
                    try {
                        const text = (msg.message.conversation || msg.message.extendedTextMessage.text || '').trim();
                        const q = text.split(" ").slice(1).join(" ").trim();
                        if (!q) {
                            await socket.sendMessage(sender, { 
                                text: '*🚫 Please enter a song name to search.*',
                                buttons: [
                                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
                                ]
                            });
                            return;
                        }

                        const searchResults = await yts(q);
                        if (!searchResults.videos.length) {
                            await socket.sendMessage(sender, { 
                                text: '*🚩 Result Not Found*',
                                buttons: [
                                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
                                ]
                            });    
                            return;
                        }

                        const video = searchResults.videos[0];

                        // API CALL
                        const apiUrl = `${api}/download/ytmp3?url=${encodeURIComponent(video.url)}&apikey=${apikey}`;
                        const response = await fetch(apiUrl);
                        const data = await response.json();

                        if (!data.status || !data.data?.result) {
                            await socket.sendMessage(sender, { 
                                text: '*🚩 Download Error. Please try again later.*',
                                buttons: [
                                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
                                ]
                            });
                            return;
                        }

                        const { title, uploader, duration, quality, format, thumbnail, download } = data.data.result;

                        const titleText = '*MARWLD-MINI-BOT-SONG DOWNLOAD*';
                        const content = `┏━━━━━━━━━━━━━━━━\n` +
                            `┃📝 \`Title\` : ${video.title}\n` +
                            `┃📈 \`Views\` : ${video.views}\n` +
                            `┃🕛 \`Duration\` : ${video.timestamp}\n` +
                            `┃🔗 \`URL\` : ${video.url}\n` +
                            `┗━━━━━━━━━━━━━━━━`;

                        const footer = config.BOT_FOOTER || '';
                        const captionMessage = formatMessage(titleText, content, footer);

                        await socket.sendMessage(sender, {
                            image: { url: config.BUTTON_IMAGES.SONG },
                            caption: captionMessage,
                            buttons: [
                                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 },
                                { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: '🤖 BOT INFO' }, type: 1 }
                            ]
                        });

                        await socket.sendMessage(sender, {
                            audio: { url: download },
                            mimetype: 'audio/mpeg'
                        });

                        await socket.sendMessage(sender, {
                            document: { url: download },
                            mimetype: "audio/mpeg",
                            fileName: `${video.title}.mp3`,
                            caption: captionMessage
                        });

                    } catch (err) {
                        console.error(err);
                        await socket.sendMessage(sender, { 
                            text: '*❌ Internal Error. Please try again later.*',
                            buttons: [
                                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
                            ]
                        });
                    }
                    break;
                }
                case 'news': {
                    await socket.sendMessage(sender, {
                        text: '📰 Fetching latest news...'
                    });
                    const newsItems = await fetchNews();
                    if (newsItems.length === 0) {
                        await socket.sendMessage(sender, {
                            image: { url: config.IMAGE_PATH },
                            caption: formatMessage(
                                '🗂️ NO NEWS AVAILABLE',
                                '❌ No news updates found at the moment. Please try again later.',
                                `${config.BOT_FOOTER}`
                            )
                        });
                    } else {
                        await SendSlide(socket, sender, newsItems.slice(0, 5));
                    }
                    break;
                }
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    `${config.BOT_FOOTER}`
                )
            });
        }
    });
}

// Setup message handlers
function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (autoReact === 'on') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

// ===== Mongo replacements for GitHub session/config operations =====

// Delete session record(s) for a number
async function deleteSessionFromDb(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        await SessionModel.deleteMany({ number: sanitizedNumber });
        console.log(`Deleted session(s) for ${sanitizedNumber} from DB`);
    } catch (error) {
        console.error('Failed to delete session from DB:', error);
    }
}

// Restore session object from DB
async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const session = await SessionModel.findOne({ number: sanitizedNumber }).sort({ updatedAt: -1 }).exec();
        if (!session) return null;
        return session.creds || null;
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

// Load user config from DB (fallback to default config object)
async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const cfg = await ConfigModel.findOne({ number: sanitizedNumber }).exec();
        if (!cfg) {
            console.warn(`No configuration found for ${number}, using default config`);
            return { ...config };
        }
        return cfg.config;
    } catch (error) {
        console.warn(`Error loading config for ${number}:`, error);
        return { ...config };
    }
}

// Update/Upsert user config
async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        await ConfigModel.updateOne(
            { number: sanitizedNumber },
            { $set: { config: newConfig, updatedAt: new Date() } },
            { upsert: true }
        );
        console.log(`Updated config for ${sanitizedNumber} in DB`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

// Setup auto restart
function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close' && lastDisconnect?.error?.output?.statusCode !== 401) {
            console.log(`Connection lost for ${number}, attempting to reconnect...`);
            await delay(10000);
            activeSockets.delete(number.replace(/[^0-9]/g, ''));
            socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
        }
    });
}

// Main pairing function
async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    await initUserEnvIfMissing(sanitizedNumber);
    await initEnvsettings(sanitizedNumber);

    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            try {
                const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
                const credsObj = JSON.parse(fileContent);
                await SessionModel.updateOne(
                    { number: sanitizedNumber },
                    { $set: { creds: credsObj, updatedAt: new Date() } },
                    { upsert: true }
                );
                console.log(`Updated creds for ${sanitizedNumber} in DB`);
            } catch (err) {
                console.error('Failed to persist creds to DB:', err);
            }
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);
                    const groupResult = await joinGroup(socket);

                    try {
                        await socket.newsletterFollow(config.NEWSLETTER_JID);
                        await socket.sendMessage(config.NEWSLETTER_JID, { react: { text: '❤️', key: { id: config.NEWSLETTER_MESSAGE_ID } } });
                        console.log('✅ Auto-followed newsletter & reacted ❤️');
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message);
                    }

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, config);
                    }

                    activeSockets.set(sanitizedNumber, socket);

                    const groupStatus = groupResult.status === 'success'
                        ? 'Joined successfully'
                        : `Failed to join group: ${groupResult.error}`;
                    await socket.sendMessage(userJid, {
                        image: { url: config.IMAGE_PATH },
                        caption: formatMessage(
                            '*𝐌𝐚𝐫𝐰𝐥𝐝-𝐌𝐢𝐧𝐢-𝐁𝐨𝐭*',
                            `✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n🍁 Channel: ${config.NEWSLETTER_JID ? 'Followed' : 'Not followed'}\n\n📋 Available Category:\n📌${config.PREFIX}alive - Show bot status\n📌${config.PREFIX}menu - Show bot command\n📌${config.PREFIX}song - Downlode Songs\n📌${config.PREFIX}video - Download Video\n📌${config.PREFIX}pair - Deploy Mini Bot\n📌${config.PREFIX}vv - Anti view one`,
                            `${config.BOT_FOOTER}`
                        )
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);

                    let numbers = [];
                    // keep legacy numbers.json file, but sync to DB too
                    if (fs.existsSync(NUMBER_LIST_PATH)) {
                        numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                    }

                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                    }

                    // Ensure number in DB
                    await NumberModel.updateOne({ number: sanitizedNumber }, { $set: { number: sanitizedNumber } }, { upsert: true });

                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || 'Marwld-Md-Free-Bot-Session'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

// Routes
router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    const sanitized = number.replace(/[^0-9]/g, '');
    if (activeSockets.has(sanitized)) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: 'BOT is running',
        activesession: activeSockets.size
    });
});

router.get('/connect-all', async (req, res) => {
    try {
        // Read numbers from DB
        const docs = await NumberModel.find({}).exec();
        const numbers = docs.map(d => d.number);
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        // Fetch session docs in DB that have creds
        const sessionDocs = await SessionModel.find({}).exec();

        if (!sessionDocs || sessionDocs.length === 0) {
            return res.status(404).send({ error: 'No session files found in DB' });
        }

        const results = [];
        for (const doc of sessionDocs) {
            const number = doc.number;
            if (!number) {
                results.push({ file: doc._id, status: 'skipped', reason: 'invalid_doc_no_number' });
                continue;
            }
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(number, mockRes);
                results.push({ number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${number}:`, error);
                results.push({ number, status: 'failed', error: error.message });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        otpStore.delete(sanitizedNumber);
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) {
        return res.status(400).send({ error: 'No OTP request found for this number' });
    }

    if (Date.now() >= storedData.expiry) {
        otpStore.delete(sanitizedNumber);
        return res.status(400).send({ error: 'OTP has expired' });
    }

    if (storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid OTP' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: config.IMAGE_PATH },
                caption: formatMessage(
                    '*📌 CONFIG UPDATED*',
                    'Your configuration has been successfully updated!',
                    `${config.BOT_FOOTER}`
                )
            });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Africa/Kampala').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

// Cleanup
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        try { socket.ws.close(); } catch(e) {}
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || 'Marwld-BOT-session'}`);
});

module.exports = router;