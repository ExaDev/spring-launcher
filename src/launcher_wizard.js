'use strict';

const EventEmitter = require('events');
const { app } = require('electron');

const log = require('electron-log');
const argv = require('./launcher_args');

const { config } = require('./launcher_config');
const { gui } = require('./launcher_gui');
const updater = require('./updater');
const springDownloader = require('./spring_downloader');
const { launcher } = require('./engine_launcher');
const { handleConfigUpdate, handleConfigReload } = require('./launcher_config_update');
const fs = require('fs');
const got = require('got');

const { showUpdateDialog } = require('./update_dialog');

const path = require('path');
const springPlatform = require('./spring_platform');

let mainWindow;
app.on('ready', () => {
	if (!gui) {
		return;
	}
	mainWindow = gui.getMainWindow();
});

class Wizard extends EventEmitter {
	constructor() {
		super();
		this.isActive = false;
		this.generateSteps();
	}

	generateSteps() {
		const steps = [];
		// Promises in async steps must never reject, because they can be awaited
		// on much later, and when they reject before they are attached, node
		// throws an unhandled rejection error.
		const asyncSteps = [];

		if (!config.no_downloads) {
			let pushConfigFetchActionAtEnd = null;
			if (config.config_url != null) {

				const asyncConfigFetch = {
					promise: null,
					action: () => {
						return new Promise(resolve => {
							got(config.config_url, { timeout: { request: 5000 } }).json()
								.then(newRawConfig => {
									try {
										const [newConfig, reloadType] = handleConfigUpdate(newRawConfig);
										resolve({newConfig, reloadType, error: null});
									} catch (error) {
										resolve({newConfig: null, reloadType: null, error});
									}
								})
								.catch(error => resolve({newConfig: null, reloadType: null, error}));
						});
					}
				};
				asyncSteps.push(asyncConfigFetch);

				const configFetchAction = {
					name: 'config update',
					action: () => {
						log.info(`Checking for config update from: ${config.config_url}...`);
						asyncConfigFetch.promise.then(({newConfig, reloadType, error}) => {
							if (error) {
								if (error.code == 'ERR_CANCELED') {
									return;
								}
								log.error(`Failed to get config update. Error: ${error}, ignoring`);
							} else {
								handleConfigReload(newConfig, reloadType);
							}
							wizard.nextStep();
						});
					}
				};

				// During first run, we check config first because the one with the
				// launcher might be very old.
				if (!fs.existsSync(path.join(springPlatform.writePath, 'config.json'))) {
					steps.push(configFetchAction);
				} else {
					pushConfigFetchActionAtEnd = configFetchAction;
				}
			}

			config.downloads.resources.forEach((resource) => {
				steps.push({
					name: 'resource',
					item: resource,
					action: () => {
						this.isActive = true;
						springDownloader.downloadResource(resource);
					}
				});
			});

			config.downloads.engines.forEach((engine) => {
				steps.push({
					name: 'engine',
					item: engine,
					action: () => {
						this.isActive = true;
						if (process.platform === 'darwin') {
							// The macOS arm64 engine is not on the rapid CDN; fetch
							// it from the ExaDev/RecoilEngine GitHub releases. The
							// engine value here is a trigger/version hint.
							springDownloader.downloadEngineGitHub(engine);
						} else {
							springDownloader.downloadEngine(engine);
						}
					}
				});
			});

			if (config.downloads.games && config.downloads.games.length > 0) {
				steps.push({
					name: 'games',
					item: config.downloads.games.join(', '),
					action: () => {
						this.isActive = true;
						springDownloader.downloadGames(config.downloads.games);
					}
				});
			}

			config.downloads.maps.forEach((map) => {
				steps.push({
					name: 'map',
					item: map,
					action: () => {
						this.isActive = true;
						springDownloader.downloadMap(map);
					}
				});
			});

			Object.entries(config.json_files).forEach(([file, contents]) => {
				steps.push({
					name: 'write file',
					item: file,
					action: () => {
						const filePath = path.join(springPlatform.writePath, file);

						const reportError = (msg) => {
							log.error(msg);
							gui.send('error', msg);
							wizard.setEnabled(false);
						};

						if (contents === null) {
							fs.rm(filePath, { force: true }, (err) => {
								if (err) {
									reportError(`Failed to remove file ${file}: ${err}`);
								} else {
									wizard.nextStep();
								}
							});
						} else {
							const buffer = JSON.stringify(contents, null, 2);
							fs.writeFile(filePath, buffer, (err) => {
								if (err) {
									reportError(`Failed write ${file}: ${err}`);
								} else {
									wizard.nextStep();
								}
							});
						}
					}
				});
			});

			if (pushConfigFetchActionAtEnd) {
				steps.push(pushConfigFetchActionAtEnd);
			}

			// Queue asynchronous check for launcher update.
			const isDev = !require('electron').app.isPackaged;
			if (isDev) {
				log.info('Development version: no self-update required');
			} else if (argv.disableLauncherUpdate) {
				log.info('Launcher application update disabled on command line');
			} else if (process.platform === 'darwin') {
				// The macOS build is ad-hoc signed (identity: null), so
				// Squirrel.Mac self-update is non-functional and would only emit
				// confusing runtime errors. Skip the self-update step until the
				// app is notarised and a GitHub publish provider is configured.
				log.info('Launcher self-update skipped on macOS (ad-hoc signed build)');
			} else {
				const asyncLauncherUpdateCheck = {
					promise: null,
					action: () => {
						// So, electron-updater API is stupid: https://github.com/electron-userland/electron-builder/issues/7447
						// This code is leaking event listeners, but it's called only once so I don't care.
						return new Promise(resolve => {
							let resolved = false;
							const resolveOnce = (result) => {
								if (!resolved) {
									resolved = true;
									resolve(result);
								}
							};

							updater.on('update-available', (updateInfo) => resolveOnce({
								updateAvailable: true,
								error: null,
								updateInfo,
							}));
							updater.on('update-not-available', () => resolveOnce({updateAvailable: false, error: null}));
							updater.on('error', error => resolveOnce({updateAvailable: null, error}));
							updater.checkForUpdates()
								.then((result) => {
									if (result == null) {
										log.warn('Check for updates was skipped by electron-updater');
										resolveOnce({updateAvailable: false, error: null});
									}
								})
								.catch(error=> resolveOnce({updateAvailable: null, error}));
						});
					}
				};
				asyncSteps.push(asyncLauncherUpdateCheck);

				const performUpdate = () => {
					gui.send('dl-started', 'autoupdate');

					updater.on('download-progress', (d) => {
						log.info(`Self-download progress: ${d.percent}`);
						gui.send('dl-progress', 'autoUpdate', d.percent, 100);
					});
					updater.on('update-downloaded', () => {
						log.info('Self-update downloaded');
						gui.send('dl-finished', 'autoupdate');
						setImmediate(() => updater.quitAndInstall(config.silent, true));
					});

					updater.on('error', error => {
						log.error(`Application failed to self-update. Error: ${error}`);
					});

					updater.downloadUpdate();
				};

				steps.push({
					name: 'launcher_update',
					action: async () => {
						log.info('Checking for launcher update');

						let timeoutId;
						const checkTimeout = new Promise(resolve => {
							timeoutId = setTimeout(() => {
								resolve({updateAvailable: null, error: 'timeout'});
							}, 5000);
						});

						const {updateAvailable, error, updateInfo} = await Promise.race([asyncLauncherUpdateCheck.promise, checkTimeout]);
						clearTimeout(timeoutId);
						if (error) {
							log.error(`Failed to check for launcher updates. Error: ${error}, ignoring`);
						} else if (updateAvailable) {
							if (config.disable_launcher_update_dialog || await showUpdateDialog(mainWindow, updateInfo)) {
								performUpdate();
								return;
							}
							log.info('User skipped launcher update');
						}
						wizard.nextStep();
					}
				});
			}
		}

		let enginePath;
		if (config.launch.engine_path != null) {
			enginePath = config.launch.engine_path;
		} else {
			const engineName = config.launch.engine || config.downloads.engines[0];
			if (engineName != null) {
				enginePath = path.join(springPlatform.writePath, 'engine', engineName, springPlatform.springBin);
			}
		}
		if (enginePath != null) {
			steps.push({
				name: 'start',
				action: (step) => {
					setTimeout(() => {
						if (launcher.state != 'failed') {
							mainWindow.hide();
						}
					}, 1000);

					log.info(`Starting Spring from: ${enginePath}`);
					launcher.launch(enginePath, config.launch.start_args);

					this.emit('launched');

					gui.send('launch-started');
					launcher.once('finished', () => {
						this.steps.push(step);
					});

					launcher.once('failed', () => {
						this.steps.push(step);
					});
				}
			});
		}

		this.started = false;
		this.steps = steps;
		this.asyncSteps = asyncSteps;
		this.enabled = true;
	}

	setEnabled(enabled) {
		this.enabled = enabled;
	}

	nextStep(forced) {
		if (!this.enabled) {
			return;
		}

		const step = this.steps.shift();
		if (step === undefined) {
			log.warn('No more steps to do.');
			gui.send('wizard-stopped');
			gui.send('wizard-finished');
			this.started = false;
			gui.send('set-next-enabled', false);
			return false;
		}
		if (!this.started) {
			gui.send('wizard-started');
			this.started = true;
			for (const step of this.asyncSteps) {
				step.promise = step.action();
			}
		}

		log.info(`Step: ${JSON.stringify(step, null, 4)}`);

		if (step.name === 'start') {
			if (!(config.auto_start || forced)) {
				gui.send('wizard-stopped');
				gui.send('wizard-finished');
				this.steps.push(step);
				return false;
			}
		} else {
			gui.send('wizard-next-step', {
				name: step.name,
				item: step.item
			});
		}

		step.action(step);
		return true;
	}
}

const wizard = new Wizard();

module.exports = {
	wizard: wizard,
};
