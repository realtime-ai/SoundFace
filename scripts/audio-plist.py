import pathlib
import plistlib
import sys

source, bundle = map(pathlib.Path, sys.argv[1:])
with (source / "BlackHole/BlackHole.plist").open("rb") as f:
    info = plistlib.load(f)
info.update(CFBundleExecutable="SoundFace", CFBundleIdentifier="app.soundface.audio",
            CFBundleName="SoundFace", CFBundleShortVersionString="0.1.0", CFBundleVersion="1")
# Give the customized plug-in a distinct factory UUID as well as distinct bundle/device IDs.
factory = "44D93163-27AE-45A5-A09F-9F96B6B59C57"
info["CFPlugInFactories"] = {factory: "BlackHole_Create"}
info["CFPlugInTypes"] = {"443ABAB8-E7B3-491A-B985-BEB9187030DB": [factory]}
with (bundle / "Contents/Info.plist").open("wb") as f:
    plistlib.dump(info, f)
