"""Preserve exactly one executor writer while replacing its checked container."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

SERVICE = "tincanban-executor"
VOLUME = "tincanban_executor_data"


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def checked_container(container_id):
    container = json.loads(docker("inspect", container_id))[0]
    labels = container["Config"]["Labels"]
    if (labels.get("service") != SERVICE or labels.get("role") != "web"
            or labels.get("destination", "") != ""
            or not any(m.get("Name") == VOLUME and m["Destination"] == "/data"
                       for m in container["Mounts"])):
        raise RuntimeError("Executor handoff encountered another service or volume")
    prefix = f"/{SERVICE}-web-"
    if not container["Name"].startswith(prefix):
        raise RuntimeError("Executor handoff encountered an unexpected container name")
    version = container["Name"][len(prefix):]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", version):
        raise RuntimeError("Executor handoff encountered an invalid container version")
    return container, version


def current_writers():
    return [checked_container(item) for item in docker(
        "ps", "-q", "--filter", f"label=service={SERVICE}",
        "--filter", "label=role=web"
    ).split()]


def handoff(action, release_id, directory):
    if action not in ("stop", "restore") or not re.fullmatch(r"[a-f0-9]{64}", release_id):
        raise ValueError("Invalid executor handoff request")
    record = directory / f"handoff-{release_id}.json"
    if record.exists():
        previous_id = json.loads(record.read_text())["containerId"]
    elif action == "stop":
        writers = current_writers()
        if len(writers) > 1:
            raise RuntimeError("Multiple executor writers exist; refusing an ambiguous handoff")
        previous_id = writers[0][0]["Id"] if writers else None
        directory.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(record, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump({"containerId": previous_id}, output)
            output.flush()
            os.fsync(output.fileno())
        descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    else:
        raise RuntimeError("No captured executor writer to restore")
    previous_version = None
    if previous_id is not None:
        if not re.fullmatch(r"[a-f0-9]{64}", previous_id):
            raise RuntimeError("Invalid captured executor container")
        _, previous_version = checked_container(previous_id)
    for container, _ in current_writers():
        if action == "stop" or container["Id"] != previous_id:
            docker("stop", "--time", "30", container["Id"])
    if action == "restore" and previous_id is not None:
        docker("start", previous_id)
    return {"containerId": previous_id, "version": previous_version}


if __name__ == "__main__":
    print(json.dumps(handoff(sys.argv[1], sys.argv[2], Path.home() / ".kamal/apps/tincanban-executor")))
