'use strict';

const path = require('path');
const fs = require('fs');
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
//   1. Query the releases API for the latest release whose tag matches
//      engine-macos-arm64-*.
//   2. Find the .tar.gz asset on that release.
//   3. Hand the asset URL to the existing httpDownloader, which downloads and
//      extracts it (via the new tar extractor) into <writePath>/engine/<tag>.
//   4. After extraction, normalise the layout so the binary sits at
//      <writePath>/engine/<tag>/spring with lib/ and share/ as siblings, then
//      set config.launch.engine_path to that binary so the wizard launches it
//      directly without re-deriving the path from a sentinel name.
//
// The httpDownloader is a singleton whose events are relayed by
// spring_downloader; this module only resolves the asset and configures the
// download, so the wizard's existing event wiring continues to work unchanged.

const RELEASES_API = 'https://api.github.com/repos/ExaDev/RecoilEngine/releases';
const TAG_PREFIX = 'engine-macos-arm64-';
const ENGINE_SUBDIR = 'engine';

// Resolve the latest engine-macos-arm64-* release and its .tar.gz asset.
// Returns { tag, assetUrl }. Throws if no matching release or asset is found.
async function resolveLatestRelease() {
	log.info(`Querying ${RELEASES_API} for latest ${TAG_PREFIX}* release`);
	const releases = await got(RELEASES_API, {
		headers: { 'User-Agent': 'spring-launcher', 'Accept': 'application/vnd.github+json' },
		timeout: { request: 15000 },
	}).json();

	if (!Array.isArray(releases)) {
		throw new Error('Unexpected GitHub releases API response (not an array)');
	}

	// The API returns releases newest-first. Take the first whose tag matches
	// and which carries a .tar.gz asset.
	for (const release of releases) {
		if (release == null || typeof release.tag_name !== 'string') {
			continue;
		}
		if (!release.tag_name.startsWith(TAG_PREFIX)) {
			continue;
		}
		if (release.draft || release.prerelease) {
			// Skip drafts and prereleases; only ship stable engine builds.
			continue;
		}
		const assets = Array.isArray(release.assets) ? release.assets : [];
		const asset = assets.find(a =>
			a != null &&
			typeof a.name === 'string' &&
			(a.name.endsWith('.tar.gz') || a.name.endsWith('.tgz')) &&
			typeof a.browser_download_url === 'string'
		);
		if (asset != null) {
			log.info(`Resolved engine release ${release.tag_name}, asset ${asset.name}`);
			return { tag: release.tag_name, assetUrl: asset.browser_download_url };
		}
		log.warn(`Release ${release.tag_name} has no .tar.gz asset, skipping`);
	}

	throw new Error(`No ${TAG_PREFIX}* release with a .tar.gz asset found on ExaDev/RecoilEngine`);
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
	// versionHint is the value from config.downloads.engines[] (e.g. the
	// sentinel "engine-macos-arm64-latest"). It is only a trigger; the real tag
	// comes from the releases API.
	async downloadEngine(versionHint) {
		log.info(`Resolving macOS engine from GitHub (hint: ${versionHint})`);

		let tag;
		let assetUrl;
		try {
			({ tag, assetUrl } = await resolveLatestRelease());
		} catch (error) {
			log.error(`Failed to resolve macOS engine release: ${error}`);
			httpDownloader.emit('failed', versionHint, `Failed to resolve macOS engine release: ${error.message}`);
			return;
		}

		// Install into the dir named by the sentinel from config.downloads.engines
		// (the versionHint), NOT the resolved tag: the launch step falls back to
		// engine/<config.downloads.engines[0]>/spring when config.launch.engine_path
		// is unset (e.g. cleared by a config reload), so the dir name must match
		// the sentinel for the launch to find the binary. assetUrl still points at
		// the real release; only the local dir name is stabilised.
		const destinationRel = path.join(ENGINE_SUBDIR, versionHint);
		const versionDir = path.join(springPlatform.writePath, destinationRel);
		log.info(`macOS engine ${tag} -> install dir ${versionDir}`);
		const springBinPath = path.join(versionDir, springPlatform.springBin);
		// The dir name is the stable sentinel, so record the real resolved tag in
		// a sidecar to detect engine updates (otherwise skip-if-exists would pin
		// users to whatever engine they first downloaded).
		const tagFile = path.join(versionDir, '.engine-tag');
		const installedTag = fs.existsSync(tagFile)
			? fs.readFileSync(tagFile, 'utf8').trim()
			: null;

		// Idempotency: skip only if the installed engine is the current binary AND
		// matches the latest resolved tag.
		if (fs.existsSync(springBinPath) && installedTag === tag) {
			log.info(`macOS engine ${tag} already installed, skipping download`);
			config.launch.engine_path = springBinPath;
			mergeEngineGameContent(versionDir);
			httpDownloader.emit('finished', versionHint);
			return;
		}

		// Either an interrupted prior attempt (binary missing) or an outdated
		// engine (installed tag != latest). Remove the stale tree so http_downloader
		// (which short-circuits when the destination exists) does a clean fetch.
		if (fs.existsSync(versionDir)) {
			log.info(`Refreshing macOS engine (installed=${installedTag || 'none'}, latest=${tag})`);
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
				fs.writeFileSync(tagFile, tag, 'utf8');
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
