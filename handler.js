const axios = require('axios');
const fs = require('fs');
const path = require('path');
process.env.TMPDIR = path.join(__dirname, 'temp_downloads');
const config = require('./config');

const API = config.apiBase;
const EPISODES_PER_PAGE = config.animeEpisodesPerPage || 10;
const TEMP_DIR = path.join(__dirname, 'temp_downloads');

if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    console.log('Created temp_downloads directory');
}

function cleanupTempDir() {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        let cleaned = 0;
        for (const file of files) {
            try {
                fs.unlinkSync(path.join(TEMP_DIR, file));
                cleaned++;
            } catch (e) { }
        }
        if (cleaned > 0) console.log(`Cleaned ${cleaned} old temp files`);
    } catch (e) { }
}
cleanupTempDir();

const sessions = new Map();
const cooldowns = new Map();

// ═══════════════════════════════════════════════
//  🛡️ SMART RATE LIMITER (Anti-Spam)
// ═══════════════════════════════════════════════
class SmartRateLimiter {
    constructor() {
        this.globalMessages = [];
        this.chatMessages = new Map();
        this.dailyCount = 0;
        this.dailyReset = Date.now();
        this.lastMessageTime = 0;
    }

    _cleanOld(arr, maxAgeMs) {
        const cutoff = Date.now() - maxAgeMs;
        while (arr.length > 0 && arr[0] < cutoff) arr.shift();
    }

    _getChatMsgs(jid) {
        if (!this.chatMessages.has(jid)) this.chatMessages.set(jid, []);
        return this.chatMessages.get(jid);
    }

    canSend(jid, isGroup = false) {
        const now = Date.now();
        const rl = config.rateLimit;
        if (now - this.dailyReset > 86400000) { this.dailyCount = 0; this.dailyReset = now; }
        if (this.dailyCount >= rl.dailyCap) return false;

        this._cleanOld(this.globalMessages, 3600000);
        const lastMin = this.globalMessages.filter(t => t > now - 60000).length;
        if (lastMin >= rl.globalPerMinute) return false;
        if (this.globalMessages.length >= rl.globalPerHour) return false;

        const chatMsgs = this._getChatMsgs(jid);
        this._cleanOld(chatMsgs, 600000);
        if (isGroup) {
            if (chatMsgs.filter(t => t > now - 60000).length >= rl.groupPerMinute) return false;
            if (chatMsgs.length >= rl.groupPer10Min) return false;
        } else {
            if (chatMsgs.filter(t => t > now - 60000).length >= rl.perChatPerMinute) return false;
            if (chatMsgs.filter(t => t > now - 300000).length >= rl.perChatPer5Min) return false;
        }
        return true;
    }

    async waitForSlot(jid, isGroup = false) {
        let waited = 0;
        while (!this.canSend(jid, isGroup) && waited < 30000) {
            await delay(1000);
            waited += 1000;
        }
        const elapsed = Date.now() - this.lastMessageTime;
        const minGap = config.rateLimit.interMessageDelay + Math.random() * config.rateLimit.interMessageJitter;
        if (elapsed < minGap) await delay(minGap - elapsed);
    }

    record(jid) {
        const now = Date.now();
        this.globalMessages.push(now);
        this._getChatMsgs(jid).push(now);
        this.dailyCount++;
        this.lastMessageTime = now;
    }
}

const rateLimiter = new SmartRateLimiter();
const reactTracker = new Map();

function wrapSockWithRateLimit(sock, isGroup) {
    return new Proxy(sock, {
        get(target, prop) {
            if (prop === 'sendMessage') {
                return async function(jid, content, options) {
                    const isEdit = content && (content.edit != null || content.delete != null);
                    if (!isEdit) {
                        await rateLimiter.waitForSlot(jid, isGroup);
                    }
                    const result = await target.sendMessage(jid, content, options);
                    if (!isEdit) {
                        rateLimiter.record(jid);
                    }
                    return result;
                };
            }
            const value = target[prop];
            if (typeof value === 'function') return value.bind(target);
            return value;
        }
    });
}

function isInOfflineSchedule() {
    const sched = config.antiDetection.offlineSchedule;
    if (!sched.enabled) return false;
    const now = new Date();
    const localHour = (now.getUTCHours() + sched.timezone) % 24;
    if (sched.startHour < sched.endHour) {
        return localHour >= sched.startHour && localHour < sched.endHour;
    }
    return localHour >= sched.startHour || localHour < sched.endHour;
}

function setSession(userId, data) {
    const existing = sessions.get(userId);
    if (existing && existing._timer) clearTimeout(existing._timer);

    const timer = setTimeout(() => {
        sessions.delete(userId);
    }, config.sessionTimeout);

    sessions.set(userId, { ...data, _timer: timer, _timestamp: Date.now() });
}

function getSession(userId) {
    const session = sessions.get(userId);
    if (!session) return null;
    if (Date.now() - session._timestamp > config.sessionTimeout) {
        sessions.delete(userId);
        return null;
    }
    return session;
}

function deleteSession(userId) {
    const session = sessions.get(userId);
    if (session && session._timer) clearTimeout(session._timer);
    sessions.delete(userId);
}

function isOnCooldown(userId) {
    const last = cooldowns.get(userId);
    const cd = config.cooldownTime + Math.random() * ((config.cooldownMax || 5000) - config.cooldownTime);
    if (last && Date.now() - last < cd) return true;
    cooldowns.set(userId, Date.now());
    return false;
}

function getMessageBody(msg) {
    const m = msg.message;
    let text = m?.conversation
        || m?.extendedTextMessage?.text
        || m?.imageMessage?.caption
        || m?.videoMessage?.caption
        || m?.buttonsResponseMessage?.selectedButtonId
        || m?.listResponseMessage?.singleSelectReply?.selectedRowId
        || '';

    text = text.replace(/@\d+/g, '').replace(/\s+/g, ' ').trim();
    return text;
}

