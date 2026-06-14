'use strict';

const { app } = require('electron');
const EventEmitter = require('events');
const { spawn } = require('child_process');
const { resolve } = require('path');
const fs = require('fs');
const path = require('path');

const log = require('electron-log');

const springPlatform = require('./spring_platform');
const { config } = require('./launcher_config');
const { springsettings } = require('./springsettings');
const { buildMacOsEngineEnv } = require('./macos_engine_env');

const { bridge } = require('./spring_bridge');
let address;
let port;

bridge.on('listening', () => {
	const a = bridge.server.address();
	address = a.address;
	port = a.port;
});

function generateScriptTXT() {
	let extraModOptions = '';
	if (config.launch.mod_options != null) {
		for (let [key, value] of Object.entries(config.launch.mod_options)) {
			extraModOptions = extraModOptions + `\n${key} = ${value};`;
		}
	}

	let mapOptions = '';
	if (config.launch.map_options != null) {
		mapOptions = '[MapOptions]\n{';
		for (let [key, value] of Object.entries(config.launch.map_options)) {
			mapOptions = mapOptions + `\n${key} = ${value};`;
		}
		mapOptions += '\n}';
	}

	let extraGameOptions = '';
	if (config.launch.game_options != null) {
		for (let [key, value] of Object.entries(config.launch.game_options)) {
			extraGameOptions = extraGameOptions + `\n${key} = ${value};`;
		}
	}

	return `[GAME]
{
	GameType = ${config.launch.game};
	HostIP = 127.0.0.1;
	IsHost = 1;
	MapName = ${config.launch.map};
	NumPlayers = 2;
	NumUsers = 2;
	GameStartDelay = 0;

	${extraGameOptions}

	[allyTeam0]
	{
		NumAllies = 0;
	}

	[allyTeam1]
	{
		NumAllies = 0;
	}

	[ModOptions]
	{
	_sl_address = ${address};
	_sl_port = ${port};
	_sl_write_path = ${springPlatform.writePath};
	_sl_launcher_version = ${app.getVersion()};
	${extraModOptions}
	}

	${mapOptions}

	[player0]
	{
		IsFromDemo = 1;
		Name = Enemy;
		Spectator = 0;
		Team = 1;
	}

	[player1]
	{
		IsFromDemo = 1;
		Name = 0;
		Spectator = 0;
		Team = 0;
	}

	[team0]
	{
		AllyTeam = 0;
		RGBColor = 0.35294119 0.35294119 1;
		TeamLeader = 0;
	}

	[team1]
	{
		AllyTeam = 1;
		RGBColor = 0.78431374 0 0;
		TeamLeader = 0;
	}

}`;
}

class Launcher extends EventEmitter {
	launch(enginePath, opts) {
		try {
			springsettings.applyDefaultsAndOverrides(config.launch.springsettings);
		} catch (e) {
			// Failures need to be asynchornous to be handled properly.
			setTimeout(() => {
				this.state = 'failed';
				this.emit('failed', e.message);
			}, 0);
			return;
		}

		if (config.no_start_script) {
			fs.writeFileSync(`${springPlatform.writePath}/sl-connection.json`, JSON.stringify({
				_sl_address: address,
				_sl_port: port,
				_sl_write_path: springPlatform.writePath,
				_sl_launcher_version: app.getVersion()
			}));
			this.launchSpring(enginePath, opts);
		} else {
			const scriptTXT = generateScriptTXT();
			const scriptTxtPath = `${springPlatform.writePath}/script.txt`;
			opts = [];
			fs.writeFile(scriptTxtPath, scriptTXT, 'utf8', () => {
				opts.push(scriptTxtPath);
				this.launchSpring(enginePath, opts);
			});
		}
	}

	launchSpring(enginePath, extraArgs) {
		var args = ['--write-dir', resolve(springPlatform.writePath)];
		if (config.isolation) {
			args.push('--isolation');
		}
		if (extraArgs != undefined) {
			args = args.concat(extraArgs);
		}

		var outputMode = 'pipe';
		const isDev = false;
		if (process.platform === 'linux' && isDev) {
			outputMode = 'inherit';
		}

		if (!fs.existsSync(enginePath)) {
			setImmediate(() => {
				this.state = 'failed';
				this.emit('failed',
					'Failed to launch: Engine binary not found. This sometimes happens '+
					'during engine upadates when a new version is incorrectly deleted or '+
					'blocked by antivirus. Resolve the issue with antivirus (E.g., '+
					'<a target="_blank" href="https://www.google.com/search?q=How+to+add+a+folder+to+%3Cyour+antivirus%3E+antivirus+exclusion+list">'+
					'add install folder to exceptions list</a>) and restart '+
					'the launcher.');
				if (!config.disable_engine_folder_deletion) {
					const engineDir = path.dirname(enginePath);
					log.info(`Deleting the engine directory ${enginePath} to retry on next run.`);
					fs.rm(engineDir, {
						force: true,
						recursive: true,
						maxRetries: 5
					}, (err) => {
						if (err) {
							log.error(`Failed to remove engine directory: ${err}`);
						}
					});
				}
			});
			return;
		}

		// The engine resolves its own dylibs and bundled data relative to its
		// working directory, so cwd must be the engine version directory (the
		// dir holding the binary). This matters on macOS for the Mesa/Vulkan
		// stack; it is harmless elsewhere.
		const engineDir = path.dirname(enginePath);

		let spawnEnv = process.env;
		if (process.platform === 'darwin') {
			// The patched Recoil engine on macOS needs its Mesa/Vulkan stack
			// wired up at launch (KosmicKrisp ICD, optional Zink). Mirror
			// bar-lobby's launch env.
			spawnEnv = buildMacOsEngineEnv(engineDir, process.env);
			// Under --isolation spring reads from the write-dir and SPRING_DATADIR.
			// The base content merged from the engine (fonts/, games/*.sdz) lives in
			// writePath, so point SPRING_DATADIR there or spring exits 21
			// ("Failed to load FontFile FreeSansBold.otf"). Mirrors bar-lobby.
			spawnEnv.SPRING_DATADIR = resolve(springPlatform.writePath);
		}

		log.info(`Launching Spring with command: ${enginePath} ${args.join(' ')}`);
		const spring = spawn(enginePath, args,
			{ stdio: outputMode, stderr: outputMode, windowsHide: false, detached: true, env: spawnEnv, cwd: engineDir });

		this.state = 'running';

		spring.on('close', (code) => {
			if (this.state != 'running') {
				return;
			}
			if (code == 0) {
				this.state = 'finished';
				this.emit('finished', code);
			} else {
				this.state = 'failed';
				this.emit('failed', `Spring failed with code: ${code}`);
			}
		});

		if (spring.stdout) {
			spring.stdout.on('data', (data) => {
				var text = data.toString();
				// remove newline character at the end
				text = text.substring(0, text.length - 1);
				this.emit('stdout', text);
			});
		}

		if (spring.stderr) {
			spring.stderr.on('data', (data) => {
				var text = data.toString();
				text = text.substring(0, text.length - 1);
				this.emit('stderr', text);
			});
		}

		spring.on('error', (error) => {
			this.state = 'failed';
			this.emit('failed', `Failed to launch Spring: ${error}`);
		});
	}
}

const launcher = new Launcher();

module.exports = {
	Launcher: Launcher,
	launcher: launcher
};
