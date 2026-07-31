"""Load a batch of users from a file — one of the app's command-line entry points."""
import argparse


def main() -> None:
    parser = argparse.ArgumentParser(description="Import users from a CSV file.")
    parser.add_argument("path")
    parser.add_argument("--dry-run", action="store_true")
    parser.parse_args()


if __name__ == "__main__":
    main()
