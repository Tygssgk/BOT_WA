module.exports = {
    // ═══ Bot Settings ═══
    botName: 'WA Downloader Bot',
    prefix: '.',
    version: '2.2.0',

    // ═══ API Configuration ═══
    apiBase: 'https://api.sonzaix.indevs.in',

    // ═══ Limits ═══
    apiTimeout: 60000,
    downloadTimeout: 600000,
    sessionTimeout: 10 * 60 * 1000,
    cooldownTime: 3000,
    cooldownMax: 5000,

    // ═══ Anti-Spam Rate Limiting ═══
    rateLimit: {
        globalPerMinute: 25,
        globalPerHour: 180,
        perChatPerMinute: 8,
        perChatPer5Min: 15,
        groupPerMinute: 4,
        groupPer10Min: 8,
        dailyCap: 500,
        interMessageDelay: 700,
        interMessageJitter: 1000,
    },

    // ═══ Anti-Detection ═══
    antiDetection: {
        offlineSchedule: {
            enabled: true,
            startHour: 0,
            endHour: 3,
            timezone: 7,
        },
        maxReactsPerInteraction: 1,
        skipReactWhenBusy: true,
    },

    // ═══ Admin & User Limits ═══
    adminNumbers: ['6281774954859@s.whatsapp.net'],
    defaultLimit: 10,

    // ═══ Filter NSFW / Vulgar ═══
    bannedKeywords: ['hentai', 'ecchi', 'yaoi', 'yuri', 'boku no pico', 'seks', 'porn', 'bokep', '18+'],

    // ═══ Download Settings ═══
    maxDownloadSize: 500 * 1024 * 1024,
    smallVideoThreshold: 30,
    sendAsDocThreshold: 30,
    linkOnlyThreshold: 300,

    // ═══ Anime Settings ═══
    animeEpisodesPerPage: 10,

    // ═══ Messages ═══
    footer: '⚡ _Powered by @IKBAL_'
};