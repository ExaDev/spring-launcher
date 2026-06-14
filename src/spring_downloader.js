'use strict';

const EventEmitter = require('events');

const { log } = require('./spring_log');
const prdDownloader = require('./prd_downloader');
const httpDownloader = require('./http_downloader');
const githubEngineDownloader = require('./github_engine_downloader');

class SpringDownloader extends EventEmitter {
	constructor() {
		super();

		this.currentDownloader = null;

		let downloaders = [prdDownloader, httpDownloader];
		for (const downloader of downloaders) {
			downloader.on('started', (downloadItem) => {
				this.emit('started', downloadItem);
			});

			downloader.on('progress', (downloadItem, current, total) => {
				this.emit('progress', downloadItem, current, total);
			});

			downloader.on('finished', (downloadItem) => {
				this.setDownloader(null);
				this.emit('finished', downloadItem);
			});

			downloader.on('failed', (downloadItem, msg) => {
				this.setDownloader(null);
				this.emit('failed', downloadItem, msg);
			});

			downloader.on('aborted', (downloadItem, msg) => {
				this.setDownloader(null);
				this.emit('aborted', downloadItem, msg);
			});
		}
	}

	setDownloader(downloader) {
		if (downloader != null && this.currentDownloader != null) {
			throw new Error('Sring downloader already downloading');
		}
		this.currentDownloader = downloader;
	}

	downloadEngine(engineName) {
		this.setDownloader(prdDownloader);
		prdDownloader.downloadEngine(engineName);
	}

	// macOS engine download path: fetches the Recoil engine from the
	// ExaDev/RecoilEngine GitHub releases instead of the rapid CDN, delegating
	// to the http downloader for the actual transfer and extraction.
	downloadEngineGitHub(versionHint) {
		this.setDownloader(httpDownloader);
		githubEngineDownloader.downloadEngine(versionHint);
	}

	downloadGames(gameNames) {
		this.setDownloader(prdDownloader);
		prdDownloader.downloadGames(gameNames);
	}

	downloadMap(mapName) {
		this.setDownloader(prdDownloader);
		prdDownloader.downloadMap(mapName);
	}

	downloadResource(resource) {
		this.setDownloader(httpDownloader);
		httpDownloader.downloadResource(resource);
	}

	stopDownload() {
		if (this.currentDownloader == null) {
			log.error('No current download. Nothing to stop');
			return;
		}
		this.currentDownloader.stopDownload();
	}
}

module.exports = new SpringDownloader();
