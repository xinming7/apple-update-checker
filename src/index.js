// Apple System Update Checker - Cloudflare Worker
// Fetches latest Apple software update information from Apple's feed

const APPLE_UPDATE_FEED = 'https://mesu.apple.com/assets/com_apple_MobileAsset_SoftwareUpdate/com_apple_MobileAsset_SoftwareUpdate.xml';
const APPLE_OTA_FEED = 'https://mesu.apple.com/assets/com_apple_MobileAsset_SoftwareUpdate/com_apple_MobileAsset_SoftwareUpdate.xml';

// Platform configurations
const PLATFORMS = {
  ios: {
    name: 'iOS',
    assetType: 'com.apple.MobileAsset.SoftwareUpdate',
    url: 'https://mesu.apple.com/assets/com_apple_MobileAsset_SoftwareUpdate/com_apple_MobileAsset_SoftwareUpdate.xml'
  },
  macos: {
    name: 'macOS',
    assetType: 'com.apple.MobileAsset.SFRSoftwareUpdate',
    url: 'https://mesu.apple.com/assets/com_apple_MobileAsset_SFRSoftwareUpdate/com_apple_MobileAsset_SFRSoftwareUpdate.xml'
  },
  watchos: {
    name: 'watchOS',
    assetType: 'com.apple.MobileAsset.WatchSoftwareUpdate',
    url: 'https://mesu.apple.com/assets/com_apple_MobileAsset_WatchSoftwareUpdate/com_apple_MobileAsset_WatchSoftwareUpdate.xml'
  },
  tvos: {
    name: 'tvOS',
    assetType: 'com.apple.MobileAsset.TVSoftwareUpdate',
    url: 'https://mesu.apple.com/assets/com_apple_MobileAsset_TVSoftwareUpdate/com_apple_MobileAsset_TVSoftwareUpdate.xml'
  }
};

/**
 * Parse Apple update XML feed
 */
async function fetchAppleUpdates(platform) {
  const config = PLATFORMS[platform];
  if (!config) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  try {
    const response = await fetch(config.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`);
    }

    const xml = await response.text();
    return parseUpdateXML(xml, platform);
  } catch (error) {
    console.error(`Error fetching ${platform} updates:`, error);
    throw error;
  }
}

/**
 * Parse Apple update XML response
 */
function parseUpdateXML(xml, platform) {
  const updates = [];

  // Extract asset information using regex (simple parser for Cloudflare Workers)
  const assetBlocks = xml.match(/<dict>[\s\S]*?<\/dict>/g) || [];

  for (const block of assetBlocks) {
    const update = {};

    // Extract version
    const versionMatch = block.match(/<key>OSVersion<\/key>\s*<string>([^<]+)<\/string>/);
    if (versionMatch) update.version = versionMatch[1];

    // Extract build number
    const buildMatch = block.match(/<key>Build<\/key>\s*<string>([^<]+)<\/string>/);
    if (buildMatch) update.build = buildMatch[1];

    // Extract posting date
    const dateMatch = block.match(/<key>PostingDate<\/key>\s*<date>([^<]+)<\/date>/);
    if (dateMatch) update.postingDate = dateMatch[1];

    // Extract product version extra
    const extraMatch = block.match(/<key>ProductVersionExtra<\/key>\s*<string>([^<]+)<\/string>/);
    if (extraMatch) update.releaseType = extraMatch[1];

    // Extract supported devices
    const devicesMatch = block.match(/<key>SupportedDevices<\/key>\s*<array>([\s\S]*?)<\/array>/);
    if (devicesMatch) {
      const deviceMatches = devicesMatch[1].match(/<string>([^<]+)<\/string>/g);
      update.supportedDevices = deviceMatches ? deviceMatches.map(d => d.replace(/<\/?string>/g, '')) : [];
    }

    // Only add if we have version info
    if (update.version) {
      updates.push({
        platform: PLATFORMS[platform].name,
        version: update.version,
        build: update.build || 'N/A',
        releaseType: update.releaseType || 'Release',
        postingDate: update.postingDate || new Date().toISOString(),
        supportedDevices: update.supportedDevices || []
      });
    }
  }

  // Deduplicate by version
  const unique = [];
  const seen = new Set();
  for (const update of updates) {
    const key = `${update.version}-${update.build}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(update);
    }
  }

  return unique.slice(0, 5); // Return latest 5 versions
}

/**
 * Main request handler
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json'
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // API Routes
    if (path === '/' || path === '/api') {
      // Return API info
      return new Response(JSON.stringify({
        name: 'Apple Update Checker',
        version: '1.0.0',
        endpoints: {
          '/api/updates/{platform}': 'Get updates for specific platform (ios, macos, watchos, tvos)',
          '/api/updates/all': 'Get updates for all platforms'
        },
        documentation: 'https://github.com/your-username/apple-update-checker'
      }), { headers: corsHeaders });
    }

    if (path.startsWith('/api/updates/')) {
      const platform = path.split('/').pop();

      try {
        let updates;

        if (platform === 'all') {
          // Fetch all platforms in parallel
          const allUpdates = await Promise.allSettled(
            Object.keys(PLATFORMS).map(p => fetchAppleUpdates(p))
          );

          updates = allUpdates
            .filter(result => result.status === 'fulfilled')
            .flatMap(result => result.value);
        } else {
          updates = await fetchAppleUpdates(platform);
        }

        return new Response(JSON.stringify({
          success: true,
          timestamp: new Date().toISOString(),
          count: updates.length,
          updates
        }), { headers: corsHeaders });

      } catch (error) {
        return new Response(JSON.stringify({
          success: false,
          error: error.message
        }), {
          status: 400,
          headers: corsHeaders
        });
      }
    }

    // 404 for unknown routes
    return new Response(JSON.stringify({
      success: false,
      error: 'Not found'
    }), {
      status: 404,
      headers: corsHeaders
    });
  }
};
