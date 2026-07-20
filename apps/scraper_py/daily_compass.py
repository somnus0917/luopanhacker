"""Backward-compatible entry point; collection now lives in apps.collector_py."""

from apps.collector_py.compass import main


if __name__ == "__main__":
    main()
