#!/usr/bin/env node

/**
 * 🎮 Nintendo Switch Emulators Auto-Sync & AbreHamrahi Cloud Uploader
 * 
 * Flow:
 * 1. Fetches current Switch emulators and releases from website API (/api/v1/emulators/sync/list).
 * 2. Authenticates with AbreHamrahi Cloud Storage using REFRESH_TOKEN.
 * 3. Resolves/creates target folders: Nintendo_Switch/Emulators/<Emulator_Name>/
 * 4. Checks if the file is already uploaded to AbreHamrahi (Instant Cache Hit).
 * 5. If not uploaded: Downloads the official binary via high-speed aria2 / stream download.
 * 6. Uploads the file to AbreHamrahi in parallel chunks.
 * 7. Obtains the direct public download link from AbreHamrahi (Domestic / Half-price Iran CDN).
 * 8. Updates the website database (/api/v1/emulators/sync/save-release) with the AbreHamrahi link!
 * 9. Cleans up local disk space.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
const DEST_DIR = params['dest-dir'] || path.join(process.cwd(), 'downloads_emulators');
const SINGLE_SLUG = params['single-slug'] || null;

if (!fs.existsSync(DEST_DIR)) {
    fs.mkdirSync(DEST_DIR, { recursive: true });
}

/**
 * Make authenticated HTTP request to site API
 */
