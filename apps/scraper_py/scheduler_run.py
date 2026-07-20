"""Backward-compatible scheduler entry point."""

import asyncio

from apps.collector_py.scheduler import main


if __name__ == "__main__":
    asyncio.run(main())
