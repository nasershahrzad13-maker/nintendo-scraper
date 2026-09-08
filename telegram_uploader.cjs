#!/usr/bin/env node

/**
 * Telegram Automated Uploader with Smart Local Server & Multi-Part Chunking Support
 * Designed for Ninten2 ROM & File Distribution System via Cloudflare Worker Proxy
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const HTTP_API_HOST = process.env.TELEGRAM_BOT_API_HOST || 'api.telegram.org';
const IS_LOCAL_SERVER = HTTP_API_HOST !== 'api.telegram.org' || process.env.TELEGRAM_LOCAL_SERVER === 'true';

// If running against Local Telegram Bot API Server, upload up to 2GB per part.
// If running against official api.telegram.org, cap at 45MB per part to prevent HTTP 413.
const MAX_PART_SIZE = IS_LOCAL_SERVER ? 1980 * 1024 * 1024 : 45 * 1024 * 1024;

let TelegramClient = null;
let StringSession = null;
try {
    const tg = require('telegram');
    const sessions = require('telegram/sessions');
    TelegramClient = tg.TelegramClient;
    StringSession = sessions.StringSession;
} catch (e) {}

const TELEGRAM_API_ID = parseInt(process.env.TELEGRAM_API_ID || '611335', 10);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH || '284b136413271772e392e697011edd16';

/**
 * Make HTTP/HTTPS request with retries
 */
function request(options, data = null, isMultipart = false, retries = 3, timeoutMs = 180000) {
    return new Promise((resolve, reject) => {
        const protocol = options.protocol === 'http:' ? http : https;

        const req = protocol.request({
            ...options,
            timeout: timeoutMs
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
                } catch (e) {
                    resolve({ status: res.statusCode, headers: res.headers, body });
                }
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error(`HTTP request timed out after ${timeoutMs / 1000}s`));
        });

        req.on('error', (err) => {
            if (retries > 0) {
                console.log(`⚠️ Network error: ${err.message}. Retrying (${retries} left)...`);
                setTimeout(() => {
                    resolve(request(options, data, isMultipart, retries - 1, timeoutMs));
                }, 2000);
            } else {
                reject(err);
            }
        });

        if (data) {
            if (Buffer.isBuffer(data)) {
                req.write(data);
            } else if (typeof data === 'string') {
                req.write(data);
            }
        }

        req.end();
    });
}

/**
 * Upload large files (up to 2GB) using Telegram MTProto Protocol (GramJS)
 */
async function uploadViaMTProto(botToken, chatId, filePath, caption = '', fileName = null) {
    if (!TelegramClient) {
        throw new Error('GramJS (telegram npm module) not available for MTProto upload.');
    }

    const targetName = fileName || path.basename(filePath);
    console.log(`📡 Connecting via MTProto Protocol for 2GB file stream...`);

    const client = new TelegramClient(new StringSession(''), TELEGRAM_API_ID, TELEGRAM_API_HASH, {
        connectionRetries: 10,
        useWSS: false
    });

    await client.start({ botAuthToken: botToken });

    console.log(`📤 Streaming "${targetName}" directly to Telegram servers (MTProto)...`);

    const message = await client.sendFile(chatId, {
        file: filePath,
        caption: caption,
        workers: 8,
        progressCallback: (progress) => {
            const percent = (progress * 100).toFixed(1);
            process.stdout.write(`\r⏳ Uploading to Telegram: ${percent}%...`);
        }
    });

    console.log('\n✅ MTProto Upload Success!');
    await client.disconnect();

    const media = message.media;
    const document = media ? (media.document || media) : null;
    const fileId = document ? (document.id ? document.id.toString() : String(message.id)) : String(message.id);

    return {
        file_id: fileId,
        file_name: targetName,
        file_size: fs.statSync(filePath).size
    };
}

/**
 * Upload a single file chunk via HTTP Bot API
 */
