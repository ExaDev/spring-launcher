'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const got = require('got');

const { log } = require('./spring_log');
const springPlatform = require('./spring_platform');
const httpDownloader = require('./http_downloader');
const { config } = require('./launcher_config');

// Fetches the macOS arm64 Recoil engine from the ExaDev/RecoilEngine GitHub
// releases. pr-downloader cannot fetch this build (it is not on the BAR rapid
// CDN), so on darwin the engine download step is routed here instead.
//
// Flow:
//   1. Inspect config.downloads.engines[0] to determine whether a specific
//      engine version is requested (e.g. "2026.06.08") or the legacy latest-
//      sentinel is in use (any value that starts with "engine-macos-arm64-").
//   2. For a specific version, query the releases API and find the release
//      whose tag matches engine-macos-arm64-<version>-* (tag contains the
//      version string).  Fall back to the latest matching release with a
//      warning if no version-specific release is found.
//      For the legacy sentinel, always resolve the latest release.
//   3. Find the .tar.gz asset on that release.
//   4. Hand the asset URL to the existing httpDownloader, which downloads and
//      extracts it into <writePath>/engine/<version>/ (version-specific) or
//      <writePath>/engine/<sentinel>/ (legacy).
//   5. After extraction, normalise the layout so the binary sits at the
//      version dir root, merge game/ content, write a .engine-tag sidecar
//      (the resolved GitHub tag) so future runs can detect a new build for
//      the same version slot, and set config.launch.engine_path.
//
// Installing each version into its own subdirectory lets multiple engine
// versions coexist on disk without collision.
//
// The httpDownloader is a singleton whose events are relayed by
// spring_downloader; this module only resolves the asset and configures the
// download, so the wizard's existing event wiring continues to work unchanged.

const RELEASES_API = 'https://api.github.com/repos/ExaDev/RecoilEngine/releases';
const TAG_PREFIX = 'engine-macos-arm64-';
const ENGINE_SUBDIR = 'engine';

// Fetch all releases (newest-first) from the GitHub API. Shared by both
// resolve functions to avoid a second network round trip.
// Returns the raw array; throws on a non-array response.
async function fetchReleases() {
	const releases = await got(RELEASES_API, {
		headers: { 'User-Agent': 'spring-launcher', 'Accept': 'application/vnd.github+json' },
		timeout: { request: 15000 },
	}).json();
	if (!Array.isArray(releases)) {
		throw new Error('Unexpected GitHub releases API response (not an array)');
	}
	return releases;
}

// The GPU engine ships in two variants per release: the default KosmicKrisp
// build (renders via Metal 4, macOS 26+) and a "-moltenvk" build (renders via
// MoltenVK, pre-26). macOS 26 is Darwin 25, so Darwin < 25 must take MoltenVK.
function prefersMoltenVK() {
	if (process.platform !== 'darwin') return false;
	const major = parseInt(os.release(), 10);
	return Number.isFinite(major) && major < 25;
}

function isMoltenVKAsset(asset) {
	return asset.name.endsWith('-moltenvk.tar.gz') || asset.name.endsWith('-moltenvk.tgz');
}

// Pick the engine tarball asset matching this OS's GPU variant, falling back to
// the other variant if the preferred one is absent (a release may carry only
// one). Returns the asset object, or null if the release has no tarball.
function findTarAsset(release) {
	const assets = (Array.isArray(release.assets) ? release.assets : []).filter(
		a =>
			a != null &&
			typeof a.name === 'string' &&
			typeof a.browser_download_url === 'string' &&
			(a.name.endsWith('.tar.gz') || a.name.endsWith('.tgz'))
	);
	if (assets.length === 0) {
		return null;
	}
	const wantMoltenVK = prefersMoltenVK();
	const preferred = assets.find(a => isMoltenVKAsset(a) === wantMoltenVK);
	const chosen = preferred || assets[0];
	if (preferred == null) {
		log.warn(`No ${wantMoltenVK ? 'MoltenVK (pre-26)' : 'KosmicKrisp (26+)'} engine asset on ${release.tag_name}; falling back to ${chosen.name}`);
	} else {
		log.info(`Selected ${wantMoltenVK ? 'MoltenVK (pre-26)' : 'KosmicKrisp (26+)'} engine asset: ${chosen.name}`);
	}
	return chosen;
}

// Return true if release is a published (non-draft, non-prerelease) engine
// release whose tag starts with the expected prefix.
function isPublishedEngineRelease(release) {
	return (
		release != null &&
		typeof release.tag_name === 'string' &&
		release.tag_name.startsWith(TAG_PREFIX) &&
		!release.draft &&
		!release.prerelease
	);
}

