"""No network or hardware: verify archive integrity and extraction boundaries."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).with_name('prepare-openocd.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)

class PackagingTests(unittest.TestCase):
    def test_archive_traversal_is_rejected(self):
        root = 'xpack-openocd-' + prepare.LOCK['version']
        for name in ['/etc/passwd', root + '/../escape', 'other/file', root + '/C:/bad', root + '/a\\b']:
            with self.assertRaises(ValueError):
                prepare.relative_member(name, root)
        self.assertEqual(prepare.relative_member(root + '/bin/openocd', root), Path('bin/openocd'))

    def test_wrong_archive_never_replaces_an_existing_engine(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            bad = tmp / 'bad.tar.gz'
            bad.write_bytes(b'not the pinned OpenOCD release')
            existing = tmp / 'engine'
            existing.mkdir()
            (existing / 'keep').write_text('existing')
            with self.assertRaises(ValueError):
                prepare.prepare('linux-x64', bad, existing)
            self.assertEqual((existing / 'keep').read_text(), 'existing')

    def test_platform_mismatch_is_not_a_valid_cache(self):
        platform = prepare.default_platform()
        self.assertTrue(prepare.verify_tree(prepare.DEST, platform, prepare.LOCK['platforms'][platform]['sha256']))
        other = 'win32-x64' if platform == 'linux-x64' else 'linux-x64'
        self.assertFalse(prepare.verify_tree(prepare.DEST, other, prepare.LOCK['platforms'][other]['sha256']))

if __name__ == '__main__':
    unittest.main()
