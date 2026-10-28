"""Startup banner — M.E.G.A. assistant identity + tagline."""

from __future__ import annotations

_WORDMARK = ("M.E.G.A.",)

_TAGLINE = "Personal AI, On Personal Devices"


def print_banner(quiet: bool = False) -> None:
    """Print the M.E.G.A. startup banner. No-op when quiet."""
    if quiet:
        return
    try:
        from rich.console import Console

        console = Console()
        for line in _WORDMARK:
            console.print(line, style="bold bright_blue", highlight=False, markup=False)
        console.print(f"      {_TAGLINE}", style="cyan", highlight=False, markup=False)
        console.print()
    except ImportError:
        for line in _WORDMARK:
            print(line)
        print(f"      {_TAGLINE}")
        print()
