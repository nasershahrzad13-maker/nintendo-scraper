#!/usr/bin/env node

/**
 * Migration Script: Transfers existing local/hosted videos from ninten2-blog to AbreHamrahi Cloud
 * and updates public video links in the website's database.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getAccessToken, resolveFolderPath, uploadFileToHamrahi, findExistingFileInHamrahi } = require('./hamrahi_uploader.cjs');

// Read command-line params
const args = process.argv.slice(2);
const params = {};
for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
        const key = args[i].substring(2);
        const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
        params[key] = val;
    }
}

const SITE_URL = (params['site-url'] || process.env.SITE_URL || 'https://ninten2.ir').replace(/\/+$/, '');
const SYNC_API_TOKEN = params['sync-token'] || process.env.SYNC_API_TOKEN || 'ninten2-sync-secret-key-2026';
const REFRESH_TOKEN = params['refresh-token'] || process.env.ABREHAMRAHI_REFRESH_TOKEN;
const TARGET_FOLDER = params['folder'] || 'Videos';

if (!REFRESH_TOKEN) {
    console.error('❌ Error: Missing AbreHamrahi Refresh Token. Set ABREHAMRAHI_REFRESH_TOKEN env or pass --refresh-token');
    process.exit(1);
}

function requestSite(endpoint, method = 'GET', data = null) {
    return new Promise((resolve, reject) => {
        const fullUrl = new URL(endpoint.startsWith('http') ? endpoint : `${SITE_URL}${endpoint}`);
        const client = fullUrl.protocol === 'https:' ? https : http;

        let payload = null;
        const headers = {
            'User-Agent': 'Ninten2-VideoMigrator/1.0',
            'X-SYNC-TOKEN': SYNC_API_TOKEN,
            'Accept': 'application/json'
        };

        if (data) {
            payload = JSON.stringify(data);
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = client.request(fullUrl, {
            method,
            headers,
            timeout: 30000
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    resolve({ status: res.statusCode, data: parsed });
                } catch (e) {
                    resolve({ status: res.statusCode, data: body });
                }
            });
        });

        req.on('timeout', () => req.destroy(new Error('Request timed out')));
        req.on('error', reject);

        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

function downloadHttpFile(fileUrl, outputPath) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(fileUrl);
        const client = urlObj.protocol === 'https:' ? https : http;

        const fileStream = fs.createWriteStream(outputPath);
        const req = client.get(fileUrl, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                // Follow redirect
                return downloadHttpFile(res.headers.location, outputPath).then(resolve).catch(reject);
            }

            if (res.statusCode !== 200) {
                fileStream.close();
                fs.unlink(outputPath, () => {});
                return reject(new Error(`Failed to download file, HTTP ${res.statusCode}`));
            }

            res.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close(() => resolve(outputPath));
            });
        });

        req.on('error', (err) => {
            fileStream.close();
            fs.unlink(outputPath, () => {});
            reject(err);
        });
    });
}

async function main() {
    console.log('====================================================');
    console.log('🎬 Ninten2 Video Migration to AbreHamrahi Cloud');
    console.log('====================================================');
    console.log(`🌐 Site URL: ${SITE_URL}`);
    console.log(`📁 Target Cloud Folder: ${TARGET_FOLDER}\n`);

    // 1. Authenticate with AbreHamrahi
    console.log('🔑 Authenticating with AbreHamrahi...');
    const accessToken = await getAccessToken(REFRESH_TOKEN);
    console.log('✅ Authentication successful!');

    console.log(`📂 Resolving or creating folder "${TARGET_FOLDER}" in AbreHamrahi...`);
    const folderId = await resolveFolderPath(accessToken, TARGET_FOLDER, REFRESH_TOKEN);
    console.log(`✅ Target folder ready (ID: ${folderId || 'Root'})\n`);

    // 2. Fetch local videos from website
    console.log('📡 Fetching list of local/hosted videos from website...');
    const listRes = await requestSite('/api/v1/sync/local-videos');

    if (listRes.status !== 200 || !listRes.data || !Array.isArray(listRes.data.data)) {
        console.error('❌ Failed to fetch video list from site:', listRes.data);
        process.exit(1);
    }

    const videos = listRes.data.data;
    console.log(`📋 Found ${videos.length} video(s) requiring migration.\n`);

    if (videos.length === 0) {
        console.log('🎉 No local videos left to migrate! Everything is up to date.');
        return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamrahi-video-migrate-'));

    let successCount = 0;
    let failedCount = 0;

    for (let i = 0; i < videos.length; i++) {
        const item = videos[i];
        console.log(`----------------------------------------------------`);
        console.log(`▶️ [${i + 1}/${videos.length}] Processing ${item.type} #${item.id}: "${item.title}"`);
        console.log(`   Current Path: ${item.local_video_path}`);

        let localFilePath = null;
        let isTempDownload = false;

        try {
            // Check if file is on local disk or needs HTTP download
            if (fs.existsSync(item.local_video_path)) {
                localFilePath = item.local_video_path;
            } else if (item.local_video_path.startsWith('http://') || item.local_video_path.startsWith('https://')) {
                // If it's a URL (e.g. from site storage), download it temporarily
                const filename = path.basename(new URL(item.local_video_path).pathname) || `video_${item.type}_${item.id}.mp4`;
                const tempDownloadPath = path.join(tempDir, filename);
                console.log(`   ⬇️ Downloading video from server: ${item.local_video_path}...`);
                await downloadHttpFile(item.local_video_path, tempDownloadPath);
                localFilePath = tempDownloadPath;
                isTempDownload = true;
            } else {
                // Check relative storage path
                const relPath = path.join(process.cwd(), item.local_video_path.replace(/^\/+/, ''));
                if (fs.existsSync(relPath)) {
                    localFilePath = relPath;
                }
            }

            if (!localFilePath || !fs.existsSync(localFilePath)) {
                console.error(`   ⚠️ Video file could not be located or downloaded: ${item.local_video_path}`);
                failedCount++;
                continue;
            }

            const fileSizeMb = (fs.statSync(localFilePath).size / (1024 * 1024)).toFixed(2);
            const fileName = path.basename(localFilePath);
            console.log(`   📦 Video ready for upload (${fileSizeMb} MB): ${fileName}`);

            // Check if file already exists in AbreHamrahi
            let uploadResult = await findExistingFileInHamrahi(accessToken, folderId, [fileName], REFRESH_TOKEN);

            if (!uploadResult) {
                console.log(`   ☁️ Uploading to AbreHamrahi...`);
                uploadResult = await uploadFileToHamrahi(accessToken, localFilePath, folderId, fileName, REFRESH_TOKEN, 4);
            }

            console.log(`   🔗 AbreHamrahi Public Link: ${uploadResult.public_url}`);

            // Update website with new public URL
            console.log(`   💾 Updating video link in website database...`);
            const updateRes = await requestSite('/api/v1/sync/save-video-url', 'POST', {
                type: item.type,
                id: item.id,
                public_url: uploadResult.public_url
            });

            if (updateRes.status === 200) {
                console.log(`   ✅ Successfully migrated and updated in site!`);
                successCount++;
            } else {
                console.error(`   ❌ Failed to update site database:`, updateRes.data);
                failedCount++;
            }

        } catch (err) {
            console.error(`   ❌ Error migrating video #${item.id}: ${err.message}`);
            failedCount++;
        } finally {
            if (isTempDownload && localFilePath && fs.existsSync(localFilePath)) {
                try { fs.unlinkSync(localFilePath); } catch (e) {}
            }
        }
    }

    // Clean up temporary directory
    try {
        fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {}

    console.log('\n====================================================');
    console.log('🏁 MIGRATION SUMMARY:');
    console.log(`   ✅ Successfully Migrated: ${successCount}`);
    console.log(`   ❌ Failed: ${failedCount}`);
    console.log('====================================================\n');
}

if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}

module.exports = { main };