async function sendDocumentToTelegram(botToken, chatId, filePath, caption = '', fileName = null) {
    const targetName = fileName || path.basename(filePath);
    const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);

    const fileBuffer = fs.readFileSync(filePath);

    let header = '';
    header += `--${boundary}\r\n`;
    header += `Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;

    if (caption) {
        header += `--${boundary}\r\n`;
        header += `Content-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`;
    }

    header += `--${boundary}\r\n`;
    header += `Content-Disposition: form-data; name="document"; filename="${targetName}"\r\n`;
    header += `Content-Type: application/octet-stream\r\n\r\n`;

    const footer = `\r\n--${boundary}--\r\n`;

    const payload = Buffer.concat([
        Buffer.from(header, 'utf-8'),
        fileBuffer,
        Buffer.from(footer, 'utf-8')
    ]);

    const parsedHost = HTTP_API_HOST.split(':');
    const hostname = parsedHost[0];
    const port = parsedHost[1] ? parseInt(parsedHost[1], 10) : (IS_LOCAL_SERVER ? 8081 : 443);
    const isHttps = !IS_LOCAL_SERVER && port === 443;

    const options = {
        protocol: isHttps ? 'https:' : 'http:',
        hostname: hostname,
        port: port,
        path: `/bot${botToken}/sendDocument`,
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': payload.length
        }
    };

    const res = await request(options, payload);

    if (res.status !== 200 || !res.body.ok) {
        throw new Error(`Telegram sendDocument failed (HTTP ${res.status}): ${JSON.stringify(res.body)}`);
    }

    const resObj = res.body.result || {};
    const doc = resObj.document || {};
    const chat = resObj.chat || {};

    return {
        file_id: doc.file_id || String(resObj.message_id || ''),
        file_unique_id: doc.file_unique_id || '',
        file_name: doc.file_name || targetName,
        file_size: doc.file_size || payload.length,
        message_id: resObj.message_id || null,
        chat_username: chat.username || null
    };
}

/**
 * Upload file to Telegram storage with automatic multi-part splitting
 */
async function uploadFileToTelegram(botToken, chatId, filePath, customFileName = null, workerDomain = 'dl.ninten2.com') {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const fileName = customFileName || path.basename(filePath);
    const domain = workerDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');

    const partSizeMb = (MAX_PART_SIZE / (1024 * 1024)).toFixed(0);
    console.log(`\n🚀 Preparing Telegram Upload for "${fileName}" (${(fileSize / (1024 * 1024)).toFixed(2)} MB)...`);
    console.log(`ℹ️ Mode: ${IS_LOCAL_SERVER ? 'Local Server (2GB Parts)' : 'HTTP Bot API (45MB Parts)'}`);

    // Case 1: File fits within max part size
    if (fileSize <= MAX_PART_SIZE) {
        console.log(`📦 File is under ${partSizeMb}MB. Uploading single file...`);
        let result;

        if (IS_LOCAL_SERVER) {
            result = await sendDocumentToTelegram(botToken, chatId, filePath, `🎮 ${fileName}`, fileName);
        } else if (fileSize > 45 * 1024 * 1024 && TelegramClient) {
            try {
                result = await uploadViaMTProto(botToken, chatId, filePath, `🎮 ${fileName}`, fileName);
            } catch (mtErr) {
                console.warn(`⚠️ MTProto upload failed (${mtErr.message}), falling back to HTTP API...`);
                result = await sendDocumentToTelegram(botToken, chatId, filePath, `🎮 ${fileName}`, fileName);
            }
        } else {
            result = await sendDocumentToTelegram(botToken, chatId, filePath, `🎮 ${fileName}`, fileName);
        }

        let channelParam = result.chat_username;
        if (!channelParam && chatId) {
            const cleanId = String(chatId).replace(/^-100/, '');
            channelParam = `c/${cleanId}`;
        }

        let publicUrl = `https://${domain}/?file_id=${result.file_id}`;
        if (channelParam && result.message_id) {
            publicUrl += `&channel=${encodeURIComponent(channelParam)}&msg=${result.message_id}`;
        }

        console.log(`✅ Upload complete! Public Link: ${publicUrl}`);

        return {
            file_id: result.file_id,
            name: fileName,
            size: fileSize,
            public_url: publicUrl,
            parts_count: 1,
            parts: [{ part: 1, file_id: result.file_id, name: fileName, url: publicUrl }]
        };
    }

    // Case 2: File exceeds MAX_PART_SIZE -> Split into parts
    const splitSizeArg = IS_LOCAL_SERVER ? '2000m' : '45m';
    console.log(`✂️ File exceeds ${partSizeMb}MB. Splitting into ${splitSizeArg} parts for Telegram upload...`);

    const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'temp_tg_parts_'));
    const partPrefix = path.join(tempDir, 'part_');

    try {
        execSync(`split -b ${splitSizeArg} "${filePath}" "${partPrefix}"`);
        const createdParts = fs.readdirSync(tempDir).filter(f => f.startsWith('part_')).sort();

        console.log(`📦 Split into ${createdParts.length} part(s). Uploading to Telegram channel...`);

        const uploadedParts = [];

        for (let i = 0; i < createdParts.length; i++) {
            const partFile = createdParts[i];
            const partPath = path.join(tempDir, partFile);
            const partName = `${fileName}.part${i + 1}`;

            console.log(`   ⏳ Uploading Part ${i + 1}/${createdParts.length}: ${partName}...`);
            let tgPart = await sendDocumentToTelegram(botToken, chatId, partPath, `📦 ${partName} (${i + 1}/${createdParts.length})`, partName);

            let channelParam = tgPart.chat_username;
            if (!channelParam && chatId) {
                const cleanId = String(chatId).replace(/^-100/, '');
                channelParam = `c/${cleanId}`;
            }

            let partUrl = `https://${domain}/?file_id=${tgPart.file_id}`;
            if (channelParam && tgPart.message_id) {
                partUrl += `&channel=${encodeURIComponent(channelParam)}&msg=${tgPart.message_id}`;
            }

            uploadedParts.push({
                part: i + 1,
                file_id: tgPart.file_id,
                name: partName,
                url: partUrl
            });
        }

        const mainUrl = uploadedParts[0].url;

        console.log(`\n🎉 All ${uploadedParts.length} parts uploaded to Telegram!`);
        console.log(`🌐 Primary Download Link: ${mainUrl}`);

        return {
            file_id: uploadedParts[0].file_id,
            name: fileName,
            size: fileSize,
            public_url: mainUrl,
            parts_count: uploadedParts.length,
            parts: uploadedParts
        };

    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (e) {}
    }
}

