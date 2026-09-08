#!/usr/bin/env node

/**
 * Nintendo Switch Games Automated Sync & Upload Pipeline with 2GB RAR Multi-Part Splitting
 * 
 * Flow:
 * 1. Queries website API for pending NSWPedia games in queue (/api/v1/games/queue/pending)
 * 2. Scrapes metadata, cover, screenshots, and direct download mirrors using nswpedia_scraper.cjs
 * 3. Downloads Base Game, Updates, DLCs via high-speed pipeline (aria2 / stream)
 * 4. Validates downloaded file (rejects HTML/403 error pages)
 * 5. Packages & splits into 2GB password-protected parts (.part1.rar, .part2.rar) if > 2GB
 * 6. Uploads all parts to AbreHamrahi Cloud with structured folders (Nintendo_Switch/<Game_Title>/...)
 * 7. Cleans up local files to preserve runner disk space
 * 8. Sends public Hamrahi links and part metadata back to website API (/api/v1/games/queue/complete)
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

const {
    getAccessToken,
    resolveFolderPath,
    findExistingFileInHamrahi,
    uploadFileToHamrahi
} = require('./hamrahi_uploader.cjs');

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
const REFRESH_TOKEN = params['refresh-token'] || process.env.ABREHAMRAHI_REFRESH_TOKEN;
const DEST_DIR = params['dest-dir'] || path.join(process.cwd(), 'downloads');
const SINGLE_URL = params['single-url'] || null;
const ZIP_PASSWORD = params['zip-password'] || process.env.ZIP_PASSWORD || 'ninten2.ir';
const PART_SIZE_MB = parseInt(params['part-size-mb'] || '2048', 10) || 2048; // 2GB (2048MB) parts
const BATCH_LIMIT = parseInt(params['limit'] || '50', 10) || 50;

/**
 * Package and split file into 2GB password-protected parts if file exceeds 2GB (PART_SIZE_MB)
 * Returns array of part file objects: [{ path, name, partNumber, totalParts, size, format }]
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

    // Clean up any previous parts with same prefix
    const existingFiles = fs.readdirSync(destDir).filter(f => f.startsWith(`${cleanBaseName}.`));
    for (const ef of existingFiles) {
        try { fs.unlinkSync(path.join(destDir, ef)); } catch {}
    }

    // Check if multi-part splitting is needed (> 2000MB)
    if (totalSize > splitSizeBytes && (hasRar || has7z || hasZip)) {
        console.log(`    📦 File size (${formatBytes(totalSize)}) exceeds ${splitSizeMb}MB -> Splitting into ${splitSizeMb}MB RAR parts (.part1.rar, .part2.rar)...`);

        let splitSuccess = false;

        if (hasRar) {
            try {
                // Standard RAR multi-volume format (.part1.rar, .part2.rar, etc.)
                // -m0 (Store mode, zero compression delay) + -p (password) + -ep1 (exclude paths) -y (assume yes)
                const outputBase = path.join(destDir, `${cleanBaseName}.rar`);
                const cmd = `rar a -v${splitSizeMb}m -m0 -p"${password}" -ep1 -y "${outputBase}" "${sourceFilePath}"`;
                execSync(cmd, { stdio: 'inherit' });

                const createdFiles = fs.readdirSync(destDir)
                    .filter(f => f.startsWith(`${cleanBaseName}.part`) && f.endsWith('.rar'))
                    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

                if (createdFiles.length > 0) {
                    const totalParts = createdFiles.length;
                    for (let idx = 0; idx < createdFiles.length; idx++) {
                        const partFile = createdFiles[idx];
                        const partPath = path.join(destDir, partFile);
                        const partStats = fs.statSync(partPath);
                        parts.push({
                            path: partPath,
                            name: partFile,
                            partNumber: idx + 1,
                            totalParts: totalParts,
                            size: partStats.size,
                            format: 'RAR'
                        });
                    }
                    splitSuccess = true;
                } else if (fs.existsSync(outputBase)) {
                    const outStats = fs.statSync(outputBase);
                    parts.push({
                        path: outputBase,
                        name: path.basename(outputBase),
                        partNumber: 1,
                        totalParts: 1,
                        size: outStats.size,
                        format: 'RAR'
                    });
                    splitSuccess = true;
                }
            } catch (rarErr) {
                console.warn(`    ⚠️ RAR command failed (${rarErr.message}). Attempting fallback with 7z...`);
                // Clean up any failed RAR parts
                const failedFiles = fs.readdirSync(destDir).filter(f => f.startsWith(`${cleanBaseName}.`) && f.endsWith('.rar'));
                for (const ff of failedFiles) {
                    try { fs.unlinkSync(path.join(destDir, ff)); } catch {}
                }
            }
        }
        
        if (!splitSuccess && has7z) {
            // Fallback 7z
            const outputBase = path.join(destDir, `${cleanBaseName}.7z`);
            const cmd = `7z a -v${splitSizeMb}m -mx=0 -mmt=on -p"${password}" "${outputBase}" "${sourceFilePath}"`;
            execSync(cmd, { stdio: 'inherit' });

            const createdFiles = fs.readdirSync(destDir)
                .filter(f => f.startsWith(`${cleanBaseName}.7z.`))
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

            const totalParts = createdFiles.length;
            for (let idx = 0; idx < createdFiles.length; idx++) {
                const partFile = createdFiles[idx];
                const partPath = path.join(destDir, partFile);
                const partStats = fs.statSync(partPath);
                parts.push({
                    path: partPath,
                    name: partFile,
                    partNumber: idx + 1,
                    totalParts: totalParts,
                    size: partStats.size,
                    format: '7Z'
                });
            }
            splitSuccess = true;
        }
    } else {
        // Single part archive (under 2GB) -> use .rar or .zip
        if (hasRar) {
            const outputRar = path.join(destDir, `${cleanBaseName}.rar`);
            const cmd = `rar a -m0 -p"${password}" -ep1 -idq "${outputRar}" "${sourceFilePath}"`;
            execSync(cmd, { stdio: 'ignore' });
            const outStats = fs.statSync(outputRar);
            parts.push({
                path: outputRar,
                name: path.basename(outputRar),
                partNumber: 1,
                totalParts: 1,
                size: outStats.size,
                format: 'RAR'
            });
        } else if (has7z) {
            const outputZip = path.join(destDir, `${cleanBaseName}.zip`);
            const cmd = `7z a -tzip -mx=0 -mmt=on -p"${password}" "${outputZip}" "${sourceFilePath}"`;
            execSync(cmd, { stdio: 'ignore' });
            const outStats = fs.statSync(outputZip);
            parts.push({
                path: outputZip,
                name: path.basename(outputZip),
                partNumber: 1,
                totalParts: 1,
                size: outStats.size,
                format: 'ZIP'
            });
        } else if (hasZip) {
            const outputZip = path.join(destDir, `${cleanBaseName}.zip`);
            const sourceDir = path.dirname(sourceFilePath);
            const sourceBase = path.basename(sourceFilePath);
            const cmd = `cd "${sourceDir}" && zip -q -0 -P "${password}" "${outputZip}" "${sourceBase}"`;
            execSync(cmd, { stdio: 'ignore' });
            const outStats = fs.statSync(outputZip);
            parts.push({
                path: outputZip,
                name: path.basename(outputZip),
                partNumber: 1,
                totalParts: 1,
                size: outStats.size,
                format: 'ZIP'
            });
        }
    }

    // Verify archive integrity before returning parts
    try {
        verifyArchiveParts(parts, password);
    } catch (verifyErr) {
        console.error(`    ❌ Archive integrity verification failed: ${verifyErr.message}`);
        // Clean up broken parts
        for (const p of parts) {
            try { if (fs.existsSync(p.path)) fs.unlinkSync(p.path); } catch {}
        }
        throw verifyErr;
    }

    return parts;
}

/**
 * Test integrity of created archive parts using rar t, 7z t, or unzip -t
 */
