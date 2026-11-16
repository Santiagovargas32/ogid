import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import time

spec = importlib.util.spec_from_file_location('bounded', Path(__file__).parents[1] / 'scripts/observe-bounded-runtime.py')
bounded = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bounded)


class BoundedObserverTest(unittest.TestCase):
    def run_fixture(self, action):
        with tempfile.TemporaryDirectory() as tmp:
            process = subprocess.Popen(['sleep', '60'])
            try:
                action(process, Path(tmp) / 'run')
            finally:
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=5)

    def test_rotates_and_stops_only_owned_process_with_durable_receipt(self):
        def action(process, output):
            result = bounded.observe(process.pid, bounded.identity(process.pid)[0], output,
                                     .15, .02, lambda: {'metric': 1}, segment_seconds=.05)
            self.assertEqual(result['state'], 'observed')
            self.assertTrue(result['signalSent'])
            self.assertTrue(result['processExited'])
            self.assertGreaterEqual(len(list(output.glob('samples-*.jsonl'))), 2)
            self.assertTrue((output / 'heartbeat.json').exists())
            self.assertTrue((output / 'result.json').exists())
        self.run_fixture(action)

    def test_identity_mismatch_never_signals_process(self):
        def action(process, output):
            result = bounded.observe(process.pid, '0', output, .1, .02, lambda: {})
            self.assertEqual(result['state'], 'incomplete')
            self.assertFalse(result['signalSent'])
            self.assertIsNone(process.poll())
        self.run_fixture(action)

    def test_collector_failure_stops_runtime_and_remains_incomplete(self):
        def action(process, output):
            def fail():
                raise ValueError('collector failed')
            result = bounded.observe(process.pid, bounded.identity(process.pid)[0], output, .1, .02, fail)
            self.assertEqual(result['state'], 'incomplete')
            self.assertTrue(result['signalSent'])
            self.assertTrue(result['processExited'])
        self.run_fixture(action)

    def test_segment_budget_failure_preserves_incomplete_receipt(self):
        def action(process, output):
            result = bounded.observe(process.pid, bounded.identity(process.pid)[0], output, .1, .02,
                                     lambda: {'metric': 'x' * 100}, segment_bytes=10)
            self.assertEqual(result['persistedSamples'], 0)
            self.assertFalse(result['continuous'])
            self.assertTrue(result['processExited'])
        self.run_fixture(action)

    def test_slow_disk_acknowledgements_do_not_block_sampling_or_stop(self):
        def action(process, output):
            real_atomic = bounded.atomic
            captured = []
            def delayed(path, value):
                if path.name == 'heartbeat.json':
                    time.sleep(.06)
                real_atomic(path, value)
            def collect():
                captured.append(time.monotonic())
                return {'metric': 1}
            with patch.object(bounded, 'atomic', delayed):
                result = bounded.observe(process.pid, bounded.identity(process.pid)[0], output,
                                         .2, .02, collect)
            self.assertEqual(result['state'], 'observed')
            self.assertEqual(result['samples'], result['persistedSamples'])
            self.assertGreaterEqual(len(captured), 7)
            self.assertLess(max(b-a for a,b in zip(captured,captured[1:])), .05)
            self.assertTrue(result['processExited'])
        self.run_fixture(action)

    def test_persistence_queue_exhaustion_is_explicit_and_keeps_existing_rows(self):
        import threading
        gate = threading.Event()
        real_atomic = bounded.atomic
        def delayed(path, value):
            if path.name == 'heartbeat.json':
                gate.wait(2)
            real_atomic(path, value)
        with tempfile.TemporaryDirectory() as tmp, patch.object(bounded, 'atomic', delayed):
            writer = bounded.SampleWriter(Path(tmp), 4096, capacity=1)
            try:
                writer.submit(0, {'first':True}, {})
                until = time.monotonic()+2
                while writer.persisted<1 and time.monotonic()<until:
                    time.sleep(.001)
                writer.submit(0, {'second':True}, {})
                with self.assertRaisesRegex(RuntimeError, 'queue exhausted'):
                    writer.submit(0, {'third':True}, {})
            finally:
                gate.set()
                writer.close(3)
            self.assertEqual(writer.persisted, 2)


if __name__ == '__main__':
    unittest.main()