// Resolve the release for a specific version string (e.g. "2026.06.08").
// Looks for a published release whose tag_name contains the version as a
// substring (covers both "engine-macos-arm64-2026.06.08" exact tags and
// suffixed forms like "engine-macos-arm64-2026.06.08-g<sha>").
// Falls back to the latest published release with a warning if no version-
// specific release is found.
// Returns { tag, assetUrl }. Throws if no usable release exists at all.
async function resolveReleaseForVersion(version) {
	log.info(`Querying ${RELEASES_API} for engine version ${version}`);
	const releases = await fetchReleases();

	// First pass: look for a release whose tag contains the version string.
	for (const release of releases) {
		if (!isPublishedEngineRelease(release)) {
			continue;
		}
		if (!release.tag_name.includes(version)) {
			continue;
		}
		const asset = findTarAsset(release);
		if (asset != null) {
			log.info(`Resolved engine release ${release.tag_name} for version ${version}, asset ${asset.name}`);
			return { tag: release.tag_name, assetUrl: asset.browser_download_url, assetName: asset.name };
		}
		log.warn(`Release ${release.tag_name} matches version ${version} but has no .tar.gz asset, skipping`);
	}

	// No version-specific release found -- fall back to latest with a warning.
	log.warn(
		`No ${TAG_PREFIX}${version}* release found on ExaDev/RecoilEngine; ` +
		'falling back to latest engine release'
	);
	return resolveLatestRelease(releases);
}

// Resolve the latest engine-macos-arm64-* release and its .tar.gz asset.
// Accepts an optional pre-fetched releases array to avoid a second API call.
// Returns { tag, assetUrl }. Throws if no matching release or asset is found.
async function resolveLatestRelease(releases) {
	if (releases == null) {
		log.info(`Querying ${RELEASES_API} for latest ${TAG_PREFIX}* release`);
		releases = await fetchReleases();
	}

	// The API returns releases newest-first. Take the first that is a published
	// engine release and carries a .tar.gz asset.
	for (const release of releases) {
		if (!isPublishedEngineRelease(release)) {
			continue;
		}
		const asset = findTarAsset(release);
		if (asset != null) {
			log.info(`Resolved latest engine release ${release.tag_name}, asset ${asset.name}`);
			return { tag: release.tag_name, assetUrl: asset.browser_download_url, assetName: asset.name };
		}
		log.warn(`Release ${release.tag_name} has no .tar.gz asset, skipping`);
	}

	throw new Error(`No ${TAG_PREFIX}* release with a .tar.gz asset found on ExaDev/RecoilEngine`);
}

// Determine whether a downloads.engines entry is a legacy latest-sentinel
// (any value beginning with the tag prefix) or a specific version string
// (e.g. "2026.06.08"). The sentinel form was used before per-version installs;
// it is kept for backwards compatibility.
function isLegacySentinel(versionHint) {
	return versionHint.startsWith(TAG_PREFIX);
}

// Move every entry inside dir/<inner> up into dir, then remove the now-empty
// inner directory. Used to flatten a wrapping top-level directory or a bin/
// subdirectory so the engine binary ends up at the version-dir root.
function flattenInto(dir, inner) {
	const innerPath = path.join(dir, inner);
	for (const entry of fs.readdirSync(innerPath)) {
		const src = path.join(innerPath, entry);
		const dst = path.join(dir, entry);
		fs.renameSync(src, dst);
	}
	fs.rmdirSync(innerPath);
}

// Normalise the extracted engine tree so springBin sits at versionDir/spring.
// The ExaDev tarball layout is not guaranteed, so handle the two known shapes:
//   - a single wrapping top-level directory (recoil-<tag>/spring, lib/, share/)
//   - a bin/ subdirectory (bin/spring, lib/, share/) as bar-lobby's install
//     normaliser expects
// If spring is already at the root, do nothing.
function normaliseEngineLayout(versionDir) {
	const springBin = springPlatform.springBin; // 'spring' on darwin
	if (fs.existsSync(path.join(versionDir, springBin))) {
		return;
	}

	// Case: bin/spring -> flatten bin/ into the version dir.
	if (fs.existsSync(path.join(versionDir, 'bin', springBin))) {
		log.info(`Flattening bin/ into ${versionDir}`);
		flattenInto(versionDir, 'bin');
	}
	if (fs.existsSync(path.join(versionDir, springBin))) {
		fs.chmodSync(path.join(versionDir, springBin), 0o755);
		return;
	}

	// Case: single wrapping directory that contains spring (possibly under bin/).
	const entries = fs.readdirSync(versionDir);
	if (entries.length === 1) {
		const wrapped = path.join(versionDir, entries[0]);
		if (fs.statSync(wrapped).isDirectory()) {
			log.info(`Flattening wrapping directory ${entries[0]} into ${versionDir}`);
			flattenInto(versionDir, entries[0]);
			if (fs.existsSync(path.join(versionDir, 'bin', springBin))) {
				flattenInto(versionDir, 'bin');
			}
		}
	}

	if (fs.existsSync(path.join(versionDir, springBin))) {
		fs.chmodSync(path.join(versionDir, springBin), 0o755);
		return;
	}

	throw new Error(`Engine binary '${springBin}' not found in extracted tree at ${versionDir}`);
}

