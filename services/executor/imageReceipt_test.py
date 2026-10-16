import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import unittest

spec = importlib.util.spec_from_file_location("executor_image_receipt", Path(__file__).with_name("imageReceipt.py"))
receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt)


def archive(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as writer:
        for name, content in entries.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(content)
            writer.addfile(entry, io.BytesIO(content))
    output.seek(0)
    return output


class ImageReceiptAcceptance(unittest.TestCase):
    def setUp(self):
        self.config = b'{"rootfs":{"diff_ids":["checked-layer"]}}'
        self.config_id = "sha256:" + hashlib.sha256(self.config).hexdigest()
        self.manifest = json.dumps({"schemaVersion": 2, "config": {"digest": self.config_id}}).encode()
        self.manifest_id = "sha256:" + hashlib.sha256(self.manifest).hexdigest()

    def test_given_classic_export_when_checking_then_exact_config_bytes_are_required(self):
        source = archive({self.config_id.removeprefix("sha256:") + ".json": self.config})
        self.assertEqual(receipt.archive_config(source, self.config_id, self.manifest_id), self.config_id)

    def test_given_sparse_containerd_export_when_checking_then_verified_manifest_binds_the_checked_config(self):
        source = archive({"blobs/sha256/" + self.manifest_id.removeprefix("sha256:"): self.manifest,
                          "manifest.json": b'[{"Config":"unmaterialized-config"}]'})
        self.assertEqual(receipt.archive_config(source, self.config_id, self.manifest_id), self.config_id)

    def test_given_changed_manifest_bytes_when_checking_then_filename_cannot_fake_registry_identity(self):
        source = archive({"blobs/sha256/" + self.manifest_id.removeprefix("sha256:"): self.manifest + b" "})
        with self.assertRaisesRegex(RuntimeError, "manifest digest"):
            receipt.archive_config(source, self.config_id, self.manifest_id)

    def test_given_another_config_when_checking_then_a_valid_manifest_cannot_substitute_checked_image(self):
        source = archive({"blobs/sha256/" + self.manifest_id.removeprefix("sha256:"): self.manifest})
        with self.assertRaisesRegex(RuntimeError, "checked config"):
            receipt.archive_config(source, "sha256:" + "f" * 64, self.manifest_id)


if __name__ == "__main__":
    unittest.main()