// CLI Execution Support
async function main() {
    const args = process.argv.slice(2);
    const params = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('--')) {
            const key = args[i].substring(2);
            const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
            params[key] = val;
        }
    }

    const botToken = params['bot-token'] || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = params['chat-id'] || process.env.TELEGRAM_CHAT_ID;
    const filePath = params['file'] || params['path'];
    const workerDomain = params['worker-domain'] || process.env.CLOUDFLARE_WORKER_DOMAIN || 'dl.ninten2.com';
    const customName = params['name'] || null;

    if (!botToken) {
        console.error('❌ Error: Missing Telegram Bot Token. Pass --bot-token or set TELEGRAM_BOT_TOKEN env.');
        process.exit(1);
    }

    if (!chatId) {
        console.error('❌ Error: Missing Telegram Chat ID. Pass --chat-id or set TELEGRAM_CHAT_ID env.');
        process.exit(1);
    }

    if (!filePath) {
        console.error('❌ Error: Missing file path. Pass --file /path/to/game.nsp');
        process.exit(1);
    }

    try {
        const result = await uploadFileToTelegram(botToken, chatId, filePath, customName, workerDomain);

        console.log('\n=============================================');
        console.log('🎉 TELEGRAM UPLOAD COMPLETE!');
        console.log(`🎮 File Name:    ${result.name}`);
        console.log(`📦 Size:         ${(result.size / (1024 * 1024)).toFixed(2)} MB`);
        console.log(`🧩 Parts Count:  ${result.parts_count}`);
        console.log(`🌐 Direct Link:  ${result.public_url}`);
        console.log('=============================================\n');

        if (process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `public_url=${result.public_url}\n`);
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `file_id=${result.file_id}\n`);
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `file_name=${result.name}\n`);
        }
    } catch (err) {
        console.error(`\n❌ Error: ${err.message}`);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    sendDocumentToTelegram,
    uploadFileToTelegram
};
