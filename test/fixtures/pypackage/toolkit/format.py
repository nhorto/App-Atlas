"""Renders a duration the way a person would say it out loud.

The `__main__` block at the bottom is left over from debugging, which is exactly what
the two of them in `psf/requests` are — and they were enough to file the most-imported
library in Python under "Something you run".
"""


def format_duration(seconds):
    """Turn 90 into "1m 30s"."""
    return f"{seconds // 60}m {seconds % 60}s"


if __name__ == "__main__":
    print(format_duration(90))
