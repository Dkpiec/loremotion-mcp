"""Entrypoint shim: python -m loremotion_mcp"""
from .server import main

raise SystemExit(main())
