"""Bind the running container to exact checked config bytes and registry manifest."""
import hashlib
import json
import re
import subprocess
import sys
import tarfile


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def archive_config(stream, expected_config, expected_manifest):
    expected_hash = expected_config.removeprefix("sha256:")
    expected_manifest_hash = expected_manifest.removeprefix("sha256:")
    config_hash = None
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for entry in archive:
            config_entry = entry.name in (f"blobs/sha256/{expected_hash}", f"{expected_hash}.json")
            manifest_entry = entry.name == f"blobs/sha256/{expected_manifest_hash}"
            if not config_entry and not manifest_entry:
                continue
            if not entry.isfile() or entry.size > 2 * 1024 * 1024:
                raise RuntimeError("Executor image metadata exceeds its receipt bound")
            content = archive.extractfile(entry).read()
            content_hash = "sha256:" + hashlib.sha256(content).hexdigest()
            if config_entry:
                if content_hash != expected_config:
                    raise RuntimeError("Active executor image differs from checked config bytes")
                config_hash = content_hash
            if manifest_entry:
                if content_hash != expected_manifest:
                    raise RuntimeError("Active executor image manifest digest differs from published manifest")
                manifest = json.loads(content)
                if manifest.get("config", {}).get("digest") != expected_config:
                    raise RuntimeError("Active executor manifest does not bind the checked config")
                config_hash = expected_config
    if config_hash != expected_config:
        raise RuntimeError("Active executor archive does not contain checked config evidence")
    return config_hash


def image_receipt(container_name, expected_config, expected_manifest):
    if (not re.fullmatch(r"tincanban-executor-web-release-[a-f0-9]{64}", container_name)
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", expected_config)
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", expected_manifest)):
        raise ValueError("Invalid executor image receipt request")
    container = json.loads(docker("inspect", container_name))[0]
    container_image = container["Image"]
    image = json.loads(docker("image", "inspect", container_image))[0]
    # Docker's classic store reports config IDs; its containerd store can report
    # manifest IDs and export only that manifest. Verify its config binding or
    # the actual config bytes, always retaining the registry digest check.
    process = subprocess.Popen(["docker", "image", "save", container_image], stdout=subprocess.PIPE)
    try:
        config_hash = archive_config(process.stdout, expected_config, expected_manifest)
        if process.wait() != 0:
            raise RuntimeError("Cannot read the active executor image config")
    except BaseException:
        process.kill()
        process.wait()
        raise
    finally:
        process.stdout.close()
    if config_hash != expected_config:
        raise RuntimeError("Active executor image config differs from checked config bytes")
    return {"containerImageId": container_image, "configImageId": config_hash,
            "repoDigests": image.get("RepoDigests", [])}


if __name__ == "__main__":
    print(json.dumps(image_receipt(sys.argv[1], sys.argv[2], sys.argv[3])))
