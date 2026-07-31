"""Write the current orders out to disk — a second command-line entry point."""
import argparse


def main() -> None:
    parser = argparse.ArgumentParser(description="Export orders to a directory.")
    parser.add_argument("out_dir")
    parser.parse_args()


if __name__ == "__main__":
    main()
