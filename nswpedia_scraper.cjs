#!/usr/bin/env node

/**
 * NSWPedia Direct Download Links Scraper & Downloader
 * 
 * Features:
 *  - Search ROMs by keyword on NSWPedia
 *  - Extract complete metadata (Title, Cover, Screenshots, Description)
 *  - Extract all mirrors (Base Game, Updates, DLCs)
 *  - Follow intermediate download pages to get direct storage links (Vikingfile/Direct, 1Fichier, Datanodes)
 *  - High-speed direct file downloading with live progress bar, speed, and resume support
 *  - Modular (exportable to other scripts) and CLI executable
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * HTTP GET helper with redirect handling, custom headers and auto-retry
 */
function fetchUrl(urlStr, options = {}, retries = 4) {
    return new Promise((resolve, reject) => {
        let parsedUrl;
        try {
            parsedUrl = new URL(urlStr);
        } catch (e) {
            return reject(new Error(`Invalid URL: ${urlStr}`));
        }

        const protocol = parsedUrl.protocol === 'https:' ? https : http;

        const reqOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,fa;q=0.8',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"Windows"',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
                'Referer': options.referer || 'https://nswpedia.com/',
                ...options.headers
            },
            rejectUnauthorized: false
        };

        const timeoutMs = options.timeout || 60000;
        let isTimedOut = false;

        const req = protocol.request(reqOptions, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const nextUrl = new URL(res.headers.location, urlStr).href;
                return resolve(fetchUrl(nextUrl, { ...options, referer: urlStr }, retries));
            }

            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: data,
                    finalUrl: urlStr
                });
            });
        });

        req.on('error', (err) => {
            if (retries > 0) {
                const backoffDelay = (5 - retries) * 2000;
                setTimeout(() => {
                    resolve(fetchUrl(urlStr, options, retries - 1));
                }, backoffDelay);
            } else {
                reject(err);
            }
        });

        req.setTimeout(timeoutMs, () => {
            isTimedOut = true;
            req.destroy(new Error(`Timeout fetching ${urlStr} (${timeoutMs}ms)`));
        });

        req.end();
    });
}

/**
 * Strip HTML tags and decode entities
 */
