"""Backward-compatible status imports for older scraper modules."""

from apps.collector_py.status import LOGIN_SCREENSHOT, read_status, write_status

__all__ = ["LOGIN_SCREENSHOT", "read_status", "write_status"]
