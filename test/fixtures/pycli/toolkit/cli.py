"""The one command this package installs.

`pyproject.toml` gives it a name, so the door is `estimate` — not the path, and not the
path twice.
"""
import argparse


def main():
    parser = argparse.ArgumentParser(prog="estimate")
    parser.add_argument("job")
    return parser.parse_args()
