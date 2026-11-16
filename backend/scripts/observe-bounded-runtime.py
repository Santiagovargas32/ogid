#!/usr/bin/env python3
"""Observe an explicitly identified npm-managed backend, independently of chat.

Run detached with persistent stdout/stderr. Never launches OGID. The backend
must also have --run-for-ms so losing this observer still bounds its lifetime.
Private output is exclusive, rotated hourly, and limited to 32 MiB per segment.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import queue
import threading
import time


def identity(pid):
    raw = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    return raw[19], raw[0]


def atomic(path, value):
    temporary = path.with_suffix('.tmp')
    with open(temporary, 'w', encoding='utf8') as output:
        os.chmod(temporary, 0o600)
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class SampleWriter:
    """Bound disk work separately from the observation clock and stop signal.

    A slow fsync may delay durable acknowledgements, never silently drop a
    sample. Exhaustion or an unconfirmed drain invalidates the observation.
    """
    def __init__(self, directory, segment_bytes, capacity=64):
        self.directory, self.segment_bytes = directory, segment_bytes
        self.queue = queue.Queue(maxsize=capacity)
        self.error, self.persisted = None, 0
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def submit(self, segment, sample, heartbeat):
        if self.error:
            raise RuntimeError('Sample writer failed') from self.error
        line = json.dumps(sample, separators=(',', ':')) + '\n'
        if len(line.encode()) > min(self.segment_bytes, 1024 * 1024):
            raise RuntimeError('Observer row byte budget exceeded')
        try:
            self.queue.put_nowait((segment, line, heartbeat))
        except queue.Full as error:
            raise RuntimeError('Observer persistence queue exhausted') from error

    def run(self):
        stream, segment = None, None
        try:
            while True:
                item = self.queue.get()
                if item is None:
                    break
                number, line, heartbeat = item
                if number != segment:
                    if stream:
                        stream.close()
                    segment = number
                    stream = open(self.directory / f'samples-{number:04d}.jsonl', 'x', encoding='utf8')
                    os.chmod(stream.name, 0o600)
                if stream.tell() + len(line.encode()) > self.segment_bytes:
                    raise RuntimeError('Observer segment byte budget exceeded')
                stream.write(line)
                stream.flush()
                os.fsync(stream.fileno())
                self.persisted += 1
                atomic(self.directory / 'heartbeat.json', {**heartbeat, 'persistedSamples': self.persisted})
        except Exception as error:
            self.error = error
        finally:
            if stream:
                stream.close()

    def close(self, timeout):
        until = time.monotonic() + timeout
        while self.thread.is_alive():
            try:
                self.queue.put(None, timeout=min(.1, max(0, until - time.monotonic())))
                break
            except queue.Full:
                if time.monotonic() >= until:
                    raise RuntimeError('Observer persistence drain unconfirmed')
        self.thread.join(max(0, until - time.monotonic()))
        if self.thread.is_alive():
            raise RuntimeError('Observer persistence drain unconfirmed')
        if self.error:
            raise RuntimeError('Observer persistence failed') from self.error


def observe(pid, start_ticks, directory, duration, interval, collect,
            segment_seconds=3600, segment_bytes=32 * 1024 * 1024,
            shutdown_seconds=30):
    directory.mkdir(mode=0o700)  # Refuse to overwrite an earlier run.
    began = time.monotonic()
    result = dict(pid=pid, startTicks=start_ticks, samples=0, maxGapSeconds=0,
                  signalSent=False, continuous=False, state='incomplete')
    handle = writer = None
    interrupted = False
    def interrupt(_signal, _frame):
        nonlocal interrupted
        interrupted = True
    old_handlers = {s: signal.signal(s, interrupt) for s in (signal.SIGTERM, signal.SIGINT)}
    try:
        # Acquire a stable handle, then validate starttime. A recycled numeric
        # PID can never redirect a later signal to a different process.
        handle = os.pidfd_open(pid)
        ticks, state = identity(pid)
        if ticks != str(start_ticks) or state == 'Z':
            raise RuntimeError('Runtime identity changed or already exited')
        atomic(directory / 'identity.json', {**result, 'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip()})
        writer = SampleWriter(directory, segment_bytes)
        poll = select.poll()
        poll.register(handle, select.POLLIN)
        previous = None
        while not poll.poll(0):
            now = time.monotonic()
            if interrupted or now - began >= duration:
                result['reason'] = 'observer-interrupted' if interrupted else 'observation-bound'
                break
            current_segment = int((now - began) // segment_seconds)
            sample = collect()
            sampled = time.monotonic()
            if previous is not None:
                result['maxGapSeconds'] = max(result['maxGapSeconds'], sampled - previous)
            previous = sampled
            result['samples'] += 1
            writer.submit(current_segment, sample, {**result, 'utc': time.time(), 'monotonic': sampled})
            time.sleep(max(0, min(interval - (sampled - now), duration - (sampled - began))))
        else:
            result['reason'] = 'runtime-exited'
        result['continuous'] = (result.get('reason') == 'observation-bound' and
                                result['samples'] >= 2 and result['maxGapSeconds'] <= 10)
    except Exception as error:
        result['error'] = type(error).__name__ + ': ' + str(error)
    finally:
        if handle is not None:
            try:
                # No signal after an identity mismatch; pidfd also protects
                # against exit/reuse between checking and sending.
                if identity(pid)[0] == str(start_ticks):
                    poll = select.poll()
                    poll.register(handle, select.POLLIN)
                    if not poll.poll(0):
                        signal.pidfd_send_signal(handle, signal.SIGTERM)
                        result['signalSent'] = True
                    result['processExited'] = bool(poll.poll(round(shutdown_seconds * 1000)))
            except (FileNotFoundError, ProcessLookupError):
                result['processExited'] = True
            finally:
                os.close(handle)
        for signum, handler in old_handlers.items():
            signal.signal(signum, handler)
        if writer:
            try:
                writer.close(shutdown_seconds)
            except Exception as error:
                result['continuous'] = False
                result['writerError'] = str(error)
            result['persistedSamples'] = writer.persisted
            if writer.persisted != result['samples']:
                result['continuous'] = False
        result['elapsedSeconds'] = time.monotonic() - began
        result['state'] = 'observed' if result['continuous'] and result.get('processExited') else 'incomplete'
        # Process exit is not proof of a clean durable shutdown. The caller
        # must reconcile server_stopped, children, jobs, owner and handles.
        atomic(directory / 'result.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--start-ticks', required=True)
    parser.add_argument('--duration', type=float, required=True)
    parser.add_argument('--interval', type=float, default=5)
    parser.add_argument('--devices', nargs='+', default=['sda'])
    args = parser.parse_args()
    if not (1 <= args.duration <= 172800 and 1 <= args.interval <= 5 and args.pid > 1):
        parser.error('duration 1..172800, interval 1..5, pid > 1')
    for device in args.devices:
        if not device.isalnum() or Path('/sys/class/block', device, 'partition').exists():
            parser.error('select whole devices, not partitions')
    backend = Path(__file__).resolve().parents[1]
    command = Path(f'/proc/{args.pid}/cmdline').read_bytes().split(b'\0')
    if (Path(f'/proc/{args.pid}/cwd').resolve() != backend or len(command) < 2 or
            Path(os.fsdecode(command[1])).name != 'server.js' or
            not any(arg.startswith(b'--run-for-ms=') for arg in command[2:])):
        parser.error('target must be this backend with an internal --run-for-ms bound')
    spec = importlib.util.spec_from_file_location('host_observer', Path(__file__).with_name('observe-host-io.py'))
    observer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(observer)
    previous, processes = None, {}
    def collect():
        nonlocal previous, processes
        previous, processes = observer.sample(set(args.devices), previous, processes)
        return previous
    result = observe(args.pid, args.start_ticks, args.output, args.duration, args.interval, collect)
    print(json.dumps(result))
    return 0 if result['state'] == 'observed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