function verifyArchiveParts(parts, password = ZIP_PASSWORD) {
    if (!parts || parts.length === 0) {
        throw new Error('No archive parts generated to verify.');
    }

    const firstPart = parts[0];
    console.log(`    🔍 Verifying archive integrity before upload (${firstPart.format} format, ${parts.length} part(s))...`);

    const format = firstPart.format;
    const firstPath = firstPart.path;

    if (format === 'RAR') {
        try {
            // rar t -p"password" -idq "firstPartPath"
            const cmd = `rar t -p"${password}" -idq "${firstPath}"`;
            execSync(cmd, { stdio: 'ignore' });
            console.log(`    ✅ RAR archive integrity test PASSED (${parts.length} part(s) verified).`);
        } catch (err) {
            throw new Error(`RAR archive integrity check failed for ${firstPart.name}: ${err.message}`);
        }
    } else if (format === '7Z') {
        try {
            const cmd = `7z t -p"${password}" "${firstPath}"`;
            execSync(cmd, { stdio: 'ignore' });
            console.log(`    ✅ 7Z archive integrity test PASSED (${parts.length} part(s) verified).`);
        } catch (err) {
            throw new Error(`7Z archive integrity check failed for ${firstPart.name}: ${err.message}`);
        }
    } else if (format === 'ZIP') {
        try {
            let hasUnzip = false;
            try { execSync('which unzip', { stdio: 'ignore' }); hasUnzip = true; } catch {}
            const testCmd = hasUnzip
                ? `unzip -t -P "${password}" "${firstPath}"`
                : `7z t -p"${password}" "${firstPath}"`;
            execSync(testCmd, { stdio: 'ignore' });
            console.log(`    ✅ ZIP archive integrity test PASSED.`);
        } catch (err) {
            throw new Error(`ZIP archive integrity check failed for ${firstPart.name}: ${err.message}`);
        }
    }
}

