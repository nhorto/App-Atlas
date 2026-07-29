"""Cleans the export."""


def clean(text):
    """Strip the junk."""
    return text.strip()


if __name__ == "__main__":
    print(clean(input("text: ")))