function extractUrl(text) {
    const regex = /(https?:\/\/[^\s]+)/gi;
    const match = text.match(regex);
    return match ? match[0] : null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function simulateTyping(sock, jid) {
    try {
        await sock.presenceSubscribe(jid);
        await sock.sendPresenceUpdate('composing', jid);
        // Human-like: 2-5 sec random delay (max 5 sec per user request)
        const typingTime = 2000 + Math.random() * 3000;
        await delay(typingTime);
        await sock.sendPresenceUpdate('paused', jid);
    } catch (e) { }
}

function detectPlatform(url) {
    if (/youtu(be\.com|\.be)/i.test(url)) return 'youtube';
    if (/tiktok\.com/i.test(url)) return 'tiktok';
    if (/instagram\.com/i.test(url)) return 'instagram';
    if (/facebook\.com|fb\.watch|fb\.com/i.test(url)) return 'facebook';
    if (/terabox\.com|1024terabox\.com/i.test(url)) return 'terabox';
    return null;
}

function formatSize(bytes) {
    if (!bytes || isNaN(bytes)) return 'N/A';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

function formatSizeMB(bytes) {
    if (!bytes || isNaN(bytes)) return 0;
    return bytes / (1024 * 1024);
}

function formatSizeKb(kb) {
    if (!kb || isNaN(kb)) return null;
    const mb = kb / 1024;
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${mb.toFixed(1)} MB`;
}

function parseSizeToMB(sizeStr) {
    if (!sizeStr) return 0;
    const str = sizeStr.toUpperCase();
    let val = parseFloat(str.replace(/[^0-9.]/g, ''));
    if (str.includes('GB')) val *= 1024;
    if (str.includes('KB')) val /= 1024;
    return val || 0;
}

function formatDuration(seconds) {
    if (!seconds) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatNumber(num) {
    if (!num) return '0';
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
}

function cleanTitle(filename) {
    return (filename || 'Unknown')
        .replace(/\s*\(\d+p,?\s*h264\)/gi, '')
        .replace(/\s*\.\w{3,4}$/, '')
        .trim();
}

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '...' : str;
}

async function react(sock, msg, emoji) {
    try {
        // Limit reacts: max 1 per interaction to reduce API calls
        const msgId = msg.key.id;
        const count = reactTracker.get(msgId) || 0;
        if (count >= (config.antiDetection.maxReactsPerInteraction || 1)) return;
        reactTracker.set(msgId, count + 1);
        // Clean old tracker entries
        if (reactTracker.size > 200) {
            const keys = [...reactTracker.keys()].slice(0, 100);
            keys.forEach(k => reactTracker.delete(k));
        }
        await sock.sendMessage(msg.key.remoteJid, {
            react: { text: emoji, key: msg.key }
        });
    } catch (e) { }
}

const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

function timestamp() {
    return new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getStatusEmoji(status) {
    if (!status) return '⚪';
    const s = status.toLowerCase();
    if (s === 'completed') return '✅';
    if (s === 'ongoing') return '🟢';
    if (s === 'upcoming') return '🔜';
    return '⚪';
}

function extractEpNumber(chapter) {
    const chMatch = String(chapter.ch).match(/^(\d+)/);
    if (chMatch) return parseInt(chMatch[1]);
    const urlMatch = String(chapter.url).match(/-(\d+)$/);
    if (urlMatch) return parseInt(urlMatch[1]);
    return 1;
}

function getPreferredStream(streams, resolution) {
    const links = streams[resolution];
    if (!links || links.length === 0) return null;

    const validLinks = links.filter(l => l.link && l.link.startsWith('http'));
    if (validLinks.length === 0) return null;

    const animekita = validLinks.find(l => l.link.includes('storage.animekita.org'));
    if (animekita) return { ...animekita, source: 'AnimKita', fast: true };

    return { ...validLinks[0], source: 'Alternatif', fast: false };
}

function generateTempName(prefix, ext) {
    const rand = Math.random().toString(36).substring(2, 10);
    return `${prefix}_${Date.now()}_${rand}.${ext}`;
}

function getDiskSpace() {
    try {
        const files = fs.readdirSync(TEMP_DIR);
        let totalUsed = 0;
        for (const file of files) {
            try {
                const stats = fs.statSync(path.join(TEMP_DIR, file));
                totalUsed += stats.size;
            } catch (e) { }
        }
        return { tempUsed: totalUsed };
    } catch (e) {
        return { tempUsed: 0 };
    }
}

function cleanupFile(filepath) {
    try {
        if (filepath && fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
            console.log(`Deleted: ${path.basename(filepath)}`);
        }
    } catch (e) {
        setTimeout(() => {
            try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch (e2) { }
        }, 5000);
    }
}

async function downloadToFile(url, filename, onProgress) {
    const filepath = path.join(TEMP_DIR, filename);
    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 60000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Accept': '*/*',
        },
        maxRedirects: 10
    });

    const writer = fs.createWriteStream(filepath);
    const totalBytes = parseInt(response.headers['content-length'] || '0', 10);

    return new Promise((resolve, reject) => {
        let downloadedBytes = 0;
        let lastPercent = 0;

        const downloadTimer = setTimeout(() => {
            response.data.destroy();
            writer.destroy();
            cleanupFile(filepath);
            reject(new Error('Download timeout exceeded'));
        }, config.downloadTimeout || 600000);

        response.data.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            if (totalBytes > 0 && onProgress) {
                const percent = Math.floor((downloadedBytes / totalBytes) * 100);
                if (percent >= lastPercent + 25) {
                    lastPercent = percent;
                    onProgress(percent, downloadedBytes, totalBytes);
                }
            }
        });

        response.data.pipe(writer);

        writer.on('finish', () => {
            clearTimeout(downloadTimer);
            resolve({
                filepath: filepath,
                size: downloadedBytes,
                sizeMB: downloadedBytes / (1024 * 1024)
            });
        });

        writer.on('error', (err) => {
            clearTimeout(downloadTimer);
            cleanupFile(filepath);
            reject(err);
        });

        response.data.on('error', (err) => {
            clearTimeout(downloadTimer);
            writer.destroy();
            cleanupFile(filepath);
            reject(err);
        });
    });
}

async function sendFileFromDisk(sock, jid, filepath, type, caption, displayFilename) {
    const stats = fs.statSync(filepath);
    const fileSizeMB = stats.size / (1024 * 1024);
    const smallThreshold = config.smallVideoThreshold || 30;

    try {
        if (type === 'video' && fileSizeMB <= smallThreshold) {
            await sock.sendMessage(jid, {
                video: { stream: fs.createReadStream(filepath) },
                mimetype: 'video/mp4',
                caption: caption || undefined,
                fileName: displayFilename || 'video.mp4'
            });
            return true;
        }

        if (type === 'video' || type === 'document') {
            await sock.sendMessage(jid, {
                document: { stream: fs.createReadStream(filepath) },
                mimetype: type === 'video' ? 'video/mp4' : 'application/octet-stream',
                fileName: displayFilename || 'file.mp4',
                caption: caption || undefined
            });
            return true;
        }

        if (type === 'audio') {
            await sock.sendMessage(jid, {
                audio: { stream: fs.createReadStream(filepath) },
                mimetype: 'audio/mpeg',
                ptt: false,
                fileName: displayFilename || 'audio.mp3'
            });
            return true;
        }

        if (type === 'image') {
            await sock.sendMessage(jid, {
                image: { stream: fs.createReadStream(filepath) },
                caption: caption || undefined
            });
            return true;
        }

        const ext = (displayFilename || '').split('.').pop().toLowerCase();
        const mimeTypes = {
            'pdf': 'application/pdf', 'zip': 'application/zip',
            'mp4': 'video/mp4', 'mkv': 'video/x-matroska',
            'mp3': 'audio/mpeg', 'jpg': 'image/jpeg', 'png': 'image/png'
        };

        await sock.sendMessage(jid, {
            document: { stream: fs.createReadStream(filepath) },
            mimetype: mimeTypes[ext] || 'application/octet-stream',
            fileName: displayFilename || 'download',
            caption: caption || undefined
        });
        return true;

    } catch (sendError) {
        try {
            await sock.sendMessage(jid, {
                document: { stream: fs.createReadStream(filepath) },
                mimetype: 'application/octet-stream',
                fileName: displayFilename || 'download.bin',
                caption: caption || undefined
            });
            return true;
        } catch (fallbackError) {
            return false;
        }
    }
}

let activeDownloads = 0;
let heavyTaskRunning = false; 
const MAX_CONCURRENT_NORMAL = 3;
const downloadQueue = [];

function processQueue() {
    if (downloadQueue.length === 0) return;

    const nextTaskIsHeavy = downloadQueue[0].isHeavy;

    if (heavyTaskRunning) return;

    if (nextTaskIsHeavy && activeDownloads > 0) return;

    if (!nextTaskIsHeavy && activeDownloads >= MAX_CONCURRENT_NORMAL) return;

    if (nextTaskIsHeavy) {
        heavyTaskRunning = true;
    }
    
    activeDownloads++;
    const taskObj = downloadQueue.shift();
    taskObj.task();
}

async function downloadAndSend(sock, jid, url, type, caption, displayFilename, msg, isHeavy = false) {
    return new Promise((resolve) => {
        const queuePosition = downloadQueue.length + 1;

        if ((isHeavy && activeDownloads > 0) || (!isHeavy && activeDownloads >= MAX_CONCURRENT_NORMAL) || heavyTaskRunning) {
            sock.sendMessage(jid, { 
                text: `🚦 _Server sedang sibuk memproses unduhan besar._\n⏳ _Kamu berada di antrean ke-${queuePosition}. Mohon sabar menunggu..._` 
            }).catch(() => {});
        }

        downloadQueue.push({
            isHeavy: isHeavy,
            task: async () => {
                try {
                    const result = await downloadAndSendCore(sock, jid, url, type, caption, displayFilename, msg);
                    resolve(result);
                } catch (err) {
                    resolve(false);
                } finally {
                    activeDownloads--;
                    if (isHeavy) heavyTaskRunning = false;
                    
                    cleanupTempDir(); 
                    
                    processQueue();
                }
            }
        });

        processQueue();
    });
}

async function downloadAndSendCore(sock, jid, url, type, caption, displayFilename, msg) {
    let ext = 'bin';
    if (type === 'video') ext = 'mp4';
    else if (type === 'audio') ext = 'mp3';
    else if (type === 'image') ext = 'jpg';
    else {
        const fnExt = (displayFilename || '').split('.').pop().toLowerCase();
        if (fnExt && fnExt.length <= 5 && fnExt !== displayFilename) ext = fnExt;
    }

    const tempFilename = generateTempName('dl', ext);
    let downloadResult = null;
    let progressMsgKey = null;

    try {
        const initMsg = await sock.sendMessage(jid, { 
            text: `⏳ _Mulai menarik file dari server..._\n📁 *${truncate(displayFilename, 40)}*` 
        });
        if (initMsg) progressMsgKey = initMsg.key;

        downloadResult = await downloadToFile(url, tempFilename, async (percent, downloaded, total) => {
            if (progressMsgKey) {
                try {
                    await sock.sendMessage(jid, {
                        text: `⏳ _Mendownload: ${percent}%_\n📁 *${truncate(displayFilename, 40)}*\n💾 ${formatSize(downloaded)} / ${formatSize(total)}\n\n_Tunggu sebentar, jangan spam yah ganteng..._`,
                        edit: progressMsgKey
                    });
                } catch (e) { }
            }
        });

        if (!downloadResult || downloadResult.size === 0) {
            if (progressMsgKey) await sock.sendMessage(jid, { text: `❌ *Download gagal!*\nFile kosong.`, edit: progressMsgKey });
            if (downloadResult) cleanupFile(downloadResult.filepath);
            return false;
        }

        if (progressMsgKey) {
            await sock.sendMessage(jid, { 
                text: `✅ _Selesai diunduh ke server!_\n📤 _Sedang mengirim file ke WhatsApp kamu..._\n\n⚠️ _Proses pengiriman memakan waktu tergantung ukuran file._`, 
                edit: progressMsgKey 
            });
            await sock.sendPresenceUpdate('composing', jid);
        }

        const sendSuccess = await sendFileFromDisk(
            sock, jid, downloadResult.filepath,
            type, caption, displayFilename
        );

        if (!sendSuccess) {
            await sock.sendMessage(jid, { text: `❌ *Gagal kirim file!*\nFile terlalu besar untuk WhatsApp.` });
            return false;
        }

        return true;

    } catch (error) {
        if (progressMsgKey) {
            await sock.sendMessage(jid, { text: `❌ *Download gagal!*\n📛 Server tujuan memutus koneksi.`, edit: progressMsgKey });
        }
        return false;

    } finally {
        await sock.sendPresenceUpdate('paused', jid);
        if (downloadResult && downloadResult.filepath) {
            cleanupFile(downloadResult.filepath);
        } else {
            cleanupFile(path.join(TEMP_DIR, tempFilename));
        }
    }
}


module.exports = async function handleMessage(sock, msg) {
    const jid = msg.key.remoteJid;
    const sender = msg.key.participant || jid;
    const pushName = msg.pushName || 'User';
    const body = getMessageBody(msg);

    if (!body || body.length === 0) return;
    const text = body.trim();
    const textLower = text.toLowerCase();

    const isGroup = jid.endsWith('@g.us');

    // ═══ Anti-Detection: Offline Schedule (00:00-03:00 WIB) ═══
    if (isInOfflineSchedule()) return;

    // ═══ Anti-Detection: Global Rate Check ═══
    if (!rateLimiter.canSend(jid, isGroup)) {
        console.log(`[RATE-LIMIT] Skipped message from ${sender.split('@')[0]}`);
        return;
    }

    // ═══ Wrap sock with rate limiter ═══
    sock = wrapSockWithRateLimit(sock, isGroup);

    const senderShort = sender.split('@')[0];
    console.log(`[${timestamp()}] ${pushName} (${senderShort})${isGroup ? ' [GRP]' : ''}: ${text.substring(0, 80)}`);

    const url = extractUrl(text);

    const validCommands = ['menu', '.menu', '/menu', 'help', '.help', '/help', 'info', '.info', '/info', '0', 'cancel', '.cancel', 'wibu', '.wibu', '/wibu', 'drakor', '.drakor', '/drakor'];
    
    const isWibuSearch = textLower.startsWith('wibu ') || textLower.startsWith('.wibu ') || textLower.startsWith('/wibu ');
    const isDrakorSearch = textLower.startsWith('drakor ') || textLower.startsWith('.drakor ') || textLower.startsWith('/drakor ');

    const isNav = ['next', 'n', '.next', 'prev', 'p', '.prev', 'back', 'b', '.back'].includes(textLower);
    const isNumber = /^\d+$/.test(text);

    const isValidAction = validCommands.includes(textLower) || isWibuSearch || isDrakorSearch || url || (getSession(sender) && (isNav || isNumber));

    if (isValidAction) {
        if (isOnCooldown(sender)) {
            await react(sock, msg, '⏳');
            return;
        }
        await simulateTyping(sock, jid);
    }

    if (['.drakor', '/drakor', 'drakor'].includes(textLower)) {
        await react(sock, msg, '🎬');
        return await sock.sendMessage(jid, {
            text: `🎬 *DRAKOR & DRACHIN DOWNLOADER*\n\n📌 *Cara Pakai:*\nKetik *.drakor <judul>*\nContoh: *.drakor squid game*`
        });
    }

    if (isDrakorSearch) {
        const query = text.replace(/^[./]?drakor\s+/i, '').trim();
        if (!query) return;
        return handleDrakorSearch(sock, jid, sender, query, msg);
    }

    if (/^\d+$/.test(text) && getSession(sender)) {
        const num = parseInt(text);
        const session = getSession(sender);
        if (session.platform === 'anime') return handleAnimeSelection(sock, jid, sender, num, msg);
        if (session.platform === 'drakor') return handleDrakorSelection(sock, jid, sender, num, msg);
        else if (num >= 1 && num <= 9) return handleSelection(sock, jid, sender, num, msg);
    }

    if (['.menu', '.help', '.start', '/menu', '/help', '/start', 'menu'].includes(textLower)) {
        return sendMenu(sock, jid, msg, pushName);
    }
    if (['.info', '/info', 'info'].includes(textLower)) {
        return sendInfo(sock, jid, msg);
    }
    if (['0', '.cancel', '.batal', '/cancel', 'cancel', 'batal'].includes(textLower)) {
        if (getSession(sender)) {
            deleteSession(sender);
            await sock.sendMessage(jid, { text: '✅ Sesi dibatalkan.' });
        }
        return;
    }

    if (['.wibu', '/wibu', 'wibu'].includes(textLower)) {
        return sendAnimeHelp(sock, jid, msg);
    }
    if (textLower.startsWith('.wibu ') || textLower.startsWith('/wibu ') || textLower.startsWith('wibu ')) {
        let query = '';
        if (textLower.startsWith('.wibu ')) query = text.substring(6).trim();
        else if (textLower.startsWith('/wibu ')) query = text.substring(6).trim();
        else if (textLower.startsWith('wibu ')) query = text.substring(5).trim();

        if (!query) return sendAnimeHelp(sock, jid, msg);
        return handleAnimeSearch(sock, jid, sender, query, msg);
    }

    if (['next', 'n', '#n', '.next', 'lanjut'].includes(textLower)) {
        const s = getSession(sender);
        if (s && s.platform === 'anime' && s.state === 'anime_detail') return handleAnimePage(sock, jid, sender, 'next', msg);
    }
    if (['prev', 'p', '#p', '.prev', 'sebelumnya'].includes(textLower)) {
        const s = getSession(sender);
        if (s && s.platform === 'anime' && s.state === 'anime_detail') return handleAnimePage(sock, jid, sender, 'prev', msg);
    }
    if (['back', 'b', '.back', '/back', 'kembali'].includes(textLower)) {
        const s = getSession(sender);
        if (s && s.platform === 'anime') return handleAnimeBack(sock, jid, sender, msg);
    }

    if (/^\d+$/.test(text) && getSession(sender)) {
        const num = parseInt(text);
        const session = getSession(sender);
        if (session.platform === 'anime') return handleAnimeSelection(sock, jid, sender, num, msg);
        else if (num >= 1 && num <= 9) return handleSelection(sock, jid, sender, num, msg);
    }
    
    if (url) {
        let platform = null;

        if (textLower.startsWith('yt ') || textLower.startsWith('.yt ')) {
            platform = 'youtube';
        } else if (textLower.startsWith('ig ') || textLower.startsWith('.ig ')) {
            platform = 'instagram';
        } else if (textLower.startsWith('tt ') || textLower.startsWith('.tt ')) {
            platform = 'tiktok';
        } else if (textLower.startsWith('fb ') || textLower.startsWith('.fb ')) {
            platform = 'facebook';
        }

        if (platform) {
            return handlePlatform(sock, jid, sender, url, platform, msg, pushName);
        }
    }
};

async function sendMenu(sock, jid, msg, pushName) {
    await react(sock, msg, '📋');
    await sock.sendMessage(jid, {
        text: `🌟 *Halo, ${pushName}!*\nSelamat datang di *WA Downloader Bot* 📥\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n📥 *Media Downloader:*\nGunakan perintah berikut + link:\n┣ *yt <link>* → YouTube (MP4/MP3)\n┣ *tt <link>* → TikTok (Video/Audio)\n┣ *ig <link>* → Instagram (Reels/Post)\n┣ *fb <link>* → Facebook Video\n┗ *terabox <link>* → Download Terabox\n_(💡 Bisa juga kirim link langsung tanpa awalan!)_\n\n🎬 *Streaming & Download:*\n🌸 *.wibu <judul>* → Cari Anime\n🇰🇷 *.drakor <judul>* → Cari Drakor\n\n⚙️ *Perintah Lainnya:*\n┣ *.menu* → Menampilkan menu\n┣ *.info* → Info & Status Server\n┗ *0* → Batalkan sesi/antrean\n\n💡 _Tips: Di grup, mention bot + perintah_\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n⚡ _Powered by @IKBAL_`
    });
}

async function sendInfo(sock, jid, msg) {
    await react(sock, msg, 'ℹ️');
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const mem = process.memoryUsage();
    const disk = getDiskSpace();

    await sock.sendMessage(jid, {
        text: `ℹ️ *BOT INFORMATION*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n🤖 *Nama:* ${config.botName}\n📌 *Versi:* ${config.version}\n🛠️ *Engine:* Node.js ${process.version}\n⏱️ *Uptime:* ${hours}j ${mins}m\n💾 *RAM:* ${formatSize(mem.heapUsed)} / ${formatSize(mem.heapTotal)}\n📁 *Temp:* ${formatSize(disk.tempUsed)}\n📊 *Sesi:* ${sessions.size} aktif\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n📥 *Download:* YT, TikTok, IG, FB, Terabox\n🌸 *Anime:* Search, Stream, Download\n💾 *Metode:* Download ke disk\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n${config.footer}`
    });
}

async function sendAnimeHelp(sock, jid, msg) {
    await react(sock, msg, '🌸');
    await sock.sendMessage(jid, {
        text: `🌸 *ANIME DOWNLOADER*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n📌 *Cara Pakai:*\nKetik *.wibu* diikuti judul anime\n\n📋 *Contoh:*\n┣ *.wibu Isekai Nonbiri*\n┣ *.wibu One Piece*\n┣ *.wibu Jujutsu Kaisen*\n┗ *.wibu Bocchi the Rock*\n\n🔄 *Alur:*\n  1️⃣ *.wibu <judul>* → Cari\n  2️⃣ Pilih anime dari list\n  3️⃣ Pilih nomor episode\n  4️⃣ Pilih resolusi\n  5️⃣ Bot download ke server dulu\n  6️⃣ Bot kirim video ke chat!\n\n⌨️ *Navigasi:*\n┣ *angka* → pilih item\n┣ *next/prev* → pindah halaman\n┣ *back* → kembali\n┗ *0* → batalkan\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n${config.footer}`
    });
}

async function handleAnimeSearch(sock, jid, sender, query, msg) {
    await react(sock, msg, '🔍');
    const loadingMsg = await sock.sendMessage(jid, { text: `🔍 *Mencari:* _${query}_\n⏳ _Mohon tunggu..._` });
    const editKey = loadingMsg?.key;

    try {
        const response = await axios.get(`${API}/anime/search`, {
            params: { query, page: 1 }, timeout: config.apiTimeout
        });

        const searchData = response.data.data[0];
        const results = searchData.result || [];
        const total = searchData.jumlah || results.length;

        if (results.length === 0) {
            await react(sock, msg, '❌');
            const textNotFound = `🔍 *Tidak ditemukan!*\n\nTidak ada hasil untuk: _${query}_\n\n💡 Coba kata kunci berbeda / judul romaji`;
            if (editKey) await sock.sendMessage(jid, { text: textNotFound, edit: editKey });
            else await sock.sendMessage(jid, { text: textNotFound });
            return;
        }

        if (results.length === 1) {
            await react(sock, msg, '🌸');
            return await showAnimeDetail(sock, jid, sender, results[0], msg, editKey);
        }

        const maxShow = Math.min(results.length, 15);
        const displayResults = results.slice(0, maxShow);

        setSession(sender, { platform: 'anime', state: 'anime_list', results: displayResults, query });

        let listText = '';
        displayResults.forEach((anime, i) => {
            const statusEm = getStatusEmoji(anime.status);
            const genres = (anime.genre || []).slice(0, 3).join(', ');
            listText += `  ⌊${i + 1}⌋ *${truncate(anime.judul, 45)}*\n      ${statusEm} ${anime.status || '-'} │ ⭐ ${anime.score || '?'} │ 📊 ${anime.total_episode || '?'} Ep\n      🎭 ${genres || '-'}\n\n`;
        });

        const finalMsg = `🔍 *HASIL PENCARIAN*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n🔎 _${query}_ → ${total} ditemukan\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n${listText}━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Ketik *nomor* untuk detail\n🔄 Ketik *0* batalkan`;

        await simulateTyping(sock, jid);
        if (editKey) await sock.sendMessage(jid, { text: finalMsg, edit: editKey });
        else await sock.sendMessage(jid, { text: finalMsg });
        
    } catch (error) {
        await react(sock, msg, '❌');
        const errText = `❌ *Gagal mencari!*\n💡 Server sibuk, coba lagi.`;
        if (editKey) await sock.sendMessage(jid, { text: errText, edit: editKey });
        else await sock.sendMessage(jid, { text: errText });
    }
}

async function showAnimeDetail(sock, jid, sender, animeResult, msg, editKey = null) {
    let currentEditKey = editKey;
    
    if (!currentEditKey) {
        const loadingMsg = await sock.sendMessage(jid, { text: `🌸 *Mengambil detail...*\n⏳ _Mohon tunggu..._` });
        currentEditKey = loadingMsg?.key;
    } else {
        await sock.sendMessage(jid, { text: `🌸 *Mengambil detail...*\n⏳ _Mohon tunggu..._`, edit: currentEditKey });
    }

    try {
        const response = await axios.get(`${API}/anime/detail`, {
            params: { series: animeResult.url }, timeout: config.apiTimeout
        });

        const data = response.data.data[0];
        if (!data) { 
            await sock.sendMessage(jid, { text: `❌ *Gagal ambil detail.*`, edit: currentEditKey }); 
            return; 
        }

        const episodes = (data.chapter || []).slice().sort((a, b) => (parseInt(a.ch) || 0) - (parseInt(b.ch) || 0));
        if (episodes.length === 0) { 
            await sock.sendMessage(jid, { text: `❌ *Belum ada episode.*`, edit: currentEditKey }); 
            return; 
        }

        const animeInfo = {
            judul: data.judul, series_id: data.series_id, cover: data.cover,
            rating: data.rating, type: data.type, status: data.status,
            studio: data.author, published: data.published,
            genre: data.genre || [], sinopsis: data.sinopsis || '-'
        };

        setSession(sender, { platform: 'anime', state: 'anime_detail', animeInfo, episodes, page: 1 });
        await simulateTyping(sock, jid);
        await showEpisodePage(sock, jid, sender, msg, true, currentEditKey);

    } catch (error) {
        await sock.sendMessage(jid, { text: `❌ *Gagal ambil detail!*\n💡 Coba lagi.`, edit: currentEditKey });
    }
}

async function showEpisodePage(sock, jid, sender, msg, showFullInfo = false, editKey = null) {
    const session = getSession(sender);
    if (!session) return;

    const { animeInfo, episodes, page } = session;
    const totalPages = Math.ceil(episodes.length / EPISODES_PER_PAGE);
    const start = (page - 1) * EPISODES_PER_PAGE;
    const end = Math.min(start + EPISODES_PER_PAGE, episodes.length);
    const pageEps = episodes.slice(start, end);

    let epList = '';
    pageEps.forEach((ep, i) => {
        const idx = start + i + 1;
        epList += `  ⌊${idx}⌋  📺 Ep ${String(ep.ch).padEnd(12)}│ 👁️ ${formatNumber(ep.views)}\n`;
    });

    let nav = '';
    if (totalPages > 1) {
        let parts = [];
        if (page > 1) parts.push('◀️ *prev*');
        parts.push(`📄 ${page}/${totalPages}`);
        if (page < totalPages) parts.push('▶️ *next*');
        nav = parts.join(' │ ');
    }

    if (showFullInfo) {
        const sinopsis = truncate(animeInfo.sinopsis, 500);
        const genres = animeInfo.genre.join(', ');
        const statusEm = getStatusEmoji(animeInfo.status);

        const msgText = `🌸 *ANIME DETAIL*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n🎬 *${animeInfo.judul}*\n\n⭐ ${animeInfo.rating || '?'}/10 │ ${statusEm} ${animeInfo.status || '-'}\n📺 ${animeInfo.type || '-'} │ 🏢 ${animeInfo.studio || '-'}\n📅 ${animeInfo.published || '-'}\n🎭 ${genres || '-'}\n📊 ${episodes.length} Episode\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n📖 *Sinopsis:*\n${sinopsis}\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n📋 *Episode${totalPages > 1 ? ` (${page}/${totalPages})` : ''}:*\n\n${epList}\n${nav ? nav + '\n' : ''}━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Ketik *nomor urut* (contoh: *${start + 1}*)\n🔙 *back* │ 🔄 *0* batalkan`;

        if (animeInfo.cover) {
            try { 
                if (editKey) await sock.sendMessage(jid, { delete: editKey }).catch(()=>{});
                await sock.sendMessage(jid, { image: { url: animeInfo.cover }, caption: msgText }); 
                return; 
            } catch (e) { }
        }
        
        if (editKey) await sock.sendMessage(jid, { text: msgText, edit: editKey });
        else await sock.sendMessage(jid, { text: msgText });
        
    } else {
        const msgText = `🌸 *${animeInfo.judul}*\n\n📋 *Episode (${page}/${totalPages}):*\n\n${epList}\n${nav ? nav + '\n' : ''}━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Ketik *nomor* │ 🔙 *back* │ 🔄 *0*`;
        if (editKey) await sock.sendMessage(jid, { text: msgText, edit: editKey });
        else await sock.sendMessage(jid, { text: msgText });
    }
}

async function handleAnimeSelection(sock, jid, sender, num, msg) {
    const session = getSession(sender);
    if (!session) {
        await sock.sendMessage(jid, { text: '⏰ *Sesi berakhir.* Ketik *.wibu <judul>*' });
        return;
    }
    switch (session.state) {
        case 'anime_list': return selectAnimeFromList(sock, jid, sender, num, msg);
        case 'anime_detail': return selectEpisode(sock, jid, sender, num, msg);
        case 'anime_reso': return selectResolution(sock, jid, sender, num, msg);
        case 'anime_disclaimer': return handleAnimeDisclaimer(sock, jid, sender, num, msg);
    }
}

async function selectAnimeFromList(sock, jid, sender, num, msg) {
    const session = getSession(sender);
    const index = num - 1;
    if (index < 0 || index >= session.results.length) {
        await sock.sendMessage(jid, { text: `❌ Pilih *1* - *${session.results.length}*` });
        return;
    }
    deleteSession(sender);
    await react(sock, msg, '🌸');
    await showAnimeDetail(sock, jid, sender, session.results[index], msg);
}

async function selectEpisode(sock, jid, sender, num, msg) {
    const session = getSession(sender);
    const { animeInfo, episodes } = session;
    const index = num - 1;

    if (index < 0 || index >= episodes.length) {
        await sock.sendMessage(jid, { text: `❌ Pilih *1* - *${episodes.length}*` });
        return;
    }

    const episode = episodes[index];
    const epNum = extractEpNumber(episode);

    await react(sock, msg, '⏳');
    const loadingMsg = await sock.sendMessage(jid, {
        text: `🌸 *${animeInfo.judul}*\n📺 Mengambil Episode ${episode.ch}...\n⏳ _Mohon tunggu..._`
    });
    const editKey = loadingMsg?.key;

    try {
        const streamRes = await axios.get(`${API}/anime/stream`, {
            params: { slug: episode.url, series: animeInfo.series_id, episode: epNum },
            timeout: config.apiTimeout
        });

        const streamInfo = streamRes.data.data[0];
        if (!streamInfo) {
            await sock.sendMessage(jid, { text: `❌ *Stream tidak tersedia untuk Ep ${episode.ch}*`, edit: editKey });
            return;
        }

        const resoOptions = [];

        for (const r of (streamInfo.reso || [])) {
            const streams = streamInfo.streams[r];
            if (!streams || streams.length === 0) continue;

            const preferred = getPreferredStream(streamInfo.streams, r);
            if (!preferred || !preferred.link) continue;

            let sizeLabel = null;
            let sizeKb = null;

            if (streamInfo.resoSizeKb && streamInfo.resoSizeKb[r]) {
                sizeKb = streamInfo.resoSizeKb[r];
                sizeLabel = formatSizeKb(sizeKb);
            }
            if (!sizeLabel && streamInfo.resoSize && streamInfo.resoSize[r]) {
                sizeLabel = streamInfo.resoSize[r];
            }
            if (!sizeKb && preferred.size_kb) {
                sizeKb = preferred.size_kb;
                sizeLabel = formatSizeKb(sizeKb);
            }

            resoOptions.push({
                resolution: r,
                size: sizeLabel || '~',
                sizeKb: sizeKb,
                sizeMb: sizeKb ? sizeKb / 1024 : null,
                downloadUrl: preferred.link,
                source: preferred.source,
                fast: preferred.fast || false
            });
        }

        if (resoOptions.length === 0) {
            await sock.sendMessage(jid, { text: `❌ *Tidak ada stream untuk Ep ${episode.ch}*\n💡 Coba episode lain.`, edit: editKey });
            return;
        }

        setSession(sender, {
            platform: 'anime', state: 'anime_reso',
            animeInfo, episodes, lastPage: session.page,
            selectedEpisode: episode, resoOptions
        });

        let resoList = '';
        resoOptions.forEach((opt, i) => {
            const emoji = i < NUM_EMOJI.length ? NUM_EMOJI[i] : `[${i + 1}]`;
            const speedIcon = opt.fast ? '⚡' : '📡';
            resoList += `  ${emoji}  📹 ${opt.resolution} │ 📦 ${opt.size} ${speedIcon}\n`;
        });

        const finalMsg = `🌸 *${animeInfo.judul}*\n📺 *Episode ${episode.ch}*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n📥 *Pilih Resolusi:*\n\n${resoList}\n  ⚡ = AnimKita (Cepat)\n  📡 = Server Alternatif\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Balas *angka* │ 🔙 *back* │ 🔄 *0*`;

        await simulateTyping(sock, jid);
        await sock.sendMessage(jid, { text: finalMsg, edit: editKey });

    } catch (error) {
        await react(sock, msg, '❌');
        await sock.sendMessage(jid, { text: `❌ *Gagal ambil stream Ep ${episode.ch}*\n🔙 *back* untuk kembali`, edit: editKey });
    }
}

async function selectResolution(sock, jid, sender, num, msg) {
    const session = getSession(sender);
    const { animeInfo, selectedEpisode, resoOptions } = session;
    const index = num - 1;

    if (index < 0 || index >= resoOptions.length) {
        await sock.sendMessage(jid, { text: `❌ Pilih *1* - *${resoOptions.length}*` });
        return;
    }

    const selected = resoOptions[index];

    if (!selected.downloadUrl) {
        await sock.sendMessage(jid, { text: `❌ *Link tidak tersedia untuk ${selected.resolution}*` });
        return;
    }

    setSession(sender, {
        platform: 'anime',
        state: 'anime_disclaimer',
        animeInfo,
        selectedEpisode,
        selectedReso: selected
    });

    const disclaimerMsg = `⚠️ *PERINGATAN & DISCLAIMER* ⚠️\n━━━━━━━━━━━━━━━━━━━━━━━━\n\nMengunduh konten berhak cipta secara tidak resmi adalah tindakan ilegal.\n\nDengan melanjutkan, kamu setuju bahwa:\n1. Bot ini hanya sebagai alat bantu perantara.\n2. *Owner tidak bertanggung jawab* atas dosa, risiko hukum, atau konsekuensi apa pun(maen aman Wak😅🗿🙏).\n3. Risiko sepenuhnya kamu tanggung sendiri.\n\nApakah kamu setuju?\n\n  1️⃣  *Ya, Saya Setuju*\n  0️⃣  *Batal*\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Balas *1* untuk lanjut.`;

    await react(sock, msg, '⚠️');
    await simulateTyping(sock, jid);
    await sock.sendMessage(jid, { text: disclaimerMsg });
}

async function handleAnimeDisclaimer(sock, jid, sender, num, msg) {
    const session = getSession(sender);
    if (!session) return;

    if (num === 1) {
        const { animeInfo, selectedEpisode, selectedReso } = session;
        deleteSession(sender);
        await executeAnimeDownload(sock, jid, animeInfo, selectedEpisode, selectedReso, msg);
    } else {
        deleteSession(sender);
        await sock.sendMessage(jid, { text: `❌ Proses dibatalkan.` });
    }
}

async function executeAnimeDownload(sock, jid, animeInfo, selectedEpisode, selected, msg) {
    const sizeMb = selected.sizeMb || 0;
    const filename = `${animeInfo.judul} - Ep ${selectedEpisode.ch} [${selected.resolution}].mp4`;
    const caption = `🌸 ${animeInfo.judul}\n📺 Episode ${selectedEpisode.ch} (${selected.resolution})`;

    await react(sock, msg, '⏬');

    await sock.sendMessage(jid, {
        text: `🌸 *${animeInfo.judul}*\n📺 Episode ${selectedEpisode.ch} • ${selected.resolution}\n📦 Size: ${selected.size}\n${selected.fast ? '⚡ Server: AnimKita' : '📡 Server: Alternatif'}\n\n💾 _Mendownload ke server..._\n${sizeMb > 80 ? '⚠️ _File besar, sabar ya ~_' : '⏳ _Mohon tunggu..._'}`
    });

    const success = await downloadAndSend(sock, jid, selected.downloadUrl, 'video', caption, filename, msg, true);

    if (!success) {
        await react(sock, msg, '❌');
    }
}

async function handleAnimePage(sock, jid, sender, direction, msg) {
    const session = getSession(sender);
    if (!session || session.state !== 'anime_detail') return;

    const totalPages = Math.ceil(session.episodes.length / EPISODES_PER_PAGE);
    let newPage = session.page;

    if (direction === 'next') {
        if (session.page >= totalPages) { await sock.sendMessage(jid, { text: '📄 Halaman terakhir!' }); return; }
        newPage++;
    } else {
        if (session.page <= 1) { await sock.sendMessage(jid, { text: '📄 Halaman pertama!' }); return; }
        newPage--;
    }

    setSession(sender, { ...session, page: newPage });
    await showEpisodePage(sock, jid, sender, msg, false);
}

async function handleAnimeBack(sock, jid, sender, msg) {
    const session = getSession(sender);
    if (!session) return;

    if (session.state === 'anime_reso') {
        setSession(sender, {
            platform: 'anime', state: 'anime_detail',
            animeInfo: session.animeInfo, episodes: session.episodes,
            page: session.lastPage || 1
        });
        await sock.sendMessage(jid, { text: '🔙 _Kembali ke episode..._' });
        await showEpisodePage(sock, jid, sender, msg, false);
        return;
    }
    if (session.state === 'anime_detail' || session.state === 'anime_list') {
        deleteSession(sender);
        await sock.sendMessage(jid, { text: '🔙 *Sesi selesai.*\n💡 *.wibu <judul>* untuk cari lagi.' });
    }
}

async function handlePlatform(sock, jid, sender, url, platform, msg, pushName) {
    // React removed — sub-handler will react once

    const emoji = { youtube: '🔴', tiktok: '🎵', instagram: '📸', facebook: '🔵', terabox: '📦' };
    const name = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', facebook: 'Facebook', terabox: 'Terabox' };

    await sock.sendMessage(jid, {
        text: `${emoji[platform]} *${name[platform]} Detected!*\n⏳ Memproses...`
    });

    try {
        switch (platform) {
            case 'youtube': return await handleYoutube(sock, jid, sender, url, msg);
            case 'tiktok': return await handleTiktok(sock, jid, sender, url, msg);
            case 'instagram': return await handleInstagram(sock, jid, sender, url, msg);
            case 'facebook': return await handleFacebook(sock, jid, sender, url, msg);
            case 'terabox': return await handleTerabox(sock, jid, sender, url, msg);
        }
    } catch (error) {
        await react(sock, msg, '❌');
        await sock.sendMessage(jid, {
            text: `❌ *Gagal memproses ${name[platform]}*\n\n┣ Link tidak valid/expired\n┣ Konten private\n┗ Server sibuk\n\n💡 Cek link & coba lagi.`
        });
    }
}

async function handleYoutube(sock, jid, sender, url, msg) {
    const response = await axios.get(`${API}/youtube/video`, { params: { url }, timeout: config.apiTimeout });
    const data = response.data;
    if (!data.download_link) throw new Error('No links');

    const title = cleanTitle(data.filename);
    const links = data.download_link;
    const options = [];

    if (links['1080p']) options.push({ label: '1080p (Full HD)', icon: '🔹', url: links['1080p'], type: 'video', quality: '1080p' });
    if (links['720p']) options.push({ label: '720p (HD)', icon: '🔹', url: links['720p'], type: 'video', quality: '720p' });
    if (links['480p']) options.push({ label: '480p (SD)', icon: '🔹', url: links['480p'], type: 'video', quality: '480p' });
    if (links['360p']) options.push({ label: '360p (Low)', icon: '🔹', url: links['360p'], type: 'video', quality: '360p' });
    options.push({ label: 'MP3 320kbps', icon: '🎵', type: 'audio', quality: '320kbps', originalUrl: url });
    options.push({ label: 'MP3 128kbps', icon: '🎵', type: 'audio', quality: '128kbps', originalUrl: url });

    setSession(sender, { platform: 'youtube', title, options, originalUrl: url });

    let videoOpts = '', audioOpts = '';
    options.forEach((opt, i) => {
        const line = `  ${NUM_EMOJI[i]}  ${opt.icon} ${opt.label}\n`;
        if (opt.type === 'video') videoOpts += line; else audioOpts += line;
    });

    await react(sock, msg, '🔴');
    await sock.sendMessage(jid, {
        text: `🔴 *YOUTUBE*\n━━━━━━━━━━━━━━━━━━━━━━━━\n📹 *${title}*\n\n📥 *Video:*\n${videoOpts}\n🎵 *Audio:*\n${audioOpts}\n━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Balas *angka* │ *0* batalkan`
    });
}

async function handleTiktok(sock, jid, sender, url, msg) {
    const response = await axios.get(`${API}/sosmed/tiktok`, { params: { url }, timeout: config.apiTimeout });
    const data = response.data;
    if (data.status !== 'success' || !data.data) throw new Error('API error');

    const info = data.data;
    const options = [];

    if (info.hdplay) options.push({ label: `HD No WM • ${formatSize(info.hd_size)}`, icon: '🎬', url: info.hdplay, type: 'video' });
    if (info.play) options.push({ label: `Normal No WM • ${formatSize(info.size)}`, icon: '📹', url: info.play, type: 'video' });
    if (info.wmplay) options.push({ label: `Watermark • ${formatSize(info.wm_size)}`, icon: '💧', url: info.wmplay, type: 'video' });
    if (info.music) options.push({ label: truncate(`Audio (${info.music_info?.title || 'Sound'})`, 50), icon: '🎵', url: info.music, type: 'audio' });

    if (options.length === 0) throw new Error('No media');

    setSession(sender, { platform: 'tiktok', title: info.title || 'TikTok', options });

    let optsText = '';
    options.forEach((opt, i) => { optsText += `  ${NUM_EMOJI[i]}  ${opt.icon} ${opt.label}\n`; });

    const msgText = `🎵 *TIKTOK*\n━━━━━━━━━━━━━━━━━━━━━━━━\n📝 *${truncate(info.title || '-', 80)}*\n👤 @${info.author?.unique_id || '?'} • ${formatDuration(info.duration)}\n👀 ${formatNumber(info.play_count)} • ❤️ ${formatNumber(info.digg_count)}\n\n📥 *Format:*\n${optsText}\n━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Balas *angka* │ *0* batalkan`;

    await react(sock, msg, '🎵');
    if (info.cover) {
        try { await sock.sendMessage(jid, { image: { url: info.cover }, caption: msgText }); return; } catch (e) { }
    }
    await sock.sendMessage(jid, { text: msgText });
}

async function handleInstagram(sock, jid, sender, url, msg) {
    const response = await axios.get(`${API}/sosmed/instagram`, { params: { url }, timeout: config.apiTimeout });
    const data = response.data;
    if (data.status !== 'success' || !data.video_url) {
        await sock.sendMessage(jid, { text: '❌ *Video tidak ditemukan.*' }); return;
    }

    await react(sock, msg, '📸');
    await sock.sendMessage(jid, {
        text: `📸 *INSTAGRAM*\n👤 @${data.username || '?'}\n📝 ${truncate(data.description || '-', 150)}\n⏳ _Mendownload..._`
    });

    const success = await downloadAndSend(sock, jid, data.video_url, 'video', `📸 @${data.username || '?'}`, `ig_${data.username || 'video'}.mp4`, msg);
    if (success) await react(sock, msg, '✅');
    else await react(sock, msg, '❌');
}

async function handleFacebook(sock, jid, sender, url, msg) {
    const response = await axios.get(`${API}/sosmed/facebook`, { params: { url }, timeout: config.apiTimeout });
    const data = response.data;
    if (data.status !== 'success') throw new Error('API error');

    const options = [];
    if (data.video_url_hd) options.push({ label: 'HD (720p)', icon: '🔹', url: data.video_url_hd, type: 'video' });
    if (data.video_url_sd) options.push({ label: 'SD (360p)', icon: '🔸', url: data.video_url_sd, type: 'video' });
    if (options.length === 0) throw new Error('No links');

    if (options.length === 1) {
        await react(sock, msg, '🔵');
        const success = await downloadAndSend(sock, jid, options[0].url, 'video', `🔵 Facebook`, 'fb_video.mp4', msg);
        if (success) await react(sock, msg, '✅');
        else await react(sock, msg, '❌');
        return;
    }

    setSession(sender, { platform: 'facebook', title: data.description || 'Facebook', options });
    let optsText = '';
    options.forEach((opt, i) => { optsText += `  ${NUM_EMOJI[i]}  ${opt.icon} ${opt.label}\n`; });

    await react(sock, msg, '🔵');
    await sock.sendMessage(jid, {
        text: `🔵 *FACEBOOK*\n━━━━━━━━━━━━━━━━━━━━━━━━\n📹 *${data.description || 'Video'}*\n⏱️ ${data.stats?.durasi || '-'}\n\n📥 *Kualitas:*\n${optsText}\n━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Balas *angka* │ *0* batalkan`
    });
}

async function handleTerabox(sock, jid, sender, url, msg) {
    const response = await axios.get(`${API}/terabox`, { params: { url }, timeout: config.apiTimeout });
    const data = response.data;
    if (data.status !== 'success' || !data.files?.length) throw new Error('No files');

    const options = data.files.map((file) => ({
        label: `${truncate(file.filename || 'file', 50)} • ${formatSize(parseInt(file.size || 0))}`,
        icon: '📄', url: file.download_link || file.base_link,
        type: 'document', filename: file.filename || 'download'
    }));

    if (options.length === 1) {
        await react(sock, msg, '📦');
        await sock.sendMessage(jid, { text: `📦 *TERABOX*\n📄 ${options[0].filename}\n⏳ _Mendownload..._` });

        const ext = options[0].filename.split('.').pop().toLowerCase();
        const isVid = ['mp4', 'mkv', 'avi'].includes(ext);
        const isAud = ['mp3', 'wav', 'ogg'].includes(ext);
        let t = 'document';
        if (isVid) t = 'video'; else if (isAud) t = 'audio';

        const success = await downloadAndSend(sock, jid, options[0].url, t, '', options[0].filename, msg);
        if (success) await react(sock, msg, '✅');
        else await react(sock, msg, '❌');
        return;
    }

    setSession(sender, { platform: 'terabox', title: 'Terabox', options });
    let optsText = '';
    options.forEach((opt, i) => { if (i < 9) optsText += `  ${NUM_EMOJI[i]}  ${opt.icon} ${opt.label}\n`; });

    await react(sock, msg, '📦');
    await sock.sendMessage(jid, {
        text: `📦 *TERABOX*\n━━━━━━━━━━━━━━━━━━━━━━━━\n📁 ${data.total_files} file\n\n${optsText}\n━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Balas *angka* │ *0* batalkan`
    });
}

async function handleSelection(sock, jid, sender, selection, msg) {
    const session = getSession(sender);
    if (!session) { await sock.sendMessage(jid, { text: '⏰ *Sesi berakhir.* Kirim link lagi.' }); return; }

    const index = selection - 1;
    if (index < 0 || index >= session.options.length) {
        await sock.sendMessage(jid, { text: `❌ Pilih *1* - *${session.options.length}*` }); return;
    }

    const option = session.options[index];
    deleteSession(sender);
    await react(sock, msg, '⏬');

    const emoji = { youtube: '🔴', tiktok: '🎵', instagram: '📸', facebook: '🔵', terabox: '📦' };
    const em = emoji[session.platform] || '📥';

    if (session.platform === 'youtube' && option.type === 'audio') {
        try {
            await sock.sendMessage(jid, { text: `${em} *Audio ${option.quality}...*\n🎵 ${session.title}\n⏳ _Mendownload..._` });

            const musicRes = await axios.get(`${API}/youtube/music`, {
                params: { url: session.originalUrl }, timeout: config.apiTimeout
            });
            if (!musicRes.data.download_link?.[option.quality]) throw new Error('Not available');

            const audioUrl = musicRes.data.download_link[option.quality];
            const audioFile = musicRes.data.filename || `${session.title}.mp3`;

            const success = await downloadAndSend(sock, jid, audioUrl, 'audio', '', audioFile, msg);

            if (!success) {
                await react(sock, msg, '❌');
            }
            return;
        } catch (e) {
            await react(sock, msg, '❌');
            await sock.sendMessage(jid, { text: `❌ *Gagal download audio.*\n💡 Coba lagi.` });
            return;
        }
    }

    try {
        await sock.sendMessage(jid, {
            text: `${em} *Mendownload ${option.label}...*\n💾 _Download ke server..._\n📤 _Lalu dikirim ke chat!_`
        });

        const filename = option.filename || `${session.platform}_${option.quality || 'dl'}.${option.type === 'audio' ? 'mp3' : 'mp4'}`;
        const success = await downloadAndSend(sock, jid, option.url, option.type, `${em} ${session.title}`, filename, msg);

        if (!success) {
            await react(sock, msg, '❌');
        }
    } catch (e) {
        await react(sock, msg, '❌');
        await sock.sendMessage(jid, {
            text: `❌ *Gagal.*\n\n🔗 *Manual:*\n${option.url}\n\n💡 _Buka di browser_`
        });
    }
}

const DRAKOR_API = 'https://api.sonzaix.indevs.in/drama';

async function handleDrakorSearch(sock, jid, sender, query, msg) {
    await react(sock, msg, '🔍');
    const loadingMsg = await sock.sendMessage(jid, { text: `🎬 *Mencari:* _${query}_\n⏳ _Mohon tunggu..._` });
    const editKey = loadingMsg?.key;

    try {
        const response = await axios.get(`${DRAKOR_API}/search`, { params: { q: query, limit: 10 } });
        const results = response.data.data || [];

        if (results.length === 0) {
            await react(sock, msg, '❌');
            const errText = `🎬 *Tidak ditemukan!*\nTidak ada hasil untuk: _${query}_`;
            if (editKey) await sock.sendMessage(jid, { text: errText, edit: editKey });
            else await sock.sendMessage(jid, { text: errText });
            return;
        }

        setSession(sender, { platform: 'drakor', state: 'drakor_list', results, query });

        let listText = '';
        results.forEach((item, i) => {
            listText += `  ⌊${i + 1}⌋ *${truncate(item.title, 45)}*\n      🎭 ${item.category || '-'}\n      👁️ ${formatNumber(item.hits)} hits\n\n`;
        });

        const finalMsg = `🎬 *HASIL PENCARIAN DRAKOR*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n🔎 _${query}_ → ${results.length} ditemukan\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n${listText}━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Ketik *nomor* untuk detail\n🔄 Ketik *0* batalkan`;

        await simulateTyping(sock, jid);
        if (editKey) await sock.sendMessage(jid, { text: finalMsg, edit: editKey });
        else await sock.sendMessage(jid, { text: finalMsg });

    } catch (error) {
        await react(sock, msg, '❌');
        const errText = `❌ *Gagal mencari drakor!*\nServer sibuk.`;
        if (editKey) await sock.sendMessage(jid, { text: errText, edit: editKey });
        else await sock.sendMessage(jid, { text: errText });
    }
}

async function handleDrakorSelection(sock, jid, sender, num, msg) {
    const session = getSession(sender);
    if (!session) return;
    switch (session.state) {
        case 'drakor_list': return selectDrakorFromList(sock, jid, sender, num, msg);
        case 'drakor_detail': return selectDrakorEpisode(sock, jid, sender, num, msg);
        case 'drakor_reso': return selectDrakorResolution(sock, jid, sender, num, msg);
        case 'drakor_disclaimer': return handleDrakorDisclaimer(sock, jid, sender, num, msg);
        case 'drakor_confirm': return handleDrakorConfirmation(sock, jid, sender, num, msg);
    }
}

async function selectDrakorFromList(sock, jid, sender, num, msg) {
    const session = getSession(sender);
    const index = num - 1;
    if (index < 0 || index >= session.results.length) return;

    const selected = session.results[index];
    deleteSession(sender);

    await react(sock, msg, '⏳');
    const loadingMsg = await sock.sendMessage(jid, { text: `🎬 *Mengambil info detail...*\n⏳ _Mohon tunggu..._` });
    const editKey = loadingMsg?.key;

    try {
        const response = await axios.get(`${DRAKOR_API}/info`, { params: { id: selected.id } });
        
        let data = response.data;
        if (data.status === 1 && data.data) {
            data = data.data; 
        }
        
        if (!data || !data.data_episode) {
            await sock.sendMessage(jid, { text: `❌ *Data tidak lengkap.*\n💡 Gagal memuat info drakor.`, edit: editKey });
            return;
        }

        const episodes = data.data_episode;
        setSession(sender, { platform: 'drakor', state: 'drakor_detail', detail: data, episodes });

        let epList = '';
        episodes.forEach((ep, i) => {
            epList += `  ⌊${i + 1}⌋ 📺 ${ep.episode_label}\n`;
        });

        const synopsis = truncate(data.synopsis_clean, 400);
        const msgText = `🎬 *${data.title}*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n🎭 ${data.category}\n📊 ${data.total_episode} Episode\n👁️ ${formatNumber(data.hits)} hits\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n📖 *Sinopsis:*\n${synopsis}\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n📋 *List Episode:*\n\n${epList}\n━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Ketik *nomor urut episode*\n🔄 Ketik *0* batalkan`;

        await simulateTyping(sock, jid);
        
        if (data.image) {
            try {
                if (editKey) await sock.sendMessage(jid, { delete: editKey }).catch(()=>{});
                await sock.sendMessage(jid, { image: { url: data.image }, caption: msgText });
                return;
            } catch (e) {}
        }

        if (editKey) await sock.sendMessage(jid, { text: msgText, edit: editKey });
        else await sock.sendMessage(jid, { text: msgText });

    } catch (error) {
        await sock.sendMessage(jid, { text: `❌ *Gagal mengambil detail.*`, edit: editKey });
    }
}

async function selectDrakorEpisode(sock, jid, sender, num, msg) {
    const session = getSession(sender);
    const index = num - 1;
    if (index < 0 || index >= session.episodes.length) return;

    const episode = session.episodes[index];
    const detail = session.detail;

    await react(sock, msg, '⏳');
    const loadingMsg = await sock.sendMessage(jid, { text: `📺 *Membuka ${episode.episode_label}...*\n⏳ _Mohon tunggu..._` });
    const editKey = loadingMsg?.key;

    try {
        const response = await axios.get(`${DRAKOR_API}/stream`, { params: { id: episode.episode_id } });
        
        let dataRes = response.data;
        if (dataRes.status === 1 && dataRes.data) {
            dataRes = dataRes.data;
        }
        
        let actualStream = null;
        if (dataRes.data_stream && dataRes.data_stream.length > 0) {
            actualStream = dataRes.data_stream[0];
        } else if (dataRes['360p'] || dataRes['480p']) {
            actualStream = dataRes;
        }

        if (!actualStream) {
            await sock.sendMessage(jid, { text: `❌ *Stream tidak tersedia untuk episode ini.*`, edit: editKey });
            return;
        }

        const resoOptions = [];
        const qualities = ['360p', '480p', '720p', '1080p'];
        
        qualities.forEach(q => {
            if (actualStream[q]) {
                const sizeLabel = actualStream[`${q}_size`] || '~ MB';
                const sizeNum = parseSizeToMB(sizeLabel);
                resoOptions.push({
                    resolution: q,
                    url: actualStream[q],
                    sizeLabel: sizeLabel,
                    sizeMB: sizeNum
                });
            }
        });

        if (resoOptions.length === 0) {
            await sock.sendMessage(jid, { text: `❌ *Resolusi tidak ditemukan.*`, edit: editKey });
            return;
        }

        setSession(sender, { platform: 'drakor', state: 'drakor_reso', detail, episode, resoOptions });

        let resoList = '';
        resoOptions.forEach((opt, i) => {
            const emoji = i < NUM_EMOJI.length ? NUM_EMOJI[i] : `[${i + 1}]`;
            resoList += `  ${emoji} 📹 ${opt.resolution} │ 📦 ${opt.sizeLabel}\n`;
        });

        const finalMsg = `🎬 *${detail.title}*\n📺 *${episode.episode_label}*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n📥 *Pilih Resolusi:*\n\n${resoList}\n⚠️ _Perhatian: Ukuran file lebih dari 500MB tidak disarankan untuk didownload via bot._\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Balas *angka* │ 🔄 *0* batalkan`;

        await simulateTyping(sock, jid);
        await sock.sendMessage(jid, { text: finalMsg, edit: editKey });

    } catch (error) {
        await sock.sendMessage(jid, { text: `❌ *Gagal mengambil link stream.*`, edit: editKey });
    }
}

async function selectDrakorResolution(sock, jid, sender, num, msg) {
    const session = getSession(sender);
    const index = num - 1;
    if (index < 0 || index >= session.resoOptions.length) return;

    const selected = session.resoOptions[index];

    setSession(sender, {
        platform: 'drakor',
        state: 'drakor_disclaimer',
        detail: session.detail,
        episode: session.episode,
        selectedReso: selected
    });

    const disclaimerMsg = `⚠️ *PERINGATAN & DISCLAIMER* ⚠️\n━━━━━━━━━━━━━━━━━━━━━━━━\n\nMengunduh konten berhak cipta secara tidak resmi adalah tindakan ilegal.\n\nDengan melanjutkan, kamu setuju bahwa:\n1. Bot ini hanya sebagai alat bantu perantara.\n2. *Owner tidak bertanggung jawab* atas dosa, risiko hukum, atau konsekuensi apa pun(maen aman Wak😅🗿🙏).\n3. Risiko sepenuhnya kamu tanggung sendiri.\n\nApakah kamu setuju?\n\n  1️⃣  *Ya, Saya Setuju*\n  0️⃣  *Batal*\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Balas *1* untuk lanjut.`;

    await react(sock, msg, '⚠️');
    await simulateTyping(sock, jid);
    await sock.sendMessage(jid, { text: disclaimerMsg });
}

async function handleDrakorDisclaimer(sock, jid, sender, num, msg) {
    const session = getSession(sender);
    if (!session) return;

    if (num === 1) {
        const { detail, episode, selectedReso } = session;

        if (selectedReso.sizeMB > 500) {
            setSession(sender, { 
                platform: 'drakor', 
                state: 'drakor_confirm', 
                detail, 
                episode, 
                selectedReso 
            });

            const promptMsg = `⚠️ *FILE SANGAT BESAR*\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n📦 Ukuran: *${selectedReso.sizeLabel}*\n\nServer memiliki batasan untuk mendownload file di atas 500 MB. Apa yang ingin kamu lakukan?\n\n  1️⃣  *Kirimkan Link Download*\n  2️⃣  *Tetap Paksakan Download Video*\n\n━━━━━━━━━━━━━━━━━━━━━━━━\n💡 Balas *1* atau *2*`;
            
            await simulateTyping(sock, jid);
            await sock.sendMessage(jid, { text: promptMsg });
        } else {
            deleteSession(sender);
            await executeDrakorDownload(sock, jid, detail, episode, selectedReso, msg);
        }
    } else {
        deleteSession(sender);
        await sock.sendMessage(jid, { text: `❌ Proses dibatalkan.` });
    }
}

async function handleDrakorConfirmation(sock, jid, sender, num, msg) {
    const session = getSession(sender);
    if (!session) return;
    
    const { detail, episode, selectedReso } = session;
    deleteSession(sender);

    if (num === 1) {
        await react(sock, msg, '🔗');
        await simulateTyping(sock, jid);
        await sock.sendMessage(jid, { 
            text: `🔗 *LINK DOWNLOAD LANGSUNG*\n\n🎬 ${detail.title}\n📺 ${episode.episode_label} (${selectedReso.resolution})\n📦 ${selectedReso.sizeLabel}\n\n${selectedReso.url}\n\n💡 _Salin dan tempel link di atas ke browser (Chrome/Safari) kamu._` 
        });
    } else if (num === 2) {
        await executeDrakorDownload(sock, jid, detail, episode, selectedReso, msg);
    } else {
        await sock.sendMessage(jid, { text: `❌ Pilihan tidak valid. Sesi dibatalkan.` });
    }
}

async function executeDrakorDownload(sock, jid, detail, episode, selected, msg) {
    const filename = `${detail.title} - ${episode.episode_label} [${selected.resolution}].mp4`;
    const caption = `🎬 ${detail.title}\n📺 ${episode.episode_label} (${selected.resolution})`;

    await react(sock, msg, '⏬');
    await simulateTyping(sock, jid);
    await sock.sendMessage(jid, {
        text: `🎬 *${detail.title}*\n📺 ${episode.episode_label} • ${selected.resolution}\n📦 Size: ${selected.sizeLabel}\n\n💾 _Mendownload ke server..._\n📤 _Bot mungkin akan mengirimkan file dalam bentuk Dokumen jika video terlalu panjang._`
    });

    const success = await downloadAndSend(sock, jid, selected.url, 'video', caption, filename, msg, true);

    if (!success) {
        await react(sock, msg, '❌');
    }
}