function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&rsquo;/g, "'")
        .replace(/&lsquo;/g, "'")
        .replace(/&ldquo;/g, '"')
        .replace(/&rdquo;/g, '"')
        .replace(/&#8217;/g, "'")
        .replace(/&#8216;/g, "'")
        .replace(/&#8220;/g, '"')
        .replace(/&#8221;/g, '"')
        .replace(/&#8211;/g, '-')
        .replace(/&#8212;/g, '--')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Format bytes to human readable format
 */
function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Clean filename string for safe storage on disk
 */
function sanitizeFilename(name) {
    return (name || 'rom').replace(/[<>:"/\\|?*#]/g, '_').trim();
}

/**
 * Clean and format clean title from raw game name
 */
function cleanGameTitle(title) {
    let clean = (title || 'Nintendo_Switch_Game')
        .replace(/^Download\s+/i, '')
        .replace(/\s*(?:NSP|XCI|NSZ|Full Game|\+ Update|Update|DLC|v\d+[\.\d]*)\b/gi, '')
        .replace(/[^a-zA-Z0-9_\- ]/g, ' ')
        .trim()
        .replace(/\s+/g, '_');
    return clean || 'Nintendo_Switch_Game';
}

/**
 * Clean DLC display name, stripping generic prefixes or game titles
 */
function cleanDlcDisplayName(rawName, gameTitle = '') {
    if (!rawName) return '';
    let name = rawName.trim()
        .replace(/\.(nsp|xci|nsz|rar|zip|7z)$/i, '')
        .replace(/^Download\s+/i, '')
        .replace(/\.ns$/i, '')
        .replace(/_+/g, ' ')
        .trim();

    // Check if name is generic
    if (/^(dlc|pack|all dlc|dlc pack|expansion|bonus|extra)$/i.test(name)) {
        return '';
    }

    // Normalize game title & name to alphanumeric tokens to remove repetitive title prefix
    const getTokens = (str) => (str || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !/^(plus|and|the|of|a|an)$/.test(w));
    const titleTokens = getTokens(gameTitle);
    const nameTokens = getTokens(name);

    let matchCount = 0;
    for (let i = 0; i < Math.min(titleTokens.length, nameTokens.length); i++) {
        if (titleTokens[i] === nameTokens[i]) {
            matchCount++;
        } else {
            break;
        }
    }

    if (matchCount >= 2 && matchCount >= Math.min(3, titleTokens.length)) {
        const lastToken = nameTokens[matchCount - 1];
        const lastPos = name.toLowerCase().indexOf(lastToken);
        if (lastPos !== -1) {
            name = name.substring(lastPos + lastToken.length);
        }
    }

    name = name.replace(/^[\s\-_:–+]+/, '').trim();
    name = name.replace(/^DLC\s*[-–:]*\s*/i, '').replace(/\s*[-–:]*\s*DLC$/i, '').trim();

    return name;
}

/**
 * Generate proper file name for download/ROM item
 */
function generateRomFilename(gameTitle, item, extOverride = null) {
    const base = cleanGameTitle(gameTitle);
    const raw = (item.name || '').trim();
    const isGeneric = /^(all files|full game|base game|main game|download|rom|game file|update|dlc|game)$/i.test(raw);

    const ext = extOverride || (item.format ? `.${item.format.toLowerCase()}` : '.nsp');

    let typeSuffix = '';
    if (item.type === 'Update') {
        const ver = item.version && item.version !== 'Update' ? `_${item.version}` : '_Update';
        typeSuffix = ver;
    } else if (item.type === 'DLC') {
        const dlcName = cleanDlcDisplayName(raw, gameTitle);
        if (dlcName && dlcName.length > 1) {
            const cleanDlcPart = dlcName.replace(/[^a-zA-Z0-9_\- ]/g, ' ').trim().replace(/\s+/g, '_');
            typeSuffix = `_DLC_${cleanDlcPart || 'Pack'}`.replace(/_+/g, '_');
        } else {
            typeSuffix = '_DLC';
        }
    }

    return `${base}${typeSuffix}${ext}`;
}

/**
 * Parse ROM details (Type, Version, Format) from item title
 */
function parseRomItemDetails(title, formatHint = '') {
    const raw = (title || '').trim();
    let type = 'Base Game';
    let version = 'v1.0.0';
    let format = (formatHint || '').toUpperCase().trim();

    if (/\.xci/i.test(raw) || /\[XCI\]/i.test(raw) || format === 'XCI') {
        format = 'XCI';
    } else if (/\.nsz/i.test(raw) || /\[NSZ\]/i.test(raw) || format === 'NSZ') {
        format = 'NSZ';
    } else if (/\.7z/i.test(raw) || format === '7Z') {
        format = '7Z';
    } else if (/\.zip/i.test(raw) || format === 'ZIP') {
        format = 'ZIP';
    } else if (/\.rar/i.test(raw) || format === 'RAR') {
        format = 'RAR';
    } else if (!format) {
        format = 'NSP';
    }

    if (/update/i.test(raw) || /\[v?\d+\]/i.test(raw)) {
        type = 'Update';
        const vMatch = raw.match(/v?(\d+(?:\.\d+)*)/i) || raw.match(/\[v?(\d+)\]/i);
        if (vMatch && vMatch[1]) {
            version = vMatch[0].startsWith('v') || vMatch[0].startsWith('V') ? vMatch[0] : `v${vMatch[1]}`;
        } else {
            version = 'Update';
        }
    } else if (/dlc/i.test(raw) || /pack/i.test(raw) || /expansion/i.test(raw) || /unlocker/i.test(raw) || /challenge/i.test(raw) || /story/i.test(raw) || /costume/i.test(raw) || /weapon/i.test(raw) || /bonus/i.test(raw) || /adventure/i.test(raw) || /add\s+/i.test(raw) || /season\s*pass/i.test(raw)) {
        type = 'DLC';
        version = 'DLC';
    } else if (/base/i.test(raw) || /main/i.test(raw)) {
        type = 'Base Game';
        version = 'v1.0.0';
    }

    return { raw, type, version, format };
}

/**
 * Search NSWPedia or NSVault for games matching query
 */
async function searchGames(query, limit = 10, source = 'all') {
    const results = [];
    const seenUrls = new Set();

    // 1. Search NSWPedia
    if (source === 'all' || source === 'nswpedia') {
        try {
            const searchUrl = `https://nswpedia.com/?s=${encodeURIComponent(query)}`;
            const response = await fetchUrl(searchUrl);
            const html = response.body;

            const itemRegex = /<div class="archive-left subtitle">([\s\S]*?)<\/div>\s*<\/div>/gi;
            let match;

            while ((match = itemRegex.exec(html)) !== null && results.length < limit) {
                const block = match[1];
                const linkMatch = block.match(/href=['"](https:\/\/nswpedia\.com\/nintendo-switch-roms\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i);
                if (!linkMatch) continue;

                const url = linkMatch[1];
                if (seenUrls.has(url)) continue;
                seenUrls.add(url);

                const rawTitle = stripHtml(linkMatch[2]);
                const imgMatch = block.match(/<img[^>]+src=['"]([^'"]+)['"]/i);
                const cover = imgMatch ? imgMatch[1] : null;

                const badges = [];
                const badgeRegex = /<span class="badge[^"]*">([^<]+)<\/span>/gi;
                let bMatch;
                while ((bMatch = badgeRegex.exec(block)) !== null) {
                    badges.push(stripHtml(bMatch[1]));
                }

                results.push({
                    title: rawTitle,
                    url,
                    cover,
                    badges,
                    source: 'NSWPedia'
                });
            }
        } catch (err) {
            // Ignore search error
        }
    }

    // 2. Search NSVault
    if ((source === 'all' || source === 'nsvault') && results.length < limit) {
        try {
            const nsvaultSearchUrl = `https://nsvault.me/?s=${encodeURIComponent(query)}`;
            const response = await fetchUrl(nsvaultSearchUrl, { referer: 'https://nsvault.me/' });
            const html = response.body;

            // Pattern for NSVault search cards / article links
            const cardRegex = /<a\b[^>]*\bhref=['"](https:\/\/nsvault\.me\/roms\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
            let match;

            while ((match = cardRegex.exec(html)) !== null && results.length < limit) {
                const url = match[1];
                if (seenUrls.has(url)) continue;
                seenUrls.add(url);

                const block = match[2];
                const imgMatch = block.match(/<img[^>]+src=['"]([^'"]+)['"]/i);
                const titleMatch = block.match(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/i) || block.match(/class=['"][^'"]*title[^'"]*['"][^>]*>([\s\S]*?)<\//i);
                
                let rawTitle = titleMatch ? stripHtml(titleMatch[1]) : '';
                if (!rawTitle) {
                    const fallbackSlug = url.split('/').filter(Boolean).pop() || '';
                    rawTitle = fallbackSlug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                }

                const cover = imgMatch ? imgMatch[1] : null;

                results.push({
                    title: rawTitle,
                    url,
                    cover,
                    badges: ['Switch'],
                    source: 'NSVault'
                });
            }
        } catch (err) {
            // Ignore NSVault search error
        }
    }

    return results;
}

/**
 * Fetch latest ROMs from category page (NSWPedia or NSVault)
 */
async function getLatestGames(page = 1, limit = 12, source = 'all') {
    const results = [];
    const seenUrls = new Set();

    if (source === 'all' || source === 'nswpedia') {
        try {
            const catUrl = page > 1 
                ? `https://nswpedia.com/category/nintendo-switch-roms/page/${page}/`
                : `https://nswpedia.com/category/nintendo-switch-roms/`;

            const response = await fetchUrl(catUrl);
            const html = response.body;

            const itemRegex = /<div class="archive-left subtitle">([\s\S]*?)<\/div>\s*<\/div>/gi;
            let match;

            while ((match = itemRegex.exec(html)) !== null && results.length < limit) {
                const block = match[1];
                const linkMatch = block.match(/href=['"](https:\/\/nswpedia\.com\/nintendo-switch-roms\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i);
                if (!linkMatch) continue;

                const url = linkMatch[1];
                if (seenUrls.has(url)) continue;
                seenUrls.add(url);

                const rawTitle = stripHtml(linkMatch[2]);
                const imgMatch = block.match(/<img[^>]+src=['"]([^'"]+)['"]/i);
                const cover = imgMatch ? imgMatch[1] : null;

                const badges = [];
                const badgeRegex = /<span class="badge[^"]*">([^<]+)<\/span>/gi;
                let bMatch;
                while ((bMatch = badgeRegex.exec(block)) !== null) {
                    badges.push(stripHtml(bMatch[1]));
                }

                results.push({
                    title: rawTitle,
                    url,
                    cover,
                    badges,
                    source: 'NSWPedia'
                });
            }
        } catch (err) {
            // Ignore
        }
    }

    if ((source === 'all' || source === 'nsvault') && results.length < limit) {
        try {
            const nsvCatUrl = page > 1 
                ? `https://nsvault.me/nintendo-switch-roms/page/${page}/`
                : `https://nsvault.me/nintendo-switch-roms/`;

            const response = await fetchUrl(nsvCatUrl, { referer: 'https://nsvault.me/' });
            const html = response.body;

            const cardRegex = /<a\b[^>]*\bhref=['"](https:\/\/nsvault\.me\/roms\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
            let match;

            while ((match = cardRegex.exec(html)) !== null && results.length < limit) {
                const url = match[1];
                if (seenUrls.has(url)) continue;
                seenUrls.add(url);

                const block = match[2];
                const imgMatch = block.match(/<img[^>]+src=['"]([^'"]+)['"]/i);
                const titleMatch = block.match(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/i) || block.match(/class=['"][^'"]*title[^'"]*['"][^>]*>([\s\S]*?)<\//i);
                
                let rawTitle = titleMatch ? stripHtml(titleMatch[1]) : '';
                if (!rawTitle) {
                    const fallbackSlug = url.split('/').filter(Boolean).pop() || '';
                    rawTitle = fallbackSlug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                }

                const cover = imgMatch ? imgMatch[1] : null;

                results.push({
                    title: rawTitle,
                    url,
                    cover,
                    badges: ['Switch'],
                    source: 'NSVault'
                });
            }
        } catch (err) {
            // Ignore
        }
    }

    return results;
}

/**
 * Resolve direct download storage link from intermediate NSWPedia / NSVault / Dlsitex download URL
 */
async function resolveDirectDownloadLink(downloadListUrl, options = {}) {
    try {
        const res = await fetchUrl(downloadListUrl, options);
        const html = res.body;

        // 1. Direct storage servers and mirrors (including Dlsitex high speed storage, Vikingfile, 1Fichier, Mediafire, etc.)
        const directMatch = html.match(/href=['"](https?:\/\/(?:s\d+\.dlsitex\.online|vikingfile|1fichier|datanodes|multiup|rushupload|mediafire|mega|megaup|drive\.google)[^'"]+)['"]/i);

        // 2. Button with class btn-download or id download-link
        const btnMatch = html.match(/<a\b[^>]*\bclass=['"][^'"]*btn-download[^'"]*['"][^>]*\bhref=['"]([^'"]+)['"]/i) ||
                         html.match(/<a\b[^>]*\bhref=['"]([^'"]+)['"][^>]*\bclass=['"][^'"]*btn-download[^'"]*['"]/i);

        const match = btnMatch ||
                      html.match(/<a[^>]+id=['"]download-link['"][^>]+href=['"]([^'"]+)['"]/i) ||
                      html.match(/id=['"]download-link['"][^>]*\s+href=['"]([^'"]+)['"]/i) ||
                      html.match(/href=['"]([^'"]+)['"][^>]*id=['"]download-link['"]/i);

        if (directMatch && (!match || /nswpediax\.site/i.test(match[1]))) {
            return directMatch[1].replace(/&amp;/g, '&');
        }

        if (match) {
            const url = match[1].replace(/&amp;/g, '&');
            if (/nswpediax\.site/i.test(url) && directMatch) {
                return directMatch[1].replace(/&amp;/g, '&');
            }
            return url;
        }

        if (directMatch) {
            return directMatch[1].replace(/&amp;/g, '&');
        }

        return null;
    } catch (err) {
        return null;
    }
}

/**
 * Clean and format human-readable game title
 */
function sanitizeDisplayTitle(rawTitle) {
    if (!rawTitle) return '';
    let title = stripHtml(rawTitle);

    // Remove "Download " prefix
    title = title.replace(/^\s*Download\s+/i, '');

    // Remove site brand if present (NSWpedia or NSVault)
    title = title.replace(/\s*[-–|]\s*(?:NSWpedia(?:\.com)?|NSVault(?:\.me)?)\s*$/i, '');
    title = title.replace(/^(?:NSWpedia(?:\.com)?|NSVault(?:\.me)?)\s*[-–|:]*\s*/i, '');
    title = title.replace(/\s*Switch\s*[-–|]\s*(?:NSWpedia|NSVault(?:\.me)?)\s*$/i, '');

    // Remove ROM terms, formats, versions, updates, DLC suffixes
    title = title.replace(/\s*\(?(?:NSP|XCI|NSZ)(?:\/(?:NSP|XCI|NSZ))?\)?\s*(?:\+\s*Update|\+\s*DLC|Full Game|Update|DLC|v\d+[\.\d]*|\bROM\b|Base Game).*/gi, '');
    title = title.replace(/\s*\(?(?:NSP|XCI|NSZ)\)?\s*$/gi, '');
    title = title.replace(/\s*\+\s*(?:Update|DLC).*/gi, '');
    title = title.replace(/\s*v\d+[\.\d]*\s*$/gi, '');

    // Trim trailing punctuation like colons, hyphens, pluses, slashes, or whitespace
    title = title.replace(/[\s\-_:+/]+$/, '').trim();

    return title;
}

/**
 * Extract clean game title from HTML
 */
function extractGameTitle(html, fallbackSlug = '') {
    if (!html) return '';

    // 1. Check all <h1> tags in html, filtering out logo / site headers
    const h1Regex = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;
    let match;
    while ((match = h1Regex.exec(html)) !== null) {
        const text = stripHtml(match[1]).trim();
        if (text && !/(?:nswpedia|nsvault)/i.test(text)) {
            const cleaned = sanitizeDisplayTitle(text);
            if (cleaned && cleaned.length >= 2 && !/(?:nswpedia|nsvault)/i.test(cleaned)) {
                return cleaned;
            }
        }
    }

    // 2. Check <meta property="og:title">
    const ogTitleMatch = html.match(/<meta\s+property=['"]og:title['"]\s+content=['"]([^'"]+)['"]/i) ||
                         html.match(/<meta\s+content=['"]([^'"]+)['"]\s+property=['"]og:title['"]/i);
    if (ogTitleMatch) {
        const cleaned = sanitizeDisplayTitle(ogTitleMatch[1]);
        if (cleaned && cleaned.length >= 2 && !/(?:nswpedia|nsvault)/i.test(cleaned)) {
            return cleaned;
        }
    }

    // 3. Check <title> tag
    const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleTagMatch) {
        const cleaned = sanitizeDisplayTitle(titleTagMatch[1]);
        if (cleaned && cleaned.length >= 2 && !/(?:nswpedia|nsvault)/i.test(cleaned)) {
            return cleaned;
        }
    }

    // 4. Fallback: Parse from slug
    if (fallbackSlug) {
        let cleanSlug = fallbackSlug.replace(/-\d+$/, ''); // remove trailing numeric IDs
        cleanSlug = cleanSlug.replace(/(?:-switch-nsp-xci|-nsp-xci|-switch|-nsp|-xci)$/i, '');
        return cleanSlug.replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase()).trim();
    }

    return '';
}

/**
 * Scrape complete game page from NSWPedia or NSVault, including metadata and download mirrors
 */
async function scrapeGame(gameUrl, options = { resolveMirrors: true, concurrency: 5 }) {
    const isNsVault = /nsvault\.me/i.test(gameUrl) || /dlsitex\.online/i.test(gameUrl);
    const defaultReferer = isNsVault ? 'https://nsvault.me/' : 'https://nswpedia.com/';

    const res = await fetchUrl(gameUrl, { referer: defaultReferer });
    const initialHtml = res.body;

    let mainHtml = initialHtml;
    let dlHtml = initialHtml;
    let canonicalGameUrl = gameUrl;
    let downloadPageUrl = null;

    // Check if initial URL is a /download/ page or a main article page
    const isDownloadUrl = gameUrl.includes('/download/') || gameUrl.includes('download.php') || /dlsitex\.online/i.test(gameUrl);

    if (isDownloadUrl) {
        downloadPageUrl = gameUrl;
        dlHtml = initialHtml;

        const canonicalMatch = initialHtml.match(/<link\s+rel=['"]canonical['"]\s+href=['"](https?:\/\/(?:nswpedia\.com|nsvault\.me)\/[^'"]+)['"]/i) ||
                               initialHtml.match(/<a\b[^>]*\bclass=['"][^'"]*back-link[^'"]*['"][^>]*\bhref=['"]([^'"]+)['"]/i);
        if (canonicalMatch) {
            canonicalGameUrl = canonicalMatch[1];
            try {
                const mainRes = await fetchUrl(canonicalGameUrl, { referer: gameUrl });
                if (mainRes && mainRes.body) {
                    mainHtml = mainRes.body;
                }
            } catch (err) {
                // Keep initialHtml as fallback
            }
        }
    } else {
        // We are on the main game article page
        const dlBtnMatch = mainHtml.match(/<a[^>]+href=['"](https?:\/\/(?:nswpedia\.com\/download\/[^'"]+|dlsitex\.online\/download\.php\?[^'"]+|nsvault\.me\/download\/[^'"]+))['"][^>]*>/i);
        if (dlBtnMatch) {
            downloadPageUrl = dlBtnMatch[1];
            try {
                const dlRes = await fetchUrl(downloadPageUrl, { referer: gameUrl });
                if (dlRes && dlRes.body) {
                    dlHtml = dlRes.body;
                }
            } catch (err) {
                // Keep initialHtml as fallback
            }
        }
    }

    // 1. Extract Clean Title
    const fallbackSlug = gameUrl.split('/').filter(Boolean).pop() || '';
    const title = extractGameTitle(mainHtml, fallbackSlug) || extractGameTitle(dlHtml, fallbackSlug) || 'Nintendo Switch Game';

    // 2. Info Block Metadata (Title ID, Firmware, Release Date, Publisher)
    let titleId = null;
    const tidMatch = mainHtml.match(/Title ID<\/span>\s*<span[^>]*>([0-9A-Fa-f]{16})<\/span>/i) ||
                     mainHtml.match(/Title ID[^<]*<\/span>[\s\S]*?<span[^>]*>([0-9A-Fa-f]{16})<\/span>/i) ||
                     mainHtml.match(/Title ID\s*<\/span>\s*<span[^>]*font-mono[^>]*>([0-9A-Fa-f]{16})<\/span>/i);
    if (tidMatch) titleId = tidMatch[1].trim();

    let releaseDate = null;
    const rdMatch = mainHtml.match(/Release Date<\/span>\s*<span[^>]*>([^<]+)<\/span>/i) ||
                    mainHtml.match(/Release Date[^<]*<\/span>[\s\S]*?<span[^>]*>([^<]+)<\/span>/i);
    if (rdMatch) releaseDate = stripHtml(rdMatch[1]);

    let requiredFirmware = null;
    const fwMatch = mainHtml.match(/Required Firmware<\/span>\s*<span[^>]*>([^<]+)<\/span>/i) ||
                    mainHtml.match(/Required Firmware[^<]*<\/span>[\s\S]*?<span[^>]*>([^<]+)<\/span>/i);
    if (fwMatch) requiredFirmware = stripHtml(fwMatch[1]);

    let publisher = null;
    const pubMatch = mainHtml.match(/Published by<\/span>\s*<span[^>]*>([\s\S]*?)<\/span>/i) ||
                     mainHtml.match(/Published by[^<]*<\/span>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i);
    if (pubMatch) publisher = stripHtml(pubMatch[1]);

    // 3. Cover Boxart & Banner
    let cover = null;
    let banner = null;

    // Check og:image first as both NSWPedia and NSVault provide the exact official game cover in og:image
    const ogMatch = mainHtml.match(/<meta\s+property=['"]og:image['"]\s+content=['"]([^'"]+)['"]/i) ||
                    mainHtml.match(/<meta\s+content=['"]([^'"]+)['"]\s+property=['"]og:image['"]/i) ||
                    dlHtml.match(/<meta\s+property=['"]og:image['"]\s+content=['"]([^'"]+)['"]/i);
    if (ogMatch && !/logo|default|placeholder/i.test(ogMatch[1])) {
        cover = ogMatch[1];
    }

    // Check specific cover art image tag (NSVault main cover art)
    if (!cover) {
        const coverArtMatch = mainHtml.match(/<img\b[^>]*\balt=['"][^'"]*cover art[^'"]*['"][^>]*\bsrc=['"]([^'"]+)['"]/i) ||
                              mainHtml.match(/<img\b[^>]*\bsrc=['"]([^'"]+)['"][^>]*\balt=['"][^'"]*cover art[^'"]*['"]/i);
        if (coverArtMatch) {
            cover = coverArtMatch[1];
        }
    }

    // Check post thumbnail image (WordPress post-thumbnail / wp-post-image)
    if (!cover) {
        const postImgMatch = mainHtml.match(/<img\b[^>]*\bclass=['"][^'"]*(?:wp-post-image|attachment-post-thumbnail|post-thumb)[^'"]*['"][^>]*\bsrc=['"]([^'"]+)['"]/i) ||
                             mainHtml.match(/<img\b[^>]*\bsrc=['"]([^'"]+)['"][^>]*\bclass=['"][^'"]*(?:wp-post-image|attachment-post-thumbnail|post-thumb)[^'"]*['"]/i) ||
                             dlHtml.match(/<img\b[^>]*\bsrc=['"]([^'"]+)['"][^>]*\bclass=['"][^'"]*(?:wp-post-image|attachment-post-thumbnail|post-thumb)[^'"]*['"]/i);
        if (postImgMatch) {
            cover = postImgMatch[1];
            const fullImgTag = postImgMatch[0];
            const srcsetMatch = fullImgTag.match(/srcset=['"]([^'"]+)['"]/i);
            if (srcsetMatch) {
                const sources = srcsetMatch[1].split(',').map(s => s.trim().split(/\s+/));
                if (sources.length > 0) {
                    sources.sort((a, b) => (parseInt(b[1]) || 0) - (parseInt(a[1]) || 0));
                    if (sources[0] && sources[0][0]) {
                        cover = sources[0][0];
                    }
                }
            }
        }
    }

    // Check hero-bg banner in NSVault
    const bannerMatch = mainHtml.match(/class=['"]hero-bg['"][^>]*style=['"][^'"]*background-image:\s*url\(['"]?([^'"\)]+)['"]?\)/i) ||
                        mainHtml.match(/background-image:\s*url\(['"]?([^'"\)]+banner[^'"\)]*)['"]?\)/i);
    if (bannerMatch) {
        banner = bannerMatch[1];
    } else if (cover) {
        banner = cover;
    }

    if (!cover) {
        cover = banner;
    }

    // Clean thumbnail dimension suffix (-300x400.jpg / -300x489.png -> .ext) to get pristine full-size cover
    if (cover) {
        cover = cover.replace(/-\d+x\d+(\.[a-zA-Z0-9]+)$/, '$1');
    }
    if (banner) {
        banner = banner.replace(/-\d+x\d+(\.[a-zA-Z0-9]+)$/, '$1');
    }

    // 4. Screenshots (Extract all regardless of attribute order or tag type)
    const screenshots = [];

    // NSVault data-lightbox-src
    const lbSrcRegex = /data-lightbox-src=['"]([^'"]+)['"]/gi;
    let lbMatch;
    while ((lbMatch = lbSrcRegex.exec(mainHtml)) !== null) {
        const ssUrl = lbMatch[1];
        if (ssUrl && !screenshots.includes(ssUrl)) {
            screenshots.push(ssUrl);
        }
    }

    // Any <a> with class containing screen_shot
    const ssLinkRegex = /<a\b[^>]*\bclass=['"][^'"]*screen_shot[^'"]*['"][^>]*\bhref=['"]([^'"]+)['"]|<a\b[^>]*\bhref=['"]([^'"]+)['"][^>]*\bclass=['"][^'"]*screen_shot[^'"]*['"]/gi;
    let sMatch;
    while ((sMatch = ssLinkRegex.exec(mainHtml)) !== null) {
        const ssUrl = sMatch[1] || sMatch[2];
        if (ssUrl && !screenshots.includes(ssUrl)) {
            screenshots.push(ssUrl);
        }
    }

    // Any img tag with screenshot in src or alt
    const ssImgRegex = /<img\b[^>]+src=['"]([^'"]+screenshot[^'"]*)['"]/gi;
    while ((sMatch = ssImgRegex.exec(mainHtml)) !== null) {
        const ssUrl = sMatch[1];
        if (ssUrl && !screenshots.includes(ssUrl)) {
            screenshots.push(ssUrl);
        }
    }

    // 5. Game description
    let description = '';
    const descMatch = mainHtml.match(/<h3>Game description<\/h3>([\s\S]*?)(?:<div class="my-3"|<a [^>]*class="btn|<center>)/i) ||
                      mainHtml.match(/<h2[^>]*>(?:About The Game|Game Overview|Overview|Description)<\/h2>([\s\S]*?)(?:<h2|<section|<\/div>\s*<\/div>\s*<div class="bg-brand-card|$)/i);
    if (descMatch) {
        description = stripHtml(descMatch[1]);
    }

    // 6. Parse download tables & version cards (NSWPedia format & NSVault / Dlsitex format)
    const mirrorTables = [];

    // 6.1 Check NSVault / Dlsitex .version-card structure
    const vCardRegex = /<div class="version-card">([\s\S]*?)(?=(?:<div class="version-card">|<div class="help-block"|<\/div>\s*<\/div>\s*<div class="help-block"|$))/gi;
    let vMatch;
    const dlBaseUrl = downloadPageUrl || gameUrl;

    while ((vMatch = vCardRegex.exec(dlHtml)) !== null) {
        const cardBlock = vMatch[1];
        const hMatch = cardBlock.match(/<span class="version-name">([^<]+)<\/span>/i);
        const cardTitle = hMatch ? stripHtml(hMatch[1]).trim() : 'Base Game';

        const rowRegex = /<a[^>]+href=['"]([^'"]+)['"][^>]*class=['"]dl-row['"][\s\S]*?<span class="dl-name"[^>]*>([^<]+)<\/span>(?:[\s\S]*?<span class="dl-size">([^<]+)<\/span>)?/gi;
        let rMatch;
        const items = [];

        while ((rMatch = rowRegex.exec(cardBlock)) !== null) {
            let intermediateUrl = rMatch[1];
            if (intermediateUrl.startsWith('?')) {
                const parsedDl = new URL(dlBaseUrl);
                intermediateUrl = `${parsedDl.origin}${parsedDl.pathname}${intermediateUrl}`;
            }

            const serverName = stripHtml(rMatch[2]).trim();
            const rawSize = rMatch[3] ? stripHtml(rMatch[3]).trim() : '';
            const size = /\b(KB|MB|GB|TB|B)\b/i.test(rawSize) ? rawSize : cardTitle;

            const details = parseRomItemDetails(cardTitle, '');

            items.push({
                name: cardTitle,
                serverName,
                size,
                format: details.format,
                type: details.type,
                version: details.version,
                intermediateUrl,
                directUrl: null
            });
        }

        if (items.length > 0) {
            mirrorTables.push({
                serverName: cardTitle,
                items
            });
        }
    }

    // 6.2 Check NSWPedia table-download structure (if not already found via version-card)
    if (mirrorTables.length === 0) {
        const tableDivRegex = /<div[^>]*class=['"][^'"]*table-download[^'"]*['"][^>]*>([\s\S]*?)<\/div>/gi;
        let tMatch;
        let tableIndex = 0;

        while ((tMatch = tableDivRegex.exec(dlHtml)) !== null) {
            tableIndex++;
            const block = tMatch[1];

            // Find server heading
            const insideHMatch = block.match(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/i);
            let serverName = insideHMatch ? stripHtml(insideHMatch[1]) : '';

            if (!serverName) {
                const preHtml = dlHtml.substring(0, tMatch.index);
                const outsideHMatch = preHtml.match(/<h[234][^>]*>([\s\S]*?)<\/h[234]>(?:(?!<h[234])[\s\S])*$/i);
                serverName = outsideHMatch ? stripHtml(outsideHMatch[1]) : `Mirror Group ${tableIndex}`;
            }

            serverName = serverName.replace(/^Downloads List\s*[-–:]*\s*/i, '').trim() || `Mirror Group ${tableIndex}`;

            // Parse rows
            const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
            let rMatch;
            const items = [];

            while ((rMatch = rowRegex.exec(block)) !== null) {
                const rowContent = rMatch[1];
                if (/<th>/i.test(rowContent)) continue; // Header row

                const linkMatch = rowContent.match(/href=['"](https?:\/\/(?:nswpedia\.com|nsvault\.me|dlsitex\.online)\/download\/[^'"]+)['"]/i) ||
                                  rowContent.match(/href=['"](https?:\/\/[^'"]*\/download(?:\.php)?[^'"]+)['"]/i);
                if (!linkMatch) continue;

                const intermediateUrl = linkMatch[1];

                const cols = [];
                const colRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
                let cMatch;
                while ((cMatch = colRegex.exec(rowContent)) !== null) {
                    cols.push(stripHtml(cMatch[1]));
                }

                if (cols.length >= 2) {
                    const itemName = cols[0];
                    const col1 = cols[1] || '';
                    const col2 = cols[2] || '';

                    let size = col1;
                    let typeHint = col2;

                    // Smart detection: if col1 is a format extension and col2 is a byte size
                    if (/^(zip|nsp|xci|nsz|rar|7z)$/i.test(col1.trim()) || /\b(KB|MB|GB|TB|B)\b/i.test(col2)) {
                        size = col2;
                        typeHint = col1;
                    } else if (/\b(KB|MB|GB|TB|B)\b/i.test(col1)) {
                        size = col1;
                        typeHint = col2;
                    }

                    const details = parseRomItemDetails(itemName, typeHint);

                    items.push({
                        name: itemName,
                        size,
                        format: details.format,
                        type: details.type,
                        version: details.version,
                        intermediateUrl,
                        directUrl: null
                    });
                }
            }

            if (items.length > 0) {
                mirrorTables.push({
                    serverName,
                    items
                });
            }
        }
    }

    // 7. Resolve Direct Download Links
    if (options.resolveMirrors) {
        const allItems = [];
        for (const table of mirrorTables) {
            for (const item of table.items) {
                allItems.push(item);
            }
        }

        const batchSize = options.concurrency || 5;
        for (let i = 0; i < allItems.length; i += batchSize) {
            const batch = allItems.slice(i, i + batchSize);
            await Promise.all(batch.map(async (item) => {
                if (item.intermediateUrl) {
                    item.directUrl = await resolveDirectDownloadLink(item.intermediateUrl, { referer: downloadPageUrl || gameUrl });
                }
            }));
        }
    }

    const flatDownloads = [];
    for (const table of mirrorTables) {
        for (const item of table.items) {
            flatDownloads.push({
                server: item.serverName || table.serverName,
                name: item.name,
                type: item.type,
                version: item.version,
                size: item.size,
                format: item.format,
                intermediateUrl: item.intermediateUrl,
                directUrl: item.directUrl
            });
        }
    }

    return {
        title,
        titleId,
        releaseDate,
        requiredFirmware,
        publisher,
        gameUrl: canonicalGameUrl,
        downloadPageUrl,
        cover,
        cover_image: cover,
        coverImage: cover,
        banner,
        banner_image: banner,
        screenshots,
        description,
        mirrors: mirrorTables,
        downloads: flatDownloads
    };
}

/**
 * Download a file from URL with resume support, auto redirects, and progress callback
 */
function downloadFile(urlStr, destPath, options = {}) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(urlStr);
        const protocol = parsedUrl.protocol === 'https:' ? https : http;

        let existingBytes = 0;
        if (fs.existsSync(destPath)) {
            existingBytes = fs.statSync(destPath).size;
        }

        const headers = {
            'User-Agent': USER_AGENT,
            'Accept': '*/*',
            'Referer': options.referer || 'https://nswpedia.com/'
        };

        if (existingBytes > 0 && options.resume !== false) {
            headers['Range'] = `bytes=${existingBytes}-`;
        }

        const reqOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers,
            rejectUnauthorized: false
        };

        const startTime = Date.now();
        let lastSpeedCheck = startTime;
        let bytesSinceLastCheck = 0;
        let currentSpeed = 0;

        const req = protocol.request(reqOptions, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const nextUrl = new URL(res.headers.location, urlStr).href;
                return resolve(downloadFile(nextUrl, destPath, { ...options, referer: urlStr }));
            }

            if (res.statusCode === 416) {
                return resolve({
                    destPath,
                    totalBytes: existingBytes,
                    alreadyDownloaded: true
                });
            }

            if (res.statusCode !== 200 && res.statusCode !== 206) {
                return reject(new Error(`Download failed with HTTP ${res.statusCode}: ${res.statusMessage}`));
            }

            let finalFilename = null;
            const disp = res.headers['content-disposition'];
            if (disp) {
                const fnMatch = disp.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
                if (fnMatch) {
                    finalFilename = decodeURIComponent(fnMatch[1].replace(/['"]/g, '').trim());
                }
            }

            const contentLength = parseInt(res.headers['content-length'] || '0', 10);
            const totalBytes = res.statusCode === 206 ? (existingBytes + contentLength) : contentLength;

            const fileStream = fs.createWriteStream(destPath, {
                flags: res.statusCode === 206 ? 'a' : 'w'
            });

            let downloadedBytes = res.statusCode === 206 ? existingBytes : 0;

            res.on('data', chunk => {
                downloadedBytes += chunk.length;
                bytesSinceLastCheck += chunk.length;
                fileStream.write(chunk);

                const now = Date.now();
                if (now - lastSpeedCheck >= 500) {
                    currentSpeed = bytesSinceLastCheck / ((now - lastSpeedCheck) / 1000);
                    lastSpeedCheck = now;
                    bytesSinceLastCheck = 0;
                }

                if (options.onProgress) {
                    options.onProgress({
                        downloadedBytes,
                        totalBytes,
                        speedBytesPerSec: currentSpeed,
                        percentage: totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0
                    });
                }
            });

            res.on('end', () => {
                fileStream.end();
                resolve({
                    destPath,
                    finalFilename,
                    totalBytes: downloadedBytes
                });
            });

            res.on('error', err => {
                fileStream.end();
                reject(err);
            });
        });

        req.on('error', reject);
        req.end();
    });
}

// Module Exports
module.exports = {
    fetchUrl,
    searchGames,
    getLatestGames,
    scrapeGame,
    downloadFile,
    resolveDirectDownloadLink,
    parseRomItemDetails,
    cleanGameTitle,
    cleanDlcDisplayName,
    generateRomFilename,
    formatBytes,
    sanitizeFilename
};

// ==========================================
// CLI Execution
// ==========================================
if (require.main === module) {
    (async () => {
        const args = process.argv.slice(2);

        if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
            console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║               NSWPedia ROM Scraper & File Downloader                 ║
╚══════════════════════════════════════════════════════════════════════╝

Usage:
  node scripts/nswpedia_scraper.cjs <URL or Game Name> [options]

Commands & Options:
  # 1. Scrape and extract direct download links:
  node scripts/nswpedia_scraper.cjs "https://nswpedia.com/nintendo-switch-roms/action/pokemon-lets-go-pikachu-nsp-34"

  # 2. Scrape AND Download files to disk:
  node scripts/nswpedia_scraper.cjs "Pokemon Let's Go Pikachu" --download all
  node scripts/nswpedia_scraper.cjs "Pokemon Let's Go Pikachu" --download update
  node scripts/nswpedia_scraper.cjs "Pokemon Let's Go Pikachu" --download base
  node scripts/nswpedia_scraper.cjs "Pokemon Let's Go Pikachu" --download dlc

  # 3. Specify custom destination folder:
  node scripts/nswpedia_scraper.cjs "Zelda Tears of the Kingdom" --download update --dest ./roms/

  # 4. Search games:
  node scripts/nswpedia_scraper.cjs --search "Mario Kart"

  # 5. List latest ROMs:
  node scripts/nswpedia_scraper.cjs --latest --limit 5

  # 6. JSON output or export:
  node scripts/nswpedia_scraper.cjs "Super Mario Odyssey" --json
  node scripts/nswpedia_scraper.cjs "Mario Kart 8" --output mk8.json

Download Filters:
  --download [all|base|update|dlc]   Download matching files
  --dest <directory>                Destination folder (default: ./downloads)
  --output <file>                   Save scraped data into a JSON file
  --no-resolve                      Do not resolve direct links
  -h, --help                        Show this help
`);
            process.exit(0);
        }

        const isJson = args.includes('--json');
        const noResolve = args.includes('--no-resolve');
        const outputIdx = args.indexOf('--output');
        const outputFile = outputIdx !== -1 ? args[outputIdx + 1] : null;

        const limitIdx = args.indexOf('--limit');
        const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 10;

        const downloadIdx = args.indexOf('--download');
        const isDownloading = downloadIdx !== -1;
        const downloadFilter = isDownloading ? (args[downloadIdx + 1] && !args[downloadIdx + 1].startsWith('-') ? args[downloadIdx + 1].toLowerCase() : 'all') : null;

        const destIdx = args.indexOf('--dest');
        const destDir = destIdx !== -1 ? args[destIdx + 1] : path.join(process.cwd(), 'downloads');

        try {
            if (args.includes('--latest')) {
                if (!isJson) console.log(`🔍 Fetching latest ROMs from NSWPedia...`);
                const latest = await getLatestGames(1, limit);
                if (isJson) {
                    console.log(JSON.stringify(latest, null, 2));
                } else {
                    console.log(`\nFound ${latest.length} ROMs:`);
                    latest.forEach((g, i) => {
                        console.log(`\n[${i + 1}] ${g.title}`);
                        console.log(`    URL: ${g.url}`);
                        if (g.badges.length) console.log(`    Tags: ${g.badges.join(', ')}`);
                    });
                }
                process.exit(0);
            }

            const searchIdx = args.indexOf('--search');
            if (searchIdx !== -1) {
                const query = args[searchIdx + 1];
                if (!query) {
                    console.error('Error: Please provide a search query.');
                    process.exit(1);
                }
                if (!isJson) console.log(`🔍 Searching NSWPedia for: "${query}"...`);
                const searchResults = await searchGames(query, limit);

                if (isJson) {
                    console.log(JSON.stringify(searchResults, null, 2));
                } else {
                    console.log(`\nFound ${searchResults.length} results:`);
                    searchResults.forEach((g, i) => {
                        console.log(`\n[${i + 1}] ${g.title}`);
                        console.log(`    URL: ${g.url}`);
                        if (g.badges.length) console.log(`    Tags: ${g.badges.join(', ')}`);
                    });

                    if (searchResults.length > 0) {
                        console.log(`\n💡 To scrape or download:`);
                        console.log(`node scripts/nswpedia_scraper.cjs "${searchResults[0].url}" --download all`);
                    }
                }
                process.exit(0);
            }

            // Target URL or query
            let targetUrl = args.find(a => a.startsWith('http://') || a.startsWith('https://'));

            if (!targetUrl) {
                const query = args.filter(a => !a.startsWith('-') && a !== downloadFilter && a !== outputFile && a !== destDir).join(' ');
                if (!isJson) console.log(`🔍 Searching NSWPedia for: "${query}"...`);
                const results = await searchGames(query, 1);
                if (results.length === 0) {
                    console.error(`No game found matching "${query}".`);
                    process.exit(1);
                }
                targetUrl = results[0].url;
                if (!isJson) console.log(`👉 Selected: ${results[0].title} (${targetUrl})\n`);
            }

            if (!isJson) console.log(`🚀 Scraping game from: ${targetUrl}`);
            const gameData = await scrapeGame(targetUrl, { resolveMirrors: true, concurrency: 4 });

            if (isJson && !isDownloading) {
                console.log(JSON.stringify(gameData, null, 2));
            } else {
                console.log(`\n===============================================================`);
                console.log(`🎮 Game: ${gameData.title}`);
                console.log(`🔗 Page: ${gameData.gameUrl}`);
                console.log(`📥 Download Page: ${gameData.downloadPageUrl || 'N/A'}`);
                if (gameData.cover) console.log(`🖼️  Cover: ${gameData.cover}`);
                console.log(`===============================================================\n`);

                gameData.mirrors.forEach((m, mIdx) => {
                    console.log(`\n📦 [Mirror Group ${mIdx + 1}] ${m.serverName}`);
                    console.log(`---------------------------------------------------------------`);
                    m.items.forEach(item => {
                        console.log(`  🔹 ${item.name}`);
                        console.log(`     Type: ${item.type} | Version: ${item.version} | Size: ${item.size} | Format: ${item.format}`);
                        if (item.directUrl) {
                            console.log(`     ⚡ DIRECT LINK: \x1b[32m${item.directUrl}\x1b[0m`);
                        } else {
                            console.log(`     🔗 Intermediary: ${item.intermediateUrl}`);
                        }
                    });
                });
                console.log(`\n===============================================================\n`);
            }

            if (outputFile) {
                fs.writeFileSync(outputFile, JSON.stringify(gameData, null, 2), 'utf-8');
                if (!isJson) console.log(`💾 Saved output to: ${outputFile}\n`);
            }

            // ==========================================
            // Perform File Downloads if requested
            // ==========================================
            if (isDownloading) {
                if (!fs.existsSync(destDir)) {
                    fs.mkdirSync(destDir, { recursive: true });
                }

                let candidateDownloads = gameData.downloads.filter(d => d.directUrl && (d.directUrl.includes('vikingfile.com') || d.directUrl.includes('storage') || d.directUrl.includes('http')));

                if (downloadFilter === 'base') {
                    candidateDownloads = candidateDownloads.filter(d => d.type === 'Base Game');
                } else if (downloadFilter === 'update') {
                    candidateDownloads = candidateDownloads.filter(d => d.type === 'Update');
                } else if (downloadFilter === 'dlc') {
                    candidateDownloads = candidateDownloads.filter(d => d.type === 'DLC');
                }

                const uniqueDownloads = [];
                const seenKeys = new Set();

                candidateDownloads.sort((a, b) => {
                    if (a.directUrl.includes('vikingfile.com')) return -1;
                    if (b.directUrl.includes('vikingfile.com')) return 1;
                    return 0;
                });

                for (const item of candidateDownloads) {
                    const key = `${item.type}_${item.version}_${item.name.toLowerCase()}`;
                    if (!seenKeys.has(key)) {
                        seenKeys.add(key);
                        uniqueDownloads.push(item);
                    }
                }

                if (uniqueDownloads.length === 0) {
                    console.log(`⚠️ No downloadable direct links found for filter: "${downloadFilter}".`);
                    process.exit(0);
                }

                console.log(`\n⬇️  Starting download of ${uniqueDownloads.length} file(s) into: ${destDir}\n`);

                for (let i = 0; i < uniqueDownloads.length; i++) {
                    const item = uniqueDownloads[i];
                    
                    let fileExt = item.format ? `.${item.format.toLowerCase()}` : '.nsp';
                    let safeName = sanitizeFilename(item.name);
                    if (!safeName.endsWith(fileExt)) {
                        safeName += fileExt;
                    }

                    const targetFile = path.join(destDir, safeName);

                    console.log(`\n[${i + 1}/${uniqueDownloads.length}] 📥 Downloading: ${item.name} (${item.size})`);
                    console.log(`    Save As: ${targetFile}`);
                    console.log(`    Source:  ${item.directUrl}`);

                    let lastRender = 0;
                    try {
                        const result = await downloadFile(item.directUrl, targetFile, {
                            onProgress: (prog) => {
                                const now = Date.now();
                                if (now - lastRender >= 250 || prog.percentage === 100) {
                                    lastRender = now;
                                    const pct = prog.percentage.toFixed(1);
                                    const downStr = formatBytes(prog.downloadedBytes);
                                    const totalStr = formatBytes(prog.totalBytes);
                                    const speedStr = formatBytes(prog.speedBytesPerSec) + '/s';

                                    const barWidth = 25;
                                    const filled = Math.round((barWidth * prog.percentage) / 100);
                                    const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

                                    process.stdout.write(`\r    [${bar}] ${pct}% | ${downStr}/${totalStr} | ⚡ ${speedStr}   `);
                                }
                            }
                        });

                        console.log(`\n    ✅ Download Complete: ${safeName} (${formatBytes(result.totalBytes)})\n`);
                    } catch (dlErr) {
                        console.error(`\n    ❌ Download failed for ${item.name}: ${dlErr.message}`);
                    }
                }

                console.log(`\n🎉 All requested downloads completed!\n`);
            }

        } catch (err) {
            console.error('❌ Error during execution:', err.message);
            process.exit(1);
        }
    })();
}
