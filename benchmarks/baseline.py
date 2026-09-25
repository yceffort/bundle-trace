"""Build the original public analyzer in isolation for historical comparisons."""
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
COMMIT = '537b08500d0a0df2f543ebb63460da4ff441d15f'


def checkout(destination):
    names = subprocess.check_output(['git', '-c', 'core.fsmonitor=false', 'ls-tree', '-r', '--name-only', COMMIT, '--', 'src', 'Cargo.toml', 'Cargo.lock', 'README.md'], cwd=ROOT, text=True).splitlines()
    for name in names:
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(subprocess.check_output(['git', 'show', f'{COMMIT}:{name}'], cwd=ROOT))


def build():
    base = ROOT / 'artifacts/baseline'
    checkout(base / 'source')
    subprocess.run(['cargo', 'build', '--locked', '--release', '--manifest-path', str(base / 'source/Cargo.toml'), '--target-dir', str(base / 'target')], cwd=ROOT, check=True)
    output = base / 'coldpath'
    shutil.copyfile(base / 'target/release/coldpath', output)
    output.chmod(0o755)
    return output


if __name__ == '__main__':
    print(build())
