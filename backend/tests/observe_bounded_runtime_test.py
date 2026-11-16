import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

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
            self.assertEqual(result['samples'], 0)
            self.assertFalse(result['continuous'])
            self.assertTrue(result['processExited'])
        self.run_fixture(action)


if __name__ == '__main__':
    unittest.main()
