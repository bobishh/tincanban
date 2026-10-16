"""Bind the running container to exact checked config bytes and registry manifest."""
import hashlib
import json
import re
import subprocess
import sys
import tarfile


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def image_receipt(container_name, expected_config):
    if (not re.fullmatch(r"tincanban-executor-web-release-[a-f0-9]{64}", container_name)
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", expected_config)):
        raise ValueError("Invalid executor image receipt request")
    container = json.loads(docker("inspect", container_name))[0]
    container_image = container["Image"]
    image = json.loads(docker("image", "inspect", container_image))[0]
    expected_hash = expected_config.removeprefix("sha256:")
    config_hash = None
    # Docker's classic store reports config IDs; its containerd store can report
    # manifest IDs instead. Hash the actual saved config bytes in both cases.
    process = subprocess.Popen(["docker", "image", "save", container_image], stdout=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
            for entry in archive:
                if entry.name in (f"blobs/sha256/{expected_hash}", f"{expected_hash}.json"):
                    if not entry.isfile() or entry.size > 2 * 1024 * 1024:
                        raise RuntimeError("Executor image config exceeds its receipt bound")
                    content = archive.extractfile(entry).read()
                    config_hash = "sha256:" + hashlib.sha256(content).hexdigest()
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
    print(json.dumps(image_receipt(sys.argv[1], sys.argv[2])))
