"""
自动化测试入口脚本
"""

import subprocess
import sys


def main():
    res = subprocess.run([sys.executable, "-m", "pytest", "tests/"])
    sys.exit(res.returncode)


if __name__ == "__main__":
    main()
