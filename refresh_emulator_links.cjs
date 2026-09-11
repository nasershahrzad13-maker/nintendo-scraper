#!/usr/bin/env node

/**
 * Ninten2 - Switch Emulators Permanent Link Refresher & Site Sync
 * 
 * Flow:
 * 1. Fetches current Switch emulators and releases from website API (/api/v1/emulators/sync/list).
 * 2. Connects to AbreHamrahi Cloud and navigates through emulator folders.
 * 3. Creates permanent public links (/o/public/{id}/) for all emulator releases on AbreHamrahi.
 * 4. Updates the website database (/api/v1/emulators/sync/save-release) with permanent public links.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { getAccessToken, resolveFolderPath, findExistingFileInHamrahi, request: rawRequest } = require('./hamrahi_uploader.cjs');

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
const DRY_RUN = params['dry-run'] === true;

if (!REFRESH_TOKEN) {
    console.error('❌ Error: Missing ABREHAMRAHI_REFRESH_TOKEN env variable or --refresh-token flag.');
    process.exit(1);
}

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
                'User-Agent': 'Ninten2-Emulator-Permanent-Sync/1.0',
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

async function createPublicLink(accessToken, objId, refreshTokenInput) {
    let activeToken = accessToken;
    let linkRes = await rawRequest({
        hostname: 'abrehamrahi.ir',
        path: '/api/v2/sharing/public-link/create/',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${activeToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    }, { obj_id: objId });

    if ((linkRes.status === 401 || (linkRes.body && linkRes.body.code === 'token_not_valid')) && refreshTokenInput) {
        activeToken = await getAccessToken(refreshTokenInput);
        linkRes = await rawRequest({
            hostname: 'abrehamrahi.ir',
            path: '/api/v2/sharing/public-link/create/',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${activeToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        }, { obj_id: objId });
    }

    if (linkRes.status === 200 && linkRes.body && linkRes.body.link) {
        return linkRes.body.link;
    }

    throw new Error(`Public link creation failed (HTTP ${linkRes.status}): ${JSON.stringify(linkRes.body)}`);
}

async function main() {
    console.log('===========================================================');
    console.log('🎮 Ninten2 Emulator Permanent Link Refresher & Sync');
    console.log(`🌐 Site URL: ${API_BASE_URL}`);
    console.log(`🔒 Mode: ${DRY_RUN ? 'DRY-RUN (No DB updates)' : 'LIVE SYNC'}`);
    console.log('===========================================================\n');

    console.log('🔑 Authenticating with AbreHamrahi...');
    const accessToken = await getAccessToken(REFRESH_TOKEN);
    console.log('✅ Authenticated successfully!\n');

    console.log('📡 Fetching list of emulators from website...');
    const emuListRes = await requestSite('/api/v1/emulators/sync/list');

    let emulators = [];
    if (emuListRes.status === 200 && Array.isArray(emuListRes.data?.data)) {
        emulators = emuListRes.data.data;
        console.log(`✅ Loaded ${emulators.length} emulators from site.\n`);
    } else {
        console.error('❌ Failed to fetch emulators list:', emuListRes.data);
        process.exit(1);
    }

    const summaryResults = [];

    for (const emu of emulators) {
        console.log(`-----------------------------------------------------------`);
        console.log(`🕹️ Processing Emulator: ${emu.name} (${emu.slug})`);

        const folderPath = `Nintendo_Switch/Emulators/${emu.name.replace(/[^a-zA-Z0-9_\-]/g, '_')}`;
        console.log(`📂 Resolving AbreHamrahi folder: "${folderPath}"...`);

        let folderId = null;
        try {
            folderId = await resolveFolderPath(accessToken, folderPath, REFRESH_TOKEN);
        } catch (e) {
            console.warn(`   ⚠️ Folder "${folderPath}" could not be resolved. Skipping.`);
            continue;
        }

        const releases = emu.releases || [];
        for (const rel of releases) {
            const fileName = rel.file_name;
            const platform = rel.platform;
            const arch = rel.architecture || 'x64';
            const version = emu.latest_version || 'latest';

            console.log(`\n   📦 Release: ${fileName} [${platform} - ${arch}]`);
            console.log(`      Current URL: ${rel.download_url}`);

            console.log(`   🔗 Searching file in AbreHamrahi folder and generating permanent public link...`);
            let permanentUrl = null;
            try {
                const existingFile = await findExistingFileInHamrahi(accessToken, folderId, [fileName], REFRESH_TOKEN);
                if (existingFile && existingFile.public_url) {
                    permanentUrl = existingFile.public_url;
                    console.log(`   ✨ Permanent Public Link: ${permanentUrl}`);
                } else {
                    console.warn(`   ⚠️ File "${fileName}" not found in AbreHamrahi folder. Skipping.`);
                    continue;
                }
            } catch (err) {
                console.error(`   ❌ Failed to create/retrieve public link: ${err.message}`);
                continue;
            }

            if (!DRY_RUN) {
                console.log(`   💾 Updating release link in website database...`);
                const saveRes = await requestSite('/api/v1/emulators/sync/save-release', 'POST', {
                    emulator_slug: emu.slug,
                    version: version,
                    platform: platform,
                    architecture: arch,
                    file_name: fileName,
                    file_size: rel.file_size || '10 MB',
                    file_size_bytes: rel.file_size_bytes || 0,
                    download_url: permanentUrl
                });

                if (saveRes.status === 200) {
                    console.log(`   ✅ Database updated for ${emu.name} [${platform}]!`);
                    summaryResults.push({
                        emulator: emu.name,
                        platform: platform,
                        fileName: fileName,
                        status: 'Updated',
                        url: permanentUrl
                    });
                } else {
                    console.warn(`   ⚠️ Site API response (${saveRes.status}):`, saveRes.data);
                }
            }
        }
    }

    console.log('\n===========================================================');
    console.log('🎉 EMULATORS PERMANENT LINK REFRESH COMPLETED!');
    console.log('===========================================================');
    console.table(summaryResults);
}

if (require.main === module) {
    main().catch(err => {
        console.error('💥 Fatal error:', err);
        process.exit(1);
    });
}

module.exports = { main };
