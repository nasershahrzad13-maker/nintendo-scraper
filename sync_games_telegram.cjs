#!/usr/bin/env node

/**
 * Nintendo Switch Games Automated Sync & Upload Pipeline via Telegram & Cloudflare Worker
 * 
 * Flow:
 * 1. Queries website API for pending NSWPedia games in queue (/api/v1/games/queue/pending)
 * 2. Scrapes metadata, cover, screenshots, and direct download mirrors using nswpedia_scraper.cjs
 * 3. Downloads Base Game, Updates, DLCs via high-speed pipeline (aria2)
 * 4. Packages & splits into 45MB password-protected parts (.part1.rar, .part2.rar) for Telegram API limits
 * 5. Uploads all parts to Telegram Storage Channel via telegram_uploader.cjs
 * 6. Generates direct Cloudflare Worker download URLs (e.g. https://dl.ninten2.com/?file_id=...)
 * 7. Sends links & metadata back to website API (/api/v1/games/queue/complete)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const {
    scrapeGame,
    downloadFile,
    cleanGameTitle,
    cleanDlcDisplayName,
    generateRomFilename,
    formatBytes,
    sanitizeFilename
} = require('./nswpedia_scraper.cjs');

const { uploadFileToTelegram } = require('./telegram_uploader.cjs');

// Parse CLI flags
const args = process.argv.slice(2);
const params = {};
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
        const key = args[i].substring(2);
        const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
        params[key] = val;
    }
}

const API_BASE_URL = (params['api-url'] || process.env.SITE_URL || process.env.APP_URL || 'https://ninten2.ir').replace(/\/$/, '');
const SYNC_TOKEN = params['api-token'] || process.env.SYNC_API_TOKEN || 'ninten2-sync-secret-key-2026';
const BOT_TOKEN = params['bot-token'] || process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = params['chat-id'] || process.env.TELEGRAM_CHAT_ID;
const WORKER_DOMAIN = params['worker-domain'] || process.env.CLOUDFLARE_WORKER_DOMAIN || 'dl.ninten2.com';

const DEST_DIR = params['dest-dir'] || path.join(process.cwd(), 'downloads');
const SINGLE_URL = params['single-url'] || null;
const ZIP_PASSWORD = params['zip-password'] || process.env.ZIP_PASSWORD || 'ninten2.ir';
const IS_LOCAL_SERVER = (process.env.TELEGRAM_BOT_API_HOST && process.env.TELEGRAM_BOT_API_HOST !== 'api.telegram.org') || process.env.TELEGRAM_LOCAL_SERVER === 'true';
const DEFAULT_PART_SIZE = 2048;
const PART_SIZE_MB = parseInt(params['part-size-mb'] || String(DEFAULT_PART_SIZE), 10) || DEFAULT_PART_SIZE;

/**
 * Make API request to Laravel website
 */
function apiRequest(endpoint, method = 'GET', data = null) {
    return new Promise((resolve, reject) => {
        const fullUrl = `${API_BASE_URL}${endpoint}`;
        const urlObj = new URL(fullUrl);
        const isHttps = urlObj.protocol === 'https:';
        const client = isHttps ? https : http;

        let payload = null;
        if (data) {
            payload = JSON.stringify(data);
        }

        const headers = {
            'X-SYNC-TOKEN': SYNC_TOKEN,
            'Accept': 'application/json',
            'User-Agent': 'Ninten2-Telegram-Sync-Worker/1.0'
        };

        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = client.request(fullUrl, { method, headers }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsed);
                    } else {
                        reject(new Error(`API ${method} ${endpoint} failed (${res.statusCode}): ${parsed.message || body}`));
                    }
                } catch (e) {
                    reject(new Error(`API invalid response (${res.statusCode}): ${body.substring(0, 200)}`));
                }
            });
        });

        req.on('error', (err) => reject(err));
        if (payload) req.write(payload);
        req.end();
    });
}

/**
 * Package and split file into password-protected parts
 */
