# scrcpy server 4.1

This is the unmodified official Android server from Genymobile's scrcpy 4.1
release. Synkora uses separate control-only and video-only channels inside an
Android emulator owned by the current mobile session. Audio and clipboard
synchronization are disabled. No desktop scrcpy executable is bundled.

- Project: https://github.com/Genymobile/scrcpy
- Release: https://github.com/Genymobile/scrcpy/releases/tag/v4.1
- Original asset: https://github.com/Genymobile/scrcpy/releases/download/v4.1/scrcpy-server-v4.1
- Local name: `scrcpy-server-v4.1.jar`
- Size: 733706 bytes
- SHA-256: `deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae`
- Checksum source: the official GitHub release asset digest, verified on download.
- License: Apache License 2.0; the upstream license is included as `LICENSE`.

The control and framed video protocols are version-specific. Updating this
artifact also requires updating the pinned version/hash in `mobileScrcpy.ts`
and the touch/framed-video protocol tests.
The runtime checks the pinned hash before pushing the server to the owned AVD.
