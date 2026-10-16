import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("handoff", Path(__file__).with_name("rusty-storage-handoff.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class StorageHandoffTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name)
        self.calls = []
        self.old, self.new = "a" * 64, "b" * 64
        self.containers = {
            key: {"Id": key, "Name": f"/mesh-lighthouse-web-{version}",
                  "Config": {"Labels": {"service": "mesh-lighthouse", "role": "web", "destination": ""}},
                  "Mounts": [{"Name": module.VOLUME, "Destination": "/data"}]}
            for key, version in [(self.old, "previous"), (self.new, "cohort-failed")]
        }
        self.patch = patch.object(module, "docker", self.docker)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def docker(self, *args):
        self.calls.append(args)
        if args[0] == "exec":
            return f"\x1b[34mmesh-lighthouse-web\x1b[0m ingest.example / {self.old[:12]}:8080 running yes"
        if args[0] == "inspect":
            return json.dumps([next(value for key, value in self.containers.items() if key.startswith(args[1]))])
        if args[0] == "ps":
            return f"{self.old}\n{self.new}"
        if args[0] == "stop":
            # Capture the old identity durably before stopping either contender.
            record = self.path / f"storage-handoff-{'c' * 64}.json"
            self.assertEqual(json.loads(record.read_text())["containerId"], self.old)
        return ""

    def test_given_old_writer_and_failed_candidate_when_handoff_then_stop_both_and_recover_exact_previous(self):
        self.assertEqual(module.handoff("stop", "c" * 64, self.path), {"version": "previous"})
        self.assertEqual([call[-1] for call in self.calls if call[0] == "stop"], [self.new, self.old])
        self.calls.clear()
        self.assertEqual(module.handoff("restore", "c" * 64, self.path), {"version": "previous"})
        self.assertEqual([call for call in self.calls if call[0] in ("stop", "start")],
                         [("stop", "--time", "30", self.new), ("start", self.old)])
        self.calls.clear()
        module.handoff("stop", "c" * 64, self.path)
        self.assertFalse(any(call[0] == "exec" for call in self.calls), "Resume uses the captured writer")

    def test_given_wrong_volume_when_handoff_then_leave_containers_running(self):
        self.containers[self.old]["Mounts"] = []
        with self.assertRaisesRegex(RuntimeError, "another service or volume"):
            module.handoff("stop", "c" * 64, self.path)
        self.assertFalse(any(call[0] in ("stop", "start") for call in self.calls))

    def test_given_missing_receipt_when_restore_then_do_not_guess_a_previous_writer(self):
        with self.assertRaisesRegex(RuntimeError, "No captured Rusty writer"):
            module.handoff("restore", "c" * 64, self.path)
        self.assertEqual(self.calls, [])