// Copy the base content the engine ships under game/ (fonts + base sdz) into the
// data dir, where spring looks for them. Without this spring exits with code 21
// (Failed to load FontFile 'fonts/FreeSansBold.otf'). Mirrors what bar-lobby's
// macOS installer does. Idempotent.
function mergeEngineGameContent(versionDir) {
	const gameDir = path.join(versionDir, 'game');
	if (!fs.existsSync(gameDir)) {
		return;
	}
	const writePath = springPlatform.writePath;
	for (const sub of ['fonts', 'games']) {
		const src = path.join(gameDir, sub);
		if (!fs.existsSync(src)) {
			continue;
		}
		const dst = path.join(writePath, sub);
		fs.mkdirSync(dst, { recursive: true });
		for (const entry of fs.readdirSync(src)) {
			fs.cpSync(path.join(src, entry), path.join(dst, entry), { recursive: true, force: true });
		}
		log.info(`Merged engine ${sub}/ into ${dst}`);
	}
}

class GitHubEngineDownloader {
	// versionHint is the value from config.downloads.engines[] -- either a
	// specific version string (e.g. "2026.06.08") or the legacy latest-sentinel
	// (e.g. "engine-macos-arm64-latest"). In both cases the real GitHub release
	// tag comes from the API; versionHint only controls which release to look
	// for and where to install it on disk.
	async downloadEngine(versionHint) {
		log.info(`Resolving macOS engine from GitHub (version: ${versionHint})`);

		let tag;
		let assetUrl;
		let assetName;
		try {
			if (isLegacySentinel(versionHint)) {
				({ tag, assetUrl, assetName } = await resolveLatestRelease());
			} else {
				({ tag, assetUrl, assetName } = await resolveReleaseForVersion(versionHint));
			}
		} catch (error) {
			log.error(`Failed to resolve macOS engine release: ${error}`);
			httpDownloader.emit('failed', versionHint, `Failed to resolve macOS engine release: ${error.message}`);
			return;
		}

		// Install into engine/<versionHint>/ so multiple versions can coexist.
		// For legacy sentinels the dir name is the sentinel itself (unchanged
		// behaviour). For specific versions the dir name is the version string
		// (e.g. engine/2026.06.08/), which also matches the fallback launch path
		// derived from config.downloads.engines[0] in the wizard.
		const destinationRel = path.join(ENGINE_SUBDIR, versionHint);
		const versionDir = path.join(springPlatform.writePath, destinationRel);
		log.info(`macOS engine ${tag} -> install dir ${versionDir}`);
		const springBinPath = path.join(versionDir, springPlatform.springBin);
		// Record the resolved ASSET NAME (not just the release tag) in the sidecar.
		// The asset name encodes both the release tag and the GPU variant
		// (e.g. ...-g<sha>.tar.gz for KosmicKrisp vs ...-g<sha>-moltenvk.tar.gz),
		// so it changes when a new build is published OR when the OS now prefers a
		// different variant (e.g. after a macOS 26 upgrade). Comparing it forces a
		// re-fetch of the correct variant on an OS change, not just on a new build.
		const tagFile = path.join(versionDir, '.engine-tag');
		const installedAsset = fs.existsSync(tagFile)
			? fs.readFileSync(tagFile, 'utf8').trim()
			: null;

		// Idempotency: skip only if the installed engine is the current binary AND
		// the sidecar matches the resolved asset (same release tag and variant).
		if (fs.existsSync(springBinPath) && installedAsset === assetName) {
			log.info(`macOS engine ${tag} already installed at ${versionDir}, skipping download`);
			config.launch.engine_path = springBinPath;
			mergeEngineGameContent(versionDir);
			httpDownloader.emit('finished', versionHint);
			return;
		}

		// Either an interrupted prior attempt (binary missing) or a new build has
		// been published for this version slot. Remove the stale tree so
		// http_downloader (which short-circuits when the destination exists) does a
		// clean fetch.
		if (fs.existsSync(versionDir)) {
			log.info(`Refreshing macOS engine at ${versionDir} (installed=${installedAsset || 'none'}, resolved=${assetName})`);
			fs.rmSync(versionDir, { recursive: true, force: true });
		}

		// Normalise layout and wire engine_path once the http download/extract
		// pipeline finishes. http_downloader uses the resource's destination as
		// the download item name, so listen for the matching finished event.
		const onFinished = (item) => {
			if (item !== destinationRel) {
				return;
			}
			httpDownloader.removeListener('finished', onFinished);
			try {
				normaliseEngineLayout(versionDir);
			} catch (error) {
				log.error(`Failed to normalise engine layout: ${error}`);
				httpDownloader.emit('failed', versionHint, `Failed to normalise engine layout: ${error.message}`);
				return;
			}
			config.launch.engine_path = springBinPath;
			mergeEngineGameContent(versionDir);
			try {
				fs.writeFileSync(tagFile, assetName, 'utf8');
			} catch (e) {
				log.warn(`Could not write engine tag sidecar: ${e}`);
			}
			log.info(`macOS engine ${tag} ready at ${springBinPath}`);
		};
		httpDownloader.on('finished', onFinished);

		// The http downloader emits its own started/progress/finished/failed
		// events which spring_downloader relays to the wizard. The resource
		// shape mirrors config.downloads.resources entries.
		httpDownloader.downloadResource({
			url: assetUrl,
			destination: destinationRel,
			extract: true,
		});
	}
}

module.exports = new GitHubEngineDownloader();