/**
 * Generic JSON HTTP Request helper
 */
function apiRequest(endpoint, method = 'GET', data = null) {
    return new Promise((resolve, reject) => {
        const urlStr = `${API_BASE_URL}${endpoint}`;
        const parsedUrl = new URL(urlStr);
        const protocol = parsedUrl.protocol === 'https:' ? https : http;

        let payload = null;
        if (data !== null && data !== undefined) {
            if (Buffer.isBuffer(data)) {
                payload = data;
            } else if (typeof data === 'string') {
                payload = Buffer.from(data, 'utf-8');
            } else {
                payload = Buffer.from(JSON.stringify(data), 'utf-8');
            }
        }

        const headers = {
            'User-Agent': 'Ninten2-Sync-Worker/2.0',
            'Accept': 'application/json',
            'X-SYNC-TOKEN': SYNC_TOKEN,
            'Authorization': `Bearer ${SYNC_TOKEN}`
        };

        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = payload.length;
        }

        const req = protocol.request({
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: method,
            headers: headers
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(parsed);
                    } else {
                        reject(new Error(`API HTTP ${res.statusCode}: ${parsed.message || body}`));
                    }
                } catch (e) {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(body);
                    } else {
                        reject(new Error(`API HTTP ${res.statusCode}: ${body}`));
                    }
                }
            });
        });

        req.on('error', reject);
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

/**
 * Validate that downloaded file is a real game file and not an HTML error / 403 page
 */
