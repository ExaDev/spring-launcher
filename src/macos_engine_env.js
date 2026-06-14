'use strict';

const path = require('path');
const os = require('os');

// Build the environment overrides the patched Recoil engine needs to render on
// macOS. The engine ships a Mesa/Vulkan stack rather than relying on the OS GL
// driver, so it has to be pointed at the bundled KosmicKrisp Vulkan ICD and, on
// capable systems, told to drive GL through Mesa's Zink (GL-on-Vulkan) layer.
//
// The Zink hardware path is gated on the macOS version: it depends on the
// KosmicKrisp ICD and Mesa Zink dylibs that only function on macOS 26 (Tahoe)
// and later. On older releases the Zink overrides are omitted and the engine
// falls back to its software rasteriser (llvmpipe).
//
// DYLD_FALLBACK_LIBRARY_PATH (rather than DYLD_LIBRARY_PATH) is set only on the
// Zink path: it lets the dynamic loader find the bundled lib/ for Zink's runtime
// dlopen of libvulkan.1.dylib without overriding system libraries, which avoids
// the SIGBUS the engine work hit when the search order was forced.
//
// This mirrors bar-lobby's src/main/game/macos-engine-env.ts so both apps wire
// the engine the same way.
//
// engineDir is the absolute path to the engine version directory (the dir
// containing the 'spring' binary, with lib/ and share/ as siblings).
function buildMacOsEngineEnv(engineDir, baseEnv) {
	const icd = path.join(engineDir, 'share', 'vulkan', 'icd.d', 'kosmickrisp.json');

	const overrides = {
		EGL_PLATFORM: 'surfaceless',
		VULKAN_SDK: engineDir,
		VK_ICD_FILENAMES: icd,
		VK_DRIVER_FILES: icd,
	};

	// os.release() returns the Darwin kernel version; its major component maps
	// to the macOS release (Darwin 25 ~ macOS 26 Tahoe). Below the threshold the
	// Zink hardware path is unsupported and the software fallback is kept.
	const darwinMajor = Number(os.release().split('.')[0]);
	const ZINK_MIN_DARWIN_MAJOR = 25; // macOS 26 (Tahoe); below this use llvmpipe fallback
	if (darwinMajor >= ZINK_MIN_DARWIN_MAJOR) {
		overrides.GALLIUM_DRIVER = 'zink';
		overrides.MESA_LOADER_DRIVER_OVERRIDE = 'zink';
		overrides.MESA_GL_VERSION_OVERRIDE = '4.6';
		overrides.DYLD_FALLBACK_LIBRARY_PATH = path.join(engineDir, 'lib');
	}

	return Object.assign({}, baseEnv, overrides);
}

module.exports = { buildMacOsEngineEnv };
