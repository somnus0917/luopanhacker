# Legacy Python Entrypoints

These files are preserved for reference while the production path moves to the
Flask static shell, Rust API/worker, SQLite storage, and Python Playwright
scrapers.

- `streamlit_app.py`: old Streamlit dashboard surface.
- `order_dashboard.py`: old standalone generated order dashboard.
- `main.py`: old scrape/show utility for the legacy metrics database.

They are not part of the Docker production startup path.
