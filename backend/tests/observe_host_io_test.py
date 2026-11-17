"""Measurement contracts; run directly with python3, no backend or database."""
import importlib.util
from pathlib import Path
import unittest
import tempfile

spec = importlib.util.spec_from_file_location(
    'observer', Path(__file__).parents[1] / 'scripts/observe-host-io.py')
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class MeasurementContracts(unittest.TestCase):
    def btrfs_fixture(self, root):
        filesystem = root / '11111111-1111-4111-8111-111111111111'
        (filesystem / 'devices').mkdir(parents=True)
        partition = root / 'block' / 'sda' / 'sda3'
        partition.mkdir(parents=True)
        (partition / 'partition').write_text('3\n')
        (filesystem / 'devices' / 'sda3').symlink_to(partition, target_is_directory=True)
        metadata = filesystem / 'allocation' / 'metadata'
        metadata.mkdir(parents=True)
        (metadata / 'bytes_used').write_text('4096\n')
        (filesystem / 'generation').write_text('123\n')
        return filesystem

    def test_btrfs_partition_is_scoped_to_selected_whole_device(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            filesystem = self.btrfs_fixture(root)
            text = 'commits 10\ncur_commit_ms 8388\nlast_commit_ms 12\nmax_commit_ms 19000\ntotal_commit_ms 20000\n'
            (filesystem / 'commit_stats').write_text(text)
            result = observer.btrfs_stats({'sda'}, root)[filesystem.name]
            self.assertEqual(result['devices'], ['sda3'])
            self.assertEqual(result['commitStats']['cur_commit_ms'], 8388)
            self.assertEqual(result['commitStats']['max_commit_ms'], 19000)
            self.assertEqual(result['generation'], 123)
            self.assertEqual(result['metadata'], {'bytes_used': 4096})
            self.assertEqual(observer.btrfs_stats({'sdb'}, root), {})
            self.assertEqual((filesystem / 'commit_stats').read_text(), text)

    def test_unavailable_or_invalid_btrfs_counters_are_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            filesystem = self.btrfs_fixture(root)
            (filesystem / 'commit_stats').write_text('commits -1\ncur_commit_ms invalid\nprivate-label 1\nlast_commit_ms 0\n')
            result = observer.btrfs_stats({'sda'}, root)[filesystem.name]
            self.assertEqual(result['commitStats'], {'last_commit_ms': 0})
            (filesystem / 'commit_stats').unlink()
            self.assertEqual(observer.btrfs_stats({'sda'}, root)[filesystem.name]['commitStats'], {})
            self.assertEqual(observer.btrfs_stats({'sda'}, root / 'missing'), {})

    def test_btrfs_whole_device_and_fixed_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            filesystem = self.btrfs_fixture(root)
            (filesystem / 'devices' / 'sda3').unlink()
            (filesystem / 'devices' / 'sdb').mkdir()
            (filesystem / 'commit_stats').write_text('commits 4\nsecret-field 99\n')
            self.assertEqual(observer.btrfs_stats({'sdb'}, root)[filesystem.name]['commitStats'], {'commits': 4})

    def test_private_archive_preserves_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'samples.jsonl'
            target = Path(directory) / 'private'
            target.mkdir()
            source.write_bytes(b'{"utc":"fixture"}\n')
            observer.archive(source, target)
            self.assertEqual((target / source.name).read_bytes(), source.read_bytes())
            self.assertEqual((target / source.name).stat().st_mode & 0o777, 0o600)

    def test_archive_refuses_to_overwrite_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'samples.jsonl'
            source.write_bytes(b'prior evidence\n')
            with self.assertRaises(FileExistsError):
                observer.archive(source, directory)
            self.assertEqual(source.read_bytes(), b'prior evidence\n')

    def test_empty_proc_status_fields_do_not_break_capture(self):
        self.assertEqual(observer.counters('Name:\tpython3\nVmRSS:\t12000 kB\nx86_Thread_features:\t\n'),
                         {'VmRSS': 12000})

    def test_disk_interval_units_and_flush(self):
        # Two seconds: 2 reads, 4 writes, 1 flush; 512-byte diskstats sectors.
        d = [2, 0, 8, 8, 4, 0, 16, 32, -1, 1000, 3000, 0, 0, 0, 0, 1, 10]
        r = observer.disk_rates(d, 2)
        self.assertEqual((r['readIOPS'], r['writeIOPS']), (1, 2))
        self.assertEqual((r['readBytesPerSecond'], r['writeBytesPerSecond']), (2048, 4096))
        self.assertEqual((r['readAwaitMs'], r['writeAwaitMs'], r['flushAwaitMs']), (4, 8, 10))
        self.assertEqual((r['averageQueue'], r['busyPercent']), (1.5, 50))

    def test_idle_and_old_kernels_have_no_invented_latency(self):
        r = observer.disk_rates([0] * 11, 5)
        self.assertIsNone(r['readAwaitMs'])
        self.assertIsNone(r['writeAwaitMs'])
        self.assertIsNone(r['flushAwaitMs'])

    def test_reused_pid_does_not_inherit_io(self):
        old = dict(starttime=10, io={'read_bytes': 100}, majflt=2)
        new = dict(starttime=11, io={'read_bytes': 1000}, majflt=20)
        self.assertEqual(observer.process_deltas(new, old), {})
        self.assertEqual(observer.process_deltas(new, None), {})

    def test_counter_reset_is_unknown_not_negative_io(self):
        old = dict(starttime=10, io={'read_bytes': 100}, majflt=2)
        new = dict(starttime=10, io={'read_bytes': 90}, majflt=4)
        r = observer.process_deltas(new, old)
        self.assertEqual(r['ioDelta'], {})
        self.assertEqual(r['delta']['majflt'], 2)

    def test_proc_comm_with_spaces_and_parentheses(self):
        fields = ['S'] + ['0'] * 21
        fields[19], fields[21] = '12345', '2'
        r = observer.stat('42 (worker (io)) ' + ' '.join(fields))
        self.assertEqual(r['comm'], 'worker (io)')
        self.assertEqual(r['starttime'], 12345)
        self.assertEqual(r['rssBytes'], 2 * observer.os.sysconf('SC_PAGE_SIZE'))


if __name__ == '__main__':
    unittest.main()