function requestSite(endpoint, method = 'GET', data = null) {
    return new Promise((resolve, reject) => {
        const fullUrl = new URL(endpoint.startsWith('http') ? endpoint : `${API_BASE_URL}${endpoint}`);
        const isHttps = fullUrl.protocol === 'https:';
        const client = isHttps ? https : http;

        const bodyString = data ? JSON.stringify(data) : null;

        const options = {
            hostname: fullUrl.hostname,
            port: fullUrl.port || (isHttps ? 443 : 80),
            path: fullUrl.pathname + fullUrl.search,
            method: method,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Ninten2-Emulator-AbreHamrahi-Sync/1.0',
                'X-SYNC-TOKEN': SYNC_TOKEN,
                ...(bodyString ? {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(bodyString)
                } : {})
            },
            timeout: 30000
        };

        const req = client.request(options, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(responseData);
                    resolve({ status: res.statusCode, data: parsed });
                } catch (e) {
                    resolve({ status: res.statusCode, data: responseData });
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Request timeout: ${endpoint}`));
        });

        if (bodyString) {
            req.write(bodyString);
        }
        req.end();
    });
}

/**
 * Format bytes to readable string
 */
function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const p = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, p)).toFixed(1) + ' ' + units[p];
}

/**
 * Download file using aria2 or stream
 */
async function downloadFileToDisk(url, destPath) {
    console.log(`   ⏳ Downloading file: ${url} ...`);

    let hasAria2 = false;
    try {
        execSync('which aria2c', { stdio: 'ignore' });
        hasAria2 = true;
    } catch {}

    if (hasAria2) {
        try {
            const dir = path.dirname(destPath);
            const outName = path.basename(destPath);
            execSync(`aria2c -x 8 -s 8 -j 4 -k 1M --allow-overwrite=true --dir="${dir}" -o "${outName}" "${url}"`, {
                stdio: 'inherit',
                timeout: 300000
            });
            if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1024) {
                return destPath;
            }
        } catch (err) {
            console.log(`   ⚠️ aria2 failed (${err.message}). Falling back to curl/stream...`);
        }
    }

    // Fallback: curl or node stream
    try {
        execSync(`curl -L -f -s -S --connect-timeout 20 --max-time 300 -o "${destPath}" "${url}"`, {
            stdio: 'inherit'
        });
        if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1024) {
            return destPath;
        }
    } catch (e) {
        throw new Error(`Download failed for ${url}: ${e.message}`);
    }

    return destPath;
}

/**
 * Main Sync Pipeline
 */
async function main() {
    console.log('===========================================================');
    console.log('🎮 Ninten2 Nintendo Switch Emulators to AbreHamrahi Sync');
    console.log('===========================================================');

    if (!REFRESH_TOKEN) {
        console.error('❌ Error: Missing ABREHAMRAHI_REFRESH_TOKEN. Set env variable or pass --refresh-token');
        process.exit(1);
    }

    console.log(`🌐 Website URL: ${API_BASE_URL}`);

    // 1. Authenticate with AbreHamrahi
    console.log('🔑 Authenticating with AbreHamrahi Cloud...');
    const accessToken = await getAccessToken(REFRESH_TOKEN);
    console.log('✅ AbreHamrahi authenticated successfully.');

    // 2. Fetch active emulators list from site
    console.log('📡 Fetching emulators list from website API...');
    let emulators = [];
    try {
        const res = await requestSite('/api/v1/emulators/sync/list', 'GET');
        if (res.status === 200 && res.data && res.data.data) {
            emulators = res.data.data;
            console.log(`✅ Retrieved ${emulators.length} active emulators from website.`);
        } else {
            console.warn(`⚠️ Could not fetch from API (Status ${res.status}). Using local presets.`);
        }
    } catch (e) {
        console.warn(`⚠️ Failed connecting to site API: ${e.message}. Using built-in fallback.`);
    }

    // Built-in presets if API list is empty
    if (emulators.length === 0) {
        emulators = [
            {
                name: 'Ryujinx',
                slug: 'ryujinx',
                latest_version: '1.3.3',
                releases: [
                    { platform: 'windows', architecture: 'x64', file_name: 'ryujinx-1.3.3-win_x64.zip', download_url: 'https://git.ryujinx.app/projects/Ryubing/releases/download/1.3.3/ryujinx-1.3.3-win_x64.zip' },
                    { platform: 'linux', architecture: 'x64', file_name: 'ryujinx-1.3.3-linux_x64.tar.gz', download_url: 'https://git.ryujinx.app/projects/Ryubing/releases/download/1.3.3/ryujinx-1.3.3-linux_x64.tar.gz' },
                    { platform: 'macos', architecture: 'arm64', file_name: 'ryujinx-1.3.3-macos_universal.app.tar.gz', download_url: 'https://git.ryujinx.app/projects/Ryubing/releases/download/1.3.3/ryujinx-1.3.3-macos_universal.app.tar.gz' },
                ]
            },
            {
                name: 'Sudachi',
                slug: 'sudachi',
                latest_version: 'v1.0.9',
                releases: [
                    { platform: 'windows', architecture: 'x64', file_name: 'sudachi-master-win-x64-qt6.zip', download_url: 'https://archive.org/download/sudachi-master-2026-09-03-8246830/sudachi-master-2026-09-03-8246830-win-x64-qt6.zip' },
                    { platform: 'android', architecture: 'arm64', file_name: 'sudachi-app-mainline-release.apk', download_url: 'https://archive.org/download/Sudachi-apk-1.0.5/app-mainline-release.apk' },
                    { platform: 'linux', architecture: 'x64', file_name: 'sudachi-master-linux-x86_64-qt6.zip', download_url: 'https://archive.org/download/sudachi-master-2026-09-03-8246830/sudachi-master-2026-09-03-8246830-linux-x86_64-qt6.zip' },
                ]
            },
            {
                name: 'Suyu',
                slug: 'suyu',
                latest_version: 'v0.0.3',
                releases: [
                    { platform: 'windows', architecture: 'x64', file_name: 'suyu-windows-x86_64.zip', download_url: 'https://archive.org/download/suyu-emulator-releases/suyu-windows-x86_64.zip' },
                    { platform: 'android', architecture: 'arm64', file_name: 'suyu-android-v0.0.3.apk', download_url: 'https://archive.org/download/suyu-emulator-releases/suyu-android-v0.0.3.apk' },
                    { platform: 'linux', architecture: 'x64', file_name: 'suyu-linux-x86_64.AppImage', download_url: 'https://archive.org/download/suyu-emulator-releases/suyu-linux-x86_64.AppImage' },
                ]
            },
            {
                name: 'Torzu',
                slug: 'torzu',
                latest_version: 'v1.0.0',
                releases: [
                    { platform: 'windows', architecture: 'x64', file_name: 'torzu-windows-msvc.zip', download_url: 'https://archive.org/download/torzu-switch-emulator/torzu-windows-msvc.zip' },
                    { platform: 'linux', architecture: 'x64', file_name: 'torzu-linux.AppImage', download_url: 'https://archive.org/download/torzu-switch-emulator/torzu-linux.AppImage' },
                ]
            },
            {
                name: 'Switch Firmware & Keys',
                slug: 'switch-firmware-keys',
                latest_version: 'v21.2.0',
                releases: [
                    { platform: 'windows', architecture: 'universal', file_name: 'Nintendo-Switch-Firmware-21.2.0.zip', download_url: 'https://archive.org/download/nintendo-switch-firmware.-21.2.0/Prodkeys.io_Firmware_21.2.0.zip' },
                    { platform: 'android', architecture: 'universal', file_name: 'prod.keys', download_url: 'https://archive.org/download/nspk1901/prod.keys' },
                ]
            }
        ];
    }

    if (SINGLE_SLUG) {
        emulators = emulators.filter(e => e.slug === SINGLE_SLUG);
        console.log(`🎯 Single mode: Only syncing ${SINGLE_SLUG}`);
    }

    const summaryResults = [];

    // 3. Process each emulator
    for (const emu of emulators) {
        console.log(`\n-----------------------------------------------------------`);
        console.log(`🕹️ Processing Emulator: ${emu.name} (${emu.slug})`);
        console.log(`-----------------------------------------------------------`);

        const folderPath = `Nintendo_Switch/Emulators/${emu.name.replace(/[^a-zA-Z0-9_\-]/g, '_')}`;
        console.log(`📂 Resolving AbreHamrahi folder: "${folderPath}"...`);
        const folderId = await resolveFolderPath(accessToken, folderPath, REFRESH_TOKEN);

        const releases = emu.releases || [];

        for (const rel of releases) {
            const fileName = rel.file_name;
            const currentUrl = rel.download_url || '';
            const platform = rel.platform;
            const arch = rel.architecture || 'x64';
            const version = emu.latest_version || 'latest';

            console.log(`\n   📦 Target: ${fileName} [${platform} - ${arch}]`);

            // Check if existing file is already on AbreHamrahi
            let finalPublicUrl = null;
            let fileSizeStr = rel.file_size;
            let fileSizeBytes = null;

            // Step 1: Check cache in AbreHamrahi folder
            const existingInHamrahi = await findExistingFileInHamrahi(accessToken, folderId, [fileName], REFRESH_TOKEN);

            if (existingInHamrahi) {
                console.log(`   ⚡ [CACHE HIT] File already exists in AbreHamrahi!`);
                finalPublicUrl = existingInHamrahi.public_url;
                fileSizeBytes = existingInHamrahi.size;
                fileSizeStr = formatBytes(fileSizeBytes);
            } else {
                // Step 2: Download the file locally
                const localFilePath = path.join(DEST_DIR, fileName);

                try {
                    await downloadFileToDisk(currentUrl, localFilePath);

                    const stat = fs.statSync(localFilePath);
                    fileSizeBytes = stat.size;
                    fileSizeStr = formatBytes(fileSizeBytes);
                    console.log(`   📦 Local file ready (${fileSizeStr}) -> Uploading to AbreHamrahi...`);

                    // Step 3: Upload to AbreHamrahi Cloud
                    const uploadResult = await uploadFileToHamrahi(
                        accessToken,
                        localFilePath,
                        folderId,
                        fileName,
                        REFRESH_TOKEN,
                        4
                    );

                    finalPublicUrl = uploadResult.public_url;
                    console.log(`   🎉 Uploaded successfully to AbreHamrahi!`);
                } catch (upErr) {
                    console.error(`   ❌ Failed processing ${fileName}: ${upErr.message}`);
                    continue;
                } finally {
                    // Remove temp file
                    if (fs.existsSync(localFilePath)) {
                        try { fs.unlinkSync(localFilePath); } catch {}
                    }
                }
            }

            console.log(`   🔗 AbreHamrahi Public Link: ${finalPublicUrl}`);

            // Step 4: Save link to website database
            console.log(`   💾 Updating release link in website database...`);
            try {
                const saveRes = await requestSite('/api/v1/emulators/sync/save-release', 'POST', {
                    emulator_slug: emu.slug,
                    version: version,
                    platform: platform,
                    architecture: arch,
                    file_name: fileName,
                    file_size: fileSizeStr,
                    file_size_bytes: fileSizeBytes,
                    download_url: finalPublicUrl
                });

                if (saveRes.status === 200) {
                    console.log(`   ✅ Database updated: ${emu.name} [${platform}] is now pointing to AbreHamrahi!`);
                    summaryResults.push({
                        emulator: emu.name,
                        platform: platform,
                        fileName: fileName,
                        fileSize: fileSizeStr,
                        url: finalPublicUrl
                    });
                } else {
                    console.warn(`   ⚠️ Site API response (${saveRes.status}):`, saveRes.data);
                }
            } catch (saveErr) {
                console.error(`   ❌ Failed updating site API: ${saveErr.message}`);
            }
        }
    }

    console.log('\n===========================================================');
    console.log('🎉 ALL SWITCH EMULATORS SYNCED TO ABREHAMRAHI!');
    console.log('===========================================================');
    console.table(summaryResults.map(r => ({
        'شبیه‌ساز': r.emulator,
        'پلتفرم': r.platform,
        'فایل': r.fileName,
        'حجم': r.fileSize,
        'لینک ابر همراهی': r.url.substring(0, 40) + '...'
    })));

    // Set GitHub step summary if running in GitHub Actions
    if (process.env.GITHUB_STEP_SUMMARY) {
        let md = `### 🎮 انتقال شبیه‌سازهای نینتندو سوییچ به ابر همراهی\n\n`;
        md += `| شبیه‌ساز | پلتفرم | نام فایل | حجم | وضعیت |\n`;
        md += `| :--- | :--- | :--- | :--- | :--- |\n`;
        for (const item of summaryResults) {
            md += `| **${item.emulator}** | \`${item.platform}\` | ${item.fileName} | ${item.fileSize} | [لینک نیم‌بها](${item.url}) |\n`;
        }
        md += `\n*تمامی لینک‌ها در پایگاه داده سایت ثبت و کاربران مستقیماً با سرورهای پرسرعت داخلی ایران دانلود خواهند کرد.*\n`;
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('💥 Fatal error:', err);
        process.exit(1);
    });
}

module.exports = { main };
