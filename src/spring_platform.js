'use strict';

const log = require('electron-log');
const path = require('path');
const fs = require('fs');
const { existsSync, mkdirSync } = fs;
const assert = require('assert');

const platformName = process.platform;

const { config } = require('./launcher_config');
const { resolveWritePath } = require('./write_path');

var FILES_DIR = 'files';
FILES_DIR = path.resolve(`${__dirname}/../files`);
if (!existsSync(FILES_DIR)) {
	FILES_DIR = path.resolve(`${process.resourcesPath}/../files`);
}

// The following order is necessary:
// 1. Set write dir
// 2. Set logfile based on the writedir
// 3. Start logging

assert(config.title != undefined);
const writePath = resolveWritePath(config.title);

assert(writePath != undefined);
if (!existsSync(writePath)) {
	try {
		mkdirSync(writePath, { recursive: true });
	} catch (err) {
		log.error(`Cannot create writePath at: ${writePath}`);
		log.error(err);
	}
}

// This is a workaround for bug in electron-updater that changed
// installation path on windows on update. The bug was fixed, but
// we put this workaround here to fix installations that were
// already affected by the bug.
// TODO: Delete this code after some a while.
try {
	if (process.platform == 'win32' &&
		fs.existsSync(path.join(writePath, '../../data/springsettings.cfg')) &&
		!fs.existsSync(path.join(writePath, 'springsettings.cfg'))) {
		fs.rmdirSync(writePath);
		fs.renameSync(path.join(writePath, '../../data'), writePath);
	}
} catch (err) {
	log.error('Failed to move old installation to new location, ignoring. Error: ', err);
}

if (existsSync(FILES_DIR) && existsSync(writePath)) {
	fs.readdirSync(FILES_DIR).forEach(function (file) {
		const srcPath = path.join(FILES_DIR, file);
		const dstPath = path.join(writePath, file);
		// NB: we copy files each time, which is possibly slow
		// if (!existsSync(dstPath)) {
		try {
			fs.copyFileSync(srcPath, dstPath);
		} catch (err) {
			log.error(`Failed to copy file from ${srcPath} tp ${dstPath}`);
			log.error(err);
		}
		//}
	});
}

let prDownloaderBin;
if (platformName === 'win32') {
	prDownloaderBin = 'pr-downloader.exe';
	exports.springBin = 'spring.exe';
} else if (platformName === 'linux') {
	prDownloaderBin = 'pr-downloader';
	exports.springBin = 'spring';
} else if (platformName === 'darwin') {
	// Bundle the patched pr-downloader, same as win/linux. The macOS binary is
	// self-contained (links only system libs) and is our HTTP/1.1 fork, so the
	// game-download path is uniform across platforms and available at load (no
	// engine-download dependency). The engine itself is still fetched from the
	// ExaDev/RecoilEngine releases by github_engine_downloader.js.
	prDownloaderBin = 'pr-downloader';
	exports.springBin = 'spring';
} else {
	log.error(`Unsupported platform: ${platformName}`);
	process.exit(-1);
}

if (prDownloaderBin !== null) {
	exports.prDownloaderPath = path.resolve(`${__dirname}/../bin/${prDownloaderBin}`);
	if (!existsSync(exports.prDownloaderPath)) {
		exports.prDownloaderPath = path.resolve(`${process.resourcesPath}/../bin/${prDownloaderBin}`);
	}
} else {
	exports.prDownloaderPath = null;
}

exports.writePath = writePath;
