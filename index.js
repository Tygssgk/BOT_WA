const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const handleMessage = require('./handler');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════
//  🚀 BANNER
// ═══════════════════════════════════════════════
function showBanner() {
    console.log('\x1b[36m');
    console.log('╔════════════════════════════════════════╗');
    console.log('║                                        ║');
    console.log('║    📥  WA DOWNLOADER BOT  v1.0.0       ║');
    console.log('║    Multi-Platform Video Downloader      ║');
    console.log('║                                        ║');
    console.log('║    YouTube • TikTok • Instagram         ║');
    console.log('║    Facebook • Terabox                   ║');
    console.log('║                                        ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('\x1b[0m');
}

// ═══════════════════════════════════════════════
//  🔌 CONNECTION
// ═══════════════════════════════════════════════
async function startBot() {
    showBanner();

    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    const { version } = await fetchLatestBaileysVersion();

    console.log('📡 Menggunakan WA Web version:', version.join('.'));
    console.log('🔄 Menghubungkan ke WhatsApp...\n');

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ['WA Downloader Bot', 'Chrome', '131.0.0'],
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        getMessage: async () => {
            return { conversation: '' };
        }
    });

    // ── Simpan credentials ──
    sock.ev.on('creds.update', saveCreds);

    // ── Handle koneksi + QR CODE ──
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // ★★★ TAMPILKAN QR CODE MANUAL ★★★
        if (qr) {
            console.log('\n📱 Scan QR Code berikut menggunakan WhatsApp:\n');
            qrcode.generate(qr, { small: true }, (qrString) => {
                console.log(qrString);
            });
            console.log('\n📱 Buka WhatsApp > Settings > Linked Devices > Link a Device');
            console.log('─────────────────────────────────────────────────────────\n');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.log(`\n❌ Koneksi terputus. Status: ${statusCode}`);

            if (shouldReconnect) {
                console.log('🔄 Mencoba menghubungkan kembali...\n');
                startBot();
            } else {
                console.log('🚪 Bot logged out. Hapus folder auth_session dan jalankan ulang.');
            }
        }

        if (connection === 'open') {
            console.log('\n╔════════════════════════════════════╗');
            console.log('║   ✅ BOT BERHASIL TERHUBUNG!       ║');
            console.log('║   📱 Bot siap menerima pesan       ║');
            console.log('║   🤖 AI Agent: AKTIF               ║');
            console.log('╚════════════════════════════════════╝\n');

            // ═══ Presence Cycling (Bawaan Kode Kamu) ═══
            setInterval(async () => {
                try {
                    const rand = Math.random();
                    if (rand < 0.4) {
                        await sock.sendPresenceUpdate('unavailable');
                    } else {
                        await sock.sendPresenceUpdate('available');
                    }
                } catch (e) { }
            }, 60000 + Math.random() * 120000);

            // ═══ ⏰ ALARM AI AGENT ═══
            const NOMOR_OWNER = '6281774954859@s.whatsapp.net'; // <--- GANTI NOMORMU DI SINI (Pakai 62)
            const API_AGENT = 'https://ikbal199-ai-agent.hf.space/agent/news';

            // Jadwal: Setiap hari jam 07:00 pagi
            // (Untuk tes sekarang, ubah jadi '* * * * *' biar nyala tiap menit)
            cron.schedule('* * * * *', async () => {
                console.log('[ALARM] Membangunkan AI Agent di Hugging Face...');
                
                try {
                    // Beri waktu timeout 3 menit buat HF bangun dari tidur
                    const response = await axios.get(API_AGENT, { timeout: 180000 });
                    const data = response.data;
                    
                    if (data.status === 'success') {
                        console.log('[ALARM] Agent selesai tugas, mengirim file ke WhatsApp...');
                        
                        // 1. Kirim pesan rangkumannya dulu
                        await sock.sendMessage(NOMOR_OWNER, { text: `🤖 *LAPORAN TECH HARIAN*\n\n${data.pesan}` });
                        
                        // 2. Download file Excel dari server Hugging Face
                        const tempExcel = path.join(__dirname, 'Laporan_Harian.xlsx');
                        const fileStream = fs.createWriteStream(tempExcel);
                        
                        const excelRes = await axios({
                            method: 'GET',
                            url: data.excel_url,
                            responseType: 'stream'
                        });
                        
                        excelRes.data.pipe(fileStream);
                        
                        // 3. Setelah file selesai tersimpan di Katabump, kirim ke WA
                        fileStream.on('finish', async () => {
                            await sock.sendMessage(NOMOR_OWNER, {
                                document: { url: tempExcel },
                                mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                                fileName: 'Laporan_Tech_Harian.xlsx'
                            });
                            // Bersihkan file sementara biar server Katabump nggak penuh
                            fs.unlinkSync(tempExcel);
                        });
                    }
                } catch (error) {
                    console.error('[AGENT ERROR]', error.message);
                    await sock.sendMessage(NOMOR_OWNER, { 
                        text: `❌ *Gagal mengambil laporan AI Agent:*\nServer HF mungkin masih tidur lelap. (${error.message})` 
                    });
                }
            });
        }
});
    // ── Handle pesan masuk ──
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            if (msg.key.remoteJid === 'status@broadcast') continue;
            if (!msg.message) continue;

            // ═══ Random micro-delay before processing (human-like) ═══
            const microDelay = 500 + Math.random() * 1500;
            await new Promise(r => setTimeout(r, microDelay));

            try {
                await handleMessage(sock, msg);
            } catch (error) {
                console.error('❗ Error handling message:', error.message);
            }
        }
    });
}

// ── Jalankan bot ──
startBot().catch(err => {
    console.error('❗ Fatal error:', err);
    process.exit(1);
});

// ── Handle process errors ──
process.on('uncaughtException', (err) => {
    console.error('❗ Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (err) => {
    console.error('❗ Unhandled Rejection:', err);
});