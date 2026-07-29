"""Builds the weekly report. Run it; don't import it."""


def gather(rows):
    """Collect the rows worth reporting on."""
    return [r for r in rows if r]


def main():
    """Prompt for a folder and write the report beside it."""
    where = input("folder: ")
    print(gather([where]))


if __name__ == "__main__":
    main()