function validateDownloadedRom(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Downloaded file does not exist: ${filePath}`);
    }

    const stats = fs.statSync(filePath);
    if (stats.size < 1048576) { // Less than 1MB
        // Check if it is HTML
        try {
            const buf = Buffer.alloc(1024);
            const fd = fs.openSync(filePath, 'r');
            fs.readSync(fd, buf, 0, 1024, 0);
            fs.closeSync(fd);
            const str = buf.toString('utf-8').toLowerCase();
            if (str.includes('<html') || str.includes('<!doctype html') || str.includes('403 forbidden') || str.includes('access denied')) {
                throw new Error(`File is an HTML error page (${formatBytes(stats.size)}), not a valid ROM. Server returned 403 Forbidden or link expired.`);
            }
        } catch (e) {
            if (e.message.includes('HTML error page')) throw e;
        }
        throw new Error(`Downloaded file is suspiciously small (${formatBytes(stats.size)}). Expected Nintendo Switch ROM (> 50MB).`);
    }
}

/**
 * High-speed ROM file downloader (Aria2 preferred, fallback to stream)
 */
async function downloadRomFile(url, destPath) {
    let hasAria2 = false;
    try {
        execSync('which aria2c', { stdio: 'ignore' });
        hasAria2 = true;
    } catch {}

    if (hasAria2) {
        console.log(`    ⚡ Downloading via Aria2 Multi-Connection Accelerator: ${url}`);
        const destDir = path.dirname(destPath);
        const destFile = path.basename(destPath);

        const ariaCmd = `aria2c -x 8 -s 8 -j 1 -k 1M --max-connection-per-server=8 --retry-wait=3 --file-allocation=none --dir="${destDir}" --out="${destFile}" "${url}"`;
        execSync(ariaCmd, { stdio: 'inherit' });

        validateDownloadedRom(destPath);
        const stats = fs.statSync(destPath);
        return {
            destPath,
            totalBytes: stats.size
        };
    } else {
        console.log(`    📥 Downloading via Node.js Stream Pipeline: ${url}`);
        const dlRes = await downloadFile(url, destPath, {
            onProgress: (p) => {
                process.stdout.write(`\r⏳ Downloading: ${p.percent}% [${formatBytes(p.downloaded)} / ${formatBytes(p.total)}] @ ${formatBytes(p.speed)}/s`);
            }
        });
        console.log('');
        validateDownloadedRom(destPath);
        return dlRes;
    }
}

function cleanFolderName(title) {
    return (title || 'Game')
        .replace(/[^a-zA-Z0-9_\- ]/g, '')
        .trim()
        .replace(/\s+/g, '_');
}

/**
 * Main Runner Loop
 */
async function run() {
    console.log('===============================================================');
    console.log('🚀 Ninten2 Nintendo Switch Games Sync & Auto-Uploader Pipeline');
    console.log(`📦 Multi-Part Splitting (RAR): ${PART_SIZE_MB} MB (2 GB) parts`);
    console.log('===============================================================');
    console.log(`🌐 Target Website API: ${API_BASE_URL}`);

    if (!REFRESH_TOKEN) {
        console.error('❌ Error: Missing ABREHAMRAHI_REFRESH_TOKEN environment variable.');
        process.exit(1);
    }

    if (!fs.existsSync(DEST_DIR)) {
        fs.mkdirSync(DEST_DIR, { recursive: true });
    }

    // 1. Get Pending Items from API (or use single URL)
    let queueItems = [];
    if (SINGLE_URL) {
        queueItems = [{
            id: 0,
            nswpedia_url: SINGLE_URL,
            system_platform: 'Nintendo Switch',
        }];
    } else {
        console.log(`📡 Checking website API for pending games to download (up to ${BATCH_LIMIT})...`);
        try {
            const res = await apiRequest(`/api/v1/games/queue/pending?limit=${BATCH_LIMIT}`);
            queueItems = res.data || [];
        } catch (err) {
            console.error(`❌ Failed to connect to API: ${err.message}`);
            process.exit(1);
        }
    }

    if (queueItems.length === 0) {
        console.log('✅ No pending games in queue to download. Everything is up to date!');
        process.exit(0);
    }

    console.log(`✨ Found ${queueItems.length} game(s) to process.\n`);

    // 2. Authenticate with AbreHamrahi
    console.log('🔑 Authenticating with AbreHamrahi Cloud Storage...');
    const accessToken = await getAccessToken(REFRESH_TOKEN);
    console.log('✅ AbreHamrahi authentication successful!\n');

    for (const item of queueItems) {
        console.log('---------------------------------------------------------------');
        console.log(`🎮 Processing Queue Item #${item.id}: ${item.nswpedia_url}`);

        // Notify API start
        if (item.id > 0) {
            try {
                await apiRequest('/api/v1/games/queue/start', 'POST', { queue_id: item.id });
                console.log(`📌 Marked queue item #${item.id} as processing.`);
            } catch (err) {
                console.warn(`⚠️ Warning: Could not mark start in API: ${err.message}`);
            }
        }

        try {
            // 3. Scrape NSWPedia Game Page
            console.log(`🔍 Scraping game page and resolving direct ROM mirrors...`);
            let gameData = null;
            let scrapeError = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    gameData = await scrapeGame(item.nswpedia_url, { resolveMirrors: true });
                    break;
                } catch (err) {
                    scrapeError = err;
                    if (attempt < 3) {
                        console.log(`⚠️ Scrape attempt ${attempt} failed: ${err.message}. Retrying in 5s...`);
                        await new Promise(r => setTimeout(r, 5000));
                    }
                }
            }
            if (!gameData) {
                throw scrapeError || new Error(`Failed to scrape game page after 3 attempts.`);
            }

            console.log(`\n📋 Extracted Game Details:`);
            console.log(`    Title:     ${gameData.title}`);
            console.log(`    Title ID:  ${gameData.titleId || 'N/A'}`);
            console.log(`    Firmware:  ${gameData.requiredFirmware || 'N/A'}`);
            console.log(`    Cover:     ${gameData.cover ? 'Found' : 'None'}`);
            console.log(`    Screens:   ${gameData.screenshots.length} screenshot(s) found`);
            console.log(`    Mirrors:   ${gameData.downloads.length} mirror link(s) found\n`);

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
    if (u.includes('datanodes.to')) return 50; // Datanodes free web requires browser countdown
    if (u.includes('rushupload.com')) return 40;
    if (u.includes('multiup.')) return 30;
    return 10;
}

            // 4. Select candidate download files & collect all available mirrors
            const availableDownloads = gameData.downloads.filter(d => d.directUrl && !d.directUrl.includes('placeholder'));

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
                // Sort mirrors: best host first, dead hosts last
                item.mirrors.sort((a, b) => getMirrorScore(b.directUrl) - getMirrorScore(a.directUrl));
                item.directUrl = item.mirrors[0].directUrl;
                return item;
            });

            if (selectedFiles.length === 0) {
                throw new Error('No downloadable direct ROM links found on the game page.');
            }

            console.log(`📦 Selected ${selectedFiles.length} file(s) for download & AbreHamrahi upload.`);
            for (const sf of selectedFiles) {
                console.log(`    - ${sf.name} [${sf.type}]: ${sf.mirrors.length} mirror(s) available`);
            }

            const uploadedFiles = [];
            const gameFolderName = `Nintendo_Switch/${cleanFolderName(gameData.title)}`;

            for (let i = 0; i < selectedFiles.length; i++) {
                const fileItem = selectedFiles[i];
                console.log(`\n---------------------------------------------------------------`);
                console.log(`[${i + 1}/${selectedFiles.length}] 📥 Processing: ${fileItem.name} (${fileItem.size || 'Size N/A'})`);
                console.log(`    Type:    ${fileItem.type} | Format: ${fileItem.format || 'NSP'}`);
                console.log(`    Mirrors: ${fileItem.mirrors.length} candidate mirror(s)`);

                const baseRarName = generateRomFilename(gameData.title, fileItem, '.rar');
                const cleanBaseName = baseRarName.replace(/\.(rar|zip|7z)$/i, '');
                const subFolder = fileItem.type === 'Base Game' ? 'Base_Game' : (fileItem.type === 'Update' ? 'Updates' : 'DLC');
                const targetHamrahiFolder = `${gameFolderName}/${subFolder}`;

                let fileSuccess = false;
                let lastFileError = null;

                for (let fileAttempt = 1; fileAttempt <= 3; fileAttempt++) {
                    try {
                        if (fileAttempt > 1) {
                            console.log(`\n    🔄 [Retry ${fileAttempt}/3] Retrying file: ${fileItem.name}...`);
                            await new Promise(r => setTimeout(r, 4000));
                        }

                        console.log(`    🔑 Refreshing AbreHamrahi access token...`);
                        const currentAccessToken = await getAccessToken(REFRESH_TOKEN);

                        console.log(`    ☁️ Resolving AbreHamrahi folder: "${targetHamrahiFolder}"...`);
                        const folderId = await resolveFolderPath(currentAccessToken, targetHamrahiFolder, REFRESH_TOKEN);

                        // Candidate filenames to check in AbreHamrahi before downloading
                        const candidateNames = [
                            baseRarName,
                            `${cleanBaseName}.part1.rar`,
                            `${cleanBaseName}.rar`,
                            `${cleanBaseName}.zip`,
                            `${cleanBaseName}.7z.001`,
                            fileItem.name,
                            baseRarName.replace(/\.rar$/i, '.nsp'),
                            baseRarName.replace(/\.rar$/i, '.xci'),
                            fileItem.name.replace(/\.[a-zA-Z0-9]+$/, '') + '.rar',
                            `${cleanFolderName(gameData.title)}_${subFolder}.rar`,
                            `${cleanFolderName(gameData.title)}.rar`
                        ];

                        // Check if file already exists in AbreHamrahi
                        console.log(`    🔍 Checking if file already exists on AbreHamrahi Cloud...`);
                        let existingCloudFile = await findExistingFileInHamrahi(currentAccessToken, folderId, candidateNames, REFRESH_TOKEN);

                        let fileTypeKey = 'base_game';
                        if (fileItem.type === 'Update') fileTypeKey = 'update';
                        else if (fileItem.type === 'DLC') fileTypeKey = 'dlc';

                        let baseDisplayTitle = `${cleanGameTitle(gameData.title).replace(/_/g, ' ')}`;
                        if (fileItem.type === 'Base Game') {
                            baseDisplayTitle += ' - نسخه اصلی بازی';
                        } else if (fileItem.type === 'Update') {
                            const ver = fileItem.version && fileItem.version !== 'Update' ? ` ${fileItem.version}` : '';
                            baseDisplayTitle += ` - آپدیت${ver}`.trim();
                        } else if (fileItem.type === 'DLC') {
                            const dlcName = cleanDlcDisplayName(fileItem.name, gameData.title);
                            if (dlcName && dlcName.length > 1 && !/^(base game|update)$/i.test(dlcName)) {
                                baseDisplayTitle += ` - بسته الحاقی (${dlcName})`;
                            } else {
                                baseDisplayTitle += ' - بسته الحاقی (DLC)';
                            }
                        }

                        if (existingCloudFile) {
                            console.log(`    ⚡ [CACHE HIT] Reusing existing cloud file without re-downloading: ${existingCloudFile.public_url}`);
                            uploadedFiles.push({
                                file_type: fileTypeKey,
                                title: existingCloudFile.name,
                                display_title: baseDisplayTitle,
                                version: fileItem.version || 'v1.0.0',
                                file_size: formatBytes(existingCloudFile.size),
                                file_format: existingCloudFile.name.endsWith('.rar') ? 'RAR' : (existingCloudFile.name.endsWith('.7z') ? '7Z' : 'ZIP'),
                                password: ZIP_PASSWORD,
                                part_number: 1,
                                total_parts: 1,
                                server_name: 'سرور اختصاصی مستقیم ابر همراهی (نیم‌بها)',
                                download_url: existingCloudFile.public_url,
                                folder_path: targetHamrahiFolder,
                                hamrahi_id: existingCloudFile.id,
                            });
                            fileSuccess = true;
                            break;
                        } else {
                            // Step A: Download file from candidate mirrors (with automatic fallback)
                            let dlResult = null;
                            let lastDlError = null;
                            let downloadedFilePath = null;

                            const tempExt = fileItem.format ? `.${fileItem.format.toLowerCase()}` : '.nsp';
                            const tempDownloadName = `temp_${Date.now()}_${cleanFolderName(gameData.title)}_${i + 1}${tempExt}`;
                            const tempLocalFilePath = path.join(DEST_DIR, tempDownloadName);

                            for (let mIdx = 0; mIdx < fileItem.mirrors.length; mIdx++) {
                                const currentMirror = fileItem.mirrors[mIdx];
                                const sourceUrl = currentMirror.directUrl;
                                console.log(`    📥 [Mirror ${mIdx + 1}/${fileItem.mirrors.length}] Trying source: ${sourceUrl} (${currentMirror.server || 'Direct'})`);
                                console.log(`    Saving temporary download to: ${tempLocalFilePath}`);

                                try {
                                    dlResult = await downloadRomFile(sourceUrl, tempLocalFilePath);
                                    console.log(`\n    ✅ Downloaded successfully from Mirror ${mIdx + 1}: ${formatBytes(dlResult.totalBytes)}`);
                                    downloadedFilePath = tempLocalFilePath;
                                    break;
                                } catch (dlErr) {
                                    lastDlError = dlErr;
                                    console.warn(`\n    ⚠️ Mirror ${mIdx + 1} failed: ${dlErr.message}`);
                                    if (fs.existsSync(tempLocalFilePath)) {
                                        try { fs.unlinkSync(tempLocalFilePath); } catch {}
                                    }
                                    if (mIdx < fileItem.mirrors.length - 1) {
                                        console.log(`    🔄 Falling back to mirror ${mIdx + 2}/${fileItem.mirrors.length}...`);
                                    }
                                }
                            }

                            if (!dlResult || !downloadedFilePath) {
                                throw lastDlError || new Error(`All ${fileItem.mirrors.length} mirror(s) failed for file: ${fileItem.name}`);
                            }

                            // Step B: Package & split into 2GB password-protected parts (.part1.rar, .part2.rar)
                            console.log(`    🔒 Packaging into RAR format with password '${ZIP_PASSWORD}'...`);
                            const generatedParts = createProtectedParts(downloadedFilePath, DEST_DIR, baseRarName, ZIP_PASSWORD, PART_SIZE_MB);
                            console.log(`    📦 Generated ${generatedParts.length} part(s).`);

                            // Clean up temporary downloaded source file
                            if (fs.existsSync(downloadedFilePath)) {
                                fs.unlinkSync(downloadedFilePath);
                            }

                            // Step C: Upload all parts to AbreHamrahi Cloud
                            for (let pIdx = 0; pIdx < generatedParts.length; pIdx++) {
                                const part = generatedParts[pIdx];
                                console.log(`    ☁️ Uploading Part ${part.partNumber}/${part.totalParts}: "${part.name}" (${formatBytes(part.size)})...`);

                                let partUploadResult = await findExistingFileInHamrahi(currentAccessToken, folderId, [part.name], REFRESH_TOKEN);
                                if (!partUploadResult) {
                                    partUploadResult = await uploadFileToHamrahi(currentAccessToken, part.path, folderId, part.name, REFRESH_TOKEN);
                                }
                                console.log(`    🎉 Part ${part.partNumber} Uploaded! Public Link: ${partUploadResult.public_url}`);

                                let partTitle = baseDisplayTitle;
                                if (part.totalParts > 1) {
                                    partTitle += ` (پارت ${part.partNumber} از ${part.totalParts})`;
                                }

                                uploadedFiles.push({
                                    file_type: fileTypeKey,
                                    title: part.name,
                                    display_title: partTitle,
                                    version: fileItem.version || 'v1.0.0',
                                    file_size: formatBytes(partUploadResult.size),
                                    file_format: part.format || 'RAR',
                                    password: ZIP_PASSWORD,
                                    part_number: part.partNumber,
                                    total_parts: part.totalParts,
                                    server_name: 'سرور اختصاصی مستقیم ابر همراهی (نیم‌بها)',
                                    download_url: partUploadResult.public_url,
                                    folder_path: targetHamrahiFolder,
                                    hamrahi_id: partUploadResult.id,
                                });

                                // Clean up local part file
                                if (fs.existsSync(part.path)) {
                                    fs.unlinkSync(part.path);
                                }
                            }
                            console.log(`    🧹 Cleaned up temporary local part files.`);
                            fileSuccess = true;
                            break;
                        }

                    } catch (fileErr) {
                        lastFileError = fileErr;
                        console.error(`\n    ⚠️ Attempt ${fileAttempt} failed for file ${fileItem.name}: ${fileErr.message}`);
                    }
                }

                if (!fileSuccess) {
                    console.error(`\n    ❌ Failed processing file ${fileItem.name} after 3 attempts: ${lastFileError?.message}`);
                }
            }

            if (uploadedFiles.length === 0) {
                throw new Error('No files were successfully processed or uploaded for this game.');
            }

            // 5. Complete task in Website API
            console.log(`\n📤 Sending ${uploadedFiles.length} download links and metadata back to website API...`);
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

            console.log(`\n🎉 Queue Item #${item.id} (${gameData.title}) completed successfully with ${uploadedFiles.length} file(s)!`);

        } catch (taskErr) {
            console.error(`\n❌ Error processing game ${item.nswpedia_url}: ${taskErr.message}`);

            if (item.id > 0) {
                try {
                    await apiRequest('/api/v1/games/queue/fail', 'POST', {
                        queue_id: item.id,
                        error_message: taskErr.message
                    });
                    console.log(`⚠️ Logged error in website API.`);
                } catch (failApiErr) {
                    console.error(`Failed to report error to API: ${failApiErr.message}`);
                }
            }
        }
    }

    console.log('\n===============================================================');
    console.log('🏁 All requested tasks in this run completed!');
    console.log('===============================================================\n');
}

run().catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
});