function createProtectedParts(sourceFilePath, destDir, baseName, password = ZIP_PASSWORD, splitSizeMb = PART_SIZE_MB) {
    if (!fs.existsSync(sourceFilePath)) {
        throw new Error(`Source file not found: ${sourceFilePath}`);
    }

    const stats = fs.statSync(sourceFilePath);
    const totalSize = stats.size;
    const splitSizeBytes = splitSizeMb * 1024 * 1024;
    const cleanBaseName = sanitizeFilename(baseName.replace(/\.(rar|zip|7z|nsp|xci)$/i, ''));

    let hasRar = false;
    let has7z = false;
    let hasZip = false;
    try { execSync('which rar', { stdio: 'ignore' }); hasRar = true; } catch {}
    try { execSync('which 7z || which 7za', { stdio: 'ignore' }); has7z = true; } catch {}
    try { execSync('which zip', { stdio: 'ignore' }); hasZip = true; } catch {}

    const parts = [];

    // Clean up previous parts
    const existingFiles = fs.readdirSync(destDir).filter(f => f.startsWith(`${cleanBaseName}.`));
    for (const ef of existingFiles) {
        try { fs.unlinkSync(path.join(destDir, ef)); } catch {}
    }

    if (totalSize > splitSizeBytes && (hasRar || has7z || hasZip)) {
        console.log(`    📦 File size (${formatBytes(totalSize)}) exceeds ${splitSizeMb}MB -> Splitting into ${splitSizeMb}MB RAR parts...`);

        if (hasRar) {
            const outputBase = path.join(destDir, `${cleanBaseName}.rar`);
            const cmd = `rar a -v${splitSizeMb}m -m0 -p"${password}" -ep1 -y "${outputBase}" "${sourceFilePath}"`;
            execSync(cmd, { stdio: 'pipe' });
        } else if (has7z) {
            const outputBase = path.join(destDir, `${cleanBaseName}.7z`);
            const cmd = `7z a -v${splitSizeMb}m -p"${password}" -mhe=on "${outputBase}" "${sourceFilePath}"`;
            execSync(cmd, { stdio: 'pipe' });
        }

        const generated = fs.readdirSync(destDir)
            .filter(f => f.startsWith(cleanBaseName) && f !== path.basename(sourceFilePath))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        for (let i = 0; i < generated.length; i++) {
            const pName = generated[i];
            const pPath = path.join(destDir, pName);
            const pStats = fs.statSync(pPath);
            parts.push({
                path: pPath,
                name: pName,
                partNumber: i + 1,
                totalParts: generated.length,
                size: pStats.size,
                format: pName.endsWith('.7z') ? '7Z' : 'RAR'
            });
        }
    } else {
        // Single part RAR
        console.log(`    📦 Packaging single file into password-protected RAR...`);
        let archivePath = path.join(destDir, `${cleanBaseName}.rar`);

        if (hasRar) {
            execSync(`rar a -m0 -p"${password}" -ep1 -y "${archivePath}" "${sourceFilePath}"`, { stdio: 'pipe' });
        } else if (has7z) {
            archivePath = path.join(destDir, `${cleanBaseName}.7z`);
            execSync(`7z a -p"${password}" -mhe=on "${archivePath}" "${sourceFilePath}"`, { stdio: 'pipe' });
        } else {
            archivePath = sourceFilePath;
        }

        const pStats = fs.statSync(archivePath);
        parts.push({
            path: archivePath,
            name: path.basename(archivePath),
            partNumber: 1,
            totalParts: 1,
            size: pStats.size,
            format: archivePath.endsWith('.7z') ? '7Z' : 'RAR'
        });
    }

    return parts;
}

