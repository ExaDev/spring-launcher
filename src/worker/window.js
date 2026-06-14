const { app, BrowserWindow } = require('electron');
const springPlatform = require('../spring_platform');

let workerWindow;

// Create a window for the worker

app.prependListener('ready', () => {
	workerWindow = new BrowserWindow({
		show: false,
		// contextIsolation defaults to true in modern Electron, which disables
		// require() in the renderer even with nodeIntegration on. The worker's
		// index.html does `require('./main')`, so it must be off (matches the
		// main window). Without this the download worker throws "require is not
		// defined" and the spring<->launcher download bridge never services map
		// downloads (they sit at "connecting").
		webPreferences: { nodeIntegration: true, contextIsolation: false }
	});
	workerWindow.loadFile(`${__dirname}/index.html`);

	// Send a 'start-indexing-replays' request once the worker is ready
	workerWindow.once('ready-to-show', () => {
		workerWindow.send('start-indexing-replays', springPlatform.writePath);
	});

});

module.exports = {
	getWorkerWindow: function() {
		return workerWindow;
	},
};