async function run() {
    console.log('===============================================================');
    console.log('🎮 Ninten2 Telegram & Cloudflare Worker Game Sync Pipeline');
    console.log('===============================================================\n');

    if (!BOT_TOKEN || !CHAT_ID) {
        console.error('❌ Error: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required.');
        process.exit(1);
    }

    if (!fs.existsSync(DEST_DIR)) {
        fs.mkdirSync(DEST_DIR, { recursive: true });
    }

    let itemsToProcess = [];

    if (SINGLE_URL) {
        console.log(`🎯 Single URL specified via CLI: ${SINGLE_URL}`);
        itemsToProcess.push({
            id: 0,
            nswpedia_url: SINGLE_URL,
            game_title: 'Manual Single URL Download'
        });
    } else {
        console.log('📡 Fetching pending games queue from website API...');
        try {
            const pendingRes = await apiRequest('/api/v1/games/queue/pending');
            if (pendingRes && pendingRes.status === 'success' && Array.isArray(pendingRes.data)) {
                itemsToProcess = pendingRes.data;
            }
        } catch (apiErr) {
            console.error(`⚠️ API queue fetch failed: ${apiErr.message}`);
        }
    }

    if (itemsToProcess.length === 0) {
        console.log('✅ No pending games in queue to process. Exiting cleanly.');
        return;
    }

    console.log(`📦 Found ${itemsToProcess.length} pending game(s) to process.\n`);

    for (let index = 0; index < itemsToProcess.length; index++) {
        const item = itemsToProcess[index];
        console.log(`\n===============================================================`);
        console.log(`🎮 Game [${index + 1}/${itemsToProcess.length}]: ${item.game_title || item.nswpedia_url}`);
        console.log(`🌐 Source: ${item.nswpedia_url}`);
        console.log(`===============================================================`);

        try {
            console.log('🔍 Scraping metadata and download links from NSWPedia...');
            const gameData = await scrapeGame(item.nswpedia_url);
            console.log(`✨ Scraped: "${gameData.title}" | ID: ${gameData.titleId || 'N/A'}`);
            console.log(`    Mirrors: ${gameData.downloads ? gameData.downloads.length : 0} mirror link(s) found`);

            function getMirrorScore(url) {
                if (!url) return -999;
                const u = url.toLowerCase();
                if (u.includes('nswpediax.site') || u.includes('invalid') || u.includes('placeholder')) return -100;
                if (u.includes('dlsitex.online')) return 110;
                if (u.includes('vikingfile.com')) return 100;
                if (u.includes('1fichier.com')) return 85;
                if (u.includes('mediafire.com')) return 80;
                if (u.includes('megaup.net')) return 75;
                if (u.includes('gofile.io')) return 70;
                if (u.includes('datanodes.to')) return 50;
                if (u.includes('rushupload.com')) return 40;
                if (u.includes('multiup.')) return 30;
                return 10;
            }

            const availableDownloads = (gameData.downloads || []).filter(d => d.directUrl && !d.directUrl.includes('placeholder'));
            const groupedFiles = new Map();

            for (const mirror of availableDownloads) {
                const dlcSuffix = mirror.type === 'DLC' ? cleanDlcDisplayName(mirror.name, gameData.title) : '';
                const uniqueKey = `${mirror.type}_${mirror.version || 'v0'}_${dlcSuffix || mirror.name.toLowerCase()}`;
                if (!groupedFiles.has(uniqueKey)) {
                    groupedFiles.set(uniqueKey, {
                        ...mirror,
                        mirrors: [mirror]
                    });
                } else {
                    groupedFiles.get(uniqueKey).mirrors.push(mirror);
                }
            }

            const selectedFiles = Array.from(groupedFiles.values()).map(item => {
                item.mirrors.sort((a, b) => getMirrorScore(b.directUrl) - getMirrorScore(a.directUrl));
                item.directUrl = item.mirrors[0].directUrl;
                return item;
            });

            if (selectedFiles.length === 0) {
                throw new Error('No downloadable direct ROM links found on page.');
            }

            const uploadedFiles = [];

            for (let i = 0; i < selectedFiles.length; i++) {
                const fileItem = selectedFiles[i];
                console.log(`\n📥 Processing file: ${fileItem.name} (${fileItem.type})`);

                const baseRarName = generateRomFilename(gameData.title, fileItem, '.rar');

                let downloadedFilePath = null;
                for (const mirror of fileItem.mirrors) {
                    try {
                        const targetPath = path.join(DEST_DIR, `${sanitizeFilename(fileItem.name)}`);
                        const dlUrl = mirror.directUrl || mirror.intermediateUrl;
                        const dlResult = await downloadFile(dlUrl, targetPath);
                        if (dlResult) {
                            downloadedFilePath = typeof dlResult === 'object' ? dlResult.destPath : dlResult;
                            if (downloadedFilePath && fs.existsSync(downloadedFilePath)) break;
                        }
                    } catch (dlErr) {
                        console.warn(`    ⚠️ Mirror download failed: ${dlErr.message}`);
                    }
                }

                if (!downloadedFilePath) {
                    throw new Error(`Failed downloading file: ${fileItem.name}`);
                }

                console.log(`🔒 Packaging into ${PART_SIZE_MB}MB parts...`);
                const generatedParts = createProtectedParts(downloadedFilePath, DEST_DIR, baseRarName, ZIP_PASSWORD, PART_SIZE_MB);

                if (fs.existsSync(downloadedFilePath)) {
                    fs.unlinkSync(downloadedFilePath);
                }

                for (let pIdx = 0; pIdx < generatedParts.length; pIdx++) {
                    const part = generatedParts[pIdx];
                    console.log(`✈️ Uploading Part ${part.partNumber}/${part.totalParts} to Telegram: "${part.name}"...`);

                    const tgResult = await uploadFileToTelegram(BOT_TOKEN, CHAT_ID, part.path, part.name, WORKER_DOMAIN);

                    let partTitle = `${cleanGameTitle(gameData.title).replace(/_/g, ' ')}`;
                    if (part.totalParts > 1) {
                        partTitle += ` (پارت ${part.partNumber} از ${part.totalParts})`;
                    }

                    uploadedFiles.push({
                        file_type: fileItem.type === 'Update' ? 'update' : (fileItem.type === 'DLC' ? 'dlc' : 'base_game'),
                        title: part.name,
                        display_title: partTitle,
                        version: fileItem.version || 'v1.0.0',
                        file_size: formatBytes(part.size),
                        file_format: part.format || 'RAR',
                        password: ZIP_PASSWORD,
                        part_number: part.partNumber,
                        total_parts: part.totalParts,
                        server_name: 'سرور اختصاصی پرسرعت کلودفلر (بدون فیلترشکن)',
                        download_url: tgResult.public_url,
                        telegram_file_id: tgResult.file_id
                    });

                    if (fs.existsSync(part.path)) {
                        fs.unlinkSync(part.path);
                    }
                }
            }

            console.log(`\n📤 Sending ${uploadedFiles.length} links back to website API...`);
            const completePayload = {
                queue_id: item.id,
                game_title: gameData.title,
                title_id: gameData.titleId || null,
                scraped_data: {
                    title: gameData.title,
                    title_id: gameData.titleId || null,
                    required_firmware: gameData.requiredFirmware || null,
                    developer: gameData.developer || gameData.publisher || 'Nintendo',
                    publisher: gameData.publisher || 'Nintendo',
                    release_date: gameData.releaseDate || null,
                    format: gameData.format || 'NSP',
                    cover_image: gameData.cover_image || gameData.cover || null,
                    banner_image: gameData.banner_image || gameData.banner || null,
                    screenshots: gameData.screenshots || [],
                    summary: gameData.description ? gameData.description.substring(0, 300) : '',
                    description: gameData.description || '',
                    genres: gameData.genres || ['Arcade', 'Action'],
                },
                uploaded_files: uploadedFiles,
            };

            if (item.id > 0) {
                const completeRes = await apiRequest('/api/v1/games/queue/complete', 'POST', completePayload);
                console.log(`✅ API response: ${completeRes.message || 'Complete!'}`);
            }

            console.log(`🎉 Game #${item.id} (${gameData.title}) completed successfully!`);

        } catch (taskErr) {
            console.error(`❌ Error processing game: ${taskErr.message}`);
            if (item.id > 0) {
                try {
                    await apiRequest('/api/v1/games/queue/fail', 'POST', { queue_id: item.id, error_message: taskErr.message });
                } catch (e) {}
            }
        }
    }
}

run().catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
});